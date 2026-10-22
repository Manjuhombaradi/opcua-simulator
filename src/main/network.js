"use strict";
// Network helpers: local addresses for endpoint URLs and TCP port availability checks.
const os = require("os");
const net = require("net");

function localIPv4Addresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) {
            if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) out.push(i.address);
        }
    }
    return [...new Set(out)];
}

function networkInfo() {
    return { hostname: os.hostname(), addresses: localIPv4Addresses(), platform: process.platform };
}

// Test-binds one address; resolves to null when the bind worked, otherwise to the error code.
function probe(port, host) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", (err) => resolve(err.code || err.message));
        srv.once("listening", () => srv.close(() => resolve(null)));
        if (host) srv.listen(port, host);
        else srv.listen(port);
    });
}

// The default bind (dual-stack "::" where available, which is what node-opcua uses) is not enough on
// macOS/BSD: with SO_REUSEADDR it succeeds even when another program listens on 0.0.0.0 or 127.0.0.1,
// and IPv4 clients would then reach that program. So the specific addresses are probed too; for those
// only "in use" counts (e.g. macOS allows low ports on the wildcard address but not on 127.0.0.1, and
// ::1 does not exist on hosts without IPv6).
const EXTRA_PROBE_HOSTS = ["0.0.0.0", "127.0.0.1", "::1"];

function reasonFor(code) {
    return code === "EADDRINUSE" ? "in-use" : code === "EACCES" ? "permission" : code;
}

/** Resolves to { free: boolean, reason?: "in-use" | "permission" | string }. */
async function checkPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { free: false, reason: "invalid" };
    const code = await probe(p);
    if (code) return { free: false, reason: reasonFor(code) };
    // also every LAN address: a program bound to one interface would otherwise receive remote clients
    for (const host of [...EXTRA_PROBE_HOSTS, ...localIPv4Addresses()]) {
        if ((await probe(p, host)) === "EADDRINUSE") return { free: false, reason: "in-use" };
    }
    return { free: true };
}

async function findFreePort(start, exclude = []) {
    const skip = new Set((Array.isArray(exclude) ? exclude : []).map(Number));
    for (let p = Math.max(1024, Number(start) || 4840); p < 65535; p++) {
        if (skip.has(p)) continue;
        if ((await checkPort(p)).free) return p;
    }
    return null;
}

function portProblemMessage(port, reason) {
    if (reason === "in-use") return `Port ${port} is already in use by another program (maybe another OPC UA server or a second copy of this simulator).`;
    if (reason === "permission") return `Port ${port} needs administrator/root rights on this system. Use a port above 1024 (OPC UA default is 4840).`;
    if (reason === "invalid") return `"${port}" is not a valid TCP port (1-65535).`;
    return `Port ${port} cannot be opened (${reason}).`;
}

module.exports = { localIPv4Addresses, networkInfo, checkPort, findFreePort, portProblemMessage };
