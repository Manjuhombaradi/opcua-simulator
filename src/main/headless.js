"use strict";
// Runs the simulator server without a user interface (VMs without desktop, Docker, CI pipelines).
const os = require("os");
const path = require("path");
const fs = require("fs");
const { ServerEngine, parseAdvertisedUrls, SECURE_PRESET, securityWarnings, projectScriptSummary } = require("./serverEngine");
const { fromTemplate, readProjectFile, PROJECT_EXTENSIONS } = require("./project");
const { DEFAULT_USERS } = require("./defaultProject");
const { localIPv4Addresses } = require("./network");

const TEMPLATES = ["demo", "empty", "load-test"];
const MAX_TAGS = 50000;
// headless.log becomes headless.old.log at this size (one previous file is kept); OPCUA_LOG_MAX_BYTES lowers it for tests
const LOG_MAX_BYTES = Number(process.env.OPCUA_LOG_MAX_BYTES) > 0 ? Number(process.env.OPCUA_LOG_MAX_BYTES) : 5 * 1024 * 1024;

const HELP = `OPC UA Simulator - headless mode

Usage: node src/cli.js [options] [project.opcuasim]          (npm run headless -- [options])
       <installed app> --headless [options] [project.opcuasim]

Options (environment variable in brackets):
  --project <file>         Project file saved from the desktop app (.opcuasim / .json)    [OPCUA_PROJECT]
                           A single *.opcuasim / *.json argument works the same way
  --template <name>        demo | empty | load-test, used when no project is given        [OPCUA_TEMPLATE]
  --tags <n>               Tags in the load-test template (1-50000, default 1000)         [OPCUA_TAGS]
  --port <n>               TCP port 1-65535 (default: from project, 4840)                 [OPCUA_PORT]
  --hostname <name>        Host name / IP advertised in endpoint URLs                     [OPCUA_HOSTNAME]
  --alt-hostnames <list>   Extra comma separated host names / IPs for endpoint URLs       [OPCUA_ALT_HOSTNAMES]
  --advertised-url <urls>  Extra comma separated endpoint URLs for NAT / port mapping,    [OPCUA_ADVERTISED_URL]
                           e.g. opc.tcp://192.168.1.20:48552 for docker run -p 48552:4840
  --data-dir <dir>         Folder for certificates (PKI) and logs                         [OPCUA_DATA_DIR]
  --secure                 Apply the secure preset for organisations (no anonymous, only    [OPCUA_SECURE=1]
                           encrypted policies, no auto-accept, no discovery/LDS)
  --no-scripts             Do not run method scripts (refuse calls to methods that have one, [OPCUA_NO_SCRIPTS=1]
                           for projects whose scripts you do not trust)
  --listen <where>         all (default) | localhost (loopback only, advertises localhost)   [OPCUA_LISTEN]
  --no-security            Only offer SecurityPolicy None (quick tests); user name and    [OPCUA_NO_SECURITY=1]
                           certificate logins stay available
  --regenerate-cert        New self-signed server certificate with the current host names / IPs (one-off)
                           OPCUA_REGENERATE_CERT=1 instead renews it only when names / IPs changed
  --advertise-ips          Advertise this machine's IP addresses in endpoint URLs        [OPCUA_ADVERTISE_IPS]
  --no-advertise-ips       (default: on; off in containers, turn on for docker --network host)
  --verbose                Also log debug messages (secure channels, subscriptions)       [OPCUA_LOG_LEVEL=debug]
  --help, -h               Show this help

Yes/no variables accept 1/true/yes or 0/false/no. In a container (OPCUA_IN_CONTAINER=1 or /.dockerenv)
the container's own IP addresses are not advertised: set OPCUA_HOSTNAME to the Docker host's IP or name
and publish the same port (-p 4840:4840), or set OPCUA_ADVERTISED_URL when the published port differs
(with --network host set OPCUA_ADVERTISE_IPS=1 instead).
Logs: <data folder>/logs/headless.log (rotated at 5 MB). Exit codes: 0 stopped, 1 start failed, 2 invalid options.
`;

// option key -> [command line flag, environment variable]
const VALUE_OPTIONS = {
    project: ["--project", "OPCUA_PROJECT"],
    template: ["--template", "OPCUA_TEMPLATE"],
    tags: ["--tags", "OPCUA_TAGS"],
    port: ["--port", "OPCUA_PORT"],
    hostname: ["--hostname", "OPCUA_HOSTNAME"],
    altHostnames: ["--alt-hostnames", "OPCUA_ALT_HOSTNAMES"],
    advertisedUrls: ["--advertised-url", "OPCUA_ADVERTISED_URL"],
    dataDir: ["--data-dir", "OPCUA_DATA_DIR"],
    listen: ["--listen", "OPCUA_LISTEN"]
};
// repeating these flags adds to the list instead of replacing it
const LIST_OPTIONS = ["altHostnames", "advertisedUrls"];
const FLAG_OPTIONS = { "--no-security": "noSecurity", "--secure": "secure", "--no-scripts": "noScripts", "--regenerate-cert": "regenerateCertForce", "--verbose": "verbose", "--help": "help", "-h": "help" };
// accepted and ignored: the Linux launcher and Electron pass them through; --start (a desktop option)
// is what headless mode always does, so `opcua-simulator --start` also works on a machine without display
const NO_OP_FLAGS = ["--headless", "--no-sandbox", "--disable-gpu", "--start"];

function parseBool(value, name, errors) {
    const v = String(value === undefined ? "" : value).trim().toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["", "0", "false", "no"].includes(v)) return false;
    errors.push(`${name}="${value}" is not valid (use 1/true/yes or 0/false/no)`);
    return false;
}

/**
 * Command line and environment -> options. Problems are collected in `errors` (runHeadless exits with 2).
 * `allowUnknown` ignores unknown arguments (Chromium switches when started through Electron).
 */
function parseArgs(argv, env = process.env, { allowUnknown = false } = {}) {
    const errors = [];
    const raw = {}; // key -> { value, from }; the command line overrides the environment
    for (const [key, [, name]] of Object.entries(VALUE_OPTIONS)) {
        const v = env[name] === undefined ? "" : String(env[name]).trim();
        if (v) raw[key] = { value: v, from: name }; // empty variables (e.g. from docker compose) count as unset
    }
    const logLevel = String(env.OPCUA_LOG_LEVEL || "").trim().toLowerCase();
    if (logLevel && !["debug", "info"].includes(logLevel)) errors.push(`OPCUA_LOG_LEVEL="${env.OPCUA_LOG_LEVEL}" is not valid (use debug or info)`);
    const opts = {
        noSecurity: parseBool(env.OPCUA_NO_SECURITY, "OPCUA_NO_SECURITY", errors),
        secure: parseBool(env.OPCUA_SECURE, "OPCUA_SECURE", errors),
        noScripts: parseBool(env.OPCUA_NO_SCRIPTS, "OPCUA_NO_SCRIPTS", errors),
        // the variable is usually permanent (docker compose): renew only when host names / IPs changed
        regenerateCert: parseBool(env.OPCUA_REGENERATE_CERT, "OPCUA_REGENERATE_CERT", errors),
        regenerateCertForce: false,
        advertiseIps: env.OPCUA_ADVERTISE_IPS === undefined || String(env.OPCUA_ADVERTISE_IPS).trim() === ""
            ? undefined : parseBool(env.OPCUA_ADVERTISE_IPS, "OPCUA_ADVERTISE_IPS", errors),
        verbose: logLevel === "debug",
        // set by the Dockerfile; /.dockerenv covers other images
        inContainer: /^(1|true|yes)$/i.test(String(env.OPCUA_IN_CONTAINER || "").trim()) || fs.existsSync("/.dockerenv"),
        help: false,
        errors
    };

    const fromCommandLine = new Set();
    let positional = null;
    for (let i = 0; i < argv.length; i++) {
        const a = String(argv[i]);
        const eq = a.startsWith("--") ? a.indexOf("=") : -1;
        const flag = eq > 0 ? a.slice(0, eq) : a;
        const inline = eq > 0 ? a.slice(eq + 1) : undefined;
        const key = Object.keys(VALUE_OPTIONS).find((k) => VALUE_OPTIONS[k][0] === flag);
        if (key) {
            let value = inline;
            if (value === undefined) {
                // "--port --no-security" must not swallow the next option
                if (i + 1 >= argv.length || String(argv[i + 1]).startsWith("-")) {
                    errors.push(`${flag} needs a value`);
                    continue;
                }
                value = String(argv[++i]);
            }
            value = value.trim();
            if (!value) {
                errors.push(`${flag} needs a value`);
                continue;
            }
            if (LIST_OPTIONS.includes(key) && fromCommandLine.has(key)) raw[key].value += `,${value}`;
            else raw[key] = { value, from: flag };
            fromCommandLine.add(key);
            continue;
        }
        if (flag === "--advertise-ips" || flag === "--no-advertise-ips") {
            if (inline !== undefined) errors.push(`${flag} does not take a value`);
            else opts.advertiseIps = flag === "--advertise-ips";
            continue;
        }
        if (FLAG_OPTIONS[flag] || NO_OP_FLAGS.includes(flag)) {
            if (inline !== undefined) errors.push(`${flag} does not take a value`);
            else if (FLAG_OPTIONS[flag]) opts[FLAG_OPTIONS[flag]] = true;
            continue;
        }
        if (!a.startsWith("-") && PROJECT_EXTENSIONS.some((ext) => a.toLowerCase().endsWith(`.${ext}`))) {
            if (positional) errors.push(`Only one project file can be given ("${positional}" and "${a}")`);
            positional = a;
            continue;
        }
        if (allowUnknown) continue;
        errors.push(a.startsWith("-") ? `Unknown option ${a}` : `Unexpected argument "${a}" (a project file must end in .opcuasim or .json)`);
    }
    if (positional) {
        if (fromCommandLine.has("project")) errors.push("Give the project either with --project or as a file argument, not both");
        else raw.project = { value: positional, from: "project file" };
    }

    // ---- validation
    const label = (key) => (raw[key].from.startsWith("--") ? `${raw[key].from} "${raw[key].value}"` : `${raw[key].from}="${raw[key].value}"`);
    const integer = (key, min, max) => {
        const n = /^\d+$/.test(raw[key].value) ? Number(raw[key].value) : NaN;
        return n >= min && n <= max ? n : null;
    };
    let port = null;
    if (raw.port) {
        port = integer("port", 1, 65535);
        if (port === null) errors.push(`${label("port")} is not a valid TCP port (1-65535)`);
    }
    let tags = 1000;
    if (raw.tags) {
        tags = integer("tags", 1, MAX_TAGS);
        if (tags === null) errors.push(`${label("tags")} is not a valid number of tags (1-${MAX_TAGS})`);
    }
    if (raw.template && !TEMPLATES.includes(raw.template.value)) {
        errors.push(`${label("template")} is not a template (use ${TEMPLATES.join(", ")})`);
    }
    if (raw.listen && !["all", "localhost"].includes(raw.listen.value.toLowerCase())) {
        errors.push(`${label("listen")} is not valid (use all or localhost)`);
    }
    if (raw.project && !fs.existsSync(path.resolve(raw.project.value))) {
        errors.push(`Project file not found: ${path.resolve(raw.project.value)}`);
    }
    for (const key of ["hostname", "altHostnames"]) {
        if (!raw[key]) continue;
        const names = key === "hostname" ? [raw[key].value] : raw[key].value.split(/[,;\s]+/).filter(Boolean);
        for (const h of names) {
            if (/:\/\//.test(h)) errors.push(`${label(key)}: use a host name or IP address, not a URL (--advertised-url / OPCUA_ADVERTISED_URL takes full opc.tcp:// URLs)`);
            else if (/^[^:[\]]+:\d+$/.test(h)) errors.push(`${label(key)}: give the port with --port, or use --advertised-url / OPCUA_ADVERTISED_URL when the published port differs`);
            else if (/[\s/]/.test(h)) errors.push(`${label(key)} is not a valid host name`);
        }
    }
    if (raw.advertisedUrls) {
        for (const u of parseAdvertisedUrls(raw.advertisedUrls.value).invalid) {
            errors.push(`${raw.advertisedUrls.from}: "${u}" is not a valid endpoint URL (use opc.tcp://host:port[/path])`);
        }
    }

    const get = (key) => (raw[key] ? raw[key].value : null);
    return Object.assign(opts, {
        project: get("project"),
        template: get("template") || "demo",
        tags,
        port,
        hostname: get("hostname"),
        altHostnames: get("altHostnames"),
        advertisedUrls: get("advertisedUrls"),
        dataDir: get("dataDir"),
        listen: get("listen") ? get("listen").toLowerCase() : null
    });
}

function formatLog(l) {
    return `${l.time} ${l.level.toUpperCase().padEnd(5)} [${l.source}] ${l.message}`;
}

// Create a directory (recursively) private to this user (0o700), so logs, project copies and PKI are not
// world-readable on multi-user or Docker-group hosts (SS-14). Best effort on platforms without POSIX modes.
function secureMkdir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* e.g. Windows: modes are not enforced */ }
}

// Appends lines to <dir>/headless.log. Rotation is checked at start and while running: a container with
// "restart: unless-stopped" may run for months without a restart.
function openLogFile(dir) {
    secureMkdir(dir);
    const file = path.join(dir, "headless.log");
    const oldFile = path.join(dir, "headless.old.log");
    let stream = null;
    let size = 0;
    const open = () => {
        // opened synchronously, so a read-only data folder is reported before the server starts;
        // mode 0o600 keeps logs (user names, client IPs, written values) unreadable by other local users (SS-14)
        const fd = fs.openSync(file, "a", 0o600);
        try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on platforms without POSIX modes */ }
        size = fs.fstatSync(fd).size;
        stream = fs.createWriteStream(file, { fd });
        stream.on("error", () => { /* logging must never stop the server */ });
    };
    const rotate = () => {
        try {
            stream.end();
            stream = null;
            fs.renameSync(file, oldFile);
        } catch (_) { /* e.g. locked by another program: keep appending */ }
        try { open(); } catch (_) { stream = null; }
        if (size >= LOG_MAX_BYTES) size = 0; // rename failed: try again after another LOG_MAX_BYTES
    };
    if (fs.existsSync(file) && fs.statSync(file).size >= LOG_MAX_BYTES) {
        try { fs.renameSync(file, oldFile); } catch (_) { /* reported by open() when the folder is not writable */ }
    }
    open();
    return {
        write(line) {
            const data = `${line}\n`;
            const bytes = Buffer.byteLength(data);
            if (size > 0 && size + bytes > LOG_MAX_BYTES) rotate();
            if (!stream) return;
            stream.write(data);
            size += bytes;
        },
        end() {
            if (stream) stream.end();
            stream = null;
        }
    };
}

// Throws when files cannot be created in `dir` (e.g. a Docker volume owned by root, the image runs as non-root).
function checkWritable(dir) {
    secureMkdir(dir);
    const probe = path.join(dir, `.write-test-${process.pid}`);
    try {
        fs.writeFileSync(probe, "");
        fs.unlinkSync(probe);
    } catch (err) {
        err.path = dir; // report the folder, not the probe file
        throw err;
    }
}

function isPermissionError(err) {
    return ["EACCES", "EPERM", "EROFS"].includes(err.code) || /\b(EACCES|EPERM|EROFS)\b/.test(err.message || "");
}

function dataDirProblem(dataDir, err) {
    if (!isPermissionError(err)) return `Cannot use the data folder ${dataDir}: ${err.message}`;
    let who = "this user";
    try {
        who = typeof process.getuid === "function" ? `uid ${process.getuid()}` : `user ${os.userInfo().username}`;
    } catch (_) { /* keep the generic text */ }
    return [
        `The data folder ${dataDir} is not writable by ${who} (${err.code || "permission denied"}${err.path ? `: ${err.path}` : ""}).`,
        "  Mount a writable volume or choose another folder with --data-dir / OPCUA_DATA_DIR.",
        "  A Docker volume first used by a container running as root stays owned by root: remove the volume or chown it to this uid."
    ].join("\n");
}

// Adds the server's resource path to an advertised URL that has none (node-opcua does the same).
function withResourcePath(url, resourcePath) {
    const hasPath = /^opc\.tcp:\/\/[^/]+\/./i.test(url);
    return hasPath ? url : url.replace(/\/$/, "") + (resourcePath || "");
}

// Connect URLs, security and log-ins as the running server really offers them (not as configured).
function bannerLines(engine, project, opts) {
    const cfg = project.server;
    const lines = [""];
    const port = Number(cfg.port) || 4840;
    const resourcePath = cfg.resourcePath || "";
    const advertised = parseAdvertisedUrls(cfg.advertisedUrls, resourcePath).urls.map((u) => withResourcePath(u, resourcePath));
    // in a container the own name and bridge IP cannot be reached from other machines: show only URLs that can
    // (unless IP advertising was turned on explicitly, e.g. docker --network host)
    if (opts.inContainer && !cfg.advertiseIpAddresses) {
        const names = [cfg.hostname, ...String(cfg.alternateHostnames || "").split(/[,;\s]+/)].filter(Boolean);
        const urls = [...advertised, ...names.map((h) => `opc.tcp://${h}:${port}${resourcePath}`)];
        if (!cfg.hostname && !advertised.length) {
            lines.push(
                "WARNING: running in a container, but neither OPCUA_HOSTNAME nor OPCUA_ADVERTISED_URL is set.",
                "  The endpoint URLs the server advertises use the container's own name, which clients outside",
                "  the container cannot reach. Set OPCUA_HOSTNAME to the Docker host's IP or name and publish",
                `  the same port (-p ${port}:${port}), or set OPCUA_ADVERTISED_URL=opc.tcp://<docker-host>:<published-port>`,
                "  when the published port differs.",
                ""
            );
        }
        lines.push(`Server is running in a container (listening on port ${port}). Connect your OPC UA client to:`);
        for (const u of [...new Set(urls)]) lines.push(`   ${u}`);
        if (!urls.length) lines.push(`   opc.tcp://<docker-host>:<published-port>${resourcePath}`);
        else if (names.length && !advertised.length) lines.push(`   (publish the same port: -p ${port}:${port}; set OPCUA_ADVERTISED_URL when it differs)`);
        if (/^(localhost|127\.)/i.test(cfg.hostname || "")) lines.push("Note: localhost only works for clients on the Docker host itself.");
    } else {
        const urls = engine.getEndpointUrls();
        const local = `opc.tcp://localhost:${port}${resourcePath}`;
        lines.push("Server is running. Connect your OPC UA client to:");
        for (const u of urls) lines.push(`   ${u}`);
        if (!urls.includes(local)) lines.push(`   ${local}   (same machine)`);
        if (!localIPv4Addresses().length) lines.push("Note: no network address found; only local clients can connect.");
    }

    const endpoints = engine.getEndpoints().filter((e) => !e.restricted);
    const modesByPolicy = new Map();
    for (const e of endpoints) {
        if (!modesByPolicy.has(e.securityPolicy)) modesByPolicy.set(e.securityPolicy, new Set());
        modesByPolicy.get(e.securityPolicy).add(e.securityMode);
    }
    const security = [...modesByPolicy].map(([p, modes]) => (p === "None" ? "None" : `${p} (${[...modes].join(", ")})`));
    lines.push(`Security: ${security.join("; ") || "no usable endpoint (see the warning above)"}`);
    const tokens = new Set(endpoints.flatMap((e) => e.userTokens));
    const logins = [tokens.has("Anonymous") && "anonymous", tokens.has("UserName") && "user name + password", tokens.has("Certificate") && "X.509 user certificate"].filter(Boolean);
    if (logins.length) {
        lines.push(`Login: ${logins.join(", ")}`);
    } else if (endpoints.length) {
        lines.push("WARNING: no endpoint offers a user token type, so no client can open a session. Allow anonymous, user name or certificate login in the project.");
    }
    if (tokens.has("UserName")) {
        // only the well-known demo passwords are printed; other passwords stay out of the console / container log
        const users = (cfg.users || []).map((u) => {
            const demo = DEFAULT_USERS.some((d) => d.username === u.username && d.password === u.password);
            return `${demo ? `${u.username}/${u.password}` : `${u.username} (password from the project)`}${u.role ? ` [${u.role}]` : ""}`;
        });
        lines.push(users.length ? `Users: ${users.join(", ")}` : "Users: none defined in the project, so every user name login fails");
    }
    const warnings = securityWarnings(project).filter(Boolean);
    if (warnings.length) {
        lines.push("", "Security notes:");
        for (const w of warnings) lines.push(`  - ${w}`);
        lines.push(opts.secure ? "  See SECURITY.md for hardening guidance." : "  Run with --secure for the hardened preset, or see SECURITY.md.");
    }
    if (opts.noScripts && projectScriptSummary(project).length) {
        lines.push("Method scripts are disabled (--no-scripts): methods with a script return BadUserAccessDenied.");
    }
    lines.push("Press Ctrl+C to stop.", "");
    return lines;
}

/**
 * Starts the server and keeps running until SIGINT/SIGTERM.
 * `write` receives log lines; `defaultDataDir` is used when no --data-dir is given;
 * `allowUnknown` ignores unknown arguments (Electron passes Chromium switches).
 */
async function runHeadless(argv, { defaultDataDir, write = (line) => console.log(line), onExit = (code) => process.exit(code), allowUnknown = false } = {}) {
    const opts = parseArgs(argv, process.env, { allowUnknown });
    if (opts.help) {
        write(HELP);
        onExit(0);
        return null;
    }
    if (opts.errors.length) {
        for (const e of opts.errors) write(`ERROR: ${e}`);
        write("See --help for all options.");
        onExit(2);
        return null;
    }
    const dataDir = path.resolve(opts.dataDir || defaultDataDir || path.join(process.cwd(), "opcua-simulator-data"));
    let logFile;
    try {
        secureMkdir(dataDir); // the data folder itself is private to this user (SS-14)
        logFile = openLogFile(path.join(dataDir, "logs"));
        checkWritable(path.join(dataDir, "pki"));
    } catch (err) {
        if (logFile) logFile.end();
        write(`ERROR: ${dataDirProblem(dataDir, err)}`);
        onExit(1);
        return null;
    }
    const fail = (message) => {
        write(`ERROR: ${message}`);
        logFile.end();
        onExit(1);
        return null;
    };

    let project;
    try {
        project = opts.project ? readProjectFile(opts.project) : fromTemplate(opts.template, { count: opts.tags });
    } catch (err) {
        return fail(err.message);
    }
    const cfg = project.server;
    // --secure applies the hardened preset first, so an explicit --listen / --no-security after it still wins
    if (opts.secure) Object.assign(cfg, SECURE_PRESET);
    if (opts.port) cfg.port = opts.port;
    if (opts.hostname) cfg.hostname = opts.hostname;
    if (opts.altHostnames) cfg.alternateHostnames = [cfg.alternateHostnames, opts.altHostnames].filter(Boolean).join(",");
    if (opts.advertisedUrls) cfg.advertisedUrls = [cfg.advertisedUrls, opts.advertisedUrls].filter(Boolean).join(",");
    if (opts.listen) cfg.listenAddress = opts.listen;
    if (opts.noSecurity) {
        cfg.securityPolicies = ["None"];
        cfg.securityModes = ["None"];
    }
    // container bridge IPs (172.x) cannot be reached from other machines; --network host is the exception
    if (opts.advertiseIps !== undefined) cfg.advertiseIpAddresses = opts.advertiseIps;
    else if (opts.inContainer) cfg.advertiseIpAddresses = false;

    const engine = new ServerEngine(dataDir, { headless: true });
    engine.on("log", (l) => {
        if (l.level === "debug" && !opts.verbose) return;
        const line = formatLog(l);
        logFile.write(line);
        write(line);
    });

    write(`OPC UA Simulator (headless) - project "${project.name}" from ${opts.project || `template "${opts.template}"`}`);
    write(`Data folder: ${dataDir}`);
    if (opts.inContainer && !cfg.advertiseIpAddresses) write("Container mode: the container's own IP addresses are not advertised (OPCUA_ADVERTISE_IPS=1 for --network host).");
    let regenerate = opts.regenerateCertForce;
    if (!regenerate && opts.regenerateCert) {
        try {
            const { missing } = engine.certificateMissingHosts(cfg);
            if (missing.length) {
                write(`Server certificate does not cover ${missing.join(", ")} - creating a new one (OPCUA_REGENERATE_CERT).`);
                regenerate = true;
            }
        } catch (_) { /* unreadable certificate: node-opcua reports it on start */ }
    }
    if (regenerate) {
        try {
            await engine.certificateAction("server", "regenerateOwn");
        } catch (err) {
            return fail(`Cannot regenerate the server certificate: ${err.message}`);
        }
    }
    try {
        await engine.start(project, { allowScripts: !opts.noScripts });
    } catch (err) {
        write(`ERROR: ${err.message.replace(/ \[suggested-port:\d+\]$/, "")}`);
        if (err.suggestedPort) write(`Hint: start with --port ${err.suggestedPort}`);
        if (isPermissionError(err) && String(err.path || err.message).includes(dataDir)) write(`Hint: ${dataDirProblem(dataDir, err)}`);
        logFile.end();
        onExit(1);
        return null;
    }
    for (const line of bannerLines(engine, project, opts)) write(line);

    // optional liveness file for container health checks (touched while the server runs)
    let healthTimer = null;
    if (process.env.OPCUA_HEALTH_FILE) {
        const touch = () => { if (engine.state === "running") fs.writeFile(process.env.OPCUA_HEALTH_FILE, new Date().toISOString(), () => {}); };
        touch();
        healthTimer = setInterval(touch, 10000);
    }

    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        write(`Received ${signal}, stopping server...`);
        clearInterval(healthTimer);
        try { await engine.stop(0); } catch (_) { /* ignore */ }
        logFile.end();
        onExit(0);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    return engine;
}

module.exports = { runHeadless, parseArgs, HELP, LOG_MAX_BYTES };
