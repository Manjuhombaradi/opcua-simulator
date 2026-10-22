"use strict";
// The OPC UA side of the persistent history (OPC 10000-11 HistoryRead), on top of historyStore.js:
//  - StoreHistorian: node-opcua's IVariableHistorian backed by the database (recording, bounds, ReadProcessed);
//  - readRaw(): ReadRaw of those variables page by page from the database (node-opcua's own ReadRaw would load the
//    whole requested range into memory), including values recorded before a restart;
//  - readAtTime(): ReadAtTimeDetails (node-opcua answers BadHistoryOperationUnsupported), exact samples or
//    values interpolated like the Part 13 Interpolated aggregate;
//  - captureEvent() / EventHistoryReader: events that reached an event notifier are recorded with all their fields
//    and read back with ReadEventDetails, select and where clauses evaluated by node-opcua's own filter code on an
//    event rebuilt from the stored fields.
// Continuation points of all three keep a cursor, never the remaining data, and the work of one request is bounded
// (REQUEST_*): what is left is answered with continuation points, so no request blocks the server for long.
const crypto = require("crypto");
const { createRequire } = require("module");
const { performance } = require("perf_hooks");
const {
    BinaryStream, DataType, DataValue, Variant, VariantArrayType, StatusCode, StatusCodes, NodeId, ExpandedNodeId,
    QualifiedName, NodeClass, AttributeIds, PermissionType, EventNotifierFlags, HistoryData, HistoryReadResult,
    ReadEventDetails, BrowsePathResult, SessionContext, SimpleAttributeOperand, FilterContextOnAddressSpace, checkFilter,
    extractEventField, canReceiveEvent, coerceExpandedNodeId, resolveNodeId, sameNodeId, isMinDate, decodeVariant,
    getStatusCodeFromCode
} = require("node-opcua");
// not re-exported by node-opcua: taken from node-opcua's own dependency, so no extra package is needed
const { HistoryEvent, HistoryEventFieldList } = createRequire(require.resolve("node-opcua"))("node-opcua-types");
const { MIN_TIME, MAX_TIME } = require("./historyStore");

const MAX_AT_TIME = 1000; // ReadAtTime: requested times answered per node and call, the rest with a continuation point
const MAX_AT_TIME_TOTAL = 100000; // ReadAtTime: requested times per request (more: BadTooManyOperations)
const MAX_RAW_VALUES_PER_CALL = 10000; // ReadRaw of stored history: values per node and call (MaxReturnDataValues)
const MAX_EVENTS_PER_CALL = 10000; // events per node and call; more come with a continuation point
const MAX_EVENTS_SCANNED = 20000; // stored events examined per node and call (where clause), then a continuation point
// Work of one HistoryRead request, all its nodes together. Raw and event reads of its nodes run one after the other
// in request order (inTurn): the first nodes complete, at most one is cut short when the budget is used up, and the
// nodes after it are not read at all (empty result with a continuation point, Part 11 allows that).
const REQUEST_BYTES = 8 * 1024 * 1024; // estimated size of the values / events returned
const REQUEST_EVENTS_SCANNED = 50000; // stored events examined
const REQUEST_SYNC_MS = 30; // ReadAtTime computing time (it runs synchronously)
const SLICE_MS = 10; // raw and event reads give the event loop a turn after this much work (see nextTurn)
const EVENT_BATCH = 200; // stored events read per query
const VALUE_CHUNK = 2000; // stored values read per query
const HISTORIAN_BITS = 0x1f; // Part 11 historian info bits (0:1 Raw/Calculated/Interpolated, 2 Partial, 3 ExtraData, 4 MultiValue)
const HISTORIAN_INTERPOLATED = 0x2;
const INFO_TYPE_DATA_VALUE = 0x400; // InfoType bits 10:11 = DataValue: the info bits (historian bits among them) are used
const BASE_OBJECT_TYPE = resolveNodeId("BaseObjectType");
const BASE_EVENT_TYPE = resolveNodeId("BaseEventType");
const CONDITION_TYPE = resolveNodeId("ConditionType");

const INTERPOLATABLE = new Set([DataType.SByte, DataType.Byte, DataType.Int16, DataType.UInt16, DataType.Int32, DataType.UInt32, DataType.Float, DataType.Double]);
const INTERPOLATABLE_64 = new Set([DataType.Int64, DataType.UInt64]); // node-opcua values [high, low] (two's complement)
const INTEGER_RANGE = {
    [DataType.SByte]: [-128, 127], [DataType.Byte]: [0, 255], [DataType.Int16]: [-32768, 32767], [DataType.UInt16]: [0, 65535],
    [DataType.Int32]: [-2147483648, 2147483647], [DataType.UInt32]: [0, 4294967295]
};

// ------------------------------------------------------------------ encoding

function encodeVariant(variant) {
    const stream = new BinaryStream(variant.binaryStoreSize());
    variant.encode(stream);
    return stream.buffer;
}

function toBuffer(bytes) {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const KNOWN_STATUS = new Map();
for (const sc of Object.values(StatusCodes)) {
    if (sc && typeof sc.value === "number" && !KNOWN_STATUS.has(sc.value)) KNOWN_STATUS.set(sc.value, sc);
}
const statusCache = new Map();
// numeric StatusCode (with info bits) -> StatusCode object
function statusCodeOf(value) {
    const v = value >>> 0;
    let sc = statusCache.get(v);
    if (sc) return sc;
    const base = KNOWN_STATUS.get((v & 0xffff0000) >>> 0);
    const extra = v & 0xffff;
    sc = base ? (extra ? StatusCode.makeStatusCode(base, extra) : base) : getStatusCodeFromCode(v);
    if (statusCache.size < 10000) statusCache.set(v, sc);
    return sc;
}

// statusCode with the historian bits `bits` (0 = Raw). Non-zero bits come with InfoType DataValue (OPC 10000-4:
// the info bits only count with that InfoType), e.g. Good + Interpolated = 0x00000402.
function withHistorianBits(statusCode, bits) {
    const value = statusCode ? statusCode.value >>> 0 : 0;
    let v = (value & ~HISTORIAN_BITS) >>> 0;
    if (bits) v = (v | INFO_TYPE_DATA_VALUE | bits) >>> 0;
    return statusCodeOf(v);
}

// a request DateTime -> ms, or null when "not specified" (DateTime.MinValue)
function timeOf(date) {
    if (!(date instanceof Date)) return null;
    const ms = date.getTime();
    return Number.isFinite(ms) && !isMinDate(date) ? ms : null;
}

// Cooperative time slices of the asynchronous reads (raw values, events): a read works while less than SLICE_MS
// passed in the current turn, then waits for its next turn. Turns are handed out one per event loop iteration, so
// other sessions (I/O, publish, timers) are served in between, however many reads run at the same time (all nodes
// of a request start in the same tick: the first ones use the turn, the others wait).
const turns = { start: 0, waiting: [], pumping: false };
function nextTurnDue() {
    return performance.now() - turns.start >= SLICE_MS;
}
function nextTurn() {
    return new Promise((resolve) => {
        turns.waiting.push(resolve);
        if (!turns.pumping) {
            turns.pumping = true;
            setImmediate(pumpTurn);
        }
    });
}
function pumpTurn() {
    const next = turns.waiting.shift();
    turns.start = performance.now();
    if (next) next();
    if (turns.waiting.length) setImmediate(pumpTurn);
    else turns.pumping = false;
}

// ------------------------------------------------------------------ continuation points and request budgets

// Continuation points of the history reads of one address space (raw values, values at times, events): a cursor
// state each, at most `max` per session. Part 4: the oldest one of a session is freed when a new one is needed, but
// never one that the same request created (budget). Freed with the session (releaseSession, or found closed).
class HistoryContinuationPoints {
    constructor(max = 10) {
        this.max = max;
        this.sessions = new Map(); // session id -> { session: WeakRef | null, points: Map(hex -> { state, budget }) }
    }

    sessionId(context) {
        const session = context && context.session;
        return session && session.nodeId ? session.nodeId.toString() : "";
    }

    // -> continuation point (Buffer), or null when the session's points all belong to this request
    // (BadNoContinuationPoints)
    add(context, state, budget) {
        this.sweep();
        const id = this.sessionId(context);
        let entry = this.sessions.get(id);
        if (!entry) {
            const session = context && context.session;
            entry = { session: session && typeof WeakRef === "function" ? new WeakRef(session) : null, points: new Map() };
            this.sessions.set(id, entry);
        }
        if (entry.points.size >= this.max) {
            const oldest = [...entry.points].find(([, p]) => p.budget !== budget);
            if (!oldest) return null;
            entry.points.delete(oldest[0]);
        }
        const cp = crypto.randomBytes(16);
        entry.points.set(cp.toString("hex"), { state, budget });
        return cp;
    }

    // the state of `cp` when it belongs to this session, kind of read and node (then it is removed), else null
    take(context, cp, kind, target) {
        const entry = this.sessions.get(this.sessionId(context));
        if (!entry) return null;
        const hex = Buffer.from(cp).toString("hex");
        const p = entry.points.get(hex);
        if (!p || p.state.kind !== kind || p.state.target !== target) return null;
        entry.points.delete(hex);
        return p.state;
    }

    // sessions that were closed without releaseSession (e.g. no event history reader to tell)
    sweep() {
        for (const [id, entry] of this.sessions) {
            if (!entry.session) continue;
            const session = entry.session.deref();
            if (!session || session.status === "closed" || session.status === "disposed") this.sessions.delete(id);
        }
    }

    releaseSession(sessionId) {
        this.sessions.delete(String(sessionId));
    }

    clear() {
        this.sessions.clear();
    }
}

const continuationRegistries = new WeakMap(); // address space -> HistoryContinuationPoints
function continuationPointsOf(addressSpace) {
    let points = continuationRegistries.get(addressSpace);
    if (!points) {
        points = new HistoryContinuationPoints();
        continuationRegistries.set(addressSpace, points);
    }
    return points;
}

// Budget of one request: all nodes of a HistoryRead share its details object (node-opcua serves them in parallel)
const requestBudgets = new WeakMap();
function requestBudget(details) {
    let budget = requestBudgets.get(details);
    if (!budget) {
        budget = { bytes: REQUEST_BYTES, scanned: REQUEST_EVENTS_SCANNED, syncUntil: 0, queue: Promise.resolve() };
        requestBudgets.set(details, budget);
    }
    return budget;
}

// Runs fn() when the reads of the request's previous nodes are done. node-opcua starts all nodes of a request in the
// same tick, in request order, so the nodes are read in that order instead of interleaved: otherwise every node would
// be partial when the budget runs out and need one of the session's few continuation points.
function inTurn(budget, fn) {
    const run = budget.queue.then(fn);
    budget.queue = run.then(() => {}, () => {});
    return run;
}

const budgetUsed = (budget) => budget.bytes <= 0 || budget.scanned <= 0;

// A node the request has no budget left for: not read, its state (unchanged) kept with a continuation point.
// No free point: BadNoContinuationPoints (nothing was read, nothing is lost but the state of a continued read).
function deferred(points, context, state, budget, emptyHistoryData) {
    const continuationPoint = points.add(context, state, budget);
    if (!continuationPoint) return noContinuationPoints();
    return new HistoryReadResult({ statusCode: StatusCodes.Good, continuationPoint, historyData: emptyHistoryData() });
}

// Continuation data of a call -> { result } (answered: invalid or released point) or { state } (continue) or {}
function takeState(points, context, continuationData, kind, target) {
    const cp = continuationData && continuationData.continuationPoint;
    if (cp && cp.length) {
        const state = points.take(context, cp, kind, target);
        if (!state) return { result: new HistoryReadResult({ statusCode: StatusCodes.BadContinuationPointInvalid }) };
        if (continuationData.releaseContinuationPoints) return { result: new HistoryReadResult({ statusCode: StatusCodes.Good }) };
        return { state };
    }
    if (continuationData && continuationData.releaseContinuationPoints) {
        return { result: new HistoryReadResult({ statusCode: StatusCodes.BadContinuationPointInvalid }) };
    }
    return {};
}

const noContinuationPoints = () => new HistoryReadResult({ statusCode: StatusCodes.BadNoContinuationPoints });

function isStepped(node) {
    return node.$historicalDataConfiguration?.stepped?.readValue()?.value?.value === true;
}

// ------------------------------------------------------------------ keys and namespaces

// "<namespace URI>|<identifier>": names a node independently of namespace indexes (which change when companion
// nodesets are added), used for the history keys of variables, notifiers, event types and conditions.
function nodeKey(nodeId, uris) {
    const ns = nodeId.namespace || 0;
    return `${uris[ns] || `ns${ns}`}|${nodeId.toString().replace(/^ns=\d+;/, "")}`;
}

function nodeIdFromKey(key, uris) {
    if (!key) return null;
    const at = key.indexOf("|");
    if (at < 0) return null;
    const ns = uris.indexOf(key.slice(0, at));
    if (ns < 0) return null;
    try {
        return resolveNodeId(`ns=${ns};${key.slice(at + 1)}`);
    } catch (_) {
        return null;
    }
}

// Namespace indexes inside stored values (NodeIds, QualifiedNames, event field paths) are those of the server that
// recorded them; mapFor() gives old index -> current index (-1: that namespace URI is not in this server) when the
// namespace table changed since, else null. map.uris is the old table.
class NamespaceMapper {
    constructor(store, currentId, currentUris) {
        this.store = store;
        this.currentId = currentId;
        this.uris = currentUris;
        this.cache = new Map();
    }

    mapFor(id) {
        if (id === null || id === undefined || id === this.currentId) return null;
        if (this.cache.has(id)) return this.cache.get(id);
        const old = this.store.namespaceUris(id);
        let map = null;
        if (old) {
            map = new Map();
            let changed = false;
            old.forEach((uri, i) => {
                const j = this.uris.indexOf(uri);
                if (j !== i) changed = true;
                map.set(i, j);
            });
            map.uris = old;
            if (!changed) map = null;
        }
        this.cache.set(id, map);
        return map;
    }
}

// old namespace index -> current one, -1 when its namespace is gone (an index the old table did not have stays)
function remapIndex(map, ns) {
    if (!map || !ns) return ns;
    const j = map.get(ns);
    return j === undefined ? ns : j;
}

// a NodeId / ExpandedNodeId / QualifiedName with old namespace indexes -> current ones. null when its namespace is
// not in this server: the same identifier there would name a different node. An ExpandedNodeId keeps the URI instead.
function remapValue(dataType, x, map) {
    if (!x) return x;
    if (dataType === DataType.QualifiedName) {
        const ns = remapIndex(map, x.namespaceIndex);
        return ns < 0 ? null : new QualifiedName({ name: x.name, namespaceIndex: ns });
    }
    if (dataType === DataType.ExpandedNodeId) {
        if (x.namespaceUri) return x;
        const ns = remapIndex(map, x.namespace);
        if (ns < 0) return new ExpandedNodeId(x.identifierType, x.value, 0, map.uris[x.namespace], x.serverIndex);
        return new ExpandedNodeId(x.identifierType, x.value, ns, x.namespaceUri, x.serverIndex);
    }
    const ns = remapIndex(map, x.namespace);
    return ns < 0 ? null : new NodeId(x.identifierType, x.value, ns);
}

// a stored Variant with old namespace indexes -> current ones; a scalar of a namespace that is gone becomes an
// empty Variant, an array element the null NodeId / an empty QualifiedName
function remapVariant(variant, map) {
    if (!map || !variant) return variant;
    const t = variant.dataType;
    if (t !== DataType.NodeId && t !== DataType.ExpandedNodeId && t !== DataType.QualifiedName) return variant;
    if (variant.arrayType === VariantArrayType.Scalar) {
        const value = remapValue(t, variant.value, map);
        return value === null ? new Variant() : new Variant({ dataType: t, value });
    }
    const empty = () => (t === DataType.QualifiedName ? new QualifiedName({}) : NodeId.nullNodeId);
    const value = Array.from(variant.value || [], (x) => remapValue(t, x, map) ?? empty());
    return new Variant({ dataType: t, arrayType: variant.arrayType, dimensions: variant.dimensions, value });
}

// "2:Foo.Bar" (browse names joined by ".") with old namespace indexes -> current indexes; null when a namespace
// of the path is not in this server
function remapPath(path, map) {
    if (!map) return path;
    let gone = false;
    const out = path.split(".").map((el) => {
        const m = /^(\d+):(.*)$/.exec(el);
        if (!m) return el;
        const ns = remapIndex(map, Number(m[1]));
        if (ns < 0) gone = true;
        return ns > 0 ? `${ns}:${m[2]}` : m[2];
    }).join(".");
    return gone ? null : out;
}

// ------------------------------------------------------------------ values

// DataValue -> database row (the Variant in node-opcua's binary encoding, so every data type round-trips exactly)
function valueRow(dataValue, ns) {
    const ms = (d) => (d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null);
    const source = ms(dataValue.sourceTimestamp);
    const server = ms(dataValue.serverTimestamp);
    return {
        ts: source ?? server ?? Date.now(),
        pico: source === null ? 0 : (dataValue.sourcePicoseconds | 0),
        serverTs: server,
        serverPico: server === null ? 0 : (dataValue.serverPicoseconds | 0),
        status: dataValue.statusCode ? dataValue.statusCode.value >>> 0 : 0,
        ns,
        value: encodeVariant(dataValue.value || new Variant()).toString("base64")
    };
}

function rowToDataValue(row, mapper) {
    let value = decodeVariant(new BinaryStream(Buffer.from(row.value, "base64")));
    const map = mapper && mapper.mapFor(row.ns);
    if (map) value = remapVariant(value, map);
    return new DataValue({
        value,
        statusCode: statusCodeOf(row.status),
        sourceTimestamp: new Date(row.ts),
        sourcePicoseconds: row.pico,
        serverTimestamp: row.server_ts === null ? null : new Date(row.server_ts),
        serverPicoseconds: row.server_pico
    });
}

// node-opcua IVariableHistorian (push / extractDataValues / findBoundBefore / findBoundAfter) on the store.
// Not "armed" while installHistoricalDataNode runs: that pushes the initial value, which the first
// setValueFromSource records again a moment later.
class StoreHistorian {
    constructor(store, key, { ns = null, mapper = null } = {}) {
        this.store = store;
        this.key = key;
        this.ns = ns;
        this.mapper = mapper;
        this.armed = false;
        this.recording = true;
    }

    push(dataValue) {
        if (!this.armed || !this.recording) return;
        this.store.queueValue(this.key, valueRow(dataValue, this.ns));
    }

    // Same contract as node-opcua's VariableHistorian: values with startTime <= sourceTimestamp <= endTime (DateTime
    // MinValue = open), ascending or descending (isReversed), at most maxNumberToExtract (0 = all), the result
    // reversed when reverseDataValue is set. Read in chunks so a long history does not block the event loop.
    // (ReadRaw does not come here, see readRaw(); node-opcua's processed reads do.)
    extractDataValues(details, maxNumberToExtract, isReversed, reverseDataValue, callback) {
        const start = timeOf(details.startTime);
        const end = timeOf(details.endTime);
        const limit = maxNumberToExtract > 0 ? maxNumberToExtract : Infinity;
        const out = [];
        let after = null;
        const step = () => {
            let rows;
            try {
                const want = Math.min(VALUE_CHUNK, limit - out.length);
                rows = this.store.valueRows(this.key, { start, end, reverse: isReversed, after, limit: want });
                for (const row of rows) out.push(rowToDataValue(row, this.mapper));
                if (rows.length < want || out.length >= limit) {
                    if (reverseDataValue) out.reverse();
                    callback(null, out);
                    return;
                }
            } catch (err) {
                callback(err);
                return;
            }
            after = rows[rows.length - 1];
            setImmediate(step);
        };
        step();
    }

    findBoundBefore(date) {
        const row = this.store.valueBefore(this.key, date.getTime());
        return row ? rowToDataValue(row, this.mapper) : null;
    }

    findBoundAfter(date) {
        const row = this.store.valueAfter(this.key, date.getTime());
        return row ? rowToDataValue(row, this.mapper) : null;
    }

    // ReadAtTime: the sample at exactly this time (the most recent one when there are several)
    findAt(date) {
        const row = this.store.valueAt(this.key, date.getTime());
        return row ? rowToDataValue(row, this.mapper) : null;
    }

    // ReadAtTime bounds. notBad: the nearest non-Bad values (Part 13 interpolated bounding values); skippedBefore /
    // skippedAfter tell whether Bad values were passed over on that side.
    findBounds(date, notBad) {
        const ms = date.getTime();
        const before = this.store.valueBefore(this.key, ms, notBad);
        const after = this.store.valueAfter(this.key, ms, notBad);
        let skippedBefore = false;
        let skippedAfter = false;
        if (notBad) {
            const b = this.store.valueBefore(this.key, ms, false);
            const a = this.store.valueAfter(this.key, ms, false);
            skippedBefore = !!b && (!before || b.id !== before.id);
            skippedAfter = !!a && (!after || a.id !== after.id);
        }
        return {
            before: before ? rowToDataValue(before, this.mapper) : null,
            after: after ? rowToDataValue(after, this.mapper) : null,
            skippedBefore,
            skippedAfter
        };
    }
}

// ------------------------------------------------------------------ interpolation

// Int64 / UInt64 value ([high, low] or a number) -> BigInt, null when it is not one
function toBigInt(dataType, v) {
    let u;
    if (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1])) {
        u = (BigInt(v[0] >>> 0) << 32n) | BigInt(v[1] >>> 0);
    } else if (typeof v === "number" && Number.isFinite(v)) {
        u = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    } else {
        return null;
    }
    return dataType === DataType.Int64 ? BigInt.asIntN(64, u) : u;
}

function fromBigInt(x) {
    const u = BigInt.asUintN(64, x);
    return [Number(u >> 32n), Number(u & 0xffffffffn)];
}

function isNumericVariant(v) {
    return !!v && v.arrayType === VariantArrayType.Scalar && (INTERPOLATABLE.has(v.dataType) || INTERPOLATABLE_64.has(v.dataType));
}

// The value at `ms` on the straight line between the stored values `before` and `after` (Part 13 sloped
// interpolation), integers rounded and kept in their range; null when they cannot be interpolated (not a numeric
// scalar, different data types, a NaN or infinite bound): the value before then holds (stepped).
function slopeValue(before, after, ms) {
    const a = before.value;
    const b = after.value;
    if (!isNumericVariant(a) || !isNumericVariant(b) || a.dataType !== b.dataType) return null;
    const t0 = before.sourceTimestamp.getTime();
    const t1 = after.sourceTimestamp.getTime();
    if (INTERPOLATABLE_64.has(a.dataType)) {
        const x0 = toBigInt(a.dataType, a.value);
        const x1 = toBigInt(a.dataType, b.value);
        if (x0 === null || x1 === null) return null;
        let x = x0;
        if (t1 > t0) {
            // x0 + round(num / den), halves rounded up like Math.round: floor((2 num + den) / (2 den))
            const num = (x1 - x0) * BigInt(Math.round(ms - t0));
            const den = BigInt(t1 - t0);
            const a = 2n * num + den;
            const b = 2n * den;
            let q = a / b;
            if (a % b < 0n) q -= 1n;
            x = x0 + q;
        }
        return new Variant({ dataType: a.dataType, arrayType: VariantArrayType.Scalar, value: fromBigInt(x) });
    }
    if (typeof a.value !== "number" || typeof b.value !== "number" || !Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;
    let x = t1 > t0 ? a.value + ((b.value - a.value) * (ms - t0)) / (t1 - t0) : a.value;
    const range = INTEGER_RANGE[a.dataType];
    if (range) x = Math.min(range[1], Math.max(range[0], Math.round(x)));
    else if (a.dataType === DataType.Float) x = Math.fround(x);
    return new Variant({ dataType: a.dataType, value: x });
}

// ReadRaw Bounding Value at a boundary time (as node-opcua's own: the stored value there is the bound itself; else
// interpolated between the neighbours, stepped for the Stepped setting and non-numeric values, BadBoundNotFound when
// a neighbour is missing)
function boundValue(before, after, ms, stepped) {
    const time = new Date(ms);
    if (!before || !after || !before.sourceTimestamp || !after.sourceTimestamp) {
        return new DataValue({ sourceTimestamp: time, statusCode: StatusCodes.BadBoundNotFound, value: new Variant() });
    }
    const sloped = stepped ? null : slopeValue(before, after, ms);
    return new DataValue({ sourceTimestamp: time, statusCode: withHistorianBits(before.statusCode, HISTORIAN_INTERPOLATED), value: sloped || before.value });
}

// ------------------------------------------------------------------ ReadRaw

const RAW_PAGING = Symbol("historyRawPaging");

// ReadRaw (isReadModified false) of a variable whose history is in the database is served by readRaw(); node-opcua's
// own ReadRaw extracts the whole requested range, keeps what does not fit in the session's continuation points (in
// memory) and adds the bounds with a call that overflows the stack for large ranges.
function installRawPaging(node, log = () => {}) {
    if (!node || node[RAW_PAGING] || !(node.varHistorian instanceof StoreHistorian)) return;
    node[RAW_PAGING] = true;
    node._historyReadRaw = function (context, details, indexRange, dataEncoding, continuationData, callback) {
        readRaw(this, context, details, continuationData || {}).then((result) => callback(null, result), (err) => {
            log("warn", `HistoryRead raw on ${this.nodeId.toString()} failed: ${err.message}`);
            callback(null, new HistoryReadResult({ statusCode: StatusCodes.BadInternalError }));
        });
    };
}

// every variable that addressSpace.installHistoricalDataNode gives a StoreHistorian gets readRaw (node-opcua calls
// addressSpace.onHistorizingNodeAdded at its end; the hook node-opcua-server set is kept)
function hookRawPaging(addressSpace, log) {
    if (!addressSpace || addressSpace[RAW_PAGING]) return;
    addressSpace[RAW_PAGING] = true;
    const previous = addressSpace.onHistorizingNodeAdded;
    addressSpace.onHistorizingNodeAdded = function (node) {
        installRawPaging(node, log);
        return typeof previous === "function" ? previous.call(this, node) : undefined;
    };
}

// OPC 10000-11 6.5.3 with the same rules as node-opcua's ReadRaw: startTime / endTime / numValuesPerNode (at least
// two), endTime before startTime (or only endTime) = newest first, Bounding Values (returnBounds) only with both times.
function newRawState(target, details) {
    const start = timeOf(details.startTime);
    const end = timeOf(details.endTime);
    const n = Math.max(0, Math.floor(Number(details.numValuesPerNode) || 0));
    if ((start === null && end === null) || (start === null && n === 0)) return { statusCode: StatusCodes.BadHistoryOperationUnsupported };
    const both = start !== null && end !== null;
    return {
        kind: "raw",
        target,
        lo: start === null ? MIN_TIME : both ? Math.min(start, end) : start,
        hi: end === null ? MAX_TIME : both ? Math.max(start, end) : end,
        reverse: both ? end < start : start === null,
        // both times: pages of numValuesPerNode (0 = all) until endTime; one time: numValuesPerNode values in all
        page: both && n > 0 ? n : Infinity,
        left: both || n === 0 ? Infinity : n,
        bounds: both && !!details.returnBounds,
        firstDone: false,
        lastDone: false,
        rowsDone: false,
        cursor: null, // last stored value delivered: { ts, pico, id }
        prev: null // its DataValue, the nearest value inside the range for the last bound
    };
}

async function readRaw(node, context, details, continuationData) {
    const historian = node.varHistorian;
    const points = continuationPointsOf(node.addressSpace);
    const target = node.nodeId.toString();
    const taken = takeState(points, context, continuationData, "raw", target);
    if (taken.result) return taken.result;
    let state = taken.state;
    if (!state) {
        state = newRawState(target, details);
        if (state.statusCode) return new HistoryReadResult({ statusCode: state.statusCode });
    }
    const unavailable = () => new HistoryReadResult({ statusCode: StatusCodes.BadDataUnavailable });
    if (!historian.store.isOpen) return unavailable(); // damaged or closed database
    const budget = requestBudget(details);
    return inTurn(budget, async () => {
        if (!historian.store.isOpen) return unavailable();
        if (budgetUsed(budget)) return deferred(points, context, state, budget, () => new HistoryData({ dataValues: [] }));
        let dataValues;
        try {
            dataValues = await rawPage(historian, state, budget, isStepped(node));
        } catch (err) {
            if (!historian.store.isOpen) return unavailable();
            throw err;
        }
        let continuationPoint;
        if (!state.rowsDone || (state.bounds && !state.lastDone)) {
            continuationPoint = points.add(context, state, budget);
            if (!continuationPoint) return noContinuationPoints();
        }
        return new HistoryReadResult({
            statusCode: dataValues.length || continuationPoint ? StatusCodes.Good : StatusCodes.GoodNoData,
            continuationPoint,
            historyData: new HistoryData({ dataValues })
        });
    });
}

// The next page of a ReadRaw: at most page size / MAX_RAW_VALUES_PER_CALL values (bounds included), read in chunks
// with event loop turns in between, cut short (maybe empty) when the request has used its budget.
async function rawPage(historian, state, budget, stepped) {
    const { store, key, mapper } = historian;
    const out = [];
    const cap = Math.min(state.page, MAX_RAW_VALUES_PER_CALL, state.left);
    const fetch = (limit) => store.valueRows(key, { start: state.lo, end: state.hi, reverse: state.reverse, after: state.cursor, limit });
    // `inside`: the stored value of the range nearest to that boundary, if any
    const lowBound = (inside) => boundValue(historian.findBoundBefore(new Date(state.lo)), inside || historian.findBoundAfter(new Date(state.lo)), state.lo, stepped);
    const highBound = (inside) => boundValue(inside || historian.findBoundBefore(new Date(state.hi)), historian.findBoundAfter(new Date(state.hi)), state.hi, stepped);
    if (state.bounds && !state.firstDone) {
        state.firstDone = true;
        const [row] = fetch(1);
        const first = row ? rowToDataValue(row, mapper) : null;
        if (state.lo === state.hi) {
            // one instant: the values stored at that time, or else one bound
            state.lastDone = true;
            if (!first) out.push(boundValue(historian.findBoundBefore(new Date(state.lo)), historian.findBoundAfter(new Date(state.lo)), state.lo, stepped));
        } else {
            const edge = state.reverse ? state.hi : state.lo;
            if (!first || first.sourceTimestamp.getTime() !== edge) out.push(state.reverse ? highBound(first) : lowBound(first));
        }
    }
    while (!state.rowsDone && out.length < cap) {
        if (nextTurnDue()) await nextTurn();
        if (budget.bytes <= 0) {
            // the request has returned enough: the rest with the continuation point (none when no value is left)
            if (!fetch(1).length) state.rowsDone = true;
            break;
        }
        const want = Math.min(VALUE_CHUNK, cap - out.length);
        const rows = fetch(want);
        for (const row of rows) {
            const dv = rowToDataValue(row, mapper);
            out.push(dv);
            budget.bytes -= 32 + (row.value.length * 3) / 4;
            state.cursor = { ts: row.ts, pico: row.pico, id: row.id };
            state.prev = dv;
        }
        if (rows.length < want) state.rowsDone = true;
        else if (out.length >= cap && !fetch(1).length) state.rowsDone = true;
    }
    if (Number.isFinite(state.left)) {
        state.left -= out.length;
        if (state.left <= 0) state.rowsDone = true;
    }
    if (state.rowsDone && state.bounds && !state.lastDone && out.length < cap) {
        state.lastDone = true;
        const edge = state.reverse ? state.lo : state.hi;
        const last = state.prev;
        if (!last || last.sourceTimestamp.getTime() !== edge) out.push(state.reverse ? lowBound(last) : highBound(last));
    }
    return out;
}

// ------------------------------------------------------------------ ReadAtTime

// node-opcua's in-memory VariableHistorian (used when the database cannot be opened) has no findAt / findBounds
function historianAt(historian, date) {
    if (typeof historian.findAt === "function") return historian.findAt(date);
    let found = null;
    historian.extractDataValues({ startTime: date, endTime: date }, 0, false, false, (err, values) => {
        if (!err && values && values.length) found = values[values.length - 1];
    });
    return found;
}

function historianBounds(historian, date, notBad) {
    if (typeof historian.findBounds === "function") return historian.findBounds(date, notBad);
    return { before: historian.findBoundBefore(date), after: historian.findBoundAfter(date), skippedBefore: false, skippedAfter: false };
}

// The value at one requested time (OPC 10000-11 6.5.4 ReadAtTimeDetails, interpolation as the Part 13 Interpolated
// aggregate): an exact sample is returned as stored (historian bits Raw); otherwise numeric scalars (Int64 / UInt64
// included) are interpolated linearly between the bounding values and other values are stepped (the value before
// holds), with the HistorianInterpolated bits. useSimpleBounds: the nearest stored values whatever their status (a
// Bad bound makes the result Bad); otherwise the nearest non-Bad values (Bad values skipped make it
// UncertainDataSubNormal, as does a NaN or infinite bound, which cannot be interpolated). Before the first or after
// the last stored value there is nothing to interpolate from: BadNoData.
function valueAtTime(historian, time, useSimpleBounds, stepped) {
    const ms = time instanceof Date ? time.getTime() : NaN;
    const noData = () => new DataValue({ sourceTimestamp: Number.isFinite(ms) ? time : null, statusCode: StatusCodes.BadNoData, value: new Variant() });
    if (!Number.isFinite(ms) || isMinDate(time)) return noData();
    const found = historianAt(historian, time);
    if (found) {
        // the in-memory historian hands out its own DataValues: never modify those
        const exact = typeof historian.findAt === "function" ? found : found.clone();
        exact.statusCode = withHistorianBits(exact.statusCode, 0);
        return exact;
    }
    const { before, after, skippedBefore, skippedAfter } = historianBounds(historian, time, !useSimpleBounds);
    if (!before || !after) return noData();
    const sloped = stepped ? null : slopeValue(before, after, ms);
    const bounds = sloped ? [before, after] : [before];
    const bad = bounds.find((dv) => dv.statusCode.isBad());
    if (bad) {
        return new DataValue({ sourceTimestamp: time, statusCode: withHistorianBits(bad.statusCode, HISTORIAN_INTERPOLATED), value: new Variant() });
    }
    // a numeric bound that is NaN / infinite: held, not interpolated, and not Good
    const notFinite = !stepped && !sloped && isNumericVariant(before.value) && isNumericVariant(after.value) &&
        [before.value.value, after.value.value].some((x) => typeof x === "number" && !Number.isFinite(x));
    // severity bits (node-opcua's isGood() is false for a Good code that carries info bits)
    const uncertain = notFinite || skippedBefore || (sloped && skippedAfter) || bounds.some((dv) => dv.statusCode.value >>> 30 !== 0);
    return new DataValue({
        value: sloped || before.value,
        sourceTimestamp: time,
        statusCode: withHistorianBits(uncertain ? StatusCodes.UncertainDataSubNormal : StatusCodes.Good, HISTORIAN_INTERPOLATED)
    });
}

// the requested times of a request as ms (NaN: DateTime.MinValue / invalid), one array shared by all its nodes and
// their continuation points
const requestTimes = new WeakMap();
function requestedTimes(details) {
    let times = requestTimes.get(details);
    if (!times) {
        const list = details.reqTimes || [];
        times = new Float64Array(list.length);
        for (let i = 0; i < list.length; i++) {
            const d = list[i];
            times[i] = d instanceof Date && !isMinDate(d) ? d.getTime() : NaN;
        }
        requestTimes.set(details, times);
    }
    return times;
}

// rough encoded size of a DataValue (request budget)
function dataValueSize(dv) {
    try {
        return 24 + (dv.value ? dv.value.binaryStoreSize() : 1);
    } catch (_) {
        return 64;
    }
}

// rough encoded size of the selected fields of an event (request budget): what is returned, not the stored event
function eventFieldsSize(variants) {
    let n = 8;
    for (const v of variants) {
        try {
            n += v.binaryStoreSize();
        } catch (_) {
            n += 64;
        }
    }
    return n;
}

// HistoryRead with ReadAtTimeDetails on a historizing variable -> HistoryReadResult: one DataValue per requested
// time (at most MAX_AT_TIME_TOTAL), in request order. At most MAX_AT_TIME per call, and only as many as the
// request's computing time allows (the first node of a request always gets on; a later one may get none): the rest
// come with a continuation point, which holds the remaining times. Synchronous (serverEngine's _historyRead
// wrapper), so the time is limited.
function readAtTime(node, context, details, continuationData = {}) {
    if (!node.canUserReadHistory(context)) return new HistoryReadResult({ statusCode: StatusCodes.BadUserAccessDenied });
    const historian = node.varHistorian;
    if (!historian) return new HistoryReadResult({ statusCode: StatusCodes.BadHistoryOperationUnsupported });
    const points = continuationPointsOf(node.addressSpace);
    const target = node.nodeId.toString();
    const taken = takeState(points, context, continuationData, "attime", target);
    if (taken.result) return taken.result;
    let state = taken.state;
    if (!state) {
        const count = (details.reqTimes || []).length;
        if (!count) return new HistoryReadResult({ statusCode: StatusCodes.BadInvalidArgument });
        if (count > MAX_AT_TIME_TOTAL) return new HistoryReadResult({ statusCode: StatusCodes.BadTooManyOperations });
        state = { kind: "attime", target, times: requestedTimes(details), index: 0, useSimpleBounds: !!details.useSimpleBounds };
    }
    const unavailable = () => new HistoryReadResult({ statusCode: StatusCodes.BadDataUnavailable });
    if (historian.store && !historian.store.isOpen) return unavailable();
    const budget = requestBudget(details);
    if (!budget.syncUntil) budget.syncUntil = performance.now() + REQUEST_SYNC_MS;
    const stepped = isStepped(node);
    const end = Math.min(state.times.length, state.index + MAX_AT_TIME);
    const dataValues = [];
    try {
        while (state.index < end) {
            if (budget.bytes <= 0 || performance.now() > budget.syncUntil) break; // the rest with the continuation point
            const ms = state.times[state.index];
            const dv = valueAtTime(historian, Number.isNaN(ms) ? null : new Date(ms), state.useSimpleBounds, stepped);
            budget.bytes -= dataValueSize(dv);
            dataValues.push(dv);
            state.index++;
        }
    } catch (err) {
        if (historian.store && !historian.store.isOpen) return unavailable();
        throw err;
    }
    let continuationPoint;
    if (state.index < state.times.length) {
        continuationPoint = points.add(context, state, budget);
        if (!continuationPoint) return noContinuationPoints();
    }
    return new HistoryReadResult({ statusCode: StatusCodes.Good, continuationPoint, historyData: new HistoryData({ dataValues }) });
}

// ------------------------------------------------------------------ events

const fieldNodeCache = new WeakMap();
// browse path ("EnabledState.Id", "LimitState.CurrentState.Id") -> Variable node, for every field an event of
// `source` can carry. `source` is an event type (fields: instance declarations of the type and its supertypes, the
// base type's first) or a condition instance (fields: its variables). Variables below Object components (sub-state
// machines such as LimitState or ShelvingState) are fields too, the Objects themselves are not.
function eventFieldNodes(source) {
    let map = fieldNodeCache.get(source);
    if (map) return map;
    map = new Map();
    const visit = (node, prefix, depth) => {
        for (const child of node.getAggregates()) {
            const isVariable = child.nodeClass === NodeClass.Variable;
            if (!isVariable && child.nodeClass !== NodeClass.Object) continue;
            const p = prefix + child.browseName.toString();
            if (isVariable && !map.has(p)) map.set(p, child);
            if (depth < 3) visit(child, `${p}.`, depth + 1);
        }
    };
    if (source.nodeClass === NodeClass.ObjectType) {
        const chain = [];
        for (let t = source; t && !sameNodeId(t.nodeId, BASE_OBJECT_TYPE) && chain.length < 32; t = t.subtypeOfObj) chain.unshift(t);
        for (const t of chain) visit(t, "", 0);
    } else {
        visit(source, "", 0);
    }
    fieldNodeCache.set(source, map);
    return map;
}

// value of a condition variable that the event data does not carry, as live delivery reads it
// (FilterContextOnAddressSpace.readNodeValue): its value now, or its status code when that is not Good
function liveFieldValue(node) {
    const dv = node.readValue();
    if (!dv) return null;
    return dv.statusCode.isGood() ? dv.value : new Variant({ dataType: DataType.StatusCode, value: dv.statusCode });
}

function textOf(variant) {
    const v = variant && variant.value;
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object" && "text" in v) return v.text ?? null; // LocalizedText
    if (typeof v === "object" && "name" in v) return v.name ?? null; // QualifiedName
    return String(v);
}

function encodeFields(fields) {
    let size = 4;
    for (const [p, v] of fields) size += 4 + Buffer.byteLength(p, "utf8") + v.binaryStoreSize();
    const stream = new BinaryStream(size);
    stream.writeUInt32(fields.length);
    for (const [p, v] of fields) {
        stream.writeString(p);
        v.encode(stream);
    }
    return stream.buffer;
}

function decodeFields(bytes, map) {
    const stream = new BinaryStream(toBuffer(bytes));
    const count = stream.readUInt32();
    const out = new Map();
    for (let i = 0; i < count; i++) {
        const p = remapPath(stream.readString(), map);
        const v = decodeVariant(stream);
        if (p !== null) out.set(p, remapVariant(v, map)); // a field of a namespace this server does not have is left out
    }
    return out;
}

// Event data (as delivered to notifiers) -> record for HistoryStore.queueEvent: every field the event carries, by
// browse path, plus the columns the UI lists. ctx: { uris, ns }.
function captureEvent(eventData, ctx) {
    const source = eventData.getEventDataSource && eventData.getEventDataSource();
    if (!source) return null;
    // a condition's event data (its snapshot) has no values for the variables below its Object components (e.g.
    // LimitState/CurrentState): live delivery reads those from the condition, so they are taken from it now
    const isCondition = source.nodeClass !== NodeClass.ObjectType;
    const fields = [];
    for (const [p, node] of eventFieldNodes(source)) {
        let v = eventData._readValue(node.nodeId);
        if (!v && isCondition) v = liveFieldValue(node);
        if (v && v.dataType !== DataType.Null) fields.push([p, v]);
    }
    const map = new Map(fields);
    const typeId = map.get("EventType")?.value || (isCondition ? BASE_EVENT_TYPE : source.nodeId);
    const typeNode = source.addressSpace && source.addressSpace.findNode(typeId);
    const date = (v) => (v && v.value instanceof Date && Number.isFinite(v.value.getTime()) ? v.value.getTime() : null);
    const severity = Number(map.get("Severity")?.value);
    return {
        time: date(map.get("Time")) ?? date(map.get("ReceiveTime")) ?? Date.now(),
        eventType: nodeKey(typeId, ctx.uris),
        typeName: typeNode?.browseName?.name || null,
        conditionId: isCondition ? nodeKey(source.nodeId, ctx.uris) : null,
        conditionName: textOf(map.get("ConditionName")),
        sourceName: textOf(map.get("SourceName")),
        message: textOf(map.get("Message")),
        severity: Number.isFinite(severity) ? severity : null,
        ns: ctx.ns,
        fields: encodeFields(fields)
    };
}

// A stored event shaped like node-opcua's EventData (getEventDataSource / _browse / _readValue), so its filter code
// (select clauses, where clause, ReceiveEvents permission) evaluates history exactly like live events. A field the
// event did not carry reads as an empty Variant, never as the current value of the node.
class StoredEvent {
    constructor(source, fields, conditionId) {
        this.source = source;
        this.fields = fields;
        this.conditionId = conditionId;
        this.byNodeId = new Map();
        const nodes = eventFieldNodes(source);
        for (const [p, v] of fields) {
            const node = nodes.get(p);
            if (node) this.byNodeId.set(node.nodeId.toString(), v);
        }
        this.sourceNode = fields.get("SourceNode") || null; // read by canReceiveEvent
    }

    getEventDataSource() {
        return this.source;
    }

    _browse(browsePath) {
        if (!sameNodeId(browsePath.startingNode, this.source.nodeId)) return null;
        const p = (browsePath.relativePath.elements || []).map((e) => e.targetName.toString()).join(".");
        const node = eventFieldNodes(this.source).get(p);
        if (!node) return null;
        return new BrowsePathResult({ statusCode: StatusCodes.Good, targets: [{ remainingPathIndex: 0, targetId: coerceExpandedNodeId(node.nodeId) }] });
    }

    _readValue(nodeId) {
        return this.byNodeId.get(nodeId.toString()) || new Variant();
    }
}

// HistoryRead with ReadEventDetails on event notifiers. Continuation points keep a cursor (time, recording order)
// instead of the remaining events, so a long history costs no memory between calls. Reading gives the event loop a
// turn every SLICE_MS and stops (continuation point) when the request has examined or returned enough.
// It also makes ReadRaw of the address space's StoreHistorian variables page from the database (hookRawPaging).
class EventHistoryReader {
    // store, addressSpace, uris (current namespace array), mapper (NamespaceMapper), enabled, log
    constructor({ store, addressSpace, uris, mapper, enabled = true, maxContinuationPoints = 10, log = () => {} }) {
        this.store = store;
        this.addressSpace = addressSpace;
        this.uris = uris;
        this.mapper = mapper;
        this.enabled = enabled;
        this.log = log;
        this.points = continuationPointsOf(addressSpace);
        this.points.max = Math.max(1, maxContinuationPoints);
        this.baseEventType = addressSpace.findNode(BASE_EVENT_TYPE);
        hookRawPaging(addressSpace, log);
    }

    // obj.historyRead is what node-opcua's HistoryRead service calls for Objects
    install(obj, key) {
        obj.historyRead = (context, details, indexRange, dataEncoding, continuationData) => this.historyRead(obj, key, context, details, continuationData);
    }

    // continuation points of a closed session (events, raw values, values at times)
    releaseSession(sessionId) {
        this.points.releaseSession(sessionId);
    }

    clear() {
        this.points.clear();
    }

    async historyRead(obj, key, context, details, continuationData) {
        try {
            return await this.read(obj, key, context, details, continuationData || {});
        } catch (err) {
            this.log("warn", `Event history read on ${obj.browseName.toString()} failed: ${err.message}`);
            return new HistoryReadResult({ statusCode: this.store.isOpen ? StatusCodes.BadInternalError : StatusCodes.BadDataUnavailable });
        }
    }

    async read(obj, key, context, details, continuationData) {
        const unsupported = () => new HistoryReadResult({ statusCode: StatusCodes.BadHistoryOperationUnsupported });
        if (!(details instanceof ReadEventDetails) || !this.enabled) return unsupported();
        if ((obj.eventNotifier & EventNotifierFlags.HistoryRead) === 0) return unsupported();
        if (context && typeof context.checkPermission === "function" && !context.checkPermission(obj, PermissionType.ReadHistory)) {
            return new HistoryReadResult({ statusCode: StatusCodes.BadUserAccessDenied });
        }
        const taken = takeState(this.points, context, continuationData, "events", key);
        if (taken.result) return taken.result;
        let state = taken.state;
        if (!state) {
            state = this.newState(key, details);
            if (!state) return new HistoryReadResult({ statusCode: StatusCodes.BadInvalidArgument });
        }
        const budget = requestBudget(details);
        return inTurn(budget, async () => {
            if (!this.store.isOpen) return new HistoryReadResult({ statusCode: StatusCodes.BadDataUnavailable });
            if (budgetUsed(budget)) return deferred(this.points, context, state, budget, () => new HistoryEvent({ events: [] }));
            const { events, more } = await this.readPage(state, context, budget);
            let continuationPoint;
            if (more) {
                continuationPoint = this.points.add(context, state, budget);
                if (!continuationPoint) return noContinuationPoints();
            }
            return new HistoryReadResult({
                statusCode: events.length || more ? StatusCodes.Good : StatusCodes.GoodNoData,
                continuationPoint,
                historyData: new HistoryEvent({ events })
            });
        });
    }

    // Part 11 6.5.2: at least two of startTime, endTime, numValuesPerNode; endTime before startTime (or only endTime)
    // returns the newest events first.
    newState(key, details) {
        const start = timeOf(details.startTime);
        const end = timeOf(details.endTime);
        const n = Math.max(0, Math.floor(Number(details.numValuesPerNode) || 0));
        if ((start !== null) + (end !== null) + (n > 0) < 2) return null;
        const both = start !== null && end !== null;
        const filter = details.filter || {};
        return {
            kind: "events",
            target: key,
            lo: start === null ? MIN_TIME : both ? Math.min(start, end) : start,
            hi: end === null ? MAX_TIME : both ? Math.max(start, end) : end,
            reverse: both ? end < start : start === null,
            n,
            select: filter.selectClauses || [],
            where: filter.whereClause || null,
            cursor: null
        };
    }

    async readPage(state, context, budget) {
        const pageMax = Math.min(state.n > 0 ? state.n : MAX_EVENTS_PER_CALL, MAX_EVENTS_PER_CALL);
        const events = [];
        const query = (limit) => this.store.eventRows(state.target, { lo: state.lo, hi: state.hi, reverse: state.reverse, after: state.cursor, limit });
        // a continuation point only when stored events are left (not when the page ends exactly at the last one)
        const left = () => query(1).length > 0;
        let scanned = 0;
        for (;;) {
            if (nextTurnDue()) await nextTurn();
            // the request's budget is shared by its nodes (read in request order): when it is used up, the rest
            // comes with the continuation point. The first node of a request always makes progress.
            if (budgetUsed(budget)) return { events, more: left() };
            const rows = query(EVENT_BATCH);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                state.cursor = { time: row.time, id: row.id };
                scanned++;
                budget.scanned--;
                let ev;
                try {
                    ev = this.eventFromRow(row);
                } catch (err) {
                    continue; // an unreadable entry is skipped, not fatal for the whole read
                }
                if (!this.passes(ev, context, state.where)) continue;
                const eventFields = this.select(ev, state.select);
                events.push(new HistoryEventFieldList({ eventFields }));
                budget.bytes -= eventFieldsSize(eventFields); // the selected fields, not the whole stored event
                if (events.length >= pageMax) return { events, more: i < rows.length - 1 || left() };
            }
            if (rows.length < EVENT_BATCH) return { events, more: false };
            if (scanned >= MAX_EVENTS_SCANNED) return { events, more: left() };
        }
    }

    eventFromRow(row) {
        const fields = decodeFields(row.fields, this.mapper.mapFor(row.ns));
        const typeId = nodeIdFromKey(row.event_type, this.uris);
        let source = typeId && this.addressSpace.findNode(typeId);
        if (!source || source.nodeClass !== NodeClass.ObjectType) source = this.baseEventType;
        const conditionId = row.condition_id ? nodeIdFromKey(row.condition_id, this.uris) : null;
        if (conditionId) {
            const condition = this.addressSpace.findNode(conditionId);
            if (condition && condition.nodeClass === NodeClass.Object) source = condition;
        }
        return new StoredEvent(source, fields, conditionId);
    }

    passes(ev, context, where) {
        // the same ReceiveEvents check as for live events (e.g. Audit events only for SecurityAdmin)
        if (context && typeof context.checkPermission === "function" && !canReceiveEvent(context, this.addressSpace, ev)) return false;
        if (!where || !where.elements || !where.elements.length) return true;
        return checkFilter(new FilterContextOnAddressSpace(SessionContext.defaultContext, ev), where);
    }

    select(ev, selectClauses) {
        const ctx = new FilterContextOnAddressSpace(SessionContext.defaultContext, ev);
        return selectClauses.map((op) => {
            try {
                // ConditionId (ConditionType, empty browse path, attribute NodeId): the stored one, also when the
                // condition no longer exists in the address space
                if (op instanceof SimpleAttributeOperand && !(op.browsePath && op.browsePath.length) && op.attributeId === AttributeIds.NodeId &&
                    (sameNodeId(op.typeDefinitionId, CONDITION_TYPE) || ctx.isSubtypeOf(op.typeDefinitionId, CONDITION_TYPE))) {
                    return ev.conditionId ? new Variant({ dataType: DataType.NodeId, value: ev.conditionId }) : new Variant();
                }
                return extractEventField(ctx, op) || new Variant();
            } catch (_) {
                return new Variant();
            }
        });
    }
}

// Stored event row -> plain object for the UI
function eventRowToPlain(row) {
    const out = {
        time: new Date(row.time).toISOString(),
        eventType: row.type_name || row.event_type.slice(row.event_type.indexOf("|") + 1),
        sourceName: row.source_name || "",
        message: row.message || "",
        severity: row.severity ?? null
    };
    if (row.condition_name) out.conditionName = row.condition_name;
    return out;
}

module.exports = {
    StoreHistorian, NamespaceMapper, EventHistoryReader, readAtTime, readRaw, installRawPaging, valueAtTime, captureEvent,
    nodeKey, nodeIdFromKey, rowToDataValue, eventRowToPlain, MAX_AT_TIME, MAX_AT_TIME_TOTAL, MAX_RAW_VALUES_PER_CALL, MAX_EVENTS_PER_CALL
};
