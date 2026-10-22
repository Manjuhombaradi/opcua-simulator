"use strict";
// Project templates, loading and normalisation (shared by the desktop app and the headless runner).
const fs = require("fs");
const { createDefaultProject, newId } = require("./defaultProject");

const PROJECT_EXTENSIONS = ["opcuasim", "json"];

function emptyProject() {
    const p = createDefaultProject();
    p.name = "New Project";
    p.nodes = [];
    return p;
}

// A flat project with many simulated tags, for performance / load testing of clients.
function loadTestProject(count = 1000) {
    const n = Math.max(1, Math.min(50000, Number(count) || 1000));
    const p = createDefaultProject();
    p.name = `Load Test (${n} tags)`;
    const perFolder = 500;
    const signals = ["random", "sine", "randomWalk", "ramp", "triangle"];
    const folders = [];
    for (let f = 0; f * perFolder < n; f++) {
        const children = [];
        for (let i = f * perFolder; i < Math.min(n, (f + 1) * perFolder); i++) {
            const type = signals[i % signals.length];
            children.push({
                id: newId(),
                kind: "variable",
                name: `Tag${String(i + 1).padStart(String(n).length, "0")}`,
                nodeId: "",
                description: "",
                variable: {
                    dataType: "Double", valueRank: -1, arrayLength: 0, value: 0, access: "rw", historizing: false,
                    analog: false, unit: "", euLow: 0, euHigh: 100, minimumSamplingInterval: 0,
                    simulation: { type, min: 0, max: 100, period: 20000 + (i % 7) * 5000, interval: 1000, step: 1 }
                }
            });
        }
        folders.push({ id: newId(), kind: "folder", name: `Group${f + 1}`, nodeId: "", description: "", children });
    }
    p.nodes = [{ id: newId(), kind: "folder", name: "LoadTest", nodeId: "", description: `${n} simulated tags`, children: folders }];
    return p;
}

function fromTemplate(name, options = {}) {
    switch (name) {
        case "empty": return emptyProject();
        case "load-test": return loadTestProject(options.count);
        case "demo":
        default: return createDefaultProject();
    }
}

// Fills in settings that older project files (or hand-written ones) do not have.
function normalizeProject(project) {
    if (!project || typeof project !== "object") throw new Error("Project file is empty or not an object");
    if (!Array.isArray(project.nodes)) throw new Error("Not a valid simulator project: \"nodes\" list is missing");
    const defaults = createDefaultProject().server;
    project.server = { ...defaults, ...(project.server || {}) };
    project.name = project.name || "Project";
    project.version = project.version || 1;
    return project;
}

function readProjectFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        throw new Error(`Cannot read project file ${file}: ${err.message}`);
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error(`Project file ${file} is not valid JSON: ${err.message}`);
    }
    return normalizeProject(data);
}

function isProjectFile(file) {
    return typeof file === "string" && PROJECT_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(`.${ext}`)) && fs.existsSync(file);
}

module.exports = { fromTemplate, emptyProject, loadTestProject, normalizeProject, readProjectFile, isProjectFile, PROJECT_EXTENSIONS };
