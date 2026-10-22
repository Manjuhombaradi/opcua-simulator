"use strict";
// Runs the simulated OPC UA server: builds the address space from a project, drives simulations,
// exposes alarms, events, history, sessions and certificate management to the UI.
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const {
    OPCUAServer,
    OPCUADiscoveryServer,
    OPCUACertificateManager,
    SecurityPolicy,
    MessageSecurityMode,
    UserTokenType,
    RegisterServerMethod,
    DataType,
    DataValue,
    Variant,
    LocalizedText,
    StatusCodes,
    ServerState,
    makeRoles,
    AnonymousIdentityToken,
    makeAccessLevelFlag,
    makeEUInformation,
    resolveNodeId,
    EventNotifierFlags,
    HistoryReadResult,
    ReadAtTimeDetails,
    nodesets
} = require("node-opcua");
const V = require("./valueUtils");
const { HistoryStore, historySize, MAX_HISTORY_SIZE } = require("./historyStore");
const H = require("./historyAccess");
const { listCertificates, certificateAction } = require("./pki");
const { checkPort, findFreePort, portProblemMessage, localIPv4Addresses, startLoopbackRelay } = require("./network");
const { loadQuickJS, isQuickJSUsable, runMethodScriptIsolated } = require("./methodScript");

// Known dependencies between companion specifications bundled with node-opcua.
const NODESET_DEPENDENCIES = {
    machinery: ["di"], ia: ["di"], machineTool: ["di", "machinery", "ia"], robotics: ["di"], adi: ["di"],
    autoId: ["di"], commercialKitchenEquipment: ["di"], packML: [], padim: ["di", "irdi"], iolink: ["di"],
    iolinkIODD: ["di", "iolink"], machineryJobs: ["di", "machinery"], machineryResult: ["di", "machinery"],
    machineryProcessValues: ["di", "machinery", "padim", "irdi"], isa95JobControl: ["di"],
    woodWorking: ["di", "machinery"], glass: ["di", "machinery"], metalForming: ["di", "machinery"],
    scales: ["di", "machinery"], lads: ["di", "machinery", "amb"], amb: ["di"],
    tightening: ["di", "machinery", "ijtBase", "amb"], ijtBase: ["di", "machinery", "amb"],
    cnc: [], gds: [], machineVision: [], weihenstephan: ["di"], i4aas: [], irdi: [],
    surfaceTechnologyGeneralTypes: ["di", "machinery"], surfaceTechnologyOctMss: ["di", "machinery", "surfaceTechnologyGeneralTypes"],
    fxData: ["di"], fxAc: ["di", "fxData"], fxCm: ["di", "fxData", "fxAc"]
};

const ROLE_NAMES = ["Anonymous", "AuthenticatedUser", "Observer", "Operator", "Engineer", "Supervisor", "ConfigureAdmin", "SecurityAdmin"];
const EVENT_TYPES = ["BaseEventType", "SystemEventType", "DeviceFailureEventType", "SystemStatusChangeEventType", "ProgressEventType", "AuditEventType", "TransitionEventType"];

// Well-known OPC UA Role NodeIds (namespace 0). Used to express per-role permissions on the simulated
// address space; naming them by NodeId avoids depending on nodeset load order.
const ROLE_NODEIDS = {
    Anonymous: "ns=0;i=15644", AuthenticatedUser: "ns=0;i=15656", Observer: "ns=0;i=15668",
    Operator: "ns=0;i=15680", Engineer: "ns=0;i=16036", Supervisor: "ns=0;i=15692",
    ConfigureAdmin: "ns=0;i=15716", SecurityAdmin: "ns=0;i=15704"
};
// PermissionType flags (node-opcua-types PermissionType).
const PERM = { Browse: 1, Read: 32, Write: 64, ReadHistory: 128, ReceiveEvents: 2048, Call: 4096 };
const PERM_READ = PERM.Browse | PERM.Read | PERM.ReadHistory | PERM.ReceiveEvents; // browse + read values/history + events
const PERM_WRITE = PERM_READ | PERM.Write | PERM.Call; // the above plus write values and call methods
const WRITE_ROLES = ["Operator", "Engineer", "Supervisor", "ConfigureAdmin", "SecurityAdmin"];

// The "Secure (for organisations)" preset: no anonymous access, only strong encrypted policies, no
// auto-accept of certificates, no discovery/LDS egress. Applied by the welcome wizard, the Configuration
// screen's preset button, and the headless --secure flag. The demo template keeps its convenient defaults.
const SECURE_PRESET = {
    securityPolicies: ["Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss"],
    securityModes: ["Sign", "SignAndEncrypt"],
    allowAnonymous: false,
    anonymousAccess: "readonly",
    autoAcceptCertificates: false,
    registerToLds: false,
    runDiscoveryServer: false
};

// sha256 over every method script in the project, in tree order ("" when there are none). Used by the app
// and headless runner to decide whether a project's scripts are trusted before the server will execute them.
function projectScriptSummary(project) {
    const out = [];
    const walk = (nodes, prefix) => {
        for (const node of nodes || []) {
            const p = prefix ? `${prefix}/${node.name}` : node.name;
            if (node.kind === "method" && node.method && typeof node.method.script === "string" && node.method.script.trim()) {
                out.push({ path: p, script: node.method.script });
            }
            if (node.children) walk(node.children, p);
        }
    };
    walk(project && project.nodes, "");
    return out;
}

function projectScriptsHash(project) {
    const scripts = projectScriptSummary(project);
    if (!scripts.length) return "";
    const h = crypto.createHash("sha256");
    for (const s of scripts) h.update(s.path).update("\0").update(s.script).update("\0");
    return h.digest("hex");
}

// Plain-language warnings about the current project's security-relevant settings, shown in the dashboard,
// the open/import dialog and the headless banner so the risks of a configuration are never hidden.
function securityWarnings(project) {
    const cfg = (project && project.server) || {};
    const warnings = [];
    const modes = cfg.securityModes || [];
    const policies = cfg.securityPolicies || [];
    const hasNone = policies.includes("None") || modes.includes("None");
    const anonWrite = cfg.allowAnonymous && (cfg.anonymousAccess || "readwrite") !== "readonly";
    if (anonWrite) {
        warnings.push(cfg.listenAddress === "localhost"
            ? "Anonymous clients on this computer can write values and call methods."
            : "Anonymous clients on the network can write values and call methods without a password.");
    } else if (cfg.allowAnonymous) {
        warnings.push("Anonymous clients can read values (read-only).");
    }
    if (hasNone) warnings.push("An unencrypted \"None\" endpoint is offered: traffic can be read and tampered with in transit.");
    if (cfg.autoAcceptCertificates) warnings.push("Unknown client application certificates are accepted automatically (auto-accept is on).");
    if ((cfg.listenAddress || "all") !== "localhost") warnings.push("The server listens on all network interfaces, so any host that can reach the port can connect.");
    const { DEFAULT_USERS } = require("./defaultProject");
    if (cfg.allowUsername) {
        const demo = (cfg.users || []).filter((u) => DEFAULT_USERS.some((d) => d.username === u.username && d.password === u.password));
        if (demo.length) warnings.push(`Demo passwords are in use (${demo.map((u) => `${u.username}/${u.password}`).join(", ")}); change them before exposing the server.`);
    }
    if (cfg.runDiscoveryServer) warnings.push("A Local Discovery Server is enabled; it listens for registrations from the network.");
    if (cfg.registerToLds) warnings.push(`The server registers itself with a Local Discovery Server (${cfg.ldsUrl || "ldsUrl not set"}), an outbound connection.`);
    const scripts = projectScriptSummary(project);
    if (scripts.length) warnings.push(`The project contains ${scripts.length} method script${scripts.length === 1 ? "" : "s"}; scripts run sandboxed but only projects you trust should be started.`);
    return warnings;
}

// "opc.tcp://host:port[/path], ..." -> { urls, invalid }. Used for node-opcua's advertisedEndpoints
// (extra endpoint URLs for NAT / Docker port mapping: the server still listens on its own port).
// Spellings of the same endpoint (host case, trailing slash, missing default path or port) are merged,
// the way node-opcua compares them: duplicates would make the server fail with "endpoint already exist".
function parseAdvertisedUrls(text, resourcePath = "") {
    const urls = [];
    const invalid = [];
    const seen = new Set();
    for (const u of String(text || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) {
        try {
            if (!/^opc\.tcp:\/\//i.test(u)) throw new Error("not an opc.tcp URL");
            const parsed = new URL(u.replace(/^opc\.tcp:\/\//i, "http://"));
            if (!parsed.hostname || parsed.port === "0" || parsed.username || parsed.search || parsed.hash) throw new Error("invalid");
            const urlPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
            const key = `${parsed.hostname.toLowerCase()}:${parsed.port || 4840}${urlPath || resourcePath || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            urls.push(u);
        } catch (_) {
            invalid.push(u);
        }
    }
    return { urls, invalid };
}

// Replace control characters (including CR/LF) with visible escapes and cap the length, so a client-supplied
// string in a log line cannot forge extra log entries (SS-14).
function sanitizeLogText(message) {
    let text = typeof message === "string" ? message : String(message == null ? "" : message);
    if (text.length > 4000) text = text.slice(0, 3997) + "...";
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (c === "\t" ? " " : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`));
}

// Host name or IP of an opc.tcp URL (without the brackets of an IPv6 literal).
function urlHost(url) {
    return new URL(url.replace(/^opc\.tcp:\/\//i, "http://")).hostname.replace(/^\[(.*)\]$/, "$1");
}

function hasSimulation(v) {
    return !!(v && v.simulation && v.simulation.type && v.simulation.type !== "none");
}

// SQLite reports a damaged database file (SQLITE_CORRUPT 11, SQLITE_NOTADB 26): it cannot be repaired, only replaced
function isDamagedDatabase(err) {
    if (!err) return false;
    if (typeof err.errcode === "number" && [11, 26].includes(err.errcode & 0xff)) return true;
    return /malformed|not a database|corrupt/i.test(typeof err === "string" ? err : err.message || "");
}

// node:sqlite is missing (Node.js older than 22.13 without the built-in module)
function isSqliteMissing(err) {
    return !!err && (err.code === "ERR_UNKNOWN_BUILTIN_MODULE" || /node:sqlite/.test(err.message || ""));
}

// Part 11 "collection stopped": a value with status BadDataLost (no value) stored when the server stops, or when it
// starts after a run that ended without one (killed, crashed). Values at times inside such a gap are then not
// interpolated as Good data from the values on both sides of it.
const HISTORY_GAP_STATUS = StatusCodes.BadDataLost;
function historyGapMarker(date) {
    return new DataValue({ value: new Variant(), statusCode: HISTORY_GAP_STATUS, sourceTimestamp: date, serverTimestamp: date });
}
function isHistoryGapMarker(row) {
    return !!row && ((row.status & 0xffff0000) >>> 0) === HISTORY_GAP_STATUS.value;
}

// Servers sharing one data folder (two desktop apps, the app and a container on the same volume): every running
// server keeps a row "instance:<run id>" = { pid, host, ns, ts, stored[, stopped] } in the meta table of history.db,
// updated every HISTORY_HEARTBEAT_MS (ts: when it was written; stored: everything this run recorded before that time
// is in the database, the queue is written right before the row). A row updated less than HISTORY_LIVE_MS ago (and not marked stopped) is a
// running server: no "collection stopped" markers are written then, they would land in that server's series.
// The row of a run that was killed stays behind: its last update tells until when that run was alive. A row that
// looks running is checked: on this machine by its process id; otherwise (another container or machine) by a second
// look at start, since a server killed and started again within HISTORY_LIVE_MS must not see itself as running.
const HISTORY_HEARTBEAT_MS = 1000;
const HISTORY_LIVE_MS = 5000;
const HISTORY_INSTANCE_ROW_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // left-over rows of other address spaces are removed after this
const MAX_RAW_VALUES_PER_CALL = H.MAX_RAW_VALUES_PER_CALL || 10000;
// History continuation points per session: advertised (ServerCapabilities MaxHistoryContinuationPoints) and enforced
// (raw values, values at times, events) by the same number.
const MAX_HISTORY_CONTINUATION_POINTS = 50;

// A history capacity given by the user (desktop setting, IPC): a whole number 0 .. MAX_HISTORY_SIZE, else an error
function checkHistorySize(value, what) {
    const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_HISTORY_SIZE) {
        const shown = typeof value === "string" ? `"${value}"` : String(value);
        throw new Error(`${what} must be a whole number from 0 (off) to ${MAX_HISTORY_SIZE} (got ${shown})`);
    }
    return historySize(n);
}

class ServerEngine extends EventEmitter {
    // options.headless: no desktop UI, so hints point to command line options instead of menus
    constructor(dataDir, options = {}) {
        super();
        this.dataDir = dataDir;
        this.headless = !!options.headless;
        this.starting = null; // in-flight start() promise
        this.stopping = null; // in-flight stop() promise
        this.server = null;
        this.discoveryServer = null;
        this.state = "stopped";
        this.error = null;
        this.vars = new Map(); // project id -> entry
        this.pathIndex = new Map(); // "Plant/Boiler1/Temperature" -> entry
        this.alarms = new Map();
        this.objects = new Map();
        this.sessions = new Map();
        this.simPausedAll = false;
        this.startTime = null;
        this.project = null;
        this.allowScripts = true; // set per start(); false means method scripts are refused
        this.qjs = null; // loaded QuickJS WebAssembly module (only when a project has scripts)
        this.loopbackRelays = []; // [::1] -> 127.0.0.1 relays for listen address "localhost" (SS-02)
        // persistent value and event history (<data folder>/history/history.db), opened on first use and kept open
        this.historyStore = null;
        this.historyOpenError = null;
        this.historyReplacements = 0; // damaged database files replaced by new ones (clear all)
        this.historyLimits = { values: historySize(), events: historySize() };
        this.historyCtx = null; // { store, uris, ns, mapper } of the address space being served
        this.historians = new Map(); // history key -> { historian, uaVar, archiveUpdated }
        this.eventReader = null; // HistoryRead of event notifiers
        this.eventRecording = false;
        this.eventNotifiers = []; // objects with event history (Server object, project folders and objects)
        this.serverRolePermissions = null; // RolePermissions of the Server object before event history added ReadHistory
        this.capturedEvents = new WeakMap(); // event data -> record (one event reaches several notifiers)
        this.instanceId = null; // this run's row in the history database (servers sharing the data folder)
        this.heartbeatTimer = null;
        this.heartbeatStored = 0; // ms: everything this run recorded before it is in the database (writeHeartbeat)
        this.historyPeers = []; // other running servers recording into the same history database (at start)
        this.historyGapFrom = null; // ms: until when a killed run of the same address space stored everything (or null) of the same address space (or null)
        this.consumedInstanceRows = [];
        this.deadInstanceRows = new Set(); // rows of killed servers that looked running at start (confirmHistoryPeers)
    }

    log(level, message) {
        // Single choke point: strip control characters and cap length on every log line so client-controlled
        // strings (session names, client application names, written values, method arguments) cannot inject
        // extra lines into the log file or forge audit entries (SS-14).
        this.emit("log", { time: new Date().toISOString(), level, source: "server", message: sanitizeLogText(message) });
    }

    setState(state, error = null) {
        this.state = state;
        this.error = error;
        this.emit("status", this.getStatus());
    }

    // ---------------------------------------------------------------- lifecycle

    async createCertificateManager(name, autoAccept) {
        const cm = new OPCUACertificateManager({
            rootFolder: path.join(this.dataDir, "pki", name),
            automaticallyAcceptUnknownCertificate: autoAccept
        });
        await cm.initialize();
        return cm;
    }

    resolveNodesets(cfg) {
        const wanted = [];
        const add = (key) => {
            if (wanted.includes(key)) return;
            (NODESET_DEPENDENCIES[key] || []).forEach(add);
            wanted.push(key);
        };
        (cfg.companionNodesets || []).forEach(add);
        // keep the canonical order node-opcua lists them in, which respects dependencies
        const order = Object.keys(nodesets);
        wanted.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const files = [nodesets.standard, ...wanted.filter((k) => k !== "standard").map((k) => nodesets[k])];
        for (const f of cfg.customNodesetFiles || []) {
            if (!fs.existsSync(f)) throw new Error(`NodeSet file not found: ${f}`);
            files.push(f);
        }
        return { files, keys: wanted };
    }

    // Concurrent calls (double click, auto start + Ctrl+R) share one start instead of racing for the port:
    // two OPCUAServer instances on one port would leave the winner listening without the engine tracking it.
    start(project, options = {}) {
        // start after a pending stop: the last request wins (start -> stop -> start ends running)
        if (this.stopping) return this.stopping.then(() => this.start(project, options));
        if (this.starting) return this.starting;
        if (this.server) return Promise.reject(new Error("Server is already running"));
        this.starting = this.doStart(project, options).finally(() => { this.starting = null; });
        return this.starting;
    }

    async doStart(project, options = {}) {
        this.project = JSON.parse(JSON.stringify(project));
        // When allowScripts is false (project not trusted), every method with a script is refused at call
        // time (BadUserAccessDenied) instead of being executed.
        this.allowScripts = options.allowScripts !== false;
        const cfg = this.project.server;
        this.setState("starting");
        try {
            const port = Number(cfg.port) || 4840;
            const discoveryPort = Number(cfg.discoveryServerPort) || 4841;
            if (cfg.runDiscoveryServer && discoveryPort === port) {
                throw new Error(`The local discovery server port (${discoveryPort}) must differ from the server port. Change "Discovery server port" or turn off the local discovery server.`);
            }
            const advertised = parseAdvertisedUrls(cfg.advertisedUrls, cfg.resourcePath);
            if (advertised.invalid.length) {
                throw new Error(`Advertised URL ${advertised.invalid.map((u) => `"${u}"`).join(", ")} is not valid: use opc.tcp://host:port[/path]`);
            }
            // never suggest the discovery server's port for the main server
            const exclude = cfg.runDiscoveryServer ? [discoveryPort] : [];
            const portState = await checkPort(port);
            if (!portState.free) {
                const err = new Error(portProblemMessage(port, portState.reason));
                err.code = "PORT_UNAVAILABLE";
                err.suggestedPort = await findFreePort(port + 1, exclude);
                throw err;
            }
            if (cfg.runDiscoveryServer) {
                // checked before anything starts, so a busy discovery port does not roll back a running server;
                // no [suggested-port] suffix: that suggestion would be applied to the main server port
                const discoveryState = await checkPort(discoveryPort);
                if (!discoveryState.free) {
                    const free = await findFreePort(discoveryPort + 1, [port]);
                    const err = new Error(`Local discovery server: ${portProblemMessage(discoveryPort, discoveryState.reason)} Change "Discovery server port"${free ? ` (e.g. to ${free})` : ""} or turn off the local discovery server.`);
                    err.code = "PORT_UNAVAILABLE";
                    throw err;
                }
            }
            this.serverCM = await this.createCertificateManager("server", !!cfg.autoAcceptCertificates);
            // The USER certificate manager NEVER auto-accepts: X.509 user authentication only has a point if
            // an unknown user certificate is rejected (and shown in Certificates -> User -> Rejected for
            // explicit trust). autoAcceptCertificates only ever applies to client APPLICATION certificates (SS-01).
            this.userCM = await this.createCertificateManager("user", false);
            // history of earlier runs is kept; lowered capacities remove the oldest entries now
            this.historyLimits = { values: historySize(cfg.valueHistorySize), events: historySize(cfg.eventHistorySize) };
            const store = this.openHistory(true);
            if (store) {
                store.setLimits(this.historyLimits);
                await this.confirmHistoryPeers(store);
            }
            const { files, keys } = this.resolveNodesets(cfg);
            this.log("info", `Loading ${files.length} nodeset file(s)${keys.length ? " (companion: " + keys.join(", ") + ")" : ""}`);

            // Load the QuickJS engine once, up front, when the project has method scripts and they are allowed,
            // so method binding (during buildAddressSpace) and method calls stay synchronous.
            this.qjs = null;
            if (this.allowScripts && projectScriptSummary(this.project).length) {
                try {
                    this.qjs = await loadQuickJS();
                } catch (err) {
                    throw new Error(`Cannot load the method-script engine (QuickJS): ${err.message}`);
                }
            }

            const listen = this.listenBinding(cfg);
            const users = cfg.users || [];
            const server = new OPCUAServer({
                port: Number(cfg.port) || 4840,
                resourcePath: cfg.resourcePath || "",
                host: listen.host,
                hostname: listen.hostname,
                alternateHostname: listen.alternateHostnames,
                nodeset_filename: files,
                serverInfo: {
                    applicationUri: cfg.applicationUri,
                    productUri: cfg.productUri,
                    applicationName: { text: cfg.applicationName, locale: "en" }
                },
                buildInfo: {
                    productName: cfg.productName,
                    manufacturerName: cfg.manufacturerName,
                    softwareVersion: cfg.softwareVersion,
                    buildNumber: "1",
                    buildDate: new Date()
                },
                ...this.effectiveSecurity(cfg),
                advertisedEndpoints: advertised.urls.length ? advertised.urls : undefined,
                allowAnonymous: !!cfg.allowAnonymous,
                userManager: {
                    isValidUser: (username, password) => this.isValidUser(cfg, users, username, password),
                    getUserRoles: (username) => this.userRolesFor(users, username)
                },
                serverCertificateManager: this.serverCM,
                userCertificateManager: this.userCM,
                serverCapabilities: {
                    maxSessions: Number(cfg.maxSessions) || 100,
                    maxSubscriptions: Number(cfg.maxSubscriptions) || 1000,
                    minSupportedSampleRate: Number(cfg.minSupportedSampleRate) || 100,
                    maxBrowseContinuationPoints: 10,
                    maxHistoryContinuationPoints: MAX_HISTORY_CONTINUATION_POINTS,
                    operationLimits: {
                        maxNodesPerRead: 10000, maxNodesPerWrite: 10000, maxNodesPerBrowse: 10000,
                        maxNodesPerMethodCall: 1000, maxMonitoredItemsPerCall: 10000,
                        maxNodesPerHistoryReadData: 1000, maxNodesPerHistoryReadEvents: 1000,
                        maxNodesPerTranslateBrowsePathsToNodeIds: 1000, maxNodesPerRegisterNodes: 1000
                    }
                },
                maxConnectionsPerEndpoint: Number(cfg.maxConnectionsPerEndpoint) || 100,
                isAuditing: !!cfg.isAuditing,
                registerServerMethod: cfg.registerToLds ? RegisterServerMethod.LDS : RegisterServerMethod.HIDDEN,
                discoveryServerEndpointUrl: cfg.registerToLds ? cfg.ldsUrl : undefined
            });
            this.server = server;
            // anonymous write access is granted to anonymous sessions only (see anonymousRoleResolver)
            if (Array.isArray(server.roleResolvers)) server.roleResolvers.push(this.anonymousRoleResolver(cfg));
            else if (this.anonymousMayWrite(cfg)) this.log("warn", "This node-opcua version has no role resolvers: anonymous users can only read");
            this.wireServerEvents(server);

            await server.initialize();
            this.restrictUserTokens(server, cfg);
            this.checkUserTokens();
            this.buildAddressSpace(server.engine.addressSpace);
            this.setHistoryCapabilities(server);
            await server.start();
            await this.startLoopbackRelay(cfg, port, "Server");
            this.startTime = new Date();
            this.startSimulations();

            if (cfg.runDiscoveryServer) await this.startDiscoveryServer(cfg);
            this.checkCertificateHosts(server, cfg);

            this.log("info", `Server started: ${this.getEndpointUrls().join(", ")}`);
            this.setState("running");
        } catch (err) {
            this.log("error", `Failed to start server: ${err.message}`);
            await this.cleanup();
            this.setState("error", err.message);
            if (err.code === "PORT_UNAVAILABLE") {
                // keep the suggestion when the error crosses the IPC boundary (only message survives)
                const e = new Error(`${err.message}${err.suggestedPort ? ` [suggested-port:${err.suggestedPort}]` : ""}`);
                e.code = err.code;
                e.suggestedPort = err.suggestedPort;
                throw e;
            }
            throw err;
        }
    }

    // Extra host names / IPs for endpoint URLs, so clients on other machines (VMs) get reachable URLs.
    alternateHostnames(cfg) {
        // "localhost" listen address advertises localhost only: no LAN IPs or host name alternates (EG-2/SS-02).
        if ((cfg.listenAddress || "all") === "localhost") return ["localhost"];
        const names = String(cfg.alternateHostnames || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
        if (cfg.advertiseIpAddresses !== false) names.push(...localIPv4Addresses());
        // the primary host name is repeated here on purpose: node-opcua de-duplicates endpoints, but only
        // alternate names end up in the self-signed certificate
        if (cfg.hostname) names.unshift(cfg.hostname);
        return [...new Set(names)];
    }

    // The TCP bind address and advertised host names for the configured listen address (EG-2/SS-02).
    // "all" (default) listens on every interface; "localhost" binds the loopback interface only and
    // advertises only localhost URLs. node-opcua's OPCUAServer `host` option sets the bind address.
    listenBinding(cfg) {
        if ((cfg.listenAddress || "all") === "localhost") {
            return { host: "127.0.0.1", hostname: "localhost", alternateHostnames: ["localhost"] };
        }
        return { host: undefined, hostname: cfg.hostname || undefined, alternateHostnames: this.alternateHostnames(cfg) };
    }

    // Constant-time-ish password check against the (plaintext) project users. Passwords are kept in the
    // project because the server has to compare them (SS-13); they are never written to logs.
    isValidUser(cfg, users, username, password) {
        if (!cfg.allowUsername) return false;
        let ok = false;
        for (const u of users) {
            if (u.username !== username) continue;
            const a = Buffer.from(String(u.password));
            const b = Buffer.from(String(password));
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
        }
        return ok;
    }

    // Roles a logged-in user is granted, for permission evaluation (SS-03). node-opcua always adds the
    // AuthenticatedUser role on top. A recognised role is used as-is; a user with no recognised role is
    // treated as read+write (Operator), so authenticating is never less capable than staying anonymous.
    userRolesFor(users, username) {
        const u = users.find((x) => x.username === username);
        const role = u && u.role;
        if (role === "Observer") return makeRoles(["Observer"]);
        if (WRITE_ROLES.includes(role)) return makeRoles([role]);
        return makeRoles(["Operator"]);
    }

    // Per-role permissions applied as the custom namespace's default, so write and method-call access is
    // governed by the user's role instead of being open to everyone (SS-03). Observer (viewer) is read-only;
    // the write roles may write and call; Anonymous follows anonymousAccess; AuthenticatedUser is the
    // authenticated read floor (node-opcua adds it to every logged-in session, so it must not grant write).
    //
    // The Anonymous role itself is only ever granted READ here: node-opcua adds the Anonymous role to EVERY
    // session as a permission floor (also to logged-in ones), so granting it write would make an Observer
    // writable too. Anonymous write ("Anonymous users can: read and write") is instead granted to anonymous
    // sessions only, by anonymousRoleResolver() below.
    namespaceRolePermissions(cfg) {
        return [
            { roleId: ROLE_NODEIDS.Anonymous, permissions: PERM_READ },
            { roleId: ROLE_NODEIDS.AuthenticatedUser, permissions: PERM_READ },
            { roleId: ROLE_NODEIDS.Observer, permissions: PERM_READ },
            { roleId: ROLE_NODEIDS.Operator, permissions: PERM_WRITE },
            { roleId: ROLE_NODEIDS.Engineer, permissions: PERM_WRITE },
            { roleId: ROLE_NODEIDS.Supervisor, permissions: PERM_WRITE },
            { roleId: ROLE_NODEIDS.ConfigureAdmin, permissions: PERM_WRITE },
            { roleId: ROLE_NODEIDS.SecurityAdmin, permissions: PERM_WRITE }
        ];
    }

    // true when anonymous sessions may write values and call methods (demo default "readwrite").
    anonymousMayWrite(cfg) {
        return !!cfg.allowAnonymous && (cfg.anonymousAccess || "readwrite") !== "readonly";
    }

    // Role resolver (OPC 10000-18 §4.4) that gives a session logged in WITHOUT credentials (an anonymous
    // identity token) the Operator role when anonymous write access is enabled. It looks at the token type,
    // so it never widens a logged-in user: an Observer stays read-only whatever anonymousAccess says (SS-03).
    anonymousRoleResolver(cfg) {
        const operator = makeRoles(["Operator"]);
        return {
            resolveRoles: (token) => {
                if (!this.anonymousMayWrite(cfg) || !token) return [];
                const anonymous = token instanceof AnonymousIdentityToken || (token.schema && token.schema.name === "AnonymousIdentityToken");
                return anonymous ? operator : [];
            }
        };
    }

    // Policies / modes given to OPCUAServer. node-opcua offers UserName and X509 tokens on the None endpoint only
    // for the non-None policies it is given (the token is then encrypted with the server certificate), so a
    // None-only server would offer Anonymous only. Without a Sign / SignAndEncrypt mode the extra policy creates
    // no secure endpoint; the saved configuration stays unchanged.
    effectiveSecurity(cfg) {
        let policies = cfg.securityPolicies && cfg.securityPolicies.length ? [...cfg.securityPolicies] : ["None"];
        let modes = cfg.securityModes && cfg.securityModes.length ? [...cfg.securityModes] : ["None"];
        // with only policy None, Sign / SignAndEncrypt create no endpoints either: the server is None-only
        if (modes.includes("None") && policies.every((p) => p === "None")) modes = ["None"];
        if (modes.every((m) => m === "None") && !policies.includes("Basic256Sha256")) {
            policies = [...policies, "Basic256Sha256"];
            if (cfg.allowUsername || cfg.allowCertificate) this.log("info", "Only SecurityPolicy None: user name / certificate logins are offered on the None endpoint with Basic256Sha256 token encryption");
        }
        return {
            securityPolicies: policies.map((p) => SecurityPolicy[p]),
            securityModes: modes.map((m) => MessageSecurityMode[m])
        };
    }

    // Host names / IPs the server will advertise that its existing self-signed certificate does not cover.
    // -> { file, missing } (missing is empty when there is no certificate yet: node-opcua creates a fitting one).
    certificateMissingHosts(cfg) {
        const file = path.join(this.dataDir, "pki", "server", "own", "certs", "certificate.pem");
        if (!fs.existsSync(file)) return { file, missing: [] };
        const san = new (require("crypto").X509Certificate)(fs.readFileSync(file)).subjectAltName || "";
        // "DNS:host, IP Address:10.0.0.5, URI:urn:..." -> exact entries (a substring test would accept 10.0.0.5 for 10.0.0.50)
        const covered = new Set(san.split(/,\s*/).map((e) => e.slice(e.indexOf(":") + 1).trim().toLowerCase()));
        const wanted = new Set(this.alternateHostnames(cfg)); // already starts with cfg.hostname
        if (!cfg.hostname) wanted.add(os.hostname()); // node-opcua's default host name
        for (const u of parseAdvertisedUrls(cfg.advertisedUrls, cfg.resourcePath).urls) wanted.add(urlHost(u));
        // IPv6 literals are skipped like node-opcua's own check does (the SAN text uses another notation)
        return { file, missing: [...wanted].filter((h) => !h.includes(":") && !covered.has(h.toLowerCase())) };
    }

    // The self-signed certificate is created once; warn when host names / IPs changed since (e.g. VM got a new IP).
    checkCertificateHosts(server, cfg) {
        try {
            const { file, missing } = this.certificateMissingHosts(cfg);
            if (missing.length) {
                const fix = this.headless
                    ? `restart once with --regenerate-cert (or set OPCUA_REGENERATE_CERT=1 to renew it automatically whenever names change, or delete ${file})`
                    : "use Certificates → Regenerate server certificate (while stopped)";
                this.log("warn", `Server certificate does not cover ${missing.join(", ")}. Some clients reject such connections — ${fix} to include them.`);
            }
        } catch (_) { /* informational only */ }
    }

    async startDiscoveryServer(cfg) {
        // The discovery server follows the project's autoAccept setting (false in the secure preset) instead of
        // always auto-accepting, and binds the same interface as the main server (SS-15).
        const cm = await this.createCertificateManager("discovery", !!cfg.autoAcceptCertificates);
        const listen = this.listenBinding(cfg);
        this.discoveryServer = new OPCUADiscoveryServer({
            port: Number(cfg.discoveryServerPort) || 4841,
            host: listen.host,
            hostname: listen.hostname,
            serverCertificateManager: cm
        });
        // OPCUADiscoveryServer (node-opcua 2.187) ignores its `host` option and would listen on every interface.
        // Its endpoint is created during start(), so set the bind address on it right after it is created and
        // before it listens; then check the address it really bound to.
        if (listen.host) {
            const ds = this.discoveryServer;
            const createEndpoint = ds._delayInit;
            if (typeof createEndpoint === "function") {
                ds._delayInit = async () => {
                    await createEndpoint();
                    for (const ep of ds.endpoints) ep.host = listen.host;
                };
            }
        }
        await this.discoveryServer.start();
        if (listen.host) {
            const bound = this.discoveryServer.endpoints.map((ep) => ep._server && ep._server.address && ep._server.address()).filter(Boolean);
            if (bound.some((a) => typeof a === "object" && a.address !== listen.host)) {
                try { await this.discoveryServer.shutdown(); } catch (_) { /* ignore */ }
                this.discoveryServer = null;
                throw new Error(`The local discovery server could not be limited to ${listen.host}; it was stopped. Turn off the local discovery server or listen on all interfaces.`);
            }
        }
        this.log("info", `Local Discovery Server started on port ${cfg.discoveryServerPort}${listen.host ? ` (${listen.host})` : ""}`);
        await this.startLoopbackRelay(cfg, Number(cfg.discoveryServerPort) || 4841, "Local Discovery Server");
    }

    // With listen address "localhost" the server binds 127.0.0.1 (node-opcua binds one address per server).
    // Clients that resolve "localhost" to the IPv6 loopback ::1 are served by a loopback-only relay from
    // [::1]:port to 127.0.0.1:port, when this computer has IPv6 (SS-02). A failing relay never stops the server.
    async startLoopbackRelay(cfg, port, label) {
        if ((cfg.listenAddress || "all") !== "localhost") return;
        try {
            const relay = await startLoopbackRelay(port);
            if (relay) {
                this.loopbackRelays.push(relay);
                this.log("info", `${label} also accepts IPv6 loopback connections on [::1]:${port}`);
            } else {
                this.log("info", `${label}: this computer has no IPv6 loopback address, listening on 127.0.0.1:${port} only`);
            }
        } catch (err) {
            this.log("warn", `${label}: cannot listen on [::1]:${port} (${err.code || err.message}); IPv4 clients (127.0.0.1) are not affected`);
        }
    }

    // node-opcua always advertises all token types; drop the ones disabled in the project.
    restrictUserTokens(server, cfg) {
        const allowed = new Set();
        if (cfg.allowAnonymous) allowed.add(UserTokenType.Anonymous);
        if (cfg.allowUsername) allowed.add(UserTokenType.UserName);
        if (cfg.allowCertificate) allowed.add(UserTokenType.Certificate);
        for (const ep of server.endpoints) {
            for (const d of ep.endpointDescriptions()) {
                d.userIdentityTokens = (d.userIdentityTokens || []).filter((t) => allowed.has(t.tokenType));
            }
        }
    }

    // An endpoint without any user token type accepts no session (e.g. anonymous login off on a None-only server).
    checkUserTokens() {
        const endpoints = this.getEndpoints().filter((e) => !e.restricted);
        if (!endpoints.length) {
            this.log("warn", "The server offers no usable endpoint: Sign / SignAndEncrypt need at least one security policy other than None.");
            return;
        }
        const empty = endpoints.filter((e) => !e.userTokens.length);
        if (!empty.length) return;
        const which = [...new Set(empty.map((e) => `${e.securityPolicy}/${e.securityMode}`))].join(", ");
        this.log("warn", `${empty.length} endpoint(s) (${which}) offer no user token type, so no client can open a session there. Allow anonymous, user name or certificate login in the security settings.`);
    }

    wireServerEvents(server) {
        server.on("create_session", (session) => {
            this.sessions.set(session.nodeId.toString(), session);
            this.log("info", `Session created: ${session.sessionName || "(unnamed)"} from ${session.clientDescription?.applicationName?.text || "unknown client"}`);
        });
        server.on("session_activated", (session, token) => {
            const kind = token?.constructor?.name?.replace("IdentityToken", "") || "Anonymous";
            const user = token?.userName ? ` user="${token.userName}"` : "";
            this.log("info", `Session activated: ${session.sessionName} (${kind}${user})`);
        });
        server.on("session_closed", (session, deleteSubscriptions, reason) => {
            this.sessions.delete(session.nodeId.toString());
            if (this.eventReader) this.eventReader.releaseSession(session.nodeId.toString());
            this.log("info", `Session closed: ${session.sessionName} ${reason ? "(" + reason + ")" : ""}`);
        });
        server.on("newChannel", (channel) => this.log("debug", `Secure channel opened from ${channel.remoteAddress}:${channel.remotePort} (${channel.securityPolicy?.split("#")[1] || "None"} / ${MessageSecurityMode[channel.securityMode]})`));
        server.on("closeChannel", (channel) => this.log("debug", `Secure channel closed ${channel.remoteAddress || ""}`));
        server.on("connectionRefused", (socketData) => this.log("warn", `Connection refused from ${socketData?.remoteAddress || "?"}`));
        server.on("openSecureChannelFailure", (socketData, channelData) => {
            const from = socketData?.remoteAddress || "?";
            if (!socketData?.bytesRead) {
                // a TCP connect without any OPC UA message: port scanner, load balancer or health probe
                this.log("debug", `TCP connection from ${from} closed without an OPC UA handshake`);
                return;
            }
            const policy = channelData?.securityPolicy ? ` (${String(channelData.securityPolicy).split("#")[1] || channelData.securityPolicy})` : "";
            this.log("warn", `Secure channel from ${from} failed${policy}: ${(socketData.reason || "").replace("openSecureChannel has Failed ", "")} — check certificates (Certificates → Rejected) and security settings`);
        });
        server.on("request", (request) => this.logRequest(request));
    }

    // One line per request (not per node): a client writing many tags per second must not flood the log.
    logRequest(request) {
        const name = request.schema?.name;
        if (name === "WriteRequest") {
            const writes = request.nodesToWrite || [];
            if (!writes.length) return;
            let v = null;
            try { v = writes[0].value?.value ? V.variantToPlain(writes[0].value.value) : null; } catch (_) { /* shown as null */ }
            let text = JSON.stringify(v) ?? "null";
            if (text.length > 120) text = text.slice(0, 117) + "...";
            const first = `${writes[0].nodeId.toString()} = ${text}`;
            this.log("info", writes.length === 1 ? `Client write ${first}` : `Client wrote ${writes.length} values (first: ${first})`);
        } else if (name === "CallRequest") {
            const calls = request.methodsToCall || [];
            if (!calls.length) return;
            const first = `${calls[0].methodId.toString()} on ${calls[0].objectId.toString()}`;
            this.log("info", calls.length === 1 ? `Client call ${first}` : `Client called ${calls.length} methods (first: ${first})`);
        } else if (name === "CreateSubscriptionRequest") {
            this.log("debug", `Client created subscription (publishing interval ${request.requestedPublishingInterval} ms)`);
        } else if (name === "CreateMonitoredItemsRequest") {
            this.log("debug", `Client monitors ${request.itemsToCreate?.length || 0} item(s)`);
        }
    }

    // Concurrent calls share one stop; a stop that arrives during a start waits for it, so a server that
    // finishes starting afterwards cannot be left running untracked.
    stop(shutdownDelayMs = 0) {
        if (!this.stopping) this.stopping = this.doStop(shutdownDelayMs).finally(() => { this.stopping = null; });
        return this.stopping;
    }

    async doStop(shutdownDelayMs) {
        if (this.starting) {
            try { await this.starting; } catch (_) { return; } // a failed start already cleaned up
        }
        if (!this.server) return;
        this.setState("stopping");
        this.log("info", shutdownDelayMs ? `Shutting down in ${shutdownDelayMs / 1000} s` : "Stopping server");
        this.flushHistory(); // saved before a shutdown that might not finish (quit gives it 3 s)
        try {
            await this.server.shutdown(shutdownDelayMs);
        } catch (err) {
            this.log("warn", `Shutdown error: ${err.message}`);
        }
        await this.cleanup();
        this.log("info", "Server stopped");
        this.setState("stopped");
    }

    async cleanup() {
        this.stopSimulations();
        this.stopHistory();
        for (const relay of this.loopbackRelays.splice(0)) {
            try { await relay.close(); } catch (_) { /* ignore */ }
        }
        if (this.discoveryServer) {
            try { await this.discoveryServer.shutdown(); } catch (_) { /* ignore */ }
            this.discoveryServer = null;
        }
        if (this.server) {
            try { if (this.state === "starting" || this.state === "error") await this.server.shutdown(0); } catch (_) { /* ignore */ }
        }
        this.server = null;
        this.vars.clear();
        this.pathIndex.clear();
        this.alarms.clear();
        this.objects.clear();
        this.sessions.clear();
        this.startTime = null;
    }

    // ---------------------------------------------------------------- address space

    buildAddressSpace(addressSpace) {
        this.addressSpace = addressSpace;
        addressSpace.installAlarmsAndConditionsService();
        const cfg = this.project.server;
        this.namespace = addressSpace.getNamespace(cfg.namespaceUri) || addressSpace.registerNamespace(cfg.namespaceUri);
        this.nsIndex = this.namespace.index;
        // Enforce write/call access by role across the simulated namespace (SS-03). This is the default for
        // every node in it, so a node that is forgotten (or added later) is still governed, not world-writable.
        // Namespace 0 and companion nodesets keep their standard access, so browsing and reading stay unaffected.
        if (typeof this.namespace.setDefaultRolePermissions === "function") {
            this.namespace.setDefaultRolePermissions(this.namespaceRolePermissions(cfg));
        }
        this.setupHistory(addressSpace);
        const objectsFolder = addressSpace.rootFolder.objects;
        const pending = [];
        for (const node of this.project.nodes || []) this.buildNode(node, objectsFolder, true, "", pending);
        this.finishValueHistory();
        // methods and alarms can reference variables anywhere in the tree, so they are created last
        for (const fn of pending) {
            try { fn(); } catch (err) { this.log("error", err.message); }
        }
        this.log("info", `Address space ready: ${this.vars.size} variables, ${this.alarms.size} alarms (namespace ${this.nsIndex} = ${cfg.namespaceUri})`);
    }

    // "s=Plant.Boiler1.Temperature": the NodeId of a project node without its namespace index
    nodeIdentifier(node, fullPath) {
        let id = (node.nodeId || "").trim();
        if (!id) id = "s=" + fullPath.replace(/\//g, ".");
        if (/^ns=\d+;/.test(id)) id = id.replace(/^ns=\d+;/, "");
        if (!/^(s|i|g|b)=/.test(id)) id = "s=" + id;
        return id;
    }

    makeNodeId(node, fullPath) {
        return `ns=${this.nsIndex};${this.nodeIdentifier(node, fullPath)}`;
    }

    buildNode(node, parent, parentIsFolder, parentPath, pending) {
        const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
        const ref = parentIsFolder ? { organizedBy: parent } : { componentOf: parent };
        const common = {
            browseName: node.name,
            nodeId: this.makeNodeId(node, fullPath),
            description: node.description || undefined
        };
        const server = this.addressSpace.rootFolder.objects.server;
        try {
            switch (node.kind) {
                case "folder":
                case "object": {
                    const obj = this.namespace.addObject({
                        ...common,
                        ...ref,
                        typeDefinition: node.kind === "folder" ? "FolderType" : "BaseObjectType",
                        eventNotifier: 1,
                        // chain Server -> folder -> object so events and alarms bubble up to the Server object
                        notifierOf: parent.nodeId.toString() === this.addressSpace.rootFolder.objects.nodeId.toString() ? server : parent
                    });
                    this.installEventHistory(obj);
                    this.objects.set(node.id, { node, uaNode: obj, path: fullPath });
                    for (const child of node.children || []) this.buildNode(child, obj, node.kind === "folder", fullPath, pending);
                    break;
                }
                case "variable":
                    this.buildVariable(node, common, ref, fullPath);
                    break;
                case "method":
                    pending.push(() => this.buildMethod(node, common, parent, fullPath));
                    break;
                case "alarm":
                    pending.push(() => this.buildAlarm(node, common, parent, fullPath));
                    break;
                default:
                    this.log("warn", `Unknown node kind ${node.kind} at ${fullPath}`);
            }
        } catch (err) {
            this.log("error", `Cannot create ${fullPath}: ${err.message}`);
        }
    }

    buildVariable(node, common, ref, fullPath) {
        const v = node.variable;
        const valueRank = Number(v.valueRank ?? -1);
        const accessParts = [];
        if ((v.access || "rw").includes("r")) accessParts.push("CurrentRead");
        if ((v.access || "rw").includes("w")) accessParts.push("CurrentWrite");
        if (v.historizing) accessParts.push("HistoryRead");
        const accessLevel = makeAccessLevelFlag(accessParts.join(" | ") || "None");
        const variant = V.makeVariant(v.value ?? V.defaultValueFor(v.dataType, valueRank), v.dataType, valueRank);
        const options = {
            ...common,
            ...ref,
            dataType: v.dataType,
            valueRank,
            arrayDimensions: valueRank >= 1 ? [Number(v.arrayLength) || 0] : undefined,
            accessLevel,
            userAccessLevel: accessLevel,
            minimumSamplingInterval: Number(v.minimumSamplingInterval) || 0,
            historizing: !!v.historizing,
            value: variant
        };
        let uaVar;
        if (v.analog && V.NUMERIC_TYPES.has(v.dataType)) {
            uaVar = this.namespace.addAnalogDataItem({
                ...options,
                engineeringUnitsRange: { low: Number(v.euLow) || 0, high: Number(v.euHigh) || 100 },
                engineeringUnits: makeEUInformation(v.unit || "", v.unit || "", v.unit || "")
            });
        } else {
            uaVar = this.namespace.addVariable(options);
        }
        const historyKey = v.historizing ? this.installValueHistory(uaVar) : null;
        const entry = { id: node.id, node, uaVar, path: fullPath, historyKey, paused: false, sim: { state: null, timer: null, t0: Date.now() } };
        // A simulated variable starts with its first simulated value, not with the project value that the simulation
        // would replace a moment later: that value was never simulated and would be saved in the history at every
        // start (and trigger its alarms). startSimulations() then continues from this value.
        let initial = variant;
        if (hasSimulation(v)) {
            try {
                const first = this.simulatedVariant(entry);
                if (first) {
                    initial = first;
                    entry.sim.primed = true;
                }
            } catch (_) { /* reported by the simulation timer */ }
        }
        uaVar.setValueFromSource(initial, StatusCodes.Good, new Date());
        this.vars.set(node.id, entry);
        this.pathIndex.set(fullPath, entry);
    }

    buildMethod(node, common, parent, fullPath) {
        const m = node.method || { inputs: [], outputs: [], script: "return [];" };
        const arg = (a) => ({ name: a.name, dataType: DataType[a.dataType], valueRank: -1, description: { text: a.name } });
        const method = this.namespace.addMethod(parent, {
            ...common,
            inputArguments: (m.inputs || []).map(arg),
            outputArguments: (m.outputs || []).map(arg)
        });
        const scriptText = m.script || "return [];";
        const hasScript = typeof scriptText === "string" && scriptText.trim();
        method.bindMethod((inputArguments, context, callback) => {
            // A project opened from a file that is not trusted runs with scripts disabled: refuse rather than
            // execute attacker-supplied code (UC-1/EGR-01/SS-05). Methods without a script are unaffected.
            if (hasScript && !this.allowScripts) {
                this.log("warn", "Method scripts are disabled (project not trusted)");
                return callback(null, { statusCode: StatusCodes.BadUserAccessDenied });
            }
            // A method without a script simply returns default output values (no engine needed).
            if (!hasScript) {
                const outputArguments = (m.outputs || []).map((o) => V.makeVariant(V.defaultValueFor(o.dataType, -1), o.dataType, -1));
                return callback(null, { statusCode: StatusCodes.Good, outputArguments });
            }
            // after an engine failure, swap in the fresh engine so the retired one can be garbage-collected
            const refreshEngine = () => {
                if (this.qjs && !isQuickJSUsable(this.qjs)) loadQuickJS().then((mod) => { if (this.qjs) this.qjs = mod; }, () => {});
            };
            const fail = (err) => {
                refreshEngine();
                this.log("error", `Method ${fullPath} failed: ${err.message}`);
                callback(null, { statusCode: StatusCodes.BadInternalError });
            };
            let inputs;
            try {
                inputs = inputArguments.map((a) => V.variantToPlain(a));
                this.log("info", `Method ${fullPath} called with ${JSON.stringify(inputs)}`);
                if (!this.qjs) throw new Error("method-script engine is not available");
            } catch (err) {
                return fail(err);
            }
            // The script runs inside QuickJS (WebAssembly), isolated from the host process, with a per-call
            // time limit, memory limit and host-call cap (UC-1/UC-4). Values cross only as JSON. A script that
            // breaks the engine itself (e.g. by extremely deep nesting) retires it; the next call then uses a
            // freshly loaded engine, so one bad call never affects the others.
            runMethodScriptIsolated({
                script: scriptText,
                inputs,
                host: {
                    getValue: (p) => this.readByPath(p),
                    setValue: (p, val) => this.writeByPath(p, val),
                    log: (msg) => this.log("info", `[${fullPath}] ${msg}`)
                }
            }, this.qjs).then((result) => {
                let outputArguments;
                try {
                    const out = result || [];
                    outputArguments = (m.outputs || []).map((o, i) => V.makeVariant(out[i] ?? V.defaultValueFor(o.dataType, -1), o.dataType, -1));
                } catch (err) {
                    return fail(err);
                }
                refreshEngine();
                callback(null, { statusCode: StatusCodes.Good, outputArguments });
            }, fail);
        });
    }

    buildAlarm(node, common, parent, fullPath) {
        const a = node.alarm;
        const source = this.vars.get(a.sourceId);
        if (!source) throw new Error(`Alarm ${fullPath}: source variable not found`);
        // the source variable must be an event source of a notifier (Part 9: HasEventSource hierarchy)
        if (source.uaVar.getEventSourceOfs().length === 0) {
            parent.addReference({ referenceType: "HasEventSource", nodeId: source.uaVar.nodeId });
        }
        const base = {
            ...common,
            componentOf: parent,
            conditionName: node.name,
            conditionSource: source.uaVar,
            inputNode: source.uaVar,
            optionals: ["ConfirmedState", "Confirm"]
        };
        let alarm;
        const num = (x) => (x === "" || x === null || x === undefined ? undefined : Number(x));
        if (a.type === "ExclusiveLimit" || a.type === "NonExclusiveLimit") {
            const limits = { highHighLimit: num(a.highHigh), highLimit: num(a.high), lowLimit: num(a.low), lowLowLimit: num(a.lowLow) };
            Object.keys(limits).forEach((k) => limits[k] === undefined && delete limits[k]);
            alarm = a.type === "ExclusiveLimit"
                ? this.namespace.instantiateExclusiveLimitAlarm("ExclusiveLimitAlarmType", { ...base, ...limits })
                : this.namespace.instantiateNonExclusiveLimitAlarm("NonExclusiveLimitAlarmType", { ...base, ...limits });
        } else if (a.type === "OffNormal") {
            const dt = source.node.variable.dataType;
            const normalState = this.namespace.addVariable({
                browseName: `${node.name}NormalState`,
                componentOf: parent,
                dataType: dt,
                value: V.makeVariant(a.normalValue ?? V.defaultValueFor(dt, -1), dt, -1)
            });
            alarm = this.namespace.instantiateOffNormalAlarm({ ...base, normalState });
        } else {
            throw new Error(`Unknown alarm type ${a.type}`);
        }
        // node-opcua throws when an input change does not alter the condition (e.g. Bad status while
        // already inactive); the throw would abort the value_changed listeners that feed subscriptions.
        const onInput = alarm._onInputDataValueChange.bind(alarm);
        alarm._onInputDataValueChange = (dataValue) => {
            try { onInput(dataValue); } catch (err) { this.log("debug", `Alarm ${fullPath}: ${err.message}`); }
        };
        const entry = { node, alarm, path: fullPath, severity: Number(a.severity) || 500 };
        // node-opcua reports a fixed severity (150/0); use the configured one instead
        const calc = alarm.calculateConditionInfo.bind(alarm);
        alarm.calculateConditionInfo = (stateData, isActive, value, oldInfo) => {
            const info = calc(stateData, isActive, value, oldInfo);
            info.severity = entry.severity;
            return info;
        };
        alarm.setEnabledState(true);
        this.setAlarmSeverity(alarm, entry.severity);
        this.alarms.set(node.id, entry);
    }

    setAlarmSeverity(alarm, severity) {
        alarm.severity.setValueFromSource({ dataType: DataType.UInt16, value: Math.max(1, Math.min(1000, Number(severity) || 500)) });
    }

    readByPath(p) {
        const e = this.pathIndex.get(p);
        if (!e) throw new Error(`No variable at path ${p}`);
        return V.variantToPlain(e.uaVar.readValue().value);
    }

    writeByPath(p, value) {
        const e = this.pathIndex.get(p);
        if (!e) throw new Error(`No variable at path ${p}`);
        this.applyValue(e, { value });
    }

    // ---------------------------------------------------------------- simulation

    startSimulations() {
        for (const e of this.vars.values()) {
            const s = e.node.variable.simulation;
            if (!hasSimulation(e.node.variable)) continue;
            const interval = Math.max(50, Number(s.interval) || 1000);
            // the first simulated value was set when the variable was created (buildVariable)
            if (e.sim.primed) {
                e.sim.primed = false;
            } else {
                try { this.simulateTick(e); } catch (_) { /* reported by the timer below */ }
            }
            e.sim.timer = setInterval(() => {
                if (this.simPausedAll || e.paused) return;
                try { this.simulateTick(e); } catch (err) {
                    // report once per variable, keep simulating
                    if (e.sim.lastError !== err.message) this.log("error", `Simulation ${e.path}: ${err.message}`);
                    e.sim.lastError = err.message;
                }
            }, interval);
        }
    }

    stopSimulations() {
        for (const e of this.vars.values()) if (e.sim.timer) clearInterval(e.sim.timer);
    }

    simulateValue(e, s, index = 0) {
        const min = Number(s.min ?? 0);
        const max = Number(s.max ?? 100);
        const period = Math.max(100, Number(s.period) || 10000);
        const step = Number(s.step ?? 1);
        const t = (Date.now() - e.sim.t0 + (index * period) / 8) % period;
        const phase = t / period;
        const st = e.sim;
        switch (s.type) {
            case "sine": return min + ((max - min) * (1 + Math.sin(2 * Math.PI * phase))) / 2;
            case "triangle": return min + (max - min) * (phase < 0.5 ? phase * 2 : 2 - phase * 2);
            case "sawtooth": return min + (max - min) * phase;
            case "square": return phase < 0.5 ? max : min;
            case "random": return min + Math.random() * (max - min);
            case "randomWalk": {
                const cur = st.state?.[index] ?? (min + max) / 2;
                const next = Math.min(max, Math.max(min, cur + (Math.random() * 2 - 1) * step));
                st.state = st.state || [];
                st.state[index] = next;
                return next;
            }
            case "ramp":
            case "counter": {
                const cur = st.state?.[index];
                let next = cur === undefined ? min : cur + step;
                if (next > max) next = min;
                st.state = st.state || [];
                st.state[index] = next;
                return next;
            }
            case "toggle": {
                st.state = st.state || [];
                st.state[index] = !st.state[index];
                return st.state[index];
            }
            case "clock": return new Date();
            default: return null;
        }
    }

    simulateTick(e) {
        const variant = this.simulatedVariant(e);
        if (variant) e.uaVar.setValueFromSource(variant, StatusCodes.Good, new Date());
    }

    // the next simulated value of a variable as a Variant of its data type (null: nothing to set)
    simulatedVariant(e) {
        const v = e.node.variable;
        const s = v.simulation;
        const convert = (raw) => {
            if (v.dataType === "Boolean") return typeof raw === "boolean" ? raw : raw >= (Number(s.min) + Number(s.max)) / 2;
            if (v.dataType === "DateTime") return raw instanceof Date ? raw : new Date();
            if (v.dataType === "String") return raw instanceof Date ? raw.toISOString() : `${e.node.name} ${typeof raw === "number" ? Math.round(raw * 100) / 100 : raw}`;
            if (V.NUMERIC_TYPES.has(v.dataType)) return typeof raw === "boolean" ? (raw ? 1 : 0) : raw instanceof Date ? raw.getTime() : raw;
            return raw;
        };
        const valueRank = Number(v.valueRank ?? -1);
        let value;
        if (valueRank >= 1) {
            const len = Math.max(1, Number(v.arrayLength) || 1);
            value = Array.from({ length: len }, (_, i) => convert(this.simulateValue(e, s, i)));
        } else {
            value = convert(this.simulateValue(e, s));
        }
        if (value === null) return null;
        return V.makeVariant(value, v.dataType, valueRank);
    }

    setPaused(id, paused) {
        if (id === "*") {
            this.simPausedAll = !!paused;
            this.log("info", paused ? "All simulations paused" : "All simulations resumed");
            return;
        }
        const e = this.vars.get(id);
        if (e) e.paused = !!paused;
    }

    // ---------------------------------------------------------------- live values

    requireRunning() {
        if (!this.server || this.state !== "running") throw new Error("Server is not running");
    }

    getLiveValues() {
        if (!this.server) return { pausedAll: this.simPausedAll, values: [] };
        const values = [];
        for (const e of this.vars.values()) {
            const dv = e.uaVar.readValue();
            const v = e.node.variable;
            values.push({
                id: e.id,
                path: e.path,
                nodeId: e.uaVar.nodeId.toString(),
                dataType: v.dataType,
                valueRank: Number(v.valueRank ?? -1),
                access: v.access,
                unit: v.unit || "",
                simulation: v.simulation?.type || "none",
                paused: e.paused,
                historizing: !!v.historizing,
                ...V.dataValueToPlain(dv)
            });
        }
        return { pausedAll: this.simPausedAll, values };
    }

    applyValue(e, opts) {
        const v = e.node.variable;
        const valueRank = Number(v.valueRank ?? -1);
        const variant = V.makeVariant(opts.value, v.dataType, valueRank);
        const now = new Date();
        const ts = (x) => (x ? new Date(x) : now);
        const dv = new DataValue({
            value: variant,
            statusCode: V.statusCodeFromName(opts.statusCode || "Good"),
            sourceTimestamp: opts.sourceTimestamp === null ? null : ts(opts.sourceTimestamp),
            sourcePicoseconds: Number(opts.sourcePicoseconds) || 0,
            serverTimestamp: opts.serverTimestamp === null ? null : ts(opts.serverTimestamp),
            serverPicoseconds: Number(opts.serverPicoseconds) || 0
        });
        e.uaVar._internal_set_dataValue(dv, null);
    }

    setValue(opts) {
        this.requireRunning();
        const e = this.vars.get(opts.id);
        if (!e) throw new Error("Unknown variable");
        if (opts.pauseSimulation !== undefined) e.paused = !!opts.pauseSimulation;
        this.applyValue(e, opts);
        this.log("info", `Value set ${e.path} = ${JSON.stringify(opts.value)} [${opts.statusCode || "Good"}]`);
        return V.dataValueToPlain(e.uaVar.readValue());
    }

    // ---------------------------------------------------------------- history (OPC UA Part 11)

    // The history database (<data folder>/history/history.db), opened on first use and kept open. null when it
    // cannot be opened: the server then keeps value history in memory for that run only. The reason is logged on
    // every start (`report`) and whenever it changes, not on every status request.
    openHistory(report = false) {
        if (this.historyStore && this.historyStore.isOpen) return this.historyStore;
        const dir = path.join(this.dataDir, "history");
        try {
            const store = this.historyStore || new HistoryStore(dir, { log: (level, message) => this.historyLog(level, message) });
            store.open();
            store.onPruned = (keys) => { for (const key of keys) this.updateStartOfArchive(key); };
            this.historyStore = store;
            this.historyOpenError = null;
            return store;
        } catch (err) {
            const message = isSqliteMissing(err)
                ? `Node.js ${process.versions.node} has no node:sqlite: saving history needs Node.js 22.13 or later (or the desktop app)`
                : err.message;
            const changed = this.historyOpenError !== message;
            this.historyOpenError = message;
            if (report || changed) {
                const file = path.join(dir, "history.db");
                if (isSqliteMissing(err)) {
                    this.log("error", `History needs Node.js 22.13 or later (node:sqlite); it is kept in memory only for this run (lost on stop).`);
                } else if (this.replacingDamaged && isDamagedDatabase(message)) {
                    // "clear all" / --clear-history: the hint to do exactly that would be no help
                    this.log("error", `Cannot open the history database ${file}: ${message}. The file is damaged and is being replaced by a new, empty one.`);
                } else {
                    this.log("error", `Cannot open the history database ${file}: ${message}. History is kept in memory only for this run (lost on stop). ${this.historyRecoveryHint(message)}`);
                }
            }
            return null;
        }
    }

    // Problems the history store reports (a write that failed, damage found while running): headless mode has no
    // "clear all" button, so a damaged file gets the command line way to replace it.
    historyLog(level, message) {
        if (level === "error" && this.headless && isDamagedDatabase(message) && !message.includes("--clear-history")) {
            message = `${message} ${this.historyRecoveryHint(message)}`;
        }
        this.log(level, message);
    }

    // What the user can do about a history database problem (message of the error)
    historyRecoveryHint(message) {
        const file = path.join(this.dataDir, "history", "history.db");
        if (isDamagedDatabase(message)) {
            return this.headless
                ? "The file is damaged: start once with --clear-history to replace it with a new, empty one."
                : "The file is damaged: Configuration → History → \"Clear all value history\" replaces it with a new, empty one.";
        }
        if (/EACCES|EPERM|EROFS|permission|read-?only|unable to open/i.test(message)) {
            return `Check that ${file} and its folder belong to this user and can be written (mode 0600 / 0700).`;
        }
        return "";
    }

    // A damaged database file (not a permission problem) is replaced by a new, empty one: when it cannot be opened
    // (this.historyOpenError) or, with `err`, when it opened but reading or clearing it failed. -> true when it was
    replaceDamagedHistory(err = null) {
        if (!isDamagedDatabase(err || this.historyOpenError || "")) return false;
        const reason = err ? err.message : this.historyOpenError;
        const store = this.historyStore;
        // the same store object is opened again on the new file, so a running server keeps recording into it
        if (store) {
            try { store.close(); } catch (_) { /* a damaged file may fail its last write */ }
        }
        const file = path.join(this.dataDir, "history", "history.db");
        for (const f of [file, `${file}-wal`, `${file}-shm`]) {
            try { fs.rmSync(f, { force: true }); } catch (_) { /* reported by the next open */ }
        }
        this.log("warn", `The history database was damaged (${reason}) and has been replaced by a new, empty one: all saved values and events of ${file} are gone`);
        this.historyReplacements++;
        const reopened = this.openHistory(true);
        if (!reopened) return false;
        // events recorded so far refer to rows of the old file
        this.capturedEvents = new WeakMap();
        // the namespace table of a running server, registered again in the new file
        const ctx = this.historyCtx;
        if (ctx && ctx.store === reopened) {
            try {
                ctx.ns = reopened.namespaceSetId(ctx.uris);
                if (ctx.mapper) {
                    ctx.mapper.currentId = ctx.ns;
                    ctx.mapper.cache.clear();
                }
                for (const { historian } of this.historians.values()) historian.ns = ctx.ns;
            } catch (e) {
                this.log("warn", `History: ${e.message}`);
            }
        }
        return true;
    }

    // Runs fn(store) for "clear all" -> getHistoryStats(). A damaged database (one SQLite cannot open, or one whose
    // pages turn out unreadable while it is cleared) is replaced by a new, empty one, which holds no values and no
    // events: the result then has `replaced: true`.
    clearAllWith(fn) {
        const before = this.historyReplacements;
        try {
            fn(this.requireHistory({ replaceDamaged: true }));
        } catch (err) {
            if (!this.replaceDamagedHistory(err)) throw this.historyError(err);
            try {
                fn(this.historyStore);
            } catch (again) {
                throw this.historyError(again);
            }
        }
        const stats = this.getHistoryStats();
        return this.historyReplacements !== before ? { ...stats, replaced: true } : stats;
    }

    // an error of the history database with a hint what to do about it
    historyError(err) {
        const message = err.message || String(err);
        const hint = this.historyRecoveryHint(message);
        return hint && !message.includes(hint) ? new Error(`${message}. ${hint}`) : err;
    }

    // Writes queued history entries now (they are written every 500 ms anyway).
    flushHistory() {
        if (this.historyStore) this.historyStore.flush();
    }

    // Writes and closes the database (app quit, tests). It is opened again when needed.
    closeHistory() {
        if (this.historyStore) this.historyStore.close();
    }

    stopHistory() {
        this.eventRecording = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        // "collection stopped" (Part 11) after the last value of each variable, so ReadAtTime between this stop and
        // the next start gives no made-up Good values. Not for a variable without values (e.g. cleared meanwhile).
        // Not while another running server records into the same database: the markers could land in its series.
        // This run's row then stays (marked stopped): its time is where the next start of this address space puts
        // the gap (finishValueHistory).
        const store = this.historyCtx && this.historyCtx.store;
        const shared = store ? this.otherRunningInstances(store).length > 0 : false;
        if (!shared) this.markCollectionStopped([...this.historians.entries()]);
        for (const { historian } of this.historians.values()) historian.armed = false;
        this.historians.clear();
        if (this.eventReader) this.eventReader.clear();
        this.eventReader = null;
        this.eventNotifiers = [];
        this.flushHistory();
        if (shared) this.writeHeartbeat({ stopped: true });
        else this.removeInstanceRows([`instance:${this.instanceId}`]);
        this.instanceId = null;
    }

    // "collection stopped" (BadDataLost without value) now, after the last value of each of `entries`
    // ([key, { historian }]) that is recording and whose last value is not such a marker already
    markCollectionStopped(entries) {
        const store = this.historyCtx && this.historyCtx.store;
        if (!store) return;
        const stopped = [];
        try {
            // all reads first: a read writes what is queued, so pushing in between would mean one write per variable
            for (const [key, { historian }] of entries) {
                if (!historian.armed || !historian.recording) continue;
                const last = store.valueRows(key, { reverse: true, limit: 1 })[0];
                if (last && !isHistoryGapMarker(last)) stopped.push({ historian, lastTs: last.ts });
            }
        } catch (err) {
            this.log("warn", `History: ${err.message}`);
        }
        const now = Date.now();
        // after a last value of this same millisecond (which may carry picoseconds), not before it
        for (const { historian, lastTs } of stopped) historian.push(historyGapMarker(new Date(lastTs === now ? now + 1 : now)));
    }

    // Where the "collection stopped" marker of a run that ended without one goes: the series' last value was stored
    // at lastTs (ms), this run collects from `resumedAt` (ms). Right after that last value, or at the last sign of
    // life of the killed run of this address space when that is later (a value that did not change was still valid
    // while the server ran), never at or after `resumedAt`.
    // historyGapFrom is the `stored` time of that run's last heartbeat: everything it recorded before then is in the
    // database, so a value that changed after it is not stored and its gap starts right after its last stored value.
    // Without a heartbeat row (database locked by another program for a long time, file written by an older version)
    // a value that did not change for a while before the crash gets its gap from its last change on, although the
    // server ran until later.
    gapStartAfter(lastTs, resumedAt) {
        let t = lastTs + 1;
        if (this.historyGapFrom !== null && this.historyGapFrom > t) t = this.historyGapFrom;
        return Math.min(t, resumedAt);
    }

    // After the variables of a new address space exist: HA Configuration StartOfArchive of each, and a "collection
    // stopped" marker for a run that ended without one (killed, crashed, power loss), at the start of this run before
    // its first value, so the time in between is a gap, not a slope between the values on both sides of it.
    finishValueHistory() {
        const store = this.historyCtx && this.historyCtx.store;
        const startedAt = this.historyRunStart;
        if (!store || !startedAt) return;
        const restarted = [];
        // another running server records into this database: its series are not interrupted by this start
        const shared = this.historyPeers.length > 0;
        try {
            // all reads first: a read writes what is queued, so pushing in between would mean one write per variable
            for (const [key, { historian }] of this.historians) {
                if (!shared && historian.armed && historian.recording) {
                    const last = store.valueBefore(key, startedAt.getTime());
                    if (last && !isHistoryGapMarker(last)) restarted.push({ historian, at: this.gapStartAfter(last.ts, startedAt.getTime()) });
                }
                this.updateStartOfArchive(key, true);
            }
        } catch (err) {
            this.log("warn", `History: ${err.message}`);
        }
        for (const { historian, at } of restarted) historian.push(historyGapMarker(new Date(at)));
        // the markers are written now, not with the next timer: a kill right after the start must not lose them
        if (restarted.length) this.flushHistory();
        // the rows of killed runs of this address space are used up (historyGapFrom stays for recording turned on later)
        this.removeInstanceRows(this.consumedInstanceRows);
        this.consumedInstanceRows = [];
    }

    // ---- servers sharing the history database (see HISTORY_HEARTBEAT_MS)

    // -> [{ name, pid, host, ns, ts, stopped }] of the meta table ([] when it cannot be read)
    instanceRows(store) {
        if (!store || !store.db) return [];
        try {
            store.flush(); // nothing else waits in between
            if (!store.db) return [];
            return store.db.prepare("SELECT name, value FROM meta WHERE name LIKE 'instance:%'").all().map((r) => {
                try {
                    const v = JSON.parse(r.value);
                    return v && typeof v === "object" ? { ...v, name: r.name, ts: Number(v.ts) } : null;
                } catch (_) {
                    return null;
                }
            }).filter((r) => r && Number.isFinite(r.ts));
        } catch (_) {
            return [];
        }
    }

    // a row of a server that looks running: updated recently (a clock a minute ahead is not trusted), and on this
    // machine its process still exists
    isLiveInstance(row, now = Date.now()) {
        const age = now - row.ts;
        if (row.stopped || age >= HISTORY_LIVE_MS || age <= -60000 || this.deadInstanceRows.has(row.name)) return false;
        if (row.host === os.hostname()) {
            if (row.pid === process.pid) return false; // an earlier run with this process id (e.g. a restarted container)
            try {
                process.kill(row.pid, 0);
            } catch (err) {
                if (err.code === "ESRCH") return false;
            }
        }
        return true;
    }

    otherRunningInstances(store) {
        const now = Date.now();
        const own = `instance:${this.instanceId}`;
        return this.instanceRows(store).filter((r) => r.name !== own && this.isLiveInstance(r, now));
    }

    // Before a start: rows that look running are looked at again once each should have been updated (at most 3 s
    // later); a row that was not updated meanwhile is a server that was killed (on another machine / container).
    async confirmHistoryPeers(store) {
        this.deadInstanceRows = new Set();
        try {
            const candidates = this.instanceRows(store).filter((r) => this.isLiveInstance(r));
            if (!candidates.length) return;
            const due = Math.max(...candidates.map((r) => r.ts)) + 2.5 * HISTORY_HEARTBEAT_MS;
            const wait = Math.max(0, Math.min(3000, due - Date.now()));
            if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
            const later = new Map(this.instanceRows(store).map((r) => [r.name, r]));
            for (const r of candidates) {
                const now = later.get(r.name);
                if (!now || now.stopped || now.ts <= r.ts) this.deadInstanceRows.add(r.name);
            }
        } catch (_) { /* treated by age alone */ }
    }

    // Before this run records: other running servers (no markers then, one warning), and the last sign of life of
    // killed or shared-stopped runs of the same address space (namespace table `ns`), where their gap starts.
    scanInstances(store, ns) {
        const now = Date.now();
        this.historyPeers = [];
        this.historyGapFrom = null;
        this.consumedInstanceRows = [];
        for (const r of this.instanceRows(store)) {
            if (this.isLiveInstance(r, now)) {
                this.historyPeers.push(r);
            } else if (r.ns === ns) {
                // stored: rows of earlier versions have only ts
                const upTo = typeof r.stored === "number" && Number.isFinite(r.stored) ? Math.min(r.stored, r.ts) : r.ts;
                if (upTo < now && (this.historyGapFrom === null || upTo > this.historyGapFrom)) this.historyGapFrom = upTo;
                this.consumedInstanceRows.push(r.name);
            } else if (now - r.ts > HISTORY_INSTANCE_ROW_MAX_AGE_MS) {
                this.consumedInstanceRows.push(r.name);
            }
        }
        if (this.historyPeers.length) {
            const who = this.historyPeers.map((r) => `pid ${r.pid} on ${r.host || "?"}`).join(", ");
            this.log("warn", `History: another running server (${who}) records into ${store.file} (same data folder). Values of variables that both servers serve are mixed in one series, and no "collection stopped" markers are written on start / stop while both run. Give each server its own data folder (--data-dir / OPCUA_DATA_DIR) unless that is intended.`);
        }
    }

    // this run's row: { pid, host, ns, ts, stored } (stopped: the server stopped without writing its markers).
    // The queue is written first, so `stored` (the time before that write) means: every value and event this run
    // recorded before it is in the database. While the queue cannot be written (locked by another program) `stored`
    // stays where it was and only `ts` (alive) moves on.
    writeHeartbeat({ stopped = false } = {}) {
        const store = this.historyCtx && this.historyCtx.store;
        if (!store || !store.db || !this.instanceId) return;
        try {
            const cutoff = Date.now();
            store.flush();
            if (!store.db) return; // damaged: the store reports that
            if (!store.pendingRows()) this.heartbeatStored = cutoff;
            const value = { pid: process.pid, host: os.hostname(), ns: this.historyCtx.ns, ts: Date.now(), stored: this.heartbeatStored, ...(stopped ? { stopped: true } : {}) };
            store.db.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)").run(`instance:${this.instanceId}`, JSON.stringify(value));
        } catch (_) { /* locked by another program for a moment, or damaged (the store reports that): next beat */ }
    }

    removeInstanceRows(names) {
        const store = this.historyCtx && this.historyCtx.store;
        if (!store || !store.db || !names.length) return;
        try {
            const st = store.db.prepare("DELETE FROM meta WHERE name = ?");
            for (const name of names) if (name) st.run(name);
        } catch (_) { /* removed by a later start */ }
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.writeHeartbeat();
        this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), HISTORY_HEARTBEAT_MS);
        if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
    }

    // ---- capacities while running

    // Values kept per historizing variable / events per event notifier, 0 = off (each 0 .. 1 000 000; a value that is
    // left out keeps the current one). Lowering one removes the oldest entries at once. Turning recording off or on
    // applies at once (Historizing attribute, EventNotifier HistoryRead bit, HistoryServerCapabilities). While the
    // server is stopped only the numbers are kept; the next start uses those of the project it is given.
    // -> { valueHistorySize, eventHistorySize, valueRecording, eventRecording, restartRequired, stats }
    // restartRequired: the running server keeps its history in memory (no database): new capacities apply on restart.
    setHistoryLimits({ valueHistorySize, eventHistorySize } = {}) {
        const values = valueHistorySize === undefined ? this.historyLimits.values : checkHistorySize(valueHistorySize, "Values kept per variable (valueHistorySize)");
        const events = eventHistorySize === undefined ? this.historyLimits.events : checkHistorySize(eventHistorySize, "Events kept per event notifier (eventHistorySize)");
        const before = this.historyLimits;
        this.historyLimits = { values, events };
        if (this.project && this.project.server) {
            this.project.server.valueHistorySize = values;
            this.project.server.eventHistorySize = events;
        }
        const running = this.state === "running" && !!this.server && !!this.historyCtx;
        const store = running ? this.historyCtx.store : null;
        if (store) {
            const valuesSwitch = (before.values > 0) !== (values > 0);
            // turned off: the "collection stopped" markers are saved first (a capacity of 0 saves nothing more)
            if (valuesSwitch && !values) {
                this.setValueRecording(false);
                store.flush();
            }
            store.setLimits(this.historyLimits);
            if (valuesSwitch && values) this.setValueRecording(true);
            if ((before.events > 0) !== (events > 0)) this.setEventRecording(events > 0);
            for (const key of this.historians.keys()) this.updateStartOfArchive(key, true);
        } else if (this.starting && this.historyStore && this.historyStore.isOpen) {
            // a start under way builds its address space with these capacities
            this.historyStore.setLimits(this.historyLimits);
        }
        const restartRequired = running && !store;
        if (before.values !== values || before.events !== events) {
            const what = (n, unit, per) => (n ? `up to ${n} ${unit} per ${per}` : `${unit.replace(/s$/, "")} recording off`);
            this.log("info", `History capacities${this.server ? "" : " (used from the next start)"}: ${what(values, "values", "historizing variable")}, ${what(events, "events", "event notifier")}${restartRequired ? " (applied on restart: the running server keeps its history in memory)" : ""}`);
        }
        const result = {
            valueHistorySize: values,
            eventHistorySize: events,
            valueRecording: values > 0,
            eventRecording: running ? this.eventRecording : events > 0,
            restartRequired,
            stats: this.getHistoryStats()
        };
        this.emit("status", this.getStatus());
        return result;
    }

    // Value recording of every historizing variable on / off while running. Off: a "collection stopped" marker after
    // the last value (as on stop). On: a marker for a killed earlier run that has none yet, then the current value as
    // the first value of the new collection. The Historizing attribute follows; stored values stay readable.
    setValueRecording(on) {
        const store = this.historyCtx && this.historyCtx.store;
        if (!store) return;
        const entries = [...this.historians.entries()];
        const shared = this.otherRunningInstances(store).length > 0;
        if (!on) {
            if (!shared) this.markCollectionStopped(entries);
            for (const [, { historian, uaVar }] of entries) {
                historian.recording = false;
                uaVar.historizing = false;
            }
            return;
        }
        const now = Date.now();
        const gaps = [];
        if (!shared) {
            try {
                for (const [key, { historian }] of entries) {
                    if (!historian.armed) continue;
                    const last = store.valueBefore(key, now);
                    if (last && !isHistoryGapMarker(last)) gaps.push({ historian, at: this.gapStartAfter(last.ts, now - 1) });
                }
            } catch (err) {
                this.log("warn", `History: ${err.message}`);
            }
        }
        for (const [, { historian, uaVar }] of entries) {
            historian.recording = true;
            uaVar.historizing = true;
        }
        for (const { historian, at } of gaps) historian.push(historyGapMarker(new Date(at)));
        const date = new Date(now);
        for (const [, { historian, uaVar }] of entries) {
            try {
                const dv = uaVar.readValue();
                historian.push(new DataValue({ value: dv.value, statusCode: dv.statusCode, sourceTimestamp: date, serverTimestamp: date }));
            } catch (_) { /* recorded with its next change */ }
        }
    }

    // Event recording on / off while running: what reaches the event notifiers from now on, their EventNotifier
    // HistoryRead bit, HistoryRead of events, AccessHistoryEventsCapability and ReadHistory on the Server object.
    // Recorded events stay in the database (readable again when recording is turned back on).
    setEventRecording(on) {
        this.eventRecording = !!on && !!this.eventReader;
        if (this.eventReader) this.eventReader.enabled = this.eventRecording;
        for (const obj of this.eventNotifiers) this.applyEventNotifierFlags(obj);
        const caps = this.server && this.server.engine && this.server.engine.historyServerCapabilities;
        if (caps) caps.accessHistoryEventsCapability = this.eventRecording;
        this.applyServerEventPermissions();
    }

    applyEventNotifierFlags(obj) {
        const on = this.eventRecording && !!this.eventReader;
        const flags = obj.eventNotifier | EventNotifierFlags.SubscribeToEvents;
        obj.setEventNotifier(on ? flags | EventNotifierFlags.HistoryRead : flags & ~EventNotifierFlags.HistoryRead);
    }

    // The standard nodeset lets every role receive the Server object's events but grants no ReadHistory (it defines no
    // history): with event recording on, the roles that receive its events may also read their history (SS-03: a read)
    applyServerEventPermissions() {
        const server = this.addressSpace && this.addressSpace.rootFolder.objects.server;
        const original = this.serverRolePermissions;
        if (!server || !Array.isArray(original) || typeof server.setRolePermissions !== "function") return;
        server.setRolePermissions(original.map((r) => ({
            roleId: r.roleId,
            permissions: this.eventRecording && r.permissions & PERM.ReceiveEvents ? r.permissions | PERM.ReadHistory : r.permissions
        })));
    }

    // HistoryServerCapabilities as this server really supports them (after buildAddressSpace: event recording known).
    setHistoryCapabilities(server) {
        const caps = server.engine && server.engine.historyServerCapabilities;
        if (!caps) return;
        caps.accessHistoryDataCapability = true;
        caps.accessHistoryEventsCapability = !!this.eventRecording;
        // what one HistoryRead returns per node at most (the rest comes with a continuation point)
        caps.maxReturnDataValues = MAX_RAW_VALUES_PER_CALL;
        caps.maxReturnEventValues = H.MAX_EVENTS_PER_CALL;
        // not bound by node-opcua (the nodeset value is false): values are stored and returned with their ServerTimestamp
        const node = server.engine.addressSpace && server.engine.addressSpace.findNode(resolveNodeId("ns=0;i=19091"));
        if (node && typeof node.setValueFromSource === "function") node.setValueFromSource({ dataType: DataType.Boolean, value: true });
    }

    // Prepares history for a new address space: namespace table of this run, event HistoryRead, the Server object.
    setupHistory(addressSpace) {
        let store = this.historyStore && this.historyStore.isOpen ? this.historyStore : null;
        const uris = addressSpace.getNamespaceArray().map((ns) => ns.namespaceUri);
        let ns = null;
        if (store) {
            try {
                ns = store.namespaceSetId(uris);
            } catch (err) {
                // e.g. a damaged file that SQLite could open: the server runs, history stays in memory for this run
                this.historyOpenError = err.message;
                this.log("error", `Cannot use the history database ${store.file}: ${err.message}. History is kept in memory only for this run (lost on stop). ${this.historyRecoveryHint(err.message)}`);
                store = null;
            }
        }
        const mapper = store ? new H.NamespaceMapper(store, ns, uris) : null;
        this.historyCtx = { store, uris, ns, mapper };
        this.instanceId = crypto.randomUUID();
        this.heartbeatStored = Date.now(); // this run has recorded nothing yet
        if (store) {
            this.scanInstances(store, ns);
            this.startHeartbeat();
        } else {
            this.historyPeers = [];
            this.historyGapFrom = null;
            this.consumedInstanceRows = [];
        }
        // 1 ms before this run's first value, so a restart marker (finishValueHistory) sorts before it
        this.historyRunStart = new Date(Date.now() - 1);
        this.historians.clear();
        this.eventNotifiers = [];
        this.capturedEvents = new WeakMap();
        this.eventRecording = !!store && this.historyLimits.events > 0;
        this.eventReader = store
            ? new H.EventHistoryReader({ store, addressSpace, uris, mapper, enabled: this.eventRecording, maxContinuationPoints: MAX_HISTORY_CONTINUATION_POINTS, log: (l, m) => this.log(l, m) })
            : null;
        // node-opcua fails the whole HistoryRead request (BadHistoryOperationInvalid) when one of its nodes has no
        // historyRead: Objects that are not event notifiers with history, Methods, types, Views. Those nodes answer
        // BadHistoryOperationUnsupported instead (on the base class of every node class; Variables and event
        // notifiers have their own historyRead).
        const unsupported = async () => new HistoryReadResult({ statusCode: StatusCodes.BadHistoryOperationUnsupported });
        let baseProto = Object.getPrototypeOf(addressSpace.rootFolder.objects);
        while (baseProto && Object.getPrototypeOf(baseProto) && baseProto.constructor && baseProto.constructor.name !== "BaseNodeImpl") {
            baseProto = Object.getPrototypeOf(baseProto);
        }
        const protos = baseProto && baseProto.constructor && baseProto.constructor.name === "BaseNodeImpl"
            ? [baseProto]
            // the class names may be minified: one node of every class instead
            : [addressSpace.rootFolder.objects, addressSpace.findNode("ns=0;i=11492"), addressSpace.findNode("ns=0;i=2041"),
                addressSpace.findNode("ns=0;i=63"), addressSpace.findNode("ns=0;i=1"), addressSpace.findNode("ns=0;i=31")]
                .filter(Boolean).map((n) => Object.getPrototypeOf(n));
        for (const proto of protos) {
            if (typeof proto.historyRead !== "function") {
                Object.defineProperty(proto, "historyRead", { value: unsupported, writable: true, configurable: true, enumerable: false });
            }
        }
        const server = addressSpace.rootFolder.objects.server;
        this.installEventHistory(server);
        this.serverRolePermissions = Array.isArray(server.rolePermissions) ? server.rolePermissions.map((r) => ({ roleId: r.roleId, permissions: r.permissions })) : null;
        if (this.eventRecording) this.applyServerEventPermissions();
        if (store) {
            const { values, events } = this.historyLimits;
            this.log("info", `History saved in ${store.file}: ${values ? `up to ${values} values per historizing variable` : "value recording off"}, ${events ? `up to ${events} events per event notifier` : "event recording off"}`);
        }
    }

    // Value history of a historizing variable: node-opcua's history (raw / modified / processed reads, continuation
    // points) on the database, plus ReadAtTime. Returns the history key, null without database.
    installValueHistory(uaVar) {
        const { store, uris, ns, mapper } = this.historyCtx || {};
        if (!store) {
            this.addressSpace.installHistoricalDataNode(uaVar, { maxOnlineValues: 10000 });
            this.installReadAtTime(uaVar);
            return null;
        }
        const key = H.nodeKey(uaVar.nodeId, uris);
        const historian = new H.StoreHistorian(store, key, { ns, mapper });
        this.addressSpace.installHistoricalDataNode(uaVar, { historian });
        this.installReadAtTime(uaVar);
        historian.recording = this.historyLimits.values > 0;
        // Historizing means "the server is collecting history" (OPC 10000-3 5.6.2): not while recording is off;
        // what is stored stays readable (AccessLevel HistoryRead)
        if (!historian.recording) uaVar.historizing = false;
        historian.armed = true;
        // StartOfArchive is set by finishValueHistory() once all variables exist (one database write instead of one
        // per variable: every read writes the queued values first)
        this.historians.set(key, { historian, uaVar, archiveUpdated: 0 });
        return key;
    }

    // node-opcua answers ReadAtTimeDetails with BadHistoryOperationUnsupported: values at given times are answered
    // here, every other HistoryRead goes on to node-opcua (raw, modified, processed).
    installReadAtTime(uaVar) {
        const historyRead = uaVar._historyRead;
        const log = (message) => this.log("warn", message);
        uaVar._historyRead = function (context, details, indexRange, dataEncoding, continuationData, callback) {
            if (!(details instanceof ReadAtTimeDetails)) return historyRead.call(this, context, details, indexRange, dataEncoding, continuationData, callback);
            let result;
            try {
                result = H.readAtTime(this, context, details, continuationData);
            } catch (err) {
                log(`HistoryRead at time on ${this.nodeId.toString()} failed: ${err.message}`);
                result = new HistoryReadResult({ statusCode: StatusCodes.BadInternalError });
            }
            callback(null, result);
            return undefined;
        };
    }

    // HA Configuration StartOfArchive / StartOfOnlineArchive = the oldest stored value (at most every 10 s per variable)
    updateStartOfArchive(key, force = false) {
        const h = this.historians.get(key);
        if (!h || !this.historyStore) return;
        const now = Date.now();
        if (!force && now - h.archiveUpdated < 10000) return;
        h.archiveUpdated = now;
        try {
            const oldest = this.historyStore.oldestValueTime(key);
            const date = new Date(oldest ?? now);
            const config = h.uaVar.$historicalDataConfiguration;
            config?.startOfOnlineArchive?.setValueFromSource({ dataType: DataType.DateTime, value: date });
            config?.startOfArchive?.setValueFromSource({ dataType: DataType.DateTime, value: date });
        } catch (_) { /* informational only */ }
    }

    // Event notifier (Server object, project folders and objects): with event history on it records every event that
    // reaches it and offers HistoryRead (EventNotifier bit HistoryRead); otherwise SubscribeToEvents only.
    installEventHistory(obj) {
        this.applyEventNotifierFlags(obj);
        if (!this.eventReader) return;
        const key = H.nodeKey(obj.nodeId, this.historyCtx.uris);
        this.eventReader.install(obj, key);
        // also while recording is off: it can be turned on while the server runs (recordEvent checks it)
        this.eventNotifiers.push(obj);
        obj.on("event", (eventData) => this.recordEvent(key, eventData));
    }

    recordEvent(key, eventData) {
        const store = this.historyStore;
        if (!this.eventRecording || !store) return;
        // a ConditionRefresh re-sends retained conditions (and its Refresh events) to one subscription: not new events
        if (this.addressSpace && this.addressSpace._condition_refresh_in_progress) return;
        let record = this.capturedEvents.get(eventData);
        if (!record) {
            try {
                record = H.captureEvent(eventData, this.historyCtx);
            } catch (err) {
                this.log("debug", `Event not recorded in history: ${err.message}`);
                return;
            }
            if (!record) return;
            this.capturedEvents.set(eventData, record);
            store.queueEvent(record);
        }
        store.addEventNotifier(record, key);
    }

    // history key of a project node (also while the server is stopped: from the project it last ran)
    projectNodeKey(id, kinds) {
        if (!this.project) return null;
        let found = null;
        const walk = (nodes, prefix) => {
            for (const node of nodes || []) {
                if (found) return;
                const p = prefix ? `${prefix}/${node.name}` : node.name;
                if (node.id === id) {
                    found = { node, path: p };
                    return;
                }
                walk(node.children, p);
            }
        };
        walk(this.project.nodes, "");
        if (!found || !kinds.includes(found.node.kind)) return null;
        try {
            const nodeId = resolveNodeId(`ns=1;${this.nodeIdentifier(found.node, found.path)}`);
            return { key: `${this.project.server.namespaceUri}|${nodeId.toString().replace(/^ns=\d+;/, "")}`, path: found.path };
        } catch (_) {
            return null;
        }
    }

    variableHistoryKey(id) {
        const e = this.vars.get(id);
        if (e) return { key: e.historyKey || H.nodeKey(e.uaVar.nodeId, this.historyCtx?.uris || []), path: e.path };
        return this.projectNodeKey(id, ["variable"]);
    }

    // "server" (the Server object) or the id of a project folder / object
    notifierHistoryKey(notifier) {
        if (!notifier || notifier === "server") return { key: "http://opcfoundation.org/UA/|i=2253", path: "Server" };
        const o = this.objects.get(notifier);
        if (o) return { key: H.nodeKey(o.uaNode.nodeId, this.historyCtx?.uris || []), path: o.path };
        return this.projectNodeKey(notifier, ["folder", "object"]);
    }

    // replaceDamaged: for "clear all", which may as well start a new database when the old one is unreadable
    requireHistory({ replaceDamaged = false } = {}) {
        this.replacingDamaged = replaceDamaged;
        let store;
        try {
            store = this.openHistory();
        } finally {
            this.replacingDamaged = false;
        }
        if (!store && replaceDamaged && this.replaceDamagedHistory()) store = this.historyStore;
        if (!store) throw this.historyError(new Error(`The history database cannot be used: ${this.historyOpenError}`));
        return store;
    }

    // Stored values of a variable between two times (default: the last hour), oldest first: the latest 10000 of that
    // range when it holds more. Works from the database also while the server is stopped (variables of the project
    // it last ran).
    async getHistory(id, startTime, endTime) {
        const e = this.vars.get(id);
        if (e && !e.node.variable.historizing) throw new Error("Variable is not historizing");
        const start = startTime ? new Date(startTime) : new Date(Date.now() - 3600 * 1000);
        const end = endTime ? new Date(endTime) : new Date();
        const max = 10000;
        if (e && !e.historyKey) {
            // running without the database: node-opcua's in-memory history (newest first, then put in time order)
            const historian = e.uaVar.varHistorian;
            const values = await new Promise((resolve, reject) => {
                historian.extractDataValues({ startTime: start, endTime: end, isReadModified: false, returnBounds: false }, max, true, true,
                    (err, dvs) => (err ? reject(err) : resolve(dvs)));
            });
            return (values || []).map(V.dataValueToPlain);
        }
        const target = this.variableHistoryKey(id);
        if (!target) throw new Error(this.project ? "Unknown variable" : "Server is not running");
        let rows;
        try {
            rows = this.requireHistory().valueRows(target.key, { start: start.getTime(), end: end.getTime(), reverse: true, limit: max });
        } catch (err) {
            throw this.historyError(err);
        }
        const mapper = this.historyCtx?.mapper || null;
        return rows.reverse().map((row) => V.dataValueToPlain(H.rowToDataValue(row, mapper)));
    }

    // -> { file, sizeBytes, values, events, maxValuesPerVariable, maxEventsPerNotifier } (events: distinct recorded
    // events; the max: the most values one variable / events one notifier keeps). When the database cannot be used:
    // `error`, `hint` (what to do about it) and `inMemory` (true: the server keeps the history of its run in memory
    // only; false: a running server that recorded into the file loses new values and events).
    getHistoryStats() {
        const file = path.join(this.dataDir, "history", "history.db");
        // a running server records into the file it opened at start (else in memory, for that run)
        const inMemory = !(this.server && this.historyCtx && this.historyCtx.store);
        const withError = (stats, error) => {
            const hint = this.historyRecoveryHint(error);
            return { ...stats, error, inMemory, ...(hint ? { hint } : {}) };
        };
        const unreadable = (error) => {
            let sizeBytes = 0;
            try { sizeBytes = fs.statSync(file).size; } catch (_) { /* no file */ }
            return withError({ file, sizeBytes, values: 0, events: 0, maxValuesPerVariable: 0, maxEventsPerNotifier: 0 }, error);
        };
        const store = this.openHistory();
        if (!store) return unreadable(this.historyOpenError);
        let stats;
        try {
            stats = store.stats();
        } catch (err) {
            // SQLite opened the file, but its pages are damaged
            return unreadable(err.message);
        }
        // opened now (e.g. replaced by "clear all"), but the running server started without it: from the next start
        if (this.server && inMemory) return withError(stats, this.historyOpenError || "the running server keeps its history in memory until it is restarted");
        return stats;
    }

    // { variableId } clears one variable, { all: true } every variable. Cannot be undone. -> getHistoryStats()
    // Clearing all replaces a damaged database by a new, empty one (`replaced: true`; its events are gone too).
    clearHistory({ variableId, all } = {}) {
        if (all) {
            return this.clearAllWith((store) => {
                const n = store.clearValues(null);
                this.log("info", `All value history cleared (${n} value${n === 1 ? "" : "s"} removed)`);
                for (const key of this.historians.keys()) this.updateStartOfArchive(key, true);
                store.stats(); // damage found here replaces the file too
            });
        }
        const store = this.requireHistory();
        const target = this.variableHistoryKey(variableId);
        if (!target) throw new Error("Unknown variable");
        try {
            const n = store.clearValues(target.key);
            this.log("info", `Value history of ${target.path} cleared (${n} value${n === 1 ? "" : "s"} removed)`);
            this.updateStartOfArchive(target.key, true);
            return this.getHistoryStats();
        } catch (err) {
            throw this.historyError(err);
        }
    }

    // Latest recorded events of a notifier ("server" or a project folder / object id), newest first.
    // -> [{ time, eventType, sourceName, message, severity, conditionName? }]
    getEventHistory({ notifier = "server", limit = 200 } = {}) {
        const target = this.notifierHistoryKey(notifier);
        if (!target) throw new Error("Unknown event notifier");
        const n = Math.max(1, Math.min(10000, Math.floor(Number(limit)) || 200));
        try {
            return this.requireHistory().eventRows(target.key, { reverse: true, limit: n }).map(H.eventRowToPlain);
        } catch (err) {
            throw this.historyError(err);
        }
    }

    // { notifier } clears what one notifier recorded, { all: true } all events. Cannot be undone. -> getHistoryStats()
    // Clearing all replaces a damaged database by a new, empty one (`replaced: true`; its values are gone too).
    clearEventHistory({ notifier, all } = {}) {
        if (all) {
            return this.clearAllWith((store) => {
                const n = store.clearEvents(null);
                this.log("info", `All event history cleared (${n} entr${n === 1 ? "y" : "ies"} removed)`);
                store.stats(); // damage found here replaces the file too
            });
        }
        const store = this.requireHistory();
        const target = this.notifierHistoryKey(notifier);
        if (!target) throw new Error("Unknown event notifier");
        try {
            const n = store.clearEvents(target.key);
            this.log("info", `Event history of ${target.path} cleared (${n} event${n === 1 ? "" : "s"} removed)`);
            return this.getHistoryStats();
        } catch (err) {
            throw this.historyError(err);
        }
    }

    // Headless --clear-history: every value and event, before the server starts (a damaged database is replaced).
    // -> getHistoryStats()
    clearAllHistory() {
        if (this.server || this.starting) throw new Error("Stop the server before clearing all history");
        const values = this.clearHistory({ all: true });
        const stats = this.clearEventHistory({ all: true });
        return values.replaced || stats.replaced ? { ...stats, replaced: true } : stats;
    }

    // ---------------------------------------------------------------- events & alarms

    raiseEvent({ eventType = "BaseEventType", message = "", severity = 500, sourceId = null }) {
        this.requireRunning();
        const src = sourceId ? this.objects.get(sourceId)?.uaNode : this.addressSpace.rootFolder.objects.server;
        if (!src) throw new Error("Unknown event source");
        const type = this.addressSpace.findEventType(eventType);
        if (!type) throw new Error(`Unknown event type ${eventType}`);
        src.raiseEvent(type, {
            message: { dataType: DataType.LocalizedText, value: new LocalizedText({ text: message, locale: "en" }) },
            severity: { dataType: DataType.UInt16, value: Number(severity) || 500 },
            sourceName: { dataType: DataType.String, value: src.browseName.name },
            sourceNode: { dataType: DataType.NodeId, value: src.nodeId }
        });
        this.log("info", `Event raised (${eventType}, severity ${severity}): ${message}`);
    }

    getAlarms() {
        const out = [];
        for (const [id, { alarm, path: p, node }] of this.alarms) {
            const safe = (fn, d = null) => { try { return fn(); } catch (_) { return d; } };
            const limitState = safe(() => alarm.limitState?.getCurrentState?.());
            const nonExclusive = node.alarm.type === "NonExclusiveLimit"
                ? ["highHighState", "highState", "lowState", "lowLowState"].filter((k) => safe(() => alarm[k]?.getValue())).map((k) => k.replace("State", ""))
                : [];
            out.push({
                id,
                path: p,
                type: node.alarm.type,
                source: this.vars.get(node.alarm.sourceId)?.path || "?",
                nodeId: alarm.nodeId.toString(),
                enabled: safe(() => alarm.getEnabledState(), false),
                active: safe(() => alarm.activeState.getValue(), false),
                acked: safe(() => alarm.ackedState.getValue(), true),
                confirmed: safe(() => alarm.confirmedState?.getValue(), true),
                retain: safe(() => alarm.retain.readValue().value.value, false),
                severity: safe(() => alarm.severity.readValue().value.value, 0),
                message: safe(() => alarm.message.readValue().value.value.text, ""),
                limitState: limitState || nonExclusive.join(", ") || "",
                limits: { highHigh: node.alarm.highHigh, high: node.alarm.high, low: node.alarm.low, lowLow: node.alarm.lowLow }
            });
        }
        return out;
    }

    alarmAction(id, action, comment = "") {
        this.requireRunning();
        const a = this.alarms.get(id);
        if (!a) throw new Error("Unknown alarm");
        const { alarm } = a;
        const branch = alarm.currentBranch();
        const text = comment || `${action} from Simulator UI`;
        switch (action) {
            case "enable": alarm.setEnabledState(true); break;
            case "disable": alarm.setEnabledState(false); break;
            case "acknowledge": alarm._acknowledge_branch(branch.getEventId(), text, branch, "Acknowledged"); break;
            case "confirm": alarm._confirm_branch(branch.getEventId(), text, branch, "Confirmed"); break;
            case "severity":
                a.severity = Math.max(1, Math.min(1000, Number(comment) || 500));
                this.setAlarmSeverity(alarm, a.severity);
                break;
            default: throw new Error(`Unknown alarm action ${action}`);
        }
        this.log("info", `Alarm ${a.path}: ${action}`);
    }

    // ---------------------------------------------------------------- status

    getEndpointUrls() {
        if (!this.server) return [];
        return [...new Set(this.server.endpoints.flatMap((ep) => ep.endpointDescriptions().map((d) => d.endpointUrl)).filter(Boolean))];
    }

    getEndpoints() {
        if (!this.server) return [];
        const out = [];
        for (const ep of this.server.endpoints) {
            for (const d of ep.endpointDescriptions()) {
                out.push({
                    url: d.endpointUrl,
                    securityPolicy: d.securityPolicyUri.split("#")[1],
                    securityMode: MessageSecurityMode[d.securityMode],
                    securityLevel: d.securityLevel,
                    restricted: !!d.restricted, // discovery-only endpoint of a server without SecurityMode None
                    userTokens: (d.userIdentityTokens || []).map((t) => UserTokenType[t.tokenType])
                });
            }
        }
        return out;
    }

    getStatus() {
        const status = {
            state: this.state,
            error: this.error,
            port: this.project?.server?.port ?? null,
            resourcePath: this.project?.server?.resourcePath ?? "",
            startTime: this.startTime ? this.startTime.toISOString() : null,
            endpointUrls: this.getEndpointUrls(),
            endpoints: [],
            sessions: [],
            diagnostics: null,
            serverState: null,
            discoveryServer: !!this.discoveryServer,
            namespaceIndex: this.nsIndex ?? null,
            simulationPaused: this.simPausedAll,
            // capacities in use (setHistoryLimits); eventRecording: the running server records events
            history: {
                valueHistorySize: this.historyLimits.values,
                eventHistorySize: this.historyLimits.events,
                eventRecording: this.server ? this.eventRecording : this.historyLimits.events > 0
            }
        };
        if (!this.server || this.state !== "running") return status;
        status.endpoints = this.getEndpoints();
        const eng = this.server.engine;
        try {
            const d = eng.serverDiagnosticsSummary;
            status.diagnostics = {
                currentSessionCount: d.currentSessionCount,
                cumulatedSessionCount: d.cumulatedSessionCount,
                currentSubscriptionCount: d.currentSubscriptionCount,
                cumulatedSubscriptionCount: d.cumulatedSubscriptionCount,
                securityRejectedSessionCount: d.securityRejectedSessionCount,
                rejectedSessionCount: d.rejectedSessionCount,
                sessionTimeoutCount: d.sessionTimeoutCount,
                sessionAbortCount: d.sessionAbortCount,
                securityRejectedRequestsCount: d.securityRejectedRequestsCount,
                rejectedRequestsCount: d.rejectedRequestsCount,
                currentChannels: this.server.currentChannelCount ?? null
            };
            status.serverState = ServerState[eng.getServerState ? eng.getServerState() : ServerState.Running];
        } catch (_) { /* diagnostics are best effort */ }
        for (const s of this.sessions.values()) {
            try {
                status.sessions.push({
                    id: s.nodeId.toString(),
                    name: s.sessionName,
                    client: s.clientDescription?.applicationName?.text || "",
                    clientUri: s.clientDescription?.applicationUri || "",
                    securityPolicy: s.channel?.securityPolicy?.split("#")[1] || "",
                    securityMode: s.channel ? MessageSecurityMode[s.channel.securityMode] : "",
                    remote: s.channel ? `${s.channel.remoteAddress}:${s.channel.remotePort}` : "",
                    user: s.userIdentityToken?.userName || (s.userIdentityToken?.constructor?.name || "").replace("IdentityToken", ""),
                    subscriptions: s.publishEngine?.subscriptionCount ?? 0,
                    created: s.creationDate ? s.creationDate.toISOString() : null,
                    status: s.status
                });
            } catch (_) { /* ignore */ }
        }
        return status;
    }

    setServerState(name) {
        this.requireRunning();
        const value = ServerState[name];
        if (value === undefined) throw new Error(`Unknown server state ${name}`);
        this.server.engine.setServerState(value);
        this.log("info", `ServerStatus.State set to ${name}`);
    }

    closeSession(id) {
        this.requireRunning();
        const s = this.sessions.get(id);
        if (!s) throw new Error("Unknown session");
        this.server.engine.closeSession(s.authenticationToken, true, "Forcing");
        this.log("warn", `Session ${s.sessionName} closed by operator`);
    }

    // ---------------------------------------------------------------- certificates

    async getCertificateManager(which) {
        const cfg = this.project?.server || {};
        if (which === "server") return this.serverCM || this.createCertificateManager("server", !!cfg.autoAcceptCertificates);
        // the user store never auto-accepts (SS-01), even when created on demand for the Certificates view
        if (which === "user") return this.userCM || this.createCertificateManager("user", false);
        throw new Error(`Unknown certificate store ${which}`);
    }

    async listCertificates(which) {
        return listCertificates(await this.getCertificateManager(which));
    }

    // Trusts a client APPLICATION certificate (DER, base64) in the server's PKI and removes any rejected copy.
    // Used by the built-in client's "server refused this client's certificate" dialog when the server is this
    // simulator itself (ClientEngine.lastClientCertificateRejection().ownServer). Takes effect on the next connect.
    async trustClientCertificate(derBase64) {
        const der = Buffer.from(String(derBase64 || ""), "base64");
        if (!der.length) throw new Error("No certificate to trust");
        const thumb = new crypto.X509Certificate(der).fingerprint256;
        const cm = await this.getCertificateManager("server");
        const temporary = cm !== this.serverCM;
        try {
            await cm.trustCertificate(der);
            const rejected = cm.rejectedFolder;
            if (rejected && fs.existsSync(rejected)) {
                for (const f of fs.readdirSync(rejected)) {
                    if (!/\.(pem|der)$/i.test(f)) continue;
                    const file = path.join(rejected, f);
                    try { if (new crypto.X509Certificate(fs.readFileSync(file)).fingerprint256 === thumb) fs.unlinkSync(file); } catch (_) { /* ignore unreadable entries */ }
                }
            }
            this.log("info", `Client certificate trusted (${new crypto.X509Certificate(der).subject.replace(/\n/g, ", ")})`);
        } finally {
            if (temporary) { try { await cm.dispose(); } catch (_) { /* ignore */ } }
        }
        return true;
    }

    async certificateAction(which, action, file) {
        const cm = await this.getCertificateManager(which);
        // a manager created just for this action (server never started) is released again afterwards
        const temporary = cm !== this.serverCM && cm !== this.userCM;
        try {
            if (action === "regenerateOwn") {
                if (this.server || this.starting) throw new Error("Stop the server before regenerating its certificate");
                // node-opcua creates a fresh self-signed certificate (with current host names / IPs) on next start
                for (const f of fs.readdirSync(cm.ownCertFolder)) {
                    if (/\.(pem|der)$/i.test(f)) fs.unlinkSync(path.join(cm.ownCertFolder, f));
                }
                this.log("info", "Server certificate removed; a new one is created on the next start");
                return;
            }
            await certificateAction(cm, action, file);
            this.log("info", `Certificate ${action}: ${path.basename(file)} (${which} store)`);
        } finally {
            if (temporary) { try { await cm.dispose(); } catch (_) { /* ignore */ } }
        }
    }
}

module.exports = {
    ServerEngine, ROLE_NAMES, EVENT_TYPES, NODESET_DEPENDENCIES, parseAdvertisedUrls,
    SECURE_PRESET, securityWarnings, projectScriptsHash, projectScriptSummary
};
