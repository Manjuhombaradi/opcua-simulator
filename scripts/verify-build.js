#!/usr/bin/env node
"use strict";
// Checks the unpacked apps electron-builder leaves in dist/ (CI runs it after each build):
//  - the Electron fuses match package.json "build.electronFuses" (on Linux: the real binary <exe>.bin,
//    see build/afterPack.js),
//  - the Electron / Chromium licence notices are included,
//  - on Linux, <exe> is the launcher script.
// Usage: node scripts/verify-build.js [dist folder]
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const dist = path.resolve(process.argv[2] || path.join(root, pkg.build.directories.output || "dist"));
const productName = pkg.build.productName || pkg.productName;
const exeName = pkg.build.linux.executableName;

function loadFuses() {
    try {
        return require("@electron/fuses");
    } catch (_) {
        const builderLib = path.dirname(require.resolve("app-builder-lib/package.json"));
        return require(require.resolve("@electron/fuses", { paths: [builderLib] }));
    }
}
const { getCurrentFuseWire, FuseV1Options } = loadFuses();

// package.json key (runAsNode) -> FuseV1Options index; resetAdHocDarwinSignature is not a fuse
const expected = Object.entries(pkg.build.electronFuses || {})
    .filter(([key]) => key !== "resetAdHocDarwinSignature")
    .map(([key, value]) => {
        const name = key[0].toUpperCase() + key.slice(1);
        if (FuseV1Options[name] === undefined) throw new Error(`Unknown fuse in package.json: ${key}`);
        return { name, index: FuseV1Options[name], value };
    });
if (!expected.length) throw new Error("package.json build.electronFuses is empty");

const targets = [];
for (const entry of fs.existsSync(dist) ? fs.readdirSync(dist, { withFileTypes: true }) : []) {
    const dir = path.join(dist, entry.name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (/^mac/.test(entry.name)) {
        for (const app of fs.readdirSync(dir).filter((f) => f.endsWith(".app"))) {
            targets.push({ kind: "macOS", binary: path.join(dir, app), notices: path.join(dir, app, "Contents", "Resources") });
        }
    } else if (/^win.*unpacked$/.test(entry.name)) {
        targets.push({ kind: "Windows", binary: path.join(dir, `${productName}.exe`), notices: dir });
    } else if (/^linux.*unpacked$/.test(entry.name)) {
        targets.push({ kind: "Linux", binary: path.join(dir, `${exeName}.bin`), notices: dir, launcher: path.join(dir, exeName) });
    }
}
if (!targets.length) {
    console.error(`No unpacked apps found in ${dist} (expected mac*/<app>.app, win-unpacked or linux*-unpacked).`);
    process.exit(1);
}

(async () => {
    let failed = false;
    for (const target of targets) {
        const problems = [];
        if (!fs.existsSync(target.binary)) {
            problems.push(`missing ${target.binary}`);
        } else {
            const wire = await getCurrentFuseWire(target.binary);
            for (const fuse of expected) {
                const actual = wire[fuse.index];
                if (actual !== (fuse.value ? 0x31 : 0x30)) problems.push(`fuse ${fuse.name} is ${actual === 0x31 ? "on" : actual === 0x30 ? "off" : String(actual)}, expected ${fuse.value ? "on" : "off"}`);
            }
        }
        for (const notice of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
            if (!fs.existsSync(path.join(target.notices, notice))) problems.push(`licence notice ${notice} missing in ${target.notices}`);
        }
        if (target.launcher && !fs.readFileSync(target.launcher, "utf8").startsWith("#!/bin/sh")) problems.push(`${target.launcher} is not the launcher script`);
        failed = failed || problems.length > 0;
        console.log(`${problems.length ? "FAIL" : "ok  "} ${target.kind}: ${path.relative(dist, target.binary)}`);
        for (const p of problems) console.log(`       ${p}`);
    }
    if (!failed) console.log(`Fuses (${expected.map((f) => `${f.name}=${f.value ? "on" : "off"}`).join(", ")}) and licence notices verified.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
