"use strict";
// Runs the simulated OPC UA server: builds the address space from a project, drives simulations,
// exposes alarms, events, history, sessions and certificate management to the UI.
const path = require("path");
const fs = require("fs");
const os = require("os");
const vm = require("vm");
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
    makeAccessLevelFlag,
    makeEUInformation,
    nodesets
} = require("node-opcua");
const V = require("./valueUtils");
const { listCertificates, certificateAction } = require("./pki");
const { checkPort, findFreePort, portProblemMessage, localIPv4Addresses } = require("./network");

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

// Host name or IP of an opc.tcp URL (without the brackets of an IPv6 literal).
function urlHost(url) {
    return new URL(url.replace(/^opc\.tcp:\/\//i, "http://")).hostname.replace(/^\[(.*)\]$/, "$1");
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
    }

    log(level, message) {
        this.emit("log", { time: new Date().toISOString(), level, source: "server", message });
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
    start(project) {
        // start after a pending stop: the last request wins (start -> stop -> start ends running)
        if (this.stopping) return this.stopping.then(() => this.start(project));
        if (this.starting) return this.starting;
        if (this.server) return Promise.reject(new Error("Server is already running"));
        this.starting = this.doStart(project).finally(() => { this.starting = null; });
        return this.starting;
    }

    async doStart(project) {
        this.project = JSON.parse(JSON.stringify(project));
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
            this.userCM = await this.createCertificateManager("user", !!cfg.autoAcceptCertificates);
            const { files, keys } = this.resolveNodesets(cfg);
            this.log("info", `Loading ${files.length} nodeset file(s)${keys.length ? " (companion: " + keys.join(", ") + ")" : ""}`);

            const users = cfg.users || [];
            const server = new OPCUAServer({
                port: Number(cfg.port) || 4840,
                resourcePath: cfg.resourcePath || "",
                hostname: cfg.hostname || undefined,
                alternateHostname: this.alternateHostnames(cfg),
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
                    isValidUser: (username, password) => !!cfg.allowUsername && users.some((u) => u.username === username && u.password === password),
                    getUserRoles: (username) => {
                        const u = users.find((x) => x.username === username);
                        return makeRoles(u && ROLE_NAMES.includes(u.role) ? ["AuthenticatedUser", u.role].join(";") : "AuthenticatedUser");
                    }
                },
                serverCertificateManager: this.serverCM,
                userCertificateManager: this.userCM,
                serverCapabilities: {
                    maxSessions: Number(cfg.maxSessions) || 100,
                    maxSubscriptions: Number(cfg.maxSubscriptions) || 1000,
                    minSupportedSampleRate: Number(cfg.minSupportedSampleRate) || 100,
                    maxBrowseContinuationPoints: 10,
                    maxHistoryContinuationPoints: 10,
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
            this.wireServerEvents(server);

            await server.initialize();
            this.restrictUserTokens(server, cfg);
            this.checkUserTokens();
            this.buildAddressSpace(server.engine.addressSpace);
            await server.start();
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
        const names = String(cfg.alternateHostnames || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
        if (cfg.advertiseIpAddresses !== false) names.push(...localIPv4Addresses());
        // the primary host name is repeated here on purpose: node-opcua de-duplicates endpoints, but only
        // alternate names end up in the self-signed certificate
        if (cfg.hostname) names.unshift(cfg.hostname);
        return [...new Set(names)];
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
        const cm = await this.createCertificateManager("discovery", true);
        this.discoveryServer = new OPCUADiscoveryServer({ port: Number(cfg.discoveryServerPort) || 4841, serverCertificateManager: cm });
        await this.discoveryServer.start();
        this.log("info", `Local Discovery Server started on port ${cfg.discoveryServerPort}`);
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
        const objectsFolder = addressSpace.rootFolder.objects;
        const pending = [];
        for (const node of this.project.nodes || []) this.buildNode(node, objectsFolder, true, "", pending);
        // methods and alarms can reference variables anywhere in the tree, so they are created last
        for (const fn of pending) {
            try { fn(); } catch (err) { this.log("error", err.message); }
        }
        this.log("info", `Address space ready: ${this.vars.size} variables, ${this.alarms.size} alarms (namespace ${this.nsIndex} = ${cfg.namespaceUri})`);
    }

    makeNodeId(node, fullPath) {
        let id = (node.nodeId || "").trim();
        if (!id) id = "s=" + fullPath.replace(/\//g, ".");
        if (/^ns=\d+;/.test(id)) id = id.replace(/^ns=\d+;/, "");
        if (!/^(s|i|g|b)=/.test(id)) id = "s=" + id;
        return `ns=${this.nsIndex};${id}`;
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
        if (v.historizing) this.addressSpace.installHistoricalDataNode(uaVar, { maxOnlineValues: 10000 });
        uaVar.setValueFromSource(variant, StatusCodes.Good, new Date());
        const entry = { id: node.id, node, uaVar, path: fullPath, paused: false, sim: { state: null, timer: null, t0: Date.now() } };
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
        const script = new vm.Script(`(function(inputs){\n${m.script || "return [];"}\n})`, { filename: fullPath });
        const sandbox = vm.createContext({
            Math, Date, JSON, Number, String, Boolean, Array, Object,
            getValue: (p) => this.readByPath(p),
            setValue: (p, val) => this.writeByPath(p, val),
            log: (msg) => this.log("info", `[${fullPath}] ${msg}`)
        });
        const fn = script.runInContext(sandbox, { timeout: 1000 });
        method.bindMethod((inputArguments, context, callback) => {
            try {
                const inputs = inputArguments.map((a) => V.variantToPlain(a));
                this.log("info", `Method ${fullPath} called with ${JSON.stringify(inputs)}`);
                const result = fn(inputs) || [];
                const outputArguments = (m.outputs || []).map((o, i) => V.makeVariant(result[i] ?? V.defaultValueFor(o.dataType, -1), o.dataType, -1));
                callback(null, { statusCode: StatusCodes.Good, outputArguments });
            } catch (err) {
                this.log("error", `Method ${fullPath} failed: ${err.message}`);
                callback(null, { statusCode: StatusCodes.BadInternalError });
            }
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
            if (!s || s.type === "none") continue;
            const interval = Math.max(50, Number(s.interval) || 1000);
            try { this.simulateTick(e); } catch (_) { /* reported by the timer below */ }
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
        if (value === null) return;
        e.uaVar.setValueFromSource(V.makeVariant(value, v.dataType, valueRank), StatusCodes.Good, new Date());
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

    async getHistory(id, startTime, endTime) {
        this.requireRunning();
        const e = this.vars.get(id);
        if (!e) throw new Error("Unknown variable");
        const historian = e.uaVar.varHistorian;
        if (!historian) throw new Error("Variable is not historizing");
        const start = startTime ? new Date(startTime) : new Date(Date.now() - 3600 * 1000);
        const end = endTime ? new Date(endTime) : new Date();
        const values = await new Promise((resolve, reject) => {
            historian.extractDataValues({ startTime: start, endTime: end, isReadModified: false, returnBounds: false }, 10000, false, false,
                (err, dvs) => (err ? reject(err) : resolve(dvs)));
        });
        return (values || []).map(V.dataValueToPlain);
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
            simulationPaused: this.simPausedAll
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
        if (which === "user") return this.userCM || this.createCertificateManager("user", !!cfg.autoAcceptCertificates);
        throw new Error(`Unknown certificate store ${which}`);
    }

    async listCertificates(which) {
        return listCertificates(await this.getCertificateManager(which));
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

module.exports = { ServerEngine, ROLE_NAMES, EVENT_TYPES, NODESET_DEPENDENCIES, parseAdvertisedUrls };
