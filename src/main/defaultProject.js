"use strict";
// The project that is loaded on first start. It demonstrates every feature of the simulator.
let counter = 0;
const id = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

function variable(name, dataType, extra = {}) {
    return {
        id: id(),
        kind: "variable",
        name,
        nodeId: "",
        description: extra.description || "",
        variable: {
            dataType,
            valueRank: -1,
            arrayLength: 0,
            value: extra.value ?? (dataType === "Boolean" ? false : dataType === "String" ? "" : 0),
            access: extra.access || "rw",
            historizing: !!extra.historizing,
            analog: !!extra.analog,
            unit: extra.unit || "",
            euLow: extra.euLow ?? 0,
            euHigh: extra.euHigh ?? 100,
            minimumSamplingInterval: extra.minimumSamplingInterval ?? 0,
            simulation: Object.assign({ type: "none", min: 0, max: 100, period: 10000, interval: 1000, step: 1 }, extra.simulation || {}),
            ...(extra.valueRank !== undefined ? { valueRank: extra.valueRank, arrayLength: extra.arrayLength || 0 } : {})
        }
    };
}

// Demo log-ins of the default project (the headless banner prints these when they are unchanged).
const DEFAULT_USERS = [
    { username: "admin", password: "admin", role: "ConfigureAdmin" },
    { username: "operator", password: "operator", role: "Operator" },
    { username: "viewer", password: "viewer", role: "Observer" }
];

function createDefaultProject() {
    const temperature = variable("Temperature", "Double", {
        unit: "°C", analog: true, euLow: 0, euHigh: 150, historizing: true,
        simulation: { type: "sine", min: 20, max: 110, period: 60000, interval: 1000 }
    });
    const pressure = variable("Pressure", "Double", {
        unit: "bar", analog: true, euLow: 0, euHigh: 10, historizing: true,
        simulation: { type: "randomWalk", min: 2, max: 8, step: 0.2, interval: 1000 }
    });
    const valveOpen = variable("ValveOpen", "Boolean", { value: true, description: "Writable valve state" });
    const running = variable("Running", "Boolean", { value: true, access: "rw" });

    return {
        version: 1,
        name: "Demo Plant",
        server: {
            port: 4840,
            resourcePath: "/UA/Simulator",
            hostname: "",
            applicationName: "OPC UA Simulator",
            applicationUri: "urn:opcua-simulator:server",
            productUri: "urn:opcua-simulator",
            manufacturerName: "OPC UA Simulator",
            productName: "OPC UA Simulator",
            softwareVersion: "1.0.0",
            namespaceUri: "urn:opcua-simulator:sim",
            advertiseIpAddresses: true,
            alternateHostnames: "",
            // extra endpoint URLs (comma separated opc.tcp://host:port[/path]) for NAT / Docker port mapping
            advertisedUrls: "",
            securityPolicies: ["None", "Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss"],
            securityModes: ["None", "Sign", "SignAndEncrypt"],
            allowAnonymous: true,
            // what anonymous clients may do: "readwrite" (demo default) or "readonly" (secure preset).
            // Named roles (Operator/Engineer/.../Admin) may always write and call; Observer is read-only (SS-03).
            anonymousAccess: "readwrite",
            allowUsername: true,
            allowCertificate: true,
            users: DEFAULT_USERS.map((u) => ({ ...u })),
            autoAcceptCertificates: true,
            // which network interfaces the server listens on: "all" (default) or "localhost" (loopback only) (EG-2/SS-02)
            listenAddress: "all",
            maxSessions: 100,
            maxSubscriptions: 1000,
            maxConnectionsPerEndpoint: 100,
            minSupportedSampleRate: 100,
            isAuditing: false,
            // history saved in <data folder>/history/history.db (survives restarts, cleared only on request):
            // values kept per historizing variable and events per event notifier (0 = not recorded, at most 1 000 000)
            valueHistorySize: 100000,
            eventHistorySize: 100000,
            companionNodesets: [],
            customNodesetFiles: [],
            registerToLds: false,
            ldsUrl: "opc.tcp://localhost:4840",
            runDiscoveryServer: false,
            discoveryServerPort: 4841
        },
        nodes: [
            {
                id: id(), kind: "folder", name: "Simulation", nodeId: "", description: "Signal generators",
                children: [
                    variable("Sine", "Double", { simulation: { type: "sine", min: -100, max: 100, period: 20000, interval: 500 } }),
                    variable("Triangle", "Double", { simulation: { type: "triangle", min: 0, max: 100, period: 20000, interval: 500 } }),
                    variable("Sawtooth", "Double", { simulation: { type: "sawtooth", min: 0, max: 100, period: 20000, interval: 500 } }),
                    variable("Square", "Int32", { simulation: { type: "square", min: 0, max: 1, period: 4000, interval: 500 } }),
                    variable("Random", "Double", { simulation: { type: "random", min: 0, max: 1000, interval: 1000 } }),
                    variable("RandomWalk", "Float", { simulation: { type: "randomWalk", min: 0, max: 100, step: 2, interval: 1000 } }),
                    variable("Ramp", "Int32", { simulation: { type: "ramp", min: 0, max: 1000, step: 10, interval: 1000 } }),
                    variable("Counter", "UInt32", { simulation: { type: "counter", min: 0, max: 4294967295, step: 1, interval: 1000 } }),
                    variable("Toggle", "Boolean", { simulation: { type: "toggle", interval: 2000 } }),
                    variable("Clock", "DateTime", { simulation: { type: "clock", interval: 1000 } }),
                    variable("Text", "String", { simulation: { type: "counter", min: 0, max: 99999, step: 1, interval: 2000 }, value: "Text 0" })
                ]
            },
            {
                id: id(), kind: "folder", name: "Plant", nodeId: "", description: "Example equipment",
                children: [
                    {
                        id: id(), kind: "object", name: "Boiler1", nodeId: "", description: "Boiler with alarms",
                        children: [
                            temperature, pressure, valveOpen, running,
                            variable("Setpoint", "Double", { value: 85, unit: "°C", analog: true, euLow: 0, euHigh: 150 }),
                            variable("Status", "String", { value: "Running" }),
                            variable("SerialNumber", "String", { value: "BLR-0001", access: "r" }),
                            {
                                id: id(), kind: "alarm", name: "TemperatureAlarm", nodeId: "", description: "Exclusive limit alarm on temperature",
                                alarm: { type: "ExclusiveLimit", sourceId: temperature.id, highHigh: 105, high: 95, low: 25, lowLow: 22, severity: 700, normalValue: "" }
                            },
                            {
                                id: id(), kind: "alarm", name: "PressureAlarm", nodeId: "", description: "Non-exclusive limit alarm on pressure",
                                alarm: { type: "NonExclusiveLimit", sourceId: pressure.id, highHigh: 7.8, high: 7, low: 3, lowLow: 2.2, severity: 500, normalValue: "" }
                            },
                            {
                                id: id(), kind: "alarm", name: "RunningOffNormal", nodeId: "", description: "Active when Running is false",
                                alarm: { type: "OffNormal", sourceId: running.id, severity: 300, normalValue: "true" }
                            },
                            {
                                id: id(), kind: "method", name: "SetSetpoint", nodeId: "", description: "Writes the boiler setpoint",
                                method: {
                                    inputs: [{ name: "Value", dataType: "Double" }],
                                    outputs: [{ name: "Previous", dataType: "Double" }],
                                    script: "const prev = getValue('Plant/Boiler1/Setpoint');\nsetValue('Plant/Boiler1/Setpoint', inputs[0]);\nreturn [prev];"
                                }
                            }
                        ]
                    }
                ]
            },
            {
                id: id(), kind: "folder", name: "DataTypes", nodeId: "", description: "One variable per built-in type",
                children: [
                    ...["Boolean", "SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64", "Float", "Double",
                        "String", "DateTime", "Guid", "ByteString", "XmlElement", "NodeId", "StatusCode", "QualifiedName", "LocalizedText"]
                        .map((t) => variable(t, t, {
                            value: { Boolean: true, String: "Hello OPC UA", DateTime: new Date().toISOString(), Guid: "72962b91-fa75-4ae6-8d28-b404dc7daf63", ByteString: "hex:deadbeef", XmlElement: "<a>1</a>", NodeId: "ns=0;i=2253", StatusCode: "Good", QualifiedName: "Name", LocalizedText: "Hello" }[t] ?? 0
                        })),
                    {
                        id: id(), kind: "folder", name: "Arrays", nodeId: "", description: "",
                        children: [
                            variable("DoubleArray", "Double", { valueRank: 1, arrayLength: 5, value: "[1.1, 2.2, 3.3, 4.4, 5.5]" }),
                            variable("Int32Array", "Int32", { valueRank: 1, arrayLength: 5, value: "[1, 2, 3, 4, 5]" }),
                            variable("StringArray", "String", { valueRank: 1, arrayLength: 3, value: "[\"alpha\", \"beta\", \"gamma\"]" }),
                            variable("BooleanArray", "Boolean", { valueRank: 1, arrayLength: 4, value: "[true, false, true, false]" })
                        ]
                    }
                ]
            },
            {
                id: id(), kind: "object", name: "Methods", nodeId: "", description: "Callable methods",
                children: [
                    {
                        id: id(), kind: "method", name: "Add", nodeId: "", description: "Adds two numbers",
                        method: { inputs: [{ name: "A", dataType: "Double" }, { name: "B", dataType: "Double" }], outputs: [{ name: "Sum", dataType: "Double" }], script: "return [inputs[0] + inputs[1]];" }
                    },
                    {
                        id: id(), kind: "method", name: "Echo", nodeId: "", description: "Returns the input string",
                        method: { inputs: [{ name: "Message", dataType: "String" }], outputs: [{ name: "Reply", dataType: "String" }], script: "return ['Echo: ' + inputs[0]];" }
                    },
                    {
                        id: id(), kind: "method", name: "GetServerTime", nodeId: "", description: "No inputs, returns current time",
                        method: { inputs: [], outputs: [{ name: "Time", dataType: "DateTime" }], script: "return [new Date()];" }
                    }
                ]
            }
        ]
    };
}

module.exports = { createDefaultProject, newId: id, DEFAULT_USERS };
