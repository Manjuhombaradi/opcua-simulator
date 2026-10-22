"use strict";
const path = require("path");
const fs = require("fs");
const { fileURLToPath, pathToFileURL } = require("url");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, screen, session, clipboard } = require("electron");

// ------------------------------------------------------------------ no connections the user did not ask for
// The app itself never goes online; only the OPC UA server/client sockets the user starts. Chromium would otherwise
// fetch a Hunspell spell-check dictionary from a Google CDN on Linux/Windows at every launch (until it succeeds).
// Switching the spell checker off does not stop that download; an empty language list and a loopback download URL do
// (measured in the security audit). The switches below are defence in depth for other background services.
for (const name of ["disable-background-networking", "disable-component-update", "disable-domain-reliability", "no-pings"]) {
    app.commandLine.appendSwitch(name);
}
// Web permissions (camera, microphone, location, notifications, clipboard, …): the app needs none of them, so all are
// refused. The Copy buttons write through main (app.copyText): Chromium would ask for "clipboard-read" for writeText.
const hardenedSessions = new WeakSet();
function hardenSession(s) {
    if (!s || hardenedSessions.has(s)) return;
    hardenedSessions.add(s);
    if (process.platform !== "darwin") {
        try { s.setSpellCheckerLanguages([]); } catch (_) { /* macOS uses the OS spell checker */ }
    }
    try { s.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/"); } catch (_) { /* ignore */ }
    try { s.setSpellCheckerEnabled(false); } catch (_) { /* ignore */ }
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    s.setDevicePermissionHandler(() => false);
}
app.on("session-created", hardenSession);
// No embedded browser views and no pop-up windows, whatever the page tries.
app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
// Developer tools: always when running from source; in installed builds only for troubleshooting with OPCUA_SIM_DEVTOOLS=1.
const DEVTOOLS = !app.isPackaged || process.env.OPCUA_SIM_DEVTOOLS === "1";
// Chromium's remote debugging switches would give the same control over the window (and its IPC bridge) as the
// developer tools, and no Electron fuse covers them, so installed builds refuse to start with them unless allowed.
if (!DEVTOOLS) {
    const debugSwitch = ["remote-debugging-port", "remote-debugging-pipe"].find((name) => app.commandLine.hasSwitch(name));
    if (debugSwitch) {
        process.stderr.write(`OPC UA Simulator: --${debugSwitch} is turned off in installed builds (it gives full control over the application window). Set OPCUA_SIM_DEVTOOLS=1 to allow it for troubleshooting.\n`);
        app.exit(1);
    }
}

// ------------------------------------------------------------------ early process setup
// Arguments after the executable (dev: electron . <args>; packaged: app <args>).
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);
// Linux without a display server (server VM over SSH, systemd unit): fall back to headless mode
// instead of letting Chromium abort with "Missing X server or $DISPLAY".
const NO_DISPLAY = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const HEADLESS = cliArgs.includes("--headless") || NO_DISPLAY;
// Note: running as root needs --no-sandbox (or ELECTRON_DISABLE_SANDBOX=1) on the real command line,
// because Electron checks it before this script runs; app.commandLine.appendSwitch here is too late.
// The packaged Linux launcher (build/afterPack.js) takes care of that.
if (process.platform === "linux" && HEADLESS) {
    // Without a display server use Chromium's headless platform.
    if (NO_DISPLAY) app.commandLine.appendSwitch("ozone-platform", "headless");
    // No separate GPU process: when SIGTERM reaches the whole process group (systemctl stop, pkill)
    // a killed GPU process would otherwise be relaunched and abort the app with a crash (exit 133).
    app.commandLine.appendSwitch("in-process-gpu");
}
if (HEADLESS || process.env.OPCUA_DISABLE_GPU === "1") app.disableHardwareAcceleration();
// Electron has already turned this (set by the Linux launcher) into its --no-sandbox switch; do not pass it
// on to programs the app opens (xdg-open, editors), which would otherwise run their own sandbox disabled.
delete process.env.ELECTRON_DISABLE_SANDBOX;

const { nodesets } = require("node-opcua");
const { ServerEngine, ROLE_NAMES, EVENT_TYPES, NODESET_DEPENDENCIES, SECURE_PRESET, securityWarnings, projectScriptsHash, projectScriptSummary } = require("./serverEngine");
const { ClientEngine } = require("./clientEngine");
const { SUPPORTED_DATA_TYPES, COMMON_STATUS_CODES } = require("./valueUtils");
const { listCertificates, certificateAction } = require("./pki");
const { fromTemplate, readProjectFile, normalizeProject, isProjectFile, PROJECT_EXTENSIONS } = require("./project");
const { DEFAULT_USERS } = require("./defaultProject");
const { networkInfo, checkPort, findFreePort, portProblemMessage } = require("./network");
const { runHeadless } = require("./headless");

const dataDir = app.getPath("userData");
const lastProjectFile = path.join(dataDir, "last-project.json");
const settingsFile = path.join(dataDir, "settings.json");
const logDir = path.join(dataDir, "logs");
const pkiDir = (store) => path.join(dataDir, "pki", store);

// Plain-language warnings for a project's settings (from the engine) -> [{ text, level }]
function projectWarnings(project, { opening = false } = {}) {
    if (!project || typeof project !== "object") return [];
    let list;
    try {
        list = securityWarnings(project);
    } catch (err) {
        list = [`The security settings could not be checked (${err.message}).`];
    }
    const out = list.map((text) => ({ text: String(text), level: "warn" }));
    // a shared project names files on this computer that the server reads at start
    const files = (project.server?.customNodesetFiles || []).filter((f) => typeof f === "string" && f);
    if (opening && files.length) {
        out.push({ text: `The server reads ${files.length} NodeSet file(s) from this computer at start: ${files.join(", ")}`, level: "info" });
    }
    return out;
}

// ------------------------------------------------------------------ renderer-supplied paths (EXI-04)
// The renderer may only hand back paths that the user chose in a dialog of this session, that the OS gave the app
// (double-clicked project file, command line), or that belong to the app's own folders. Everything else is refused.
const approvedPaths = {
    project: new Set(), // project files: opened, saved, double-clicked, or restored from the last session (read + write)
    read: new Set(), // files picked in an open dialog (certificates to import, NodeSet XML, client certificate/key): read only
    created: new Set() // files the app wrote in this session (exports) - may be shown in the file manager
};
const resolvePath = (file) => (typeof file === "string" && file ? path.resolve(file) : null);
function approvePath(kind, file) {
    const p = resolvePath(file);
    if (p) approvedPaths[kind].add(p);
    return file;
}
const isApproved = (kind, file) => { const p = resolvePath(file); return !!p && approvedPaths[kind].has(p); };
const hasProjectExtension = (file) => PROJECT_EXTENSIONS.some((ext) => String(file).toLowerCase().endsWith(`.${ext}`));
const realpath = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
// true when `file` lies inside `folder` (after resolving symbolic links)
function isInside(folder, file) {
    if (typeof file !== "string" || !file) return false;
    const rel = path.relative(realpath(folder), realpath(file));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
// Certificate actions: trust / reject / delete only work on files inside the store's PKI folder; import only on picked files.
function checkCertificatePath(store, action, file) {
    if (action === "regenerateOwn") return;
    if (action === "import" || action === "importIssuer") {
        if (!isApproved("read", file)) throw new Error("Choose the certificate with the Import button.");
        return;
    }
    if (!isInside(pkiDir(store), file)) throw new Error("This certificate is not in the certificate folder of the simulator.");
}
let mainWindow = null;
let rendererReady = false; // the window's renderer has fetched its initial data and listens for "open-file"
let pendingOpenFile = null;
let startupFileError = null;

// Project file given on a command line: plain or relative path (resolved against `cwd`) or a file:// URI
// (Linux file managers pass those through the .desktop entry's %U).
function projectFileArg(args, cwd) {
    for (const a of args) {
        if (typeof a !== "string" || !a || a.startsWith("-")) continue;
        let file = a;
        if (/^file:\/\//i.test(file)) {
            try { file = fileURLToPath(file); } catch (_) { continue; }
        }
        file = path.resolve(cwd || process.cwd(), file);
        if (isProjectFile(file)) return { file };
        if (PROJECT_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(`.${ext}`))) return { error: `Project file not found: ${file}` };
    }
    return null;
}
if (!HEADLESS) {
    const arg = projectFileArg(cliArgs);
    pendingOpenFile = approvePath("project", arg?.file) || null;
    startupFileError = arg?.error || null;
}

// Writes a file so that a crash or power-off during the write never leaves it truncated.
// Readable by the current user only (0600): project and state files hold the server's user passwords.
function writeFileAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        try { fs.fchmodSync(fd, 0o600); } catch (_) { /* a left-over .tmp file keeps its mode otherwise; no-op on Windows */ }
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, file);
    } catch (_) {
        // Windows: the target can be locked for a moment (virus scanner, indexer); write it directly
        try { fs.writeFileSync(file, data, { mode: 0o600 }); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    }
}

// Keeps a damaged state file for inspection (name.corrupt.json) so it is not overwritten.
function quarantine(file) {
    const target = file.replace(/\.json$/, "") + ".corrupt.json";
    try {
        fs.renameSync(file, target);
        return target;
    } catch (_) {
        return null;
    }
}

// ------------------------------------------------------------------ log file
// simple rotation: once simulator.log passes 5 MB it becomes simulator.old.log (one previous file kept)
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const logFile = path.join(logDir, "simulator.log");
let logStream = null;
let logBytes = 0; // size of simulator.log including what this run wrote
function openLogStream(rotate) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(logFile).size; } catch (_) { /* new file */ }
    let flags = "a";
    if (rotate || size > LOG_MAX_BYTES) {
        try {
            fs.renameSync(logFile, path.join(logDir, "simulator.old.log"));
        } catch (_) {
            flags = "w"; // cannot rotate: start the file over rather than letting it grow without limit
        }
        size = 0;
    }
    logBytes = size;
    // opened synchronously, so a rotation right after (log burst) renames the file this stream writes to
    // the log holds user names, client addresses and written values: current user only
    const fd = fs.openSync(logFile, flags, 0o600);
    try { fs.fchmodSync(fd, 0o600); } catch (_) { /* files from older versions; no-op on Windows */ }
    logStream = fs.createWriteStream(logFile, { fd });
    logStream.on("error", () => { /* logging must never break the app */ });
}
function writeLogLine(entry) {
    try {
        if (!logStream) openLogStream(false);
        // client-controlled text (session and application names) must not forge log entries: control characters are
        // dropped and continuation lines are indented
        const message = String(entry.message).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ").replace(/\n/g, "\n    ");
        const line = `${entry.time} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${message}\n`;
        logStream.write(line);
        logBytes += Buffer.byteLength(line);
        if (logBytes > LOG_MAX_BYTES) {
            // pending writes of the old stream still land in the renamed file
            logStream.end();
            openLogStream(true);
        }
    } catch (_) { /* logging must never break the app */ }
}

// Log entries go to the renderer in batches (at most every 250 ms) on the "log-batch" channel.
let logQueue = [];
let logFlushTimer = null;
function queueLog(entry) {
    logQueue.push(entry);
    if (logQueue.length > 5000) logQueue.splice(0, logQueue.length - 5000);
    if (!logFlushTimer) {
        logFlushTimer = setTimeout(() => {
            logFlushTimer = null;
            const batch = logQueue;
            logQueue = [];
            send("log-batch", batch);
        }, 250);
    }
}
function logApp(level, message) {
    const entry = { time: new Date().toISOString(), level, source: "app", message };
    writeLogLine(entry);
    queueLog(entry);
    if (HEADLESS && level === "error") process.stderr.write(`${message}\n`);
}

process.on("uncaughtException", (err) => logApp("error", `Unexpected error: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => logApp("error", `Unhandled promise rejection: ${err?.message || err}`));

// ------------------------------------------------------------------ headless mode
if (HEADLESS) {
    if (NO_DISPLAY && !cliArgs.includes("--headless")) {
        process.stdout.write("No graphical display found (DISPLAY / WAYLAND_DISPLAY not set) - running in headless mode. Use --help for options.\n");
    }
    app.whenReady().then(() => {
        hardenSession(session.defaultSession); // Chromium runs here too: no spell-check dictionary download
        if (process.platform === "darwin" && app.dock) app.dock.hide();
        return runHeadless(cliArgs.filter((a) => a !== "--headless"), {
            defaultDataDir: dataDir,
            write: (line) => process.stdout.write(line + "\n"),
            onExit: (code) => app.exit(code),
            allowUnknown: true // Electron / Chromium add switches of their own
        });
    }).catch((err) => {
        process.stderr.write(`ERROR: ${err.message}\n`);
        app.exit(1);
    });
    // no windows in headless mode: keep running until a signal arrives
    app.on("window-all-closed", () => {});
} else {
    startDesktop();
}

// ------------------------------------------------------------------ desktop mode
function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function readSettings() {
    // trustedScriptHashes: method-script sets the user wrote or approved on this computer (never stored in project files)
    const defaults = { welcomeDone: false, autoStartServer: false, windowBounds: null, maximized: false, trustedScriptHashes: [] };
    let text;
    try {
        text = fs.readFileSync(settingsFile, "utf8");
    } catch (_) {
        return defaults; // no settings yet
    }
    try {
        const saved = JSON.parse(text);
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("not an object");
        return { ...defaults, ...saved };
    } catch (err) {
        const kept = quarantine(settingsFile);
        logApp("warn", `Settings file is damaged (${err.message}) and was reset${kept ? `; the old file was kept as ${kept}` : ""}`);
        return defaults;
    }
}

function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    writeFileAtomic(settingsFile, JSON.stringify(next, null, 2));
    return next;
}
// Settings as the renderer sees them (the trust list is only changed through trustScripts)
function publicSettings(settings = readSettings()) {
    const { trustedScriptHashes, ...rest } = settings;
    return rest;
}
const isTrustedScriptsHash = (hash) => !hash || (readSettings().trustedScriptHashes || []).includes(hash);
function trustScriptsHash(hash) {
    if (typeof hash !== "string" || !hash || hash.length > 256) throw new Error("Invalid script fingerprint");
    const list = (readSettings().trustedScriptHashes || []).filter((x) => x !== hash);
    list.push(hash);
    writeSettings({ trustedScriptHashes: list.slice(-500) });
    return true;
}

// Shell-ready command that starts this installation (shown in Help for headless use).
function launchCommand() {
    if (!app.isPackaged) return "npm run headless --";
    let cmd = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || null;
    if (!cmd && process.platform === "linux") {
        let exe = process.execPath;
        // the Linux launcher script (build/afterPack.js) runs the real binary as opcua-simulator.bin
        if (exe.endsWith(".bin") && fs.existsSync(exe.slice(0, -4))) exe = exe.slice(0, -4);
        cmd = exe;
        try {
            // the .deb links /usr/bin/opcua-simulator to the launcher (an extracted tar.gz under /opt does not)
            if (fs.realpathSync("/usr/bin/opcua-simulator") === fs.realpathSync(exe)) cmd = "opcua-simulator";
        } catch (_) { /* no link: show the full path */ }
    }
    cmd = cmd || process.execPath;
    return /\s/.test(cmd) ? `"${cmd}"` : cmd;
}

function startDesktop() {
    if (!app.requestSingleInstanceLock()) {
        // a second launch (or double-clicked project file) is forwarded to the running window
        app.quit();
        return;
    }
    // Hands a project file to the window; creates one when there is none (macOS keeps running without).
    // The OS gave the app this path (double click, command line), so the renderer may open and later save it.
    function openFileInWindow(file) {
        approvePath("project", file);
        if (mainWindow && !mainWindow.isDestroyed() && rendererReady) send("open-file", file);
        else pendingOpenFile = file; // picked up by getInitialData
        showWindow();
    }
    function showWindow() {
        if (!app.isReady()) return; // the window is created once the app is ready
        if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow();
            return;
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    app.on("second-instance", (_e, argv, workingDirectory) => {
        // relative paths are relative to the folder the second copy was started in
        const arg = projectFileArg(argv.slice(1), workingDirectory);
        if (arg?.file) openFileInWindow(arg.file);
        else {
            if (arg?.error) logApp("error", arg.error);
            showWindow();
        }
    });
    // macOS: project file double-clicked in Finder
    app.on("open-file", (e, file) => {
        e.preventDefault();
        openFileInWindow(path.resolve(file));
    });

    const serverEngine = new ServerEngine(dataDir);
    const clientEngine = new ClientEngine(dataDir);
    const onLog = (l) => { writeLogLine(l); queueLog(l); };
    serverEngine.on("log", onLog);
    serverEngine.on("status", (s) => send("server-status", s));
    clientEngine.on("log", onLog);
    clientEngine.on("status", (s) => send("client-status", s));
    clientEngine.on("dataChanges", (b) => send("client-data", b));
    clientEngine.on("event", (e) => send("client-event", e));
    clientEngine.on("keepalive", (k) => send("client-keepalive", k));

    // Methods the renderer may call on each engine.
    const SERVER_METHODS = ["start", "stop", "getStatus", "getLiveValues", "setValue", "setPaused", "getHistory", "raiseEvent",
        "getAlarms", "alarmAction", "setServerState", "closeSession", "listCertificates", "certificateAction"];
    const CLIENT_METHODS = ["getEndpoints", "findServers", "connect", "disconnect", "browse", "readAttributes", "read", "write",
        "monitor", "unmonitor", "monitorEvents", "conditionRefresh", "conditionMethod", "getMethodInfo", "callMethod",
        "historyRead", "setPublishingInterval", "lastRejectedServerCertificate", "trustServerCertificate"];

    // Only the simulator's own page may use the IPC channels (not a frame or page it might ever navigate to).
    const normalizeUrl = (url) => {
        const u = new URL(url);
        u.hash = "";
        u.search = "";
        return process.platform === "win32" ? u.href.toLowerCase() : u.href;
    };
    const RENDERER_PAGE = normalizeUrl(pathToFileURL(path.join(__dirname, "..", "renderer", "index.html")).href);
    const fromAppPage = (event) => {
        try { return normalizeUrl(event?.senderFrame?.url || "") === RENDERER_PAGE; } catch (_) { return false; }
    };
    const wrap = (fn) => async (event, ...args) => {
        if (!fromAppPage(event)) return { ok: false, error: "Request refused: it did not come from the simulator window" };
        try {
            return { ok: true, result: await fn(...args) };
        } catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
    };

    // Method scripts run only when the user wrote them or trusted exactly this set of scripts on this computer.
    let runScriptsDisabled = false; // the running server was started with method scripts disabled
    async function startServer(project, options = {}) {
        if (!project || typeof project !== "object") throw new Error("No project to start");
        const allowScripts = options?.allowScripts !== false;
        if (allowScripts && !isTrustedScriptsHash(projectScriptsHash(project))) {
            throw new Error("[scripts-not-trusted] This project contains method scripts that have not been trusted on this computer.");
        }
        // set before the start (the renderer asks as soon as the server reports "running"); a start that joins one in
        // progress, or finds the server running, keeps the flag of that run
        if (!serverEngine.server && !serverEngine.starting) {
            runScriptsDisabled = !allowScripts && projectScriptSummary(project).length > 0;
            if (runScriptsDisabled) logApp("warn", "Starting the server with method scripts disabled (project not trusted)");
        }
        return serverEngine.start(project, { allowScripts });
    }

    ipcMain.handle("server", wrap((method, args) => {
        if (!SERVER_METHODS.includes(method)) throw new Error(`Unknown server method ${method}`);
        args = Array.isArray(args) ? args : [];
        if (method === "start") return startServer(args[0], args[1]);
        if (method === "certificateAction") {
            const [store, action, file] = args;
            if (store !== "server" && store !== "user") throw new Error(`Unknown certificate store ${store}`);
            checkCertificatePath(store, action, file);
        }
        return serverEngine[method](...args);
    }));
    ipcMain.handle("client", wrap((method, args) => {
        if (!CLIENT_METHODS.includes(method)) throw new Error(`Unknown client method ${method}`);
        args = Array.isArray(args) ? args : [];
        if (method === "connect") {
            // user certificate and key: only files picked in the file dialog
            const opts = args[0] || {};
            for (const key of ["certFile", "keyFile"]) {
                if (opts[key] && !isApproved("read", opts[key])) throw new Error("Choose the user certificate and private key with the file buttons.");
            }
        }
        if (method === "trustServerCertificate") {
            // only the certificate of the connection that was just refused, which the user saw in the dialog
            const last = typeof clientEngine.lastRejectedServerCertificate === "function" ? clientEngine.lastRejectedServerCertificate() : null;
            if (!last || !args[0] || last.der !== args[0]) throw new Error("This certificate was not offered by the last refused connection. Connect again, or trust it in Certificates → Client application PKI.");
        }
        return clientEngine[method](...args);
    }));

    // -> { project, path, dirty, source: "last" | "default", scriptsTrusted, openFile?, error? }
    // A project file given at launch is not applied here: the renderer opens it like File → Open, so the user sees
    // its security warnings first and unsaved work is never replaced silently.
    function loadStartupProject() {
        const file = pendingOpenFile;
        const fileError = startupFileError;
        pendingOpenFile = null;
        startupFileError = null;
        const last = loadLastProject();
        if (file) return { ...last, openFile: file };
        return fileError ? { ...last, error: [fileError, last.error].filter(Boolean).join(" ") } : last;
    }

    // The autosaved session: { path, project, dirty, trustedScriptsHash? } in last-project.json.
    function loadLastProject() {
        // the built-in templates are part of the app: their scripts are trusted
        const fallback = (error) => ({ project: fromTemplate("demo"), path: null, dirty: false, source: "default", scriptsTrusted: true, error });
        let text;
        try {
            text = fs.readFileSync(lastProjectFile, "utf8");
        } catch (err) {
            return fallback(err.code === "ENOENT" ? undefined : `The last session could not be read (${err.message}).`);
        }
        try {
            const saved = JSON.parse(text);
            const project = normalizeProject(saved.project);
            const file = typeof saved.path === "string" && saved.path && hasProjectExtension(saved.path) ? saved.path : null;
            // the session file is written by the app itself: its project path may be saved to again
            approvePath("project", file);
            const hash = projectScriptsHash(project);
            return {
                project,
                path: file,
                dirty: !!saved.dirty,
                source: "last",
                // trusted list, or scripts the user was editing (trusted) when the app closed
                scriptsTrusted: isTrustedScriptsHash(hash) || (!!saved.trustedScriptsHash && saved.trustedScriptsHash === hash)
            };
        } catch (err) {
            // never silently replace the user's work with the demo
            const kept = quarantine(lastProjectFile);
            return fallback(`The last session could not be restored (${err.message}).${kept ? ` The damaged file was kept as ${kept}.` : ""}`);
        }
    }

    const appApi = {
        getInitialData() {
            const startup = loadStartupProject();
            rendererReady = true;
            return {
                project: startup.project,
                projectError: startup.error || null,
                projectPath: startup.path,
                projectSource: startup.source,
                dirty: startup.dirty,
                scriptsTrusted: !!startup.scriptsTrusted,
                openFile: startup.openFile || null,
                launchCommand: launchCommand(),
                isPackaged: app.isPackaged,
                dataDir,
                logDir,
                version: app.getVersion(),
                settings: publicSettings(),
                startRequested: cliArgs.includes("--start"),
                network: networkInfo(),
                dataTypes: SUPPORTED_DATA_TYPES,
                statusCodes: COMMON_STATUS_CODES,
                roles: ROLE_NAMES,
                eventTypes: EVENT_TYPES,
                nodesets: Object.keys(nodesets).filter((k) => k !== "standard"),
                nodesetDependencies: NODESET_DEPENDENCIES,
                securityPolicies: ["None", "Basic128Rsa15", "Basic256", "Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss"],
                securityModes: ["None", "Sign", "SignAndEncrypt"],
                securePreset: SECURE_PRESET,
                demoUsers: DEFAULT_USERS.map((u) => ({ username: u.username, password: u.password })), // public demo log-ins
                platform: process.platform,
                darkMode: nativeTheme.shouldUseDarkColors
            };
        },
        getSettings: () => publicSettings(),
        setSettings(patch) {
            const { trustedScriptHashes, ...rest } = patch && typeof patch === "object" ? patch : {};
            return publicSettings(writeSettings(rest));
        },
        networkInfo: () => networkInfo(),
        // `exclude`: ports the suggestion must skip (e.g. the discovery server port)
        async checkPort(port, exclude = []) {
            const r = await checkPort(port);
            if (r.free) return { free: true };
            return { free: false, message: portProblemMessage(port, r.reason), suggestedPort: await findFreePort(Number(port) + 1, exclude) };
        },
        // The renderer owns the project path; main stores it only when it came from a dialog or the OS.
        // scriptsTrusted: the user wrote / approved the current scripts, so a restored session does not ask again.
        autosave(project, filePath, dirty, scriptsTrusted) {
            const file = filePath && isApproved("project", filePath) ? filePath : null;
            const hash = scriptsTrusted ? projectScriptsHash(project) : "";
            writeFileAtomic(lastProjectFile, JSON.stringify({ path: file, project, dirty: !!dirty, ...(hash ? { trustedScriptsHash: hash } : {}) }));
            return true;
        },
        newFromTemplate: (name, options) => fromTemplate(name, options),
        defaultServerSettings: () => fromTemplate("demo").server,
        // ---- method script trust (settings.json, never the project file)
        scriptTrust(project) {
            const hash = projectScriptsHash(project);
            return { hash, trusted: isTrustedScriptsHash(hash), scripts: projectScriptSummary(project) };
        },
        trustScripts: (hash) => trustScriptsHash(hash),
        // scripts of a template, or written / edited by the user in the designer
        trustProjectScripts(project) {
            const hash = projectScriptsHash(project);
            if (hash && !isTrustedScriptsHash(hash)) trustScriptsHash(hash);
            return hash;
        },
        // warnings for the configuration the server is running with
        runningSecurity() {
            if (serverEngine.state !== "running" || !serverEngine.project) return { warnings: [], scriptsDisabled: false, listenAddress: null };
            return {
                warnings: projectWarnings(serverEngine.project),
                scriptsDisabled: runScriptsDisabled,
                listenAddress: serverEngine.project.server?.listenAddress === "localhost" ? "localhost" : "all"
            };
        },
        async saveProject(project, saveAs, filePath) {
            if (!project || typeof project !== "object") throw new Error("No project to save");
            const known = filePath && isApproved("project", filePath) && hasProjectExtension(filePath);
            let file = !saveAs && known ? filePath : null;
            if (!file) {
                const name = `${(project.name || "project").replace(/[\\/:*?"<>|]/g, "_")}.opcuasim`;
                const res = await dialog.showSaveDialog(mainWindow, {
                    title: "Save Simulator Project",
                    defaultPath: known ? path.join(path.dirname(filePath), name) : name,
                    filters: [{ name: "OPC UA Simulator Project", extensions: ["opcuasim", "json"] }]
                });
                if (res.canceled || !res.filePath) return null;
                file = approvePath("project", res.filePath);
            }
            // new files are readable by the current user only (they hold the server's user passwords)
            fs.writeFileSync(file, JSON.stringify(project, null, 2), { mode: 0o600 });
            try { appApi.autosave(project, file, false, isTrustedScriptsHash(projectScriptsHash(project))); } catch (_) { /* the project file itself was saved */ }
            return file;
        },
        async openProject() {
            const res = await dialog.showOpenDialog(mainWindow, {
                title: "Open Simulator Project",
                filters: [{ name: "OPC UA Simulator Project", extensions: ["opcuasim", "json"] }],
                properties: ["openFile"]
            });
            if (res.canceled || !res.filePaths[0]) return null;
            return appApi.openProjectFile(approvePath("project", res.filePaths[0]));
        },
        // no side effects: the project only becomes current when the renderer applies it
        // -> { project, path, scriptsTrusted, scriptCount, warnings }
        openProjectFile(file) {
            if (!isApproved("project", file)) throw new Error("Open project files with File → Open Project….");
            if (!hasProjectExtension(file)) throw new Error(`Not a simulator project file (.${PROJECT_EXTENSIONS.join(" / .")}): ${file}`);
            const project = readProjectFile(file);
            return {
                project,
                path: file,
                scriptsTrusted: isTrustedScriptsHash(projectScriptsHash(project)),
                scriptCount: projectScriptSummary(project).length,
                warnings: projectWarnings(project, { opening: true })
            };
        },
        async pickFile(title, filters) {
            const res = await dialog.showOpenDialog(mainWindow, { title, filters: filters || [], properties: ["openFile"] });
            return res.canceled ? null : approvePath("read", res.filePaths[0]);
        },
        async exportNodeset() {
            const ns = serverEngine.namespace;
            if (!ns || serverEngine.state !== "running") throw new Error("Start the server to export its address space");
            const res = await dialog.showSaveDialog(mainWindow, {
                title: "Export NodeSet2 XML",
                defaultPath: "simulator.NodeSet2.xml",
                filters: [{ name: "NodeSet2 XML", extensions: ["xml"] }]
            });
            if (res.canceled || !res.filePath) return null;
            fs.writeFileSync(res.filePath, ns.toNodeset2XML());
            return approvePath("created", res.filePath);
        },
        async saveText(defaultName, text) {
            // only a file name is suggested; the user picks the folder
            const res = await dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(String(defaultName || "export.txt")) });
            if (res.canceled || !res.filePath) return null;
            fs.writeFileSync(res.filePath, String(text ?? ""));
            return approvePath("created", res.filePath);
        },
        // only the simulator's own folders: "logs", "data", "pki-server", "pki-user", "pki-client"
        openFolder(target) {
            const folders = { logs: logDir, data: dataDir, "pki-server": pkiDir("server"), "pki-user": pkiDir("user"), "pki-client": pkiDir("client") };
            const wanted = resolvePath(target);
            const folder = folders[target] || Object.values(folders).find((f) => path.resolve(f) === wanted);
            if (!folder) throw new Error("Only the simulator's own folders can be opened here");
            fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
            return shell.openPath(folder);
        },
        showItem(file) {
            const known = ["project", "read", "created"].some((kind) => isApproved(kind, file));
            if (!known && !isInside(dataDir, file)) throw new Error("Only files of the simulator or files you chose can be shown");
            shell.showItemInFolder(path.resolve(file));
            return true;
        },
        openExternal(url) {
            if (!/^https:\/\//.test(url)) throw new Error("Only https links can be opened");
            return shell.openExternal(url);
        },
        // Copy buttons (the web clipboard API would need a clipboard permission)
        async copyText(text) {
            await clipboard.writeText(String(text ?? "").slice(0, 1024 * 1024));
            return true;
        },
        async clientCertificates() {
            return listCertificates(await clientEngine.certificateManager());
        },
        async clientCertificateAction(action, file) {
            checkCertificatePath("client", action, file);
            await certificateAction(await clientEngine.certificateManager(), action, file);
            return true;
        }
    };

    ipcMain.handle("app", wrap((method, args) => {
        if (!Object.prototype.hasOwnProperty.call(appApi, method) || typeof appApi[method] !== "function") throw new Error(`Unknown app method ${method}`);
        return appApi[method](...(Array.isArray(args) ? args : []));
    }));

    function buildMenu() {
        const isMac = process.platform === "darwin";
        const cmd = (command) => () => send("menu", command);
        const template = [
            ...(isMac ? [{ role: "appMenu" }] : []),
            {
                label: "File",
                submenu: [
                    { label: "New Project…", accelerator: "CmdOrCtrl+N", click: cmd("new") },
                    { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: cmd("open") },
                    { type: "separator" },
                    { label: "Save Project", accelerator: "CmdOrCtrl+S", click: cmd("save") },
                    { label: "Save Project As…", accelerator: "CmdOrCtrl+Shift+S", click: cmd("saveAs") },
                    { type: "separator" },
                    { label: "Export Address Space (NodeSet2 XML)…", click: cmd("exportNodeset") },
                    { type: "separator" },
                    isMac ? { role: "close" } : { role: "quit" }
                ]
            },
            { role: "editMenu" },
            {
                label: "Server",
                submenu: [
                    { label: "Start Server", accelerator: "CmdOrCtrl+R", click: cmd("startServer") },
                    { label: "Stop Server", accelerator: "CmdOrCtrl+.", click: cmd("stopServer") },
                    { label: "Restart Server", accelerator: "CmdOrCtrl+Shift+R", click: cmd("restartServer") }
                ]
            },
            {
                label: "View",
                submenu: [
                    // installed builds: developer tools only with OPCUA_SIM_DEVTOOLS=1 (troubleshooting)
                    { role: "reload", accelerator: "CmdOrCtrl+Alt+R" }, ...(DEVTOOLS ? [{ role: "toggleDevTools" }] : []), { type: "separator" },
                    { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }
                ]
            },
            { role: "windowMenu" },
            {
                role: "help",
                submenu: [
                    { label: "Quick Start Guide", accelerator: "F1", click: cmd("help") },
                    { label: "Show Welcome Screen", click: cmd("welcome") },
                    { type: "separator" },
                    { label: "Open Log Folder", click: () => { fs.mkdirSync(logDir, { recursive: true, mode: 0o700 }); shell.openPath(logDir); } },
                    { label: "Open Data Folder", click: () => shell.openPath(dataDir) },
                    { type: "separator" },
                    { label: "OPC UA Specification (reference.opcfoundation.org)", click: () => shell.openExternal("https://reference.opcfoundation.org/") }
                ]
            }
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    // -> { bounds, area }: saved bounds clamped to the work area of their display (or a default size),
    // and the work area the window opens on.
    function windowBounds() {
        const b = readSettings().windowBounds;
        const valid = b && ["x", "y", "width", "height"].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;
        // only restore bounds that are still visible on a connected display
        if (valid && screen.getAllDisplays().some((d) => {
            const a = d.workArea;
            return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 20 && b.y < a.y + a.height - 100;
        })) {
            const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
            const area = screen.getDisplayMatching(r).workArea;
            const width = Math.min(r.width, area.width);
            const height = Math.min(r.height, area.height);
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
            return {
                area,
                bounds: { x: clamp(r.x, area.x, area.x + area.width - width), y: clamp(r.y, area.y, area.y + area.height - height), width, height }
            };
        }
        const area = screen.getPrimaryDisplay().workArea;
        return { area, bounds: { width: Math.min(1440, area.width), height: Math.min(920, area.height) } };
    }

    function createWindow() {
        const { bounds, area } = windowBounds();
        // small VM consoles (800x600, RDP at a low resolution): never larger than the screen
        const smallScreen = area.width < 1000 || area.height < 640;
        rendererReady = false;
        mainWindow = new BrowserWindow({
            ...bounds,
            minWidth: Math.min(1000, area.width),
            minHeight: Math.min(640, area.height),
            title: "OPC UA Simulator",
            show: false,
            backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b1017" : "#f4f6f9",
            webPreferences: {
                preload: path.join(__dirname, "preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                webviewTag: false,
                spellcheck: false, // no dictionary download (see the top of this file)
                devTools: DEVTOOLS
            }
        });
        if (readSettings().maximized || smallScreen) mainWindow.maximize();
        mainWindow.once("ready-to-show", () => mainWindow.show());
        mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
        // external links open in the browser, never inside the app
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https:\/\//.test(url)) shell.openExternal(url);
            return { action: "deny" };
        });
        mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
        mainWindow.webContents.on("did-start-loading", () => { rendererReady = false; }); // reload
        const saveBounds = () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            const maximized = mainWindow.isMaximized();
            writeSettings(maximized ? { maximized } : { maximized, windowBounds: mainWindow.getBounds() });
        };
        mainWindow.on("close", saveBounds);
        mainWindow.on("closed", () => { mainWindow = null; rendererReady = false; });
    }

    app.whenReady().then(() => {
        hardenSession(session.defaultSession); // before the first window (also done on "session-created")
        buildMenu();
        if (!mainWindow) createWindow(); // an open-file / second-instance event may have created it already
        app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    });

    // Runs `step` and resolves when its promise settles or after `ms`, whichever comes first (errors are ignored).
    const settleWithin = (step, ms) => {
        let timer;
        return Promise.race([
            new Promise((resolve) => resolve(step())).catch(() => {}),
            new Promise((resolve) => { timer = setTimeout(resolve, ms); })
        ]).finally(() => clearTimeout(timer));
    };
    let quitting = false;
    app.on("before-quit", async (e) => {
        if (quitting) return;
        e.preventDefault();
        quitting = true;
        // never hang on quit (that would keep the port and the single-instance lock): hard exit as a last resort
        setTimeout(() => app.exit(0), 8000);
        await settleWithin(() => clientEngine.disconnect(true), 3000);
        await settleWithin(() => serverEngine.stop(0), 3000);
        if (logStream) logStream.end();
        app.quit();
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });
}
