"use strict";
// Conversion helpers between JSON-friendly UI values and node-opcua Variants.
const {
    DataType,
    Variant,
    VariantArrayType,
    StatusCodes,
    StatusCode,
    LocalizedText,
    QualifiedName,
    coerceNodeId,
    NodeId
} = require("node-opcua");

const SUPPORTED_DATA_TYPES = [
    "Boolean", "SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64",
    "Float", "Double", "String", "DateTime", "Guid", "ByteString", "XmlElement",
    "NodeId", "StatusCode", "QualifiedName", "LocalizedText"
];

const NUMERIC_TYPES = new Set(["SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64", "Float", "Double"]);
const INTEGER_RANGES = {
    SByte: [-128, 127], Byte: [0, 255], Int16: [-32768, 32767], UInt16: [0, 65535],
    Int32: [-2147483648, 2147483647], UInt32: [0, 4294967295],
    Int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], UInt64: [0, Number.MAX_SAFE_INTEGER]
};

// Commonly used status codes, offered in the UI when setting values.
const COMMON_STATUS_CODES = [
    "Good", "GoodLocalOverride", "GoodClamped", "GoodNoData", "GoodMoreData",
    "Uncertain", "UncertainLastUsableValue", "UncertainSensorNotAccurate", "UncertainEngineeringUnitsExceeded",
    "UncertainSubNormal", "UncertainInitialValue", "UncertainNoCommunicationLastUsableValue",
    "Bad", "BadSensorFailure", "BadCommunicationError", "BadDeviceFailure", "BadOutOfService",
    "BadNoCommunication", "BadWaitingForInitialData", "BadConfigurationError", "BadNotConnected",
    "BadOutOfRange", "BadTypeMismatch", "BadDataUnavailable", "BadNodeIdUnknown", "BadInternalError"
];

function statusCodeFromName(name) {
    if (!name) return StatusCodes.Good;
    if (name instanceof StatusCode) return name;
    if (typeof name === "number") return StatusCode.makeStatusCode ? StatusCode.makeStatusCode(name) : StatusCodes.Good;
    const sc = StatusCodes[name];
    if (!sc) throw new Error(`Unknown status code "${name}"`);
    return sc;
}

function toNumber(v, dataType) {
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`"${v}" is not a valid ${dataType}`);
    if (INTEGER_RANGES[dataType]) {
        const [lo, hi] = INTEGER_RANGES[dataType];
        const r = Math.round(n);
        if (r < lo || r > hi) throw new Error(`${v} is out of range for ${dataType} [${lo}..${hi}]`);
        return r;
    }
    return n;
}

function hexOrText(v) {
    if (Buffer.isBuffer(v)) return v;
    const s = String(v ?? "");
    if (/^hex:/i.test(s)) return Buffer.from(s.slice(4).replace(/\s+/g, ""), "hex");
    if (/^base64:/i.test(s)) return Buffer.from(s.slice(7), "base64");
    return Buffer.from(s, "utf8");
}

// Coerce a single UI value (string/number/bool/object) into a JS value acceptable for a Variant.
function coerceScalar(v, dataType) {
    if (NUMERIC_TYPES.has(dataType)) return toNumber(v, dataType);
    switch (dataType) {
        case "Boolean":
            if (typeof v === "string") return ["true", "1", "on", "yes"].includes(v.trim().toLowerCase());
            return !!v;
        case "String":
        case "XmlElement":
            return v === null || v === undefined ? "" : String(v);
        case "DateTime": {
            if (v === "" || v === null || v === undefined || v === "now") return new Date();
            const d = new Date(v);
            if (Number.isNaN(d.getTime())) throw new Error(`"${v}" is not a valid DateTime`);
            return d;
        }
        case "Guid":
            return String(v || "00000000-0000-0000-0000-000000000000");
        case "ByteString":
            return hexOrText(v);
        case "NodeId":
            return coerceNodeId(v || "ns=0;i=0");
        case "StatusCode":
            return statusCodeFromName(v || "Good");
        case "QualifiedName":
            return new QualifiedName({ name: String(v ?? "") });
        case "LocalizedText":
            if (v && typeof v === "object") return new LocalizedText({ text: v.text, locale: v.locale || "" });
            return new LocalizedText({ text: String(v ?? ""), locale: "en" });
        default:
            throw new Error(`Unsupported data type ${dataType}`);
    }
}

function parseArrayInput(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
        const s = value.trim();
        if (s.startsWith("[")) return JSON.parse(s);
        if (s === "") return [];
        return s.split(",").map((x) => x.trim());
    }
    return [value];
}

function makeVariant(value, dataType, valueRank) {
    const dt = DataType[dataType];
    if (dt === undefined) throw new Error(`Unknown data type ${dataType}`);
    if (valueRank >= 1 || valueRank === 0) {
        const arr = parseArrayInput(value).map((x) => coerceScalar(x, dataType));
        let typed = arr;
        const TA = { Float: Float32Array, Double: Float64Array, SByte: Int8Array, Byte: Uint8Array, Int16: Int16Array, UInt16: Uint16Array, Int32: Int32Array, UInt32: Uint32Array }[dataType];
        if (TA) typed = TA.from(arr);
        return new Variant({ dataType: dt, arrayType: VariantArrayType.Array, value: typed });
    }
    return new Variant({ dataType: dt, value: coerceScalar(value, dataType) });
}

function defaultValueFor(dataType, valueRank) {
    if (valueRank >= 1) return "[]";
    if (NUMERIC_TYPES.has(dataType)) return 0;
    switch (dataType) {
        case "Boolean": return false;
        case "DateTime": return new Date().toISOString();
        case "Guid": return "00000000-0000-0000-0000-000000000000";
        case "NodeId": return "ns=0;i=0";
        case "StatusCode": return "Good";
        default: return "";
    }
}

// Convert any node-opcua value into something that survives structured cloning to the renderer
// and is readable for humans.
function toPlain(v, depth = 0) {
    if (v === null || v === undefined) return v ?? null;
    if (depth > 6) return String(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return "hex:" + v.toString("hex");
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (Array.isArray(v)) return v.map((x) => toPlain(x, depth + 1));
    if (v instanceof StatusCode) return v.name;
    if (v instanceof NodeId) return v.toString();
    if (v instanceof LocalizedText) return v.text ?? "";
    if (v instanceof QualifiedName) return v.toString();
    if (v instanceof Variant) return variantToPlain(v);
    if (typeof v.toJSON === "function") {
        try { return toPlain(v.toJSON(), depth + 1); } catch (_) { /* fall through */ }
    }
    const out = {};
    for (const k of Object.keys(v)) {
        if (k.startsWith("_") || typeof v[k] === "function") continue;
        out[k] = toPlain(v[k], depth + 1);
    }
    return out;
}

function int64ToNumber(x) {
    if (Array.isArray(x) && x.length === 2) return x[0] * 0x100000000 + x[1];
    return x;
}

function variantToPlain(variant) {
    if (!variant) return null;
    const dtName = DataType[variant.dataType];
    let value = variant.value;
    if (dtName === "Int64" || dtName === "UInt64") {
        value = variant.arrayType === VariantArrayType.Scalar ? int64ToNumber(value) : Array.from(value || []).map(int64ToNumber);
        return value;
    }
    return toPlain(value);
}

function dataValueToPlain(dv) {
    if (!dv) return null;
    return {
        value: variantToPlain(dv.value),
        dataType: dv.value ? DataType[dv.value.dataType] : "Null",
        arrayType: dv.value ? VariantArrayType[dv.value.arrayType] : "Scalar",
        statusCode: dv.statusCode ? dv.statusCode.name : "Good",
        statusCodeValue: dv.statusCode ? dv.statusCode.value : 0,
        sourceTimestamp: dv.sourceTimestamp ? dv.sourceTimestamp.toISOString() : null,
        sourcePicoseconds: dv.sourcePicoseconds || 0,
        serverTimestamp: dv.serverTimestamp ? dv.serverTimestamp.toISOString() : null,
        serverPicoseconds: dv.serverPicoseconds || 0
    };
}

module.exports = {
    SUPPORTED_DATA_TYPES,
    NUMERIC_TYPES,
    COMMON_STATUS_CODES,
    statusCodeFromName,
    coerceScalar,
    makeVariant,
    defaultValueFor,
    toPlain,
    variantToPlain,
    dataValueToPlain
};
