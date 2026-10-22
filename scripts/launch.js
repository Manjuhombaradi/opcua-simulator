#!/usr/bin/env node
"use strict";
// Starts the desktop app from source (npm start). Clears ELECTRON_RUN_AS_NODE, which some
// environments (e.g. editor extension hosts) set and which would make Electron behave like plain Node.
// Written in ES5 syntax on purpose: an old Node.js must be able to parse this file to print the
// version message below instead of a SyntaxError.
var path = require("path");
var fs = require("fs");
var spawn = require("child_process").spawn;
var spawnSync = require("child_process").spawnSync;

var MIN_NODE = [22, 13];
var nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < MIN_NODE[0] || (nodeVersion[0] === MIN_NODE[0] && nodeVersion[1] < MIN_NODE[1])) {
    console.error("OPC UA Simulator needs Node.js " + MIN_NODE.join(".") + " or newer to run from source (found " + process.version + ").");
    console.error("Install the current LTS from https://nodejs.org (Linux: https://github.com/nodesource/distributions),");
    console.error("or use a ready-made package instead: Windows installer / portable .exe, macOS .dmg, Linux .deb / AppImage, or Docker.");
    process.exit(1);
}

// Electron's binary is OS specific: a node_modules folder copied from (or shared with) another system
// would start the wrong binary.
var EXPECTED_BINARY = { darwin: "Electron.app/Contents/MacOS/Electron", win32: "electron.exe" }[process.platform] || "electron";
var REINSTALL_HINT = "node_modules was installed on another system (copied or shared folder). Delete the node_modules folder and start again\n" +
    "(the Start Simulator scripts reinstall automatically), or delete it and run: npm install && npm start";
var installedBinary = null;
try {
    installedBinary = fs.readFileSync(path.join(path.dirname(require.resolve("electron/package.json")), "path.txt"), "utf8").trim();
} catch (_) { /* not downloaded yet (Electron downloads its binary on first use) or not installed */ }
if (installedBinary && installedBinary !== EXPECTED_BINARY) {
    console.error("The installed Electron binary (" + installedBinary + ") is not for " + process.platform + "-" + process.arch + ".");
    console.error(REINSTALL_HINT);
    process.exit(1);
}

var electron;
try {
    electron = require("electron");
} catch (err) {
    console.error("Could not load Electron: " + String(err && err.message ? err.message : err).split("\n")[0]);
    console.error("Run `npm install` (needs internet) and start again. If that does not help, delete the node_modules folder first.");
    process.exit(1);
}

var env = {};
Object.keys(process.env).forEach(function (key) { env[key] = process.env[key]; });
delete env.ELECTRON_RUN_AS_NODE;
var args = [path.join(__dirname, "..")].concat(process.argv.slice(2));
// Linux: same decision as the packaged launcher (build/afterPack.js). The Chromium sandbox stays on unless
// it cannot work: running as root, or no usable unprivileged user namespaces (kernel setting, container,
// or Ubuntu 23.10+'s AppArmor restriction - node_modules/electron has no AppArmor profile) and no
// root-owned SUID chrome-sandbox. It must be decided before Electron starts: Electron checks it before any
// app code runs.
function firstLine(file) {
    try { return fs.readFileSync(file, "utf8").split("\n")[0].trim(); } catch (_) { return ""; }
}
function linuxSandboxProblem() {
    if (args.indexOf("--no-sandbox") >= 0 || env.ELECTRON_DISABLE_SANDBOX !== undefined) return "turned off on request (--no-sandbox / ELECTRON_DISABLE_SANDBOX)";
    if (process.getuid && process.getuid() === 0) return "running as root (start it as a normal user to keep it)";
    var userns = true;
    if (firstLine("/proc/sys/kernel/unprivileged_userns_clone") === "0" || firstLine("/proc/sys/user/max_user_namespaces") === "0") {
        userns = false;
    } else if (firstLine("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") {
        userns = false;
    } else {
        var probe = spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore" });
        if (probe.error || probe.status !== 0) userns = false;
    }
    if (userns) return "";
    try {
        // SUID fallback: root-owned chrome-sandbox with the setuid bit (04000), in a folder without spaces
        var helper = path.join(path.dirname(electron), "chrome-sandbox");
        var st = fs.statSync(helper);
        if (st.uid === 0 && (st.mode & 2048) && helper.indexOf(" ") < 0) return "";
    } catch (_) { /* no helper */ }
    return "unprivileged user namespaces are not available (kernel setting, container or AppArmor restriction)";
}
if (process.platform === "linux") {
    var sandboxProblem = linuxSandboxProblem();
    if (sandboxProblem) {
        console.error("OPC UA Simulator: Chromium sandbox disabled: " + sandboxProblem + ". See SECURITY.md, section Linux sandbox.");
        env.ELECTRON_DISABLE_SANDBOX = "1";
        env.OPCUA_SANDBOX_NOTE = "Chromium sandbox disabled: " + sandboxProblem;
        if (args.indexOf("--no-sandbox") < 0) args.splice(1, 0, "--no-sandbox");
    }
}

function spawnFailed(err) {
    console.error("Could not start Electron (" + electron + "): " + (err && err.message ? err.message : err));
    // ENOEXEC / EBADARCH (macOS: "Bad CPU type"): binary for another OS or CPU; EACCES: lost its executable bit
    if (err && (err.code === "ENOEXEC" || err.code === "EACCES" || err.code === "EBADARCH" || err.errno === -8 || err.errno === -86)) {
        console.error("The Electron binary cannot run on this system (" + process.platform + "-" + process.arch + "). " + REINSTALL_HINT);
    }
    process.exit(1);
}

var child;
try {
    child = spawn(electron, args, { stdio: "inherit", env: env });
} catch (err) {
    spawnFailed(err);
}
child.on("error", spawnFailed);
child.on("exit", function (code, signal) { process.exit(signal ? 1 : (code == null ? 0 : code)); });
["SIGINT", "SIGTERM"].forEach(function (sig) {
    process.on(sig, function () { child.kill(sig); });
});
