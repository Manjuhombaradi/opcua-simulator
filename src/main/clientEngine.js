"use strict";
// Generic OPC UA client used by the "Client" view: discovery, browse, read, write, subscriptions,
// events/alarms, method calls and history read against any OPC UA server.
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");
const {
    OPCUAClient,
    OPCUACertificateManager,
    ClientSubscription,
    ClientMonitoredItem,
    MessageSecurityMode,
    SecurityPolicy,
    UserTokenType,
    AttributeIds,
    NodeClass,
    BrowseDirection,
    DataType,
    DataValue,
    TimestampsToReturn,
    StatusCodes,
    DataChangeFilter,
    DataChangeTrigger,
    DeadbandType,
    constructEventFilter,
    coerceNodeId,
    accessLevelFlagToString,
    findBasicDataType,
    ObjectTypeIds,
    MethodIds,
    ServerState,
    ApplicationType
} = require("node-opcua");
const { readCertificate, readPrivateKeyPEM } = require("node-opcua-crypto");
const V = require("./valueUtils");

// Runs `step` and resolves when its promise settles or after `ms`, whichever comes first (errors are ignored). Used for
// shutdown steps that can hang forever on a dead channel, e.g. subscription.terminate() while reconnecting.
function settleWithin(step, ms) {
    let timer;
    return Promise.race([
        new Promise((resolve) => resolve(step())).catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, ms); })
    ]).finally(() => clearTimeout(timer));
}

const EVENT_FIELDS = [
    "EventId", "EventType", "SourceNode", "SourceName", "Time", "ReceiveTime", "Message", "Severity",
    "ConditionName", "BranchId", "Retain", "EnabledState.Id", "ActiveState", "ActiveState.Id", "AckedState.Id",
    "ConfirmedState.Id", "Quality", "ConditionId"
];

class ClientEngine extends EventEmitter {
    constructor(dataDir) {
        super();
        this.dataDir = dataDir;
        this.client = null;
        this.session = null;
        this.subscription = null;
        this.items = new Map(); // itemId -> { monitoredItem, nodeId, kind }
        this.nextItemId = 1;
        this.pendingChanges = new Map();
        this.flushTimer = null;
        this.state = "disconnected";
        this.connectionInfo = null;
        this.dataTypeCache = new Map();
    }

    log(level, message) {
        this.emit("log", { time: new Date().toISOString(), level, source: "client", message });
    }

    setState(state, extra = {}) {
        this.state = state;
        this.emit("status", { state, ...this.connectionInfo, ...extra });
    }

    async certificateManager() {
        if (!this.cm) {
            this.cm = new OPCUACertificateManager({ rootFolder: path.join(this.dataDir, "pki", "client"), automaticallyAcceptUnknownCertificate: true });
            await this.cm.initialize();
        }
        return this.cm;
    }

    async createClient(opts = {}) {
        return OPCUAClient.create({
            applicationName: "OPC UA Simulator Client",
            applicationUri: "urn:opcua-simulator:client",
            clientName: "OPCUASimulatorClient",
            securityMode: MessageSecurityMode[opts.securityMode || "None"],
            securityPolicy: SecurityPolicy[opts.securityPolicy || "None"],
            endpointMustExist: false,
            keepSessionAlive: true,
            requestedSessionTimeout: Number(opts.sessionTimeout) || 60000,
            connectionStrategy: { initialDelay: 1000, maxDelay: 10000, maxRetry: opts.maxRetry ?? 1 },
            clientCertificateManager: await this.certificateManager()
        });
    }

    // ---------------------------------------------------------------- discovery

    async getEndpoints(url) {
        const client = await this.createClient({ maxRetry: 0 });
        try {
            await client.connect(url);
            const endpoints = await client.getEndpoints();
            return endpoints.map((e) => ({
                url: e.endpointUrl,
                securityPolicy: e.securityPolicyUri.split("#")[1],
                securityMode: MessageSecurityMode[e.securityMode],
                securityLevel: e.securityLevel,
                serverName: e.server?.applicationName?.text || "",
                applicationUri: e.server?.applicationUri || "",
                userTokens: (e.userIdentityTokens || []).map((t) => ({ type: UserTokenType[t.tokenType], policyId: t.policyId, securityPolicy: (t.securityPolicyUri || "").split("#")[1] || "" }))
            }));
        } finally {
            try { await client.disconnect(); } catch (_) { /* ignore */ }
        }
    }

    async findServers(url) {
        const client = await this.createClient({ maxRetry: 0 });
        try {
            await client.connect(url);
            const servers = await client.findServers();
            return servers.map((s) => ({
                applicationName: s.applicationName?.text || "",
                applicationUri: s.applicationUri,
                productUri: s.productUri,
                applicationType: ApplicationType[s.applicationType],
                discoveryUrls: s.discoveryUrls || []
            }));
        } finally {
            try { await client.disconnect(); } catch (_) { /* ignore */ }
        }
    }

    // ---------------------------------------------------------------- connection

    async connect(opts) {
        if (this.client) await this.disconnect();
        this.connectionInfo = { url: opts.url, securityMode: opts.securityMode, securityPolicy: opts.securityPolicy, authType: opts.authType };
        this.setState("connecting");
        const client = await this.createClient({ ...opts, maxRetry: opts.autoReconnect ? -1 : 1 });
        this.client = client;
        client.on("backoff", (n, delay) => this.log("warn", `Connection attempt ${n} failed, retrying in ${delay} ms`));
        // ignore late events of a client that has already been disconnected / replaced
        client.on("connection_lost", () => { if (this.client !== client) return; this.log("warn", "Connection lost"); this.setState("reconnecting"); });
        client.on("connection_reestablished", () => { if (this.client !== client) return; this.log("info", "Connection re-established"); this.setState("connected"); });
        client.on("start_reconnection", () => this.log("info", "Reconnecting..."));
        client.on("after_reconnection", (err) => err && this.log("error", `Reconnection failed: ${err.message}`));
        try {
            await client.connect(opts.url);
            const identity = this.makeIdentity(opts, client);
            const session = await client.createSession(identity);
            this.session = session;
            session.on("keepalive", (state) => this.emit("keepalive", { state: ServerState[state] ?? state, time: new Date().toISOString() }));
            session.on("keepalive_failure", () => this.log("warn", "Session keep-alive failure"));
            session.on("session_closed", (sc) => this.log("warn", `Session closed by server (${sc?.name || ""})`));
            session.on("session_restored", () => this.log("info", "Session restored"));
            await this.createSubscription(opts);
            this.log("info", `Connected to ${opts.url} (${opts.securityPolicy}/${opts.securityMode}, ${opts.authType})`);
            this.setState("connected", { sessionId: session.sessionId.toString() });
        } catch (err) {
            this.log("error", `Connect failed: ${err.message}`);
            await this.disconnect(true);
            this.setState("disconnected", { error: err.message });
            throw err;
        }
    }

    makeIdentity(opts, client) {
        switch (opts.authType) {
            case "UserName":
                return { type: UserTokenType.UserName, userName: opts.username, password: opts.password };
            case "Certificate": {
                const certFile = opts.certFile || client.certificateFile;
                const keyFile = opts.keyFile || client.privateKeyFile;
                if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) throw new Error("User certificate or private key file not found");
                return { type: UserTokenType.Certificate, certificateData: readCertificate(certFile), privateKey: readPrivateKeyPEM(keyFile) };
            }
            default:
                return { type: UserTokenType.Anonymous };
        }
    }

    async createSubscription(opts = {}) {
        const subscription = ClientSubscription.create(this.session, {
            requestedPublishingInterval: Number(opts.publishingInterval) || 500,
            requestedLifetimeCount: 1000,
            requestedMaxKeepAliveCount: 20,
            maxNotificationsPerPublish: 10000,
            publishingEnabled: true,
            priority: 10
        });
        await new Promise((resolve, reject) => {
            subscription.once("started", resolve);
            subscription.once("internal_error", reject);
        });
        subscription.on("keepalive", () => this.emit("subscriptionKeepAlive", { time: new Date().toISOString() }));
        subscription.on("terminated", () => this.log("warn", "Subscription terminated"));
        this.subscription = subscription;
        this.log("info", `Subscription ${subscription.subscriptionId} created (publishing interval ${subscription.publishingInterval} ms)`);
    }

    async setPublishingInterval(ms) {
        this.requireSession();
        await this.subscription.modify({ requestedPublishingInterval: Number(ms) || 500, requestedLifetimeCount: 1000, requestedMaxKeepAliveCount: 20, maxNotificationsPerPublish: 10000, priority: 10 });
        this.log("info", `Publishing interval changed to ${this.subscription.publishingInterval} ms`);
        return this.subscription.publishingInterval;
    }

    async disconnect(silent = false) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.items.clear();
        const { client, session, subscription } = this;
        const reconnecting = this.state === "reconnecting" || !!client?.isReconnecting;
        this.subscription = null;
        this.session = null;
        this.client = null;
        // While reconnecting, subscription.terminate() never resolves: disconnecting the client first
        // aborts the reconnection. In every case each step is bounded, because the channel can already
        // be dead while the state still says "connected".
        if (client && reconnecting) await settleWithin(() => client.disconnect(), 2000);
        else {
            // one budget for the graceful part, then the transport is closed regardless
            await settleWithin(async () => {
                if (subscription) await subscription.terminate();
                if (session) await session.close();
            }, 2000);
            if (client) await settleWithin(() => client.disconnect(), 1500);
        }
        this.dataTypeCache.clear();
        if (!silent) {
            this.log("info", "Disconnected");
            this.setState("disconnected");
        }
    }

    requireSession() {
        if (!this.session) throw new Error("Not connected");
    }

    // ---------------------------------------------------------------- browse & read

    async browse(nodeId) {
        this.requireSession();
        const refs = [];
        let result = await this.session.browse({
            nodeId: nodeId || "ns=0;i=85",
            referenceTypeId: "HierarchicalReferences",
            includeSubtypes: true,
            browseDirection: BrowseDirection.Forward,
            nodeClassMask: 0,
            resultMask: 63
        });
        refs.push(...(result.references || []));
        while (result.continuationPoint && result.continuationPoint.length) {
            result = await this.session.browseNext(result.continuationPoint, false);
            refs.push(...(result.references || []));
        }
        return refs.map((r) => ({
            nodeId: r.nodeId.toString(),
            browseName: r.browseName.toString(),
            displayName: r.displayName?.text || r.browseName.name,
            nodeClass: NodeClass[r.nodeClass],
            typeDefinition: r.typeDefinition?.toString() || "",
            referenceType: r.referenceTypeId.toString(),
            hasChildren: r.nodeClass === NodeClass.Object || r.nodeClass === NodeClass.Variable || r.nodeClass === NodeClass.ObjectType || r.nodeClass === NodeClass.VariableType || r.nodeClass === NodeClass.View
        }));
    }

    async dataTypeName(dataTypeNodeId) {
        const key = dataTypeNodeId.toString();
        if (this.dataTypeCache.has(key)) return this.dataTypeCache.get(key);
        let name = key;
        try {
            const dv = await this.session.read({ nodeId: dataTypeNodeId, attributeId: AttributeIds.BrowseName });
            name = dv.value.value?.name || key;
        } catch (_) { /* ignore */ }
        this.dataTypeCache.set(key, name);
        return name;
    }

    async builtInType(dataTypeNodeId) {
        try {
            return DataType[await findBasicDataType(this.session, coerceNodeId(dataTypeNodeId))];
        } catch (_) {
            return null;
        }
    }

    async readAttributes(nodeId) {
        this.requireSession();
        const ids = Object.keys(AttributeIds).filter((k) => isNaN(Number(k)) && k !== "INVALID" && AttributeIds[k] > 0);
        const dvs = await this.session.read(ids.map((k) => ({ nodeId, attributeId: AttributeIds[k] })));
        const attributes = [];
        let value = null;
        const info = { nodeId };
        for (let i = 0; i < ids.length; i++) {
            const name = ids[i];
            const dv = dvs[i];
            if (dv.statusCode.equals(StatusCodes.BadAttributeIdInvalid)) continue;
            if (name === "Value") {
                value = V.dataValueToPlain(dv);
                continue;
            }
            let display = V.variantToPlain(dv.value);
            const raw = dv.value?.value;
            if (!dv.statusCode.isGood()) display = dv.statusCode.name;
            else if (name === "NodeClass") display = NodeClass[raw];
            else if (name === "AccessLevel" || name === "UserAccessLevel") display = `${accessLevelFlagToString(raw)} (${raw})`;
            else if (name === "AccessLevelEx") display = String(raw);
            else if (name === "DataType") { display = `${await this.dataTypeName(raw)} (${raw.toString()})`; info.dataType = await this.builtInType(raw); info.dataTypeNodeId = raw.toString(); }
            else if (name === "ValueRank") { display = `${raw} (${{ "-3": "ScalarOrOneDimension", "-2": "Any", "-1": "Scalar", "0": "OneOrMoreDimensions", "1": "OneDimension" }[raw] || raw + " dimensions"})`; info.valueRank = raw; }
            else if (name === "EventNotifier") display = `${raw} (${raw & 1 ? "SubscribeToEvents" : "None"})`;
            else if (name === "MinimumSamplingInterval") display = `${raw} ms`;
            if (name === "NodeClass") info.nodeClass = NodeClass[raw];
            if (name === "UserAccessLevel") info.writable = !!(raw & 2);
            if (name === "AccessLevel") info.historizing = !!(raw & 4);
            if (name === "DisplayName") info.displayName = raw?.text;
            attributes.push({ name, value: typeof display === "object" ? JSON.stringify(display) : display });
        }
        // properties (EURange, EngineeringUnits, InputArguments, ...)
        const properties = [];
        try {
            const res = await this.session.browse({ nodeId, referenceTypeId: "HasProperty", includeSubtypes: true, browseDirection: BrowseDirection.Forward, resultMask: 63 });
            const props = res.references || [];
            if (props.length) {
                const pv = await this.session.read(props.map((p) => ({ nodeId: p.nodeId, attributeId: AttributeIds.Value })));
                props.forEach((p, i) => properties.push({ name: p.browseName.name, nodeId: p.nodeId.toString(), value: JSON.stringify(V.variantToPlain(pv[i].value)) }));
            }
        } catch (_) { /* ignore */ }
        return { info, attributes, value, properties };
    }

    async read(nodeId) {
        this.requireSession();
        return V.dataValueToPlain(await this.session.read({ nodeId, attributeId: AttributeIds.Value }));
    }

    // ---------------------------------------------------------------- write

    async write(opts) {
        this.requireSession();
        let dataType = opts.dataType;
        let valueRank = opts.valueRank;
        if (!dataType || valueRank === undefined) {
            const dvs = await this.session.read([
                { nodeId: opts.nodeId, attributeId: AttributeIds.DataType },
                { nodeId: opts.nodeId, attributeId: AttributeIds.ValueRank }
            ]);
            dataType = dataType || (await this.builtInType(dvs[0].value.value));
            valueRank = valueRank ?? dvs[1].value.value;
        }
        if (!dataType) throw new Error("Cannot determine data type of node");
        if (dataType === "ExtensionObject") throw new Error("Writing structured (ExtensionObject) values is not supported from this dialog");
        const variant = V.makeVariant(opts.value, dataType, valueRank >= 0 ? 1 : -1);
        const dataValue = new DataValue({ value: variant });
        if (opts.includeStatus) dataValue.statusCode = V.statusCodeFromName(opts.statusCode);
        if (opts.includeSourceTimestamp) dataValue.sourceTimestamp = opts.sourceTimestamp ? new Date(opts.sourceTimestamp) : new Date();
        if (opts.includeServerTimestamp) dataValue.serverTimestamp = opts.serverTimestamp ? new Date(opts.serverTimestamp) : new Date();
        const statusCode = await this.session.write({ nodeId: opts.nodeId, attributeId: AttributeIds.Value, indexRange: opts.indexRange || undefined, value: dataValue });
        this.log(statusCode.isGood() ? "info" : "warn", `Write ${opts.nodeId} = ${JSON.stringify(opts.value)} -> ${statusCode.name}`);
        return statusCode.name;
    }

    // ---------------------------------------------------------------- subscriptions

    queueChange(itemId, payload) {
        this.pendingChanges.set(itemId, payload);
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                const batch = [...this.pendingChanges.values()];
                this.pendingChanges.clear();
                this.emit("dataChanges", batch);
            }, 100);
        }
    }

    async monitor(opts) {
        this.requireSession();
        let filter = null;
        if (opts.deadbandType && opts.deadbandType !== "None") {
            filter = new DataChangeFilter({
                trigger: DataChangeTrigger[opts.trigger || "StatusValue"],
                deadbandType: DeadbandType[opts.deadbandType],
                deadbandValue: Number(opts.deadbandValue) || 0
            });
        } else if (opts.trigger && opts.trigger !== "StatusValue") {
            filter = new DataChangeFilter({ trigger: DataChangeTrigger[opts.trigger], deadbandType: DeadbandType.None });
        }
        const item = ClientMonitoredItem.create(
            this.subscription,
            { nodeId: opts.nodeId, attributeId: AttributeIds.Value },
            {
                samplingInterval: opts.samplingInterval === undefined ? 250 : Number(opts.samplingInterval),
                discardOldest: opts.discardOldest !== false,
                queueSize: Number(opts.queueSize) || 10,
                filter
            },
            TimestampsToReturn.Both
        );
        await this.waitInitialized(item);
        const itemId = this.nextItemId++;
        this.items.set(itemId, { monitoredItem: item, nodeId: opts.nodeId, kind: "data" });
        item.on("changed", (dv) => this.queueChange(itemId, { itemId, nodeId: opts.nodeId, ...V.dataValueToPlain(dv) }));
        item.on("err", (msg) => this.log("error", `Monitored item ${opts.nodeId}: ${msg}`));
        const res = item.result || {};
        this.log("info", `Monitoring ${opts.nodeId} (sampling ${res.revisedSamplingInterval ?? "?"} ms, queue ${res.revisedQueueSize ?? "?"})`);
        return { itemId, revisedSamplingInterval: res.revisedSamplingInterval, revisedQueueSize: res.revisedQueueSize, statusCode: res.statusCode?.name };
    }

    waitInitialized(item) {
        return new Promise((resolve, reject) => {
            item.once("initialized", resolve);
            item.once("err", (msg) => reject(new Error(String(msg))));
        });
    }

    async unmonitor(itemId) {
        const it = this.items.get(itemId);
        if (!it) return;
        this.items.delete(itemId);
        try { await it.monitoredItem.terminate(); } catch (_) { /* ignore */ }
    }

    async monitorEvents(nodeId = "ns=0;i=2253") {
        this.requireSession();
        const item = ClientMonitoredItem.create(
            this.subscription,
            { nodeId, attributeId: AttributeIds.EventNotifier },
            { samplingInterval: 0, discardOldest: true, queueSize: 1000, filter: constructEventFilter(EVENT_FIELDS) },
            TimestampsToReturn.Both
        );
        await this.waitInitialized(item);
        const itemId = this.nextItemId++;
        this.items.set(itemId, { monitoredItem: item, nodeId, kind: "event" });
        item.on("changed", async (fields) => {
            const ev = {};
            EVENT_FIELDS.forEach((f, i) => { ev[f] = V.variantToPlain(fields[i]); });
            try {
                const t = fields[EVENT_FIELDS.indexOf("EventType")]?.value;
                if (t) ev.EventTypeName = await this.dataTypeName(t);
            } catch (_) { /* ignore */ }
            this.emit("event", { itemId, ...ev });
        });
        this.log("info", `Monitoring events on ${nodeId}`);
        return { itemId };
    }

    async conditionRefresh() {
        this.requireSession();
        const res = await this.session.call({
            objectId: coerceNodeId(ObjectTypeIds.ConditionType),
            methodId: coerceNodeId(MethodIds.ConditionType_ConditionRefresh),
            inputArguments: [{ dataType: DataType.UInt32, value: this.subscription.subscriptionId }]
        });
        return res.statusCode.name;
    }

    async conditionMethod({ conditionId, eventId, comment, action }) {
        this.requireSession();
        const methodId = {
            acknowledge: MethodIds.AcknowledgeableConditionType_Acknowledge,
            confirm: MethodIds.AcknowledgeableConditionType_Confirm,
            addComment: MethodIds.ConditionType_AddComment
        }[action];
        if (!methodId) {
            const enable = action === "enable";
            const res = await this.session.call({ objectId: conditionId, methodId: coerceNodeId(enable ? MethodIds.ConditionType_Enable : MethodIds.ConditionType_Disable), inputArguments: [] });
            return res.statusCode.name;
        }
        const res = await this.session.call({
            objectId: conditionId,
            methodId: coerceNodeId(methodId),
            inputArguments: [
                { dataType: DataType.ByteString, value: Buffer.from(String(eventId).replace(/^hex:/, ""), "hex") },
                { dataType: DataType.LocalizedText, value: { text: comment || "", locale: "en" } }
            ]
        });
        this.log(res.statusCode.isGood() ? "info" : "warn", `Condition ${action} on ${conditionId}: ${res.statusCode.name}`);
        return res.statusCode.name;
    }

    // ---------------------------------------------------------------- methods

    async getMethodInfo(methodId) {
        this.requireSession();
        const parent = await this.session.browse({ nodeId: methodId, referenceTypeId: "HasComponent", includeSubtypes: true, browseDirection: BrowseDirection.Inverse, resultMask: 63 });
        const objectId = parent.references?.[0]?.nodeId?.toString() || "";
        const props = await this.session.browse({ nodeId: methodId, referenceTypeId: "HasProperty", includeSubtypes: true, browseDirection: BrowseDirection.Forward, resultMask: 63 });
        const out = { objectId, methodId, inputs: [], outputs: [] };
        for (const p of props.references || []) {
            if (!["InputArguments", "OutputArguments"].includes(p.browseName.name)) continue;
            const dv = await this.session.read({ nodeId: p.nodeId, attributeId: AttributeIds.Value });
            const args = [];
            for (const a of dv.value.value || []) {
                args.push({ name: a.name, dataType: (await this.builtInType(a.dataType)) || "String", dataTypeName: await this.dataTypeName(a.dataType), valueRank: a.valueRank, description: a.description?.text || "" });
            }
            out[p.browseName.name === "InputArguments" ? "inputs" : "outputs"] = args;
        }
        return out;
    }

    async callMethod({ objectId, methodId, inputs }) {
        this.requireSession();
        const inputArguments = (inputs || []).map((a) => V.makeVariant(a.value, a.dataType, a.valueRank >= 0 ? 1 : -1));
        const res = await this.session.call({ objectId, methodId, inputArguments });
        this.log(res.statusCode.isGood() ? "info" : "warn", `Call ${methodId} -> ${res.statusCode.name}`);
        return {
            statusCode: res.statusCode.name,
            inputArgumentResults: (res.inputArgumentResults || []).map((s) => s.name),
            outputs: (res.outputArguments || []).map((v) => ({ dataType: DataType[v.dataType], value: V.variantToPlain(v) }))
        };
    }

    // ---------------------------------------------------------------- history

    async historyRead({ nodeId, startTime, endTime }) {
        this.requireSession();
        const start = startTime ? new Date(startTime) : new Date(Date.now() - 3600 * 1000);
        const end = endTime ? new Date(endTime) : new Date();
        const res = await this.session.readHistoryValue({ nodeId }, start, end);
        if (res.statusCode.isNotGood()) throw new Error(`History read failed: ${res.statusCode.name}`);
        return (res.historyData?.dataValues || []).map(V.dataValueToPlain);
    }

    // ---------------------------------------------------------------- certificates

    async clientCertificateInfo() {
        const cm = await this.certificateManager();
        return { rootDir: cm.rootDir };
    }
}

module.exports = { ClientEngine };
