#!/usr/bin/env node
"use strict";
// Completes the CycloneDX SBOM that @cyclonedx/cyclonedx-npm writes for the production dependencies (= the
// contents of app.asar) for the release:
//  - adds the Electron runtime that the desktop installers bundle (Electron, Chromium, Node.js), which npm
//    does not list because electron is a dev dependency; Chromium and Node.js get CPEs so vulnerability
//    scanners can match their CVEs;
//  - declares the licences of three old packages whose package.json has no "license" field (checked against
//    their LICENSE / README files).
// Usage: node scripts/sbom-finish.js <cyclonedx-npm.json> <output.cdx.json> [runtime-versions.json]
// runtime-versions.json: {"electron":"45.0.0","chrome":"...","node":"..."} printed by the packaged binary
// (process.versions); without it only the Electron version from node_modules/electron is recorded.
const fs = require("fs");
const path = require("path");

const [input, output, versionsFile] = process.argv.slice(2);
if (!input || !output) {
    console.error("Usage: node scripts/sbom-finish.js <cyclonedx-npm.json> <output.cdx.json> [runtime-versions.json]");
    process.exit(2);
}

const KNOWN_LICENCES = {
    "dequeue@1.0.5": "BSD-2-Clause",
    "humanize@0.0.9": "MIT",
    "precond@0.2.3": "MIT"
};

const bom = JSON.parse(fs.readFileSync(input, "utf8"));
const versions = versionsFile ? JSON.parse(fs.readFileSync(versionsFile, "utf8")) : {};
const electronVersion = versions.electron
    || require(path.join(__dirname, "..", "node_modules", "electron", "package.json")).version;

for (const component of bom.components || []) {
    const licence = KNOWN_LICENCES[`${component.name}@${component.version}`];
    if (licence && !(component.licenses && component.licenses.length)) {
        component.licenses = [{ license: { id: licence, acknowledgement: "concluded" } }];
    }
}

const runtime = {
    type: "framework",
    name: "electron",
    version: electronVersion,
    "bom-ref": `runtime|electron@${electronVersion}`,
    description: "Electron runtime bundled in the desktop installers (not in the Docker image, which uses Node.js from the base image)",
    licenses: [{ license: { id: "MIT", acknowledgement: "declared" } }],
    purl: `pkg:npm/electron@${electronVersion}`,
    externalReferences: [
        { type: "website", url: "https://www.electronjs.org" },
        { type: "release-notes", url: `https://github.com/electron/electron/releases/tag/v${electronVersion}` },
        { type: "license", url: "https://github.com/electron/electron/blob/main/LICENSE", comment: "Chromium licences: LICENSES.chromium.html in the installed app" }
    ],
    components: []
};
if (versions.chrome) {
    runtime.components.push({
        type: "framework",
        name: "chromium",
        version: versions.chrome,
        "bom-ref": `runtime|chromium@${versions.chrome}`,
        cpe: `cpe:2.3:a:google:chrome:${versions.chrome}:*:*:*:*:*:*:*`,
        purl: `pkg:generic/chromium@${versions.chrome}`,
        licenses: [{ license: { id: "BSD-3-Clause", acknowledgement: "declared" } }]
    });
}
if (versions.node) {
    runtime.components.push({
        type: "framework",
        name: "node.js",
        version: versions.node,
        "bom-ref": `runtime|node@${versions.node}`,
        cpe: `cpe:2.3:a:nodejs:node.js:${versions.node}:*:*:*:*:*:*:*`,
        purl: `pkg:generic/node@${versions.node}`,
        licenses: [{ license: { id: "MIT", acknowledgement: "declared" } }]
    });
}
if (!runtime.components.length) delete runtime.components;

bom.components = (bom.components || []).filter((c) => c.name !== "electron" || c.type !== "framework");
bom.components.push(runtime);
const rootRef = bom.metadata && bom.metadata.component && bom.metadata.component["bom-ref"];
if (rootRef) {
    bom.dependencies = bom.dependencies || [];
    let root = bom.dependencies.find((d) => d.ref === rootRef);
    if (!root) bom.dependencies.push(root = { ref: rootRef, dependsOn: [] });
    root.dependsOn = Array.from(new Set([...(root.dependsOn || []), runtime["bom-ref"]]));
    const children = (runtime.components || []).map((c) => c["bom-ref"]);
    bom.dependencies.push({ ref: runtime["bom-ref"], dependsOn: children });
    for (const child of children) bom.dependencies.push({ ref: child, dependsOn: [] });
}

fs.writeFileSync(output, JSON.stringify(bom, null, 2) + "\n");
console.log(`SBOM written to ${output}: ${bom.components.length} components incl. electron ${electronVersion}`
    + (versions.chrome ? ` (Chromium ${versions.chrome}, Node.js ${versions.node})` : ""));
