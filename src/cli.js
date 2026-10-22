#!/usr/bin/env node
"use strict";
// Headless entry point: `node src/cli.js [--project file] [--port 4840] ...` (used by Docker and npm run headless).
// Keep this file parseable by old Node.js versions (no optional chaining / nullish coalescing): the version
// check below must be able to run there.
const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 13)) {
    // node-opcua needs require() of ES modules, which older versions fail with a cryptic ERR_REQUIRE_ESM
    console.error(`OPC UA Simulator needs Node.js 22.13 or newer (found ${process.version}).`);
    console.error("Install a current Node.js from https://nodejs.org (or NodeSource / nvm), or use the Docker image or the installed app instead.");
    process.exit(1);
}

const os = require("os");
const path = require("path");
const { runHeadless } = require("./main/headless");

process.on("unhandledRejection", (err) => console.error("Unhandled error:", (err && err.message) || err));

runHeadless(process.argv.slice(2), { defaultDataDir: path.join(os.homedir(), ".opcua-simulator") }).catch((err) => {
    console.error(`ERROR: ${(err && err.message) || err}`);
    process.exit(1);
});
