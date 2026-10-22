"use strict";
// Runs OPC UA method scripts inside QuickJS compiled to WebAssembly, instead of node:vm.
//
// node:vm is explicitly NOT a security boundary: a script could reach the host process through any
// host-realm object passed into the sandbox (Object.constructor === the Function constructor), and the
// previous implementation also built the wrapper by string concatenation, so a script could even close
// the wrapper and run arbitrary top-level code while the address space was being built. This replaces it
// with a real boundary: the script runs in a separate WebAssembly JavaScript engine that has no access to
// Node, the filesystem, the network, timers or any host object. The only things it can touch are three
// purpose-built host functions (getValue / setValue / log), and every value that crosses the boundary is
// plain JSON. Each call gets a fresh runtime (no shared state between calls) with a wall-clock timeout, a
// memory limit and a cap on host calls, so a looping or allocating script can no longer hang or exhaust
// the server.
//
// QuickJS runs inside one shared WebAssembly instance. A few scripts can leave that instance unusable: very deep
// nesting (recursion, JSON.parse / eval of deeply nested text) can exhaust the host's own stack while the WASM code
// runs, and after some stack overflows QuickJS's own clean-up stops with an assertion ("Aborted(...)"). In both
// cases the instance's state is undefined afterwards, so it is retired and the next call gets a fresh instance
// (loading one takes a few milliseconds). One bad script therefore never breaks later method calls (UC-4).
const { newQuickJSWASMModuleFromVariant, newVariant } = require("quickjs-emscripten-core");
const baseVariant = require("@jitl/quickjs-wasmfile-release-sync");

// Per-call limits (shared with the UI text and SECURITY.md).
const TIME_LIMIT_MS = 1000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_HOST_CALLS = 10000;
// QuickJS's own stack limit. Kept well below the host stack so that ordinary deep recursion (thousands of calls)
// ends with a normal, catchable "stack overflow" error inside the script; nesting that still reaches the host
// stack first is handled by retiring the WASM instance (see above).
const MAX_STACK_BYTES = 256 * 1024;

// Emscripten prints "Aborted(...)" to stderr when QuickJS stops on an assertion; the failure is reported as the
// method error instead, so keep the console clean.
const variant = newVariant(baseVariant, { emscriptenModule: { printErr: () => {} } });

// The WebAssembly module is loaded once and reused while it is healthy; newRuntime() per call is cheap (~0.2 ms).
let modulePromise = null;
let currentModule = null;
const retiredModules = new WeakSet();

function loadQuickJS() {
    if (!modulePromise) {
        const p = newQuickJSWASMModuleFromVariant(variant).then(
            (mod) => {
                if (modulePromise === p) currentModule = mod;
                return mod;
            },
            (err) => {
                if (modulePromise === p) modulePromise = null; // allow a later retry if loading failed
                throw err;
            }
        );
        modulePromise = p;
    }
    return modulePromise;
}

// false once a module has been retired after an engine failure: get a fresh one with loadQuickJS().
function isQuickJSUsable(mod) {
    return !!mod && !retiredModules.has(mod);
}

function retireModule(mod) {
    retiredModules.add(mod);
    if (currentModule === mod || !currentModule) {
        currentModule = null;
        modulePromise = null;
    }
}

// Bootstrap evaluated inside the guest: it wraps the raw host bridges (which speak JSON strings) in the
// getValue / setValue / log the script sees, builds the script's function body with the guest's own
// Function constructor (so no host code is ever concatenated with the script text), runs it with the
// call inputs, and returns the result as a JSON string. Everything here executes in the guest realm.
const HARNESS = `
(function () {
    "use strict";
    var getValue = function (path) {
        var r = __hostGetValue(JSON.stringify(path === undefined ? null : path));
        return JSON.parse(r);
    };
    var setValue = function (path, value) {
        __hostSetValue(JSON.stringify([path === undefined ? null : path, value === undefined ? null : value]));
    };
    var log = function (message) {
        __hostLog(JSON.stringify(message === undefined ? "" : String(message)));
    };
    var inputs = JSON.parse(__scriptInputs);
    // The script body runs as the body of this function; the guest's own Function constructor parses it,
    // so a body that is not a valid function body throws a SyntaxError here (reported as a method error).
    var fn = new Function("inputs", "getValue", "setValue", "log", __scriptBody);
    var out = fn(inputs, getValue, setValue, log);
    return JSON.stringify(out === undefined ? null : out);
})()
`;

/**
 * Runs one method script and returns its result as a plain JS value (parsed from the guest's JSON).
 * `host` provides getValue(path) / setValue(path, value) / log(message), all operating on plain JSON values.
 * Throws an Error (with a readable message) when the script throws, times out, runs out of memory, makes too
 * many host calls, or returns a value that is not JSON.
 *
 * `qjsModule` is the module returned by loadQuickJS(). When the script breaks the engine itself, that module is
 * retired (isQuickJSUsable() turns false) and the next call must use a fresh one: runMethodScriptIsolated() does
 * that automatically.
 */
function runMethodScript(qjsModule, { script, inputs, host }) {
    if (!isQuickJSUsable(qjsModule)) throw new Error("the method-script engine is restarting, call the method again");
    let hostCalls = 0;
    let stoppedBy = null; // set by the interrupt handler (host side), so a script cannot fake a timeout
    const deadline = Date.now() + TIME_LIMIT_MS;
    let runtime = null;
    let context = null;
    let outcome = null; // { json } on success, { error } when the script failed in a normal way
    try {
        runtime = qjsModule.newRuntime();
        runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
        runtime.setMaxStackSize(MAX_STACK_BYTES);
        // the interrupt fires regularly while the guest runs: stop on timeout or when host calls run away
        runtime.setInterruptHandler(() => {
            if (hostCalls > MAX_HOST_CALLS) stoppedBy = "host-calls";
            else if (Date.now() > deadline) stoppedBy = "time";
            return stoppedBy !== null;
        });

        context = runtime.newContext();
        const countCall = () => {
            hostCalls += 1;
            if (hostCalls > MAX_HOST_CALLS) throw new Error(`a method script may make at most ${MAX_HOST_CALLS} getValue/setValue/log calls`);
        };
        // Each bridge speaks JSON strings only. A host-side throw is turned into a guest exception with
        // the same message, so the script sees a normal error it can catch, and if it does not, the
        // message surfaces as the method error. No host object or stack ever crosses into the guest.
        const registerBridge = (name, impl) => {
            const fn = context.newFunction(name, (argHandle) => {
                try {
                    countCall();
                    const out = impl(argHandle ? context.getString(argHandle) : "null");
                    return context.newString(out === undefined ? "null" : out);
                } catch (err) {
                    return { error: context.newError(err instanceof Error ? err.message : String(err)) };
                }
            });
            context.setProp(context.global, name, fn);
            fn.dispose();
        };
        registerBridge("__hostGetValue", (pathJson) => {
            const value = host.getValue(JSON.parse(pathJson));
            return JSON.stringify(value === undefined ? null : value);
        });
        registerBridge("__hostSetValue", (argsJson) => {
            const [path, value] = JSON.parse(argsJson);
            host.setValue(path, value);
            return "null";
        });
        registerBridge("__hostLog", (msgJson) => {
            host.log(JSON.parse(msgJson));
            return "null";
        });

        const setString = (name, value) => {
            const h = context.newString(value);
            context.setProp(context.global, name, h);
            h.dispose();
        };
        setString("__scriptInputs", JSON.stringify(Array.isArray(inputs) ? inputs : []));
        setString("__scriptBody", String(script == null ? "return [];" : script));

        const result = context.evalCode(HARNESS, "method-script.js");
        if (result.error) {
            const info = context.dump(result.error);
            result.error.dispose();
            outcome = { error: new Error(describeGuestError(info, stoppedBy)) };
        } else {
            const json = context.getString(result.value);
            result.value.dispose();
            outcome = { json };
        }
    } catch (err) {
        // Something was thrown out of the engine itself rather than by the script: the host stack ran out
        // while QuickJS was running, or the WASM code trapped / aborted. The instance's state is undefined
        // now (its stack and heap may be half-unwound), so it is not disposed or used again.
        retireModule(qjsModule);
        throw new Error(describeEngineFailure(err));
    }
    // Free the context and runtime. After some stack overflows QuickJS's clean-up stops on an assertion even
    // though every handle was released; the script's result is still valid, only this WASM instance is retired.
    try {
        context.dispose();
        runtime.dispose();
    } catch (_) {
        retireModule(qjsModule);
    }
    if (outcome.error) throw outcome.error;
    return JSON.parse(outcome.json);
}

/**
 * Like runMethodScript, but gets a healthy QuickJS module itself (loading a fresh one after an engine failure).
 * Resolves to the script's result; rejects with a readable Error.
 */
async function runMethodScriptIsolated(options, qjsModule = null) {
    const mod = isQuickJSUsable(qjsModule) ? qjsModule : await loadQuickJS();
    return runMethodScript(mod, options);
}

const STACK_MESSAGE = "method script nested too deeply (stack overflow) and was stopped";

// Turn the guest's thrown value into a one-line message for the method log. Timeouts and the host-call cap are
// decided by the host-side `stoppedBy` flag, never by the text of the guest's error.
function describeGuestError(info, stoppedBy) {
    if (stoppedBy === "host-calls") return `method script made more than ${MAX_HOST_CALLS} getValue/setValue/log calls and was stopped`;
    if (stoppedBy === "time") return `method script ran longer than ${TIME_LIMIT_MS} ms and was stopped`;
    const isInternal = info && typeof info === "object" && info.name === "InternalError";
    if (isInternal && info.message === "out of memory") {
        return `method script ran out of memory (the limit is ${Math.round(MEMORY_LIMIT_BYTES / (1024 * 1024))} MB per call) and was stopped`;
    }
    if (isInternal && info.message === "stack overflow") return STACK_MESSAGE;
    if (info && typeof info === "object" && info.message) return `${info.name || "Error"}: ${info.message}`;
    return `method script failed: ${typeof info === "string" ? info : JSON.stringify(info)}`;
}

// One-line message for a failure of the engine itself (see runMethodScript's catch).
function describeEngineFailure(err) {
    const message = String((err && err.message) || err || "");
    if (err instanceof RangeError && /call stack/i.test(message)) return `${STACK_MESSAGE} (the script engine is restarted for the next call)`;
    const short = message.replace(/\s*Build with -sASSERTIONS.*$/s, "").slice(0, 200);
    return `method script stopped the script engine${short ? ` (${short})` : ""}; the engine is restarted for the next call`;
}

module.exports = {
    loadQuickJS,
    isQuickJSUsable,
    runMethodScript,
    runMethodScriptIsolated,
    TIME_LIMIT_MS,
    MEMORY_LIMIT_BYTES,
    MAX_HOST_CALLS
};
