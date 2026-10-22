"use strict";
/* Address space designer: edit folders, objects, variables, methods and alarms of the project. */
const SIMULATION_TYPES = [
    { value: "none", label: "None (static / writable)" },
    { value: "sine", label: "Sine wave" },
    { value: "triangle", label: "Triangle wave" },
    { value: "sawtooth", label: "Sawtooth" },
    { value: "square", label: "Square wave" },
    { value: "random", label: "Random (uniform)" },
    { value: "randomWalk", label: "Random walk" },
    { value: "ramp", label: "Ramp (min → max, wraps)" },
    { value: "counter", label: "Counter (step increments)" },
    { value: "toggle", label: "Toggle (boolean)" },
    { value: "clock", label: "Current time" }
];
const SIM_FIELDS = {
    none: [], sine: ["min", "max", "period", "interval"], triangle: ["min", "max", "period", "interval"],
    sawtooth: ["min", "max", "period", "interval"], square: ["min", "max", "period", "interval"],
    random: ["min", "max", "interval"], randomWalk: ["min", "max", "step", "interval"],
    ramp: ["min", "max", "step", "interval"], counter: ["min", "max", "step", "interval"],
    toggle: ["interval"], clock: ["interval"]
};
const CONTAINER_KINDS = new Set(["folder", "object"]);
let idCounter = 0;
const newNodeId = () => `n${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const Designer = {
    selectedId: null,
    expanded: new Set(),

    // ------------------------------------------------------------ tree helpers
    walk(nodes, fn, parentPath = "", parent = null) {
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const p = parentPath ? `${parentPath}/${n.name}` : n.name;
            if (fn(n, p, nodes, i, parent) === false) return false;
            if (n.children && this.walk(n.children, fn, p, n) === false) return false;
        }
        return true;
    },
    find(id) {
        let found = null;
        this.walk(App.project.nodes, (n, p, list, index, parent) => {
            if (n.id === id) { found = { node: n, path: p, list, index, parent }; return false; }
            return true;
        });
        return found;
    },
    allVariables() {
        const out = [];
        this.walk(App.project.nodes, (n, p) => { if (n.kind === "variable") out.push({ id: n.id, path: p, node: n }); });
        return out;
    },
    allContainers() {
        const out = [];
        this.walk(App.project.nodes, (n, p) => { if (CONTAINER_KINDS.has(n.kind)) out.push({ id: n.id, path: p, node: n }); });
        return out;
    },

    validate(nodes) {
        const problems = [];
        const ids = new Map();
        const check = (list, parentPath) => {
            const names = new Set();
            for (const n of list) {
                const p = parentPath ? `${parentPath}/${n.name}` : n.name;
                if (!n.name || !n.name.trim()) problems.push(`${parentPath || "(root)"}: a node has an empty name`);
                if (names.has(n.name)) problems.push(`${p}: duplicate browse name under the same parent`);
                names.add(n.name);
                if (n.nodeId) {
                    if (ids.has(n.nodeId)) problems.push(`${p}: NodeId "${n.nodeId}" is also used by ${ids.get(n.nodeId)}`);
                    ids.set(n.nodeId, p);
                }
                if (n.kind === "alarm" && !this.findIn(nodes, n.alarm?.sourceId)) problems.push(`${p}: alarm source variable is missing`);
                if ((n.kind === "method" || n.kind === "alarm") && !parentPath) problems.push(`${p}: ${n.kind}s must be placed inside a folder or object`);
                if (n.children) check(n.children, p);
            }
        };
        check(nodes, "");
        return problems;
    },
    findIn(nodes, id) {
        let ok = false;
        this.walk(nodes, (n) => { if (n.id === id) { ok = true; return false; } return true; });
        return ok;
    },

    // ------------------------------------------------------------ node factories
    create(kind) {
        const base = { id: newNodeId(), kind, name: "", nodeId: "", description: "" };
        switch (kind) {
            case "folder": return { ...base, name: "NewFolder", children: [] };
            case "object": return { ...base, name: "NewObject", children: [] };
            case "variable": return {
                ...base, name: "NewVariable",
                variable: { dataType: "Double", valueRank: -1, arrayLength: 0, value: 0, access: "rw", historizing: false, analog: false, unit: "", euLow: 0, euHigh: 100, minimumSamplingInterval: 0, simulation: { type: "none", min: 0, max: 100, period: 10000, interval: 1000, step: 1 } }
            };
            case "method": return { ...base, name: "NewMethod", method: { inputs: [{ name: "Input", dataType: "Double" }], outputs: [{ name: "Output", dataType: "Double" }], script: "return [inputs[0] * 2];" } };
            case "alarm": {
                const v = this.allVariables()[0];
                return { ...base, name: "NewAlarm", alarm: { type: "ExclusiveLimit", sourceId: v?.id || "", highHigh: 90, high: 80, low: 20, lowLow: 10, severity: 500, normalValue: "" } };
            }
        }
        return base;
    },

    uniqueName(list, name) {
        const names = new Set(list.map((n) => n.name));
        if (!names.has(name)) return name;
        let i = 1;
        while (names.has(`${name}${i}`)) i++;
        return `${name}${i}`;
    },

    targetList() {
        const sel = this.selectedId && this.find(this.selectedId);
        if (!sel) return { list: App.project.nodes, parent: null };
        if (CONTAINER_KINDS.has(sel.node.kind)) return { list: sel.node.children, parent: sel.node };
        return { list: sel.list, parent: sel.parent };
    },

    add(kind) {
        const { list, parent } = this.targetList();
        if ((kind === "method" || kind === "alarm") && !parent) {
            toast("Methods and alarms must be added inside a folder or object. Select one first.", "warn");
            return;
        }
        const node = this.create(kind);
        node.name = this.uniqueName(list, node.name);
        list.push(node);
        if (parent) this.expanded.add(parent.id);
        this.selectedId = node.id;
        App.markDirty();
        this.refresh();
    },

    clone(node) {
        const copy = JSON.parse(JSON.stringify(node));
        const remap = (n) => { n.id = newNodeId(); n.nodeId = ""; (n.children || []).forEach(remap); };
        remap(copy);
        return copy;
    },

    duplicate() {
        const sel = this.find(this.selectedId);
        if (!sel) return;
        const copy = this.clone(sel.node);
        copy.name = this.uniqueName(sel.list, sel.node.name);
        sel.list.splice(sel.index + 1, 0, copy);
        this.selectedId = copy.id;
        App.markDirty();
        this.refresh();
    },

    async remove() {
        const sel = this.find(this.selectedId);
        if (!sel) return;
        const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
        const total = count(sel.node);
        if (total > 1 && !(await confirmDialog("Delete nodes", `Delete "${sel.path}" and ${total - 1} child node(s)?`, "Delete", true))) return;
        sel.list.splice(sel.index, 1);
        this.selectedId = sel.list[sel.index]?.id || sel.list[sel.index - 1]?.id || sel.parent?.id || null;
        App.markDirty();
        this.refresh();
    },

    move(delta) {
        const sel = this.find(this.selectedId);
        if (!sel) return;
        const j = sel.index + delta;
        if (j < 0 || j >= sel.list.length) return;
        sel.list.splice(sel.index, 1);
        sel.list.splice(j, 0, sel.node);
        App.markDirty();
        this.refresh();
    },

    moveInto(dragId, targetId) {
        if (dragId === targetId) return;
        const drag = this.find(dragId);
        if (!drag) return;
        let targetList = App.project.nodes;
        if (targetId) {
            const target = this.find(targetId);
            if (!target || !CONTAINER_KINDS.has(target.node.kind)) return;
            // refuse to move a node into its own subtree
            if (this.findIn([drag.node], targetId)) return;
            targetList = target.node.children;
            this.expanded.add(targetId);
        }
        drag.list.splice(drag.index, 1);
        drag.node.name = this.uniqueName(targetList, drag.node.name);
        targetList.push(drag.node);
        App.markDirty();
        this.refresh();
    },

    async bulkAdd() {
        const { list, parent } = this.targetList();
        const prefix = h("input", { value: "Tag" });
        const count = h("input", { type: "number", value: 10, min: 1, max: 10000 });
        const dt = select(App.meta.dataTypes.filter((t) => !["NodeId", "QualifiedName", "StatusCode", "XmlElement"].includes(t)), "Double");
        const sim = select(SIMULATION_TYPES, "random");
        const min = h("input", { type: "number", value: 0 });
        const max = h("input", { type: "number", value: 100 });
        const interval = h("input", { type: "number", value: 1000 });
        const ok = await modal({
            title: `Bulk add variables${parent ? ` to ${parent.name}` : ""}`,
            body: h("div", { class: "form-grid two" },
                field("Name prefix", prefix), field("Count", count, "Up to 10 000 variables (load testing)"),
                field("Data type", dt), field("Simulation", sim),
                field("Min", min), field("Max", max), field("Update interval (ms)", interval)),
            buttons: [{ label: "Cancel", value: false }, { label: "Add", class: "primary", value: true }]
        });
        if (!ok) return;
        const n = Math.min(10000, Math.max(1, Number(count.value) || 1));
        const width = String(n).length;
        for (let i = 1; i <= n; i++) {
            const v = this.create("variable");
            v.name = this.uniqueName(list, `${prefix.value}${String(i).padStart(width, "0")}`);
            v.variable.dataType = dt.value;
            v.variable.value = defaultValue(dt.value, -1);
            Object.assign(v.variable.simulation, { type: sim.value, min: Number(min.value), max: Number(max.value), interval: Number(interval.value) });
            list.push(v);
        }
        if (parent) this.expanded.add(parent.id);
        App.markDirty();
        this.refresh();
        toast(`${n} variables added`, "success");
    },

    // ------------------------------------------------------------ rendering
    mount(view) {
        view.className = "fill";
        if (!this.selectedId || !this.find(this.selectedId)) this.selectedId = App.project.nodes[0]?.id || null;
        if (!this.expanded.size) App.project.nodes.forEach((n) => this.expanded.add(n.id));
        this.treeEl = h("div", { class: "tree pane-scroll", style: { padding: "8px" } });
        this.editorEl = h("div", { class: "pane-scroll", style: { padding: "16px" } });
        this.problemsEl = h("div");
        const tb = (label, fn, title) => h("button", { class: "btn small", title, onclick: fn }, label);
        const treeCard = h("div", { class: "card pane", style: { width: "380px", flexShrink: 0 } },
            h("div", { class: "card-head", style: { flexWrap: "wrap" } },
                h("div", { class: "btn-group" },
                    tb("+ Folder", () => this.add("folder")), tb("+ Object", () => this.add("object")),
                    tb("+ Variable", () => this.add("variable")), tb("+ Method", () => this.add("method")),
                    tb("+ Alarm", () => this.add("alarm"))),
                h("div", { class: "btn-group" },
                    tb("Bulk add…", () => this.bulkAdd(), "Create many variables at once"),
                    tb(icon("duplicate"), () => this.duplicate(), "Duplicate"), tb("↑", () => this.move(-1), "Move up"),
                    tb("↓", () => this.move(1), "Move down"), tb(icon("trash"), () => this.remove(), "Delete"))),
            this.treeEl,
            this.problemsEl);
        // dropping on empty tree area moves to root
        this.treeEl.addEventListener("dragover", (e) => e.preventDefault());
        this.treeEl.addEventListener("drop", (e) => {
            if (e.target === this.treeEl) { e.preventDefault(); this.moveInto(e.dataTransfer.getData("text/plain"), null); }
        });
        view.appendChild(h("div", { class: "split" }, treeCard, h("div", { class: "card pane", style: { flex: 1 } }, this.editorEl)));
        this.refresh();
        return () => { this.treeEl = null; };
    },

    refresh() {
        if (!this.treeEl) return;
        this.renderTree();
        this.renderEditor();
        this.renderProblems();
    },

    renderProblems() {
        const problems = this.validate(App.project.nodes);
        clear(this.problemsEl);
        if (problems.length) {
            this.problemsEl.appendChild(h("div", { style: { borderTop: "1px solid var(--border)", padding: "8px 12px", maxHeight: "120px", overflow: "auto" } },
                problems.map((p) => h("div", { class: "small", style: { color: "var(--bad)" } }, "⚠ " + p))));
        }
    },

    renderTree() {
        const scroll = this.treeEl.scrollTop;
        clear(this.treeEl);
        let varCount = 0;
        this.walk(App.project.nodes, (n) => { if (n.kind === "variable") varCount++; });
        if (!App.project.nodes.length) {
            this.treeEl.appendChild(h("div", { class: "empty" }, h("div", { class: "big" }, icon("folders")), "Empty address space. Add a folder or object to start."));
        }
        const renderList = (list, container) => {
            for (const n of list) {
                const isContainer = CONTAINER_KINDS.has(n.kind);
                const open = this.expanded.has(n.id);
                const meta = n.kind === "variable"
                    ? `${n.variable.dataType}${n.variable.valueRank >= 1 ? "[]" : ""}${n.variable.simulation?.type !== "none" ? " · " + n.variable.simulation.type : ""}`
                    : n.kind === "alarm" ? n.alarm.type : isContainer ? `${(n.children || []).length}` : "";
                const row = h("div", { class: `tree-node ${this.selectedId === n.id ? "selected" : ""}`, draggable: "true" },
                    h("span", { class: "tree-toggle", onclick: (e) => { e.stopPropagation(); open ? this.expanded.delete(n.id) : this.expanded.add(n.id); this.renderTree(); } },
                        isContainer && (n.children || []).length ? (open ? "▼" : "▶") : ""),
                    kindIcon(n.kind),
                    h("span", { class: "tree-label" }, n.name),
                    h("span", { class: "tree-meta" }, meta));
                row.addEventListener("click", () => { this.selectedId = n.id; this.renderTree(); this.renderEditor(); });
                row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", n.id); e.dataTransfer.effectAllowed = "move"; });
                if (isContainer) {
                    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop-target"); });
                    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
                    row.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); this.moveInto(e.dataTransfer.getData("text/plain"), n.id); });
                }
                container.appendChild(row);
                if (isContainer && open && n.children?.length) {
                    const childBox = h("div", { class: "tree-children" });
                    container.appendChild(childBox);
                    renderList(n.children, childBox);
                }
            }
        };
        renderList(App.project.nodes, this.treeEl);
        this.treeEl.appendChild(h("div", { class: "muted small", style: { padding: "10px 6px" } }, `${varCount} variables · drag nodes onto folders/objects to move them`));
        this.treeEl.scrollTop = scroll;
    },

    renderEditor() {
        const el = clear(this.editorEl);
        const sel = this.selectedId && this.find(this.selectedId);
        if (!sel) {
            el.appendChild(h("div", { class: "empty" }, h("div", { class: "big" }, "←"), "Select a node to edit it"));
            return;
        }
        const n = sel.node;
        const changed = (rerenderTree = false) => { App.markDirty(); if (rerenderTree) { this.renderTree(); this.renderProblems(); } };
        const bind = (obj, key, attrs = {}, rerender = false) => {
            const input = h(attrs.textarea ? "textarea" : "input", { value: obj[key] ?? "", ...attrs, textarea: undefined });
            input.addEventListener("input", () => {
                obj[key] = attrs.type === "number" ? (input.value === "" ? "" : Number(input.value)) : input.value;
                changed(rerender);
            });
            return input;
        };
        const nsIndexHint = App.serverStatus.namespaceIndex ? `ns=${App.serverStatus.namespaceIndex}` : "ns=<sim>";
        el.appendChild(h("div", { class: "row", style: { marginBottom: "14px" } },
            kindIcon(n.kind), h("h2", { style: { margin: 0, fontSize: "16px" } }, n.name),
            h("span", { class: "badge" }, n.kind), h("span", { class: "spacer" }),
            h("span", { class: "muted small mono" }, sel.path)));

        el.appendChild(h("div", { class: "form-grid" },
            field("Browse name", bind(n, "name", {}, true)),
            field("NodeId (optional)", bind(n, "nodeId", { class: "mono", placeholder: `s=${sel.path.replace(/\//g, ".")}` }, true), `e.g. s=MyTag, i=1001, g=<guid>; namespace ${nsIndexHint} is added automatically`),
            h("div", { class: "span-all" }, field("Description", bind(n, "description")))));

        if (n.kind === "variable") this.variableEditor(el, n, changed);
        if (n.kind === "method") this.methodEditor(el, n, changed);
        if (n.kind === "alarm") this.alarmEditor(el, n, changed);
        if (CONTAINER_KINDS.has(n.kind)) {
            el.appendChild(h("hr", { class: "sep" }));
            el.appendChild(h("div", { class: "muted" }, n.kind === "folder"
                ? "A FolderType object. Children are linked with Organizes references."
                : "A BaseObjectType object (event notifier). Children are linked with HasComponent references. Methods and alarms live inside objects or folders."));
            el.appendChild(h("div", { class: "btn-group", style: { marginTop: "10px" } },
                ["folder", "object", "variable", "method", "alarm"].map((k) => h("button", { class: "btn small", onclick: () => this.add(k) }, `+ ${k[0].toUpperCase() + k.slice(1)} inside`))));
        }
    },

    variableEditor(el, n, changed) {
        const v = n.variable;
        const rerender = () => this.renderEditor();
        const dt = select(App.meta.dataTypes, v.dataType);
        dt.addEventListener("change", () => { v.dataType = dt.value; v.value = defaultValue(v.dataType, v.valueRank); changed(true); rerender(); });
        const rank = select([{ value: -1, label: "Scalar" }, { value: 1, label: "Array (1 dimension)" }], String(v.valueRank));
        rank.addEventListener("change", () => { v.valueRank = Number(rank.value); v.value = defaultValue(v.dataType, v.valueRank); changed(true); rerender(); });
        const access = select([{ value: "rw", label: "Read / Write" }, { value: "r", label: "Read only" }, { value: "w", label: "Write only" }], v.access);
        access.addEventListener("change", () => { v.access = access.value; changed(); });
        const numInput = (obj, key, attrs = {}) => {
            const i = h("input", { type: "number", value: obj[key] ?? "", ...attrs });
            i.addEventListener("input", () => { obj[key] = i.value === "" ? "" : Number(i.value); changed(true); });
            return i;
        };
        let valueInput;
        if (v.dataType === "Boolean" && v.valueRank < 1) {
            valueInput = select(["true", "false"], String(v.value === true || v.value === "true"));
            valueInput.addEventListener("change", () => { v.value = valueInput.value === "true"; changed(); });
        } else if (v.valueRank >= 1) {
            valueInput = h("textarea", { rows: 3, value: typeof v.value === "string" ? v.value : JSON.stringify(v.value) });
            valueInput.addEventListener("input", () => { v.value = valueInput.value; changed(); });
        } else {
            valueInput = h("input", { value: v.value ?? "", class: "mono" });
            valueInput.addEventListener("input", () => { v.value = V_NUMERIC.has(v.dataType) && valueInput.value !== "" && !isNaN(valueInput.value) ? Number(valueInput.value) : valueInput.value; changed(); });
        }
        el.appendChild(h("div", { class: "section-title", style: { marginTop: "18px" } }, "Variable"));
        el.appendChild(h("div", { class: "form-grid" },
            field("Data type", dt),
            field("Value rank", rank),
            v.valueRank >= 1 ? field("Array length", numInput(v, "arrayLength", { min: 0 }), "0 = variable length") : null,
            field("Access level", access),
            field("Minimum sampling interval (ms)", numInput(v, "minimumSamplingInterval", { min: 0 }), "0 = exception based"),
            h("div", { class: "span-all" }, field("Initial value", valueInput, valueHint(v.dataType, v.valueRank)))));

        el.appendChild(h("div", { class: "checks", style: { marginTop: "12px" } },
            checkbox("Historizing (HistoryRead, stores up to 10 000 values)", v.historizing, (c) => { v.historizing = c; changed(); }),
            V_NUMERIC.has(v.dataType) ? checkbox("AnalogItemType (EURange + EngineeringUnits)", v.analog, (c) => { v.analog = c; changed(); rerender(); }) : null));
        if (v.analog && V_NUMERIC.has(v.dataType)) {
            const unit = h("input", { value: v.unit || "", placeholder: "°C, bar, m/s …" });
            unit.addEventListener("input", () => { v.unit = unit.value; changed(); });
            el.appendChild(h("div", { class: "form-grid", style: { marginTop: "12px" } },
                field("Engineering unit", unit), field("EURange low", numInput(v, "euLow")), field("EURange high", numInput(v, "euHigh"))));
        }

        const s = v.simulation = v.simulation || { type: "none" };
        const simSel = select(SIMULATION_TYPES, s.type);
        simSel.addEventListener("change", () => { s.type = simSel.value; changed(true); rerender(); });
        const labels = { min: "Minimum", max: "Maximum", period: "Period (ms)", interval: "Update interval (ms)", step: "Step" };
        el.appendChild(h("div", { class: "section-title", style: { marginTop: "18px" } }, "Simulation"));
        el.appendChild(h("div", { class: "form-grid" },
            field("Signal", simSel, s.type === "none" ? "Value only changes when written by a client or set manually" : "Generated in the server; can be paused per variable in Live Values"),
            (SIM_FIELDS[s.type] || []).map((k) => field(labels[k], numInput(s, k)))));
    },

    methodEditor(el, n, changed) {
        const m = n.method;
        const argTable = (args, title) => {
            const body = h("tbody");
            args.forEach((a, i) => {
                const name = h("input", { value: a.name });
                name.addEventListener("input", () => { a.name = name.value; changed(); });
                const dt = select(App.meta.dataTypes, a.dataType);
                dt.addEventListener("change", () => { a.dataType = dt.value; changed(); });
                body.appendChild(h("tr", null, h("td", { class: "muted" }, `[${i}]`), h("td", null, name), h("td", null, dt),
                    h("td", { class: "actions" }, h("button", { class: "btn small", onclick: () => { args.splice(i, 1); changed(); this.renderEditor(); } }, "Remove"))));
            });
            return h("div", null,
                h("div", { class: "section-title", style: { marginTop: "18px" } }, title),
                h("table", null, h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Name"), h("th", null, "Data type"), h("th", null, ""))), body),
                h("button", { class: "btn small", style: { marginTop: "6px" }, onclick: () => { args.push({ name: `Arg${args.length + 1}`, dataType: "Double" }); changed(); this.renderEditor(); } }, "+ Add argument"));
        };
        el.appendChild(h("div", { class: "grid-2" }, argTable(m.inputs, "Input arguments"), argTable(m.outputs, "Output arguments")));
        const script = h("textarea", { rows: 10, value: m.script || "", spellcheck: "false" });
        script.addEventListener("input", () => { m.script = script.value; changed(); });
        const paths = this.allVariables().map((x) => x.path);
        el.appendChild(h("div", { class: "section-title", style: { marginTop: "18px" } }, "Implementation (JavaScript)"));
        el.appendChild(script);
        el.appendChild(h("div", { class: "hint", style: { marginTop: "6px" } },
            "Available: inputs[] (input argument values), getValue(path), setValue(path, value), log(message). Return an array with one value per output argument. Execution timeout 1 s."));
        el.appendChild(h("details", { style: { marginTop: "8px" } }, h("summary", { class: "small" }, `Variable paths (${paths.length})`),
            h("div", { class: "mono small", style: { maxHeight: "160px", overflow: "auto", marginTop: "6px" } }, paths.map((p) => h("div", { style: { cursor: "pointer" }, onclick: () => copyText(p) }, p)))));
    },

    alarmEditor(el, n, changed) {
        const a = n.alarm;
        const rerender = () => this.renderEditor();
        const type = select([
            { value: "ExclusiveLimit", label: "ExclusiveLimitAlarm (one active limit at a time)" },
            { value: "NonExclusiveLimit", label: "NonExclusiveLimitAlarm (several limits can be active)" },
            { value: "OffNormal", label: "OffNormalAlarm (value differs from normal state)" }
        ], a.type);
        type.addEventListener("change", () => { a.type = type.value; changed(true); rerender(); });
        const vars = this.allVariables().filter((x) => a.type === "OffNormal" || V_NUMERIC.has(x.node.variable.dataType));
        const source = select([{ value: "", label: "— select variable —" }, ...vars.map((x) => ({ value: x.id, label: `${x.path} (${x.node.variable.dataType})` }))], a.sourceId);
        source.addEventListener("change", () => { a.sourceId = source.value; changed(true); });
        const num = (key) => {
            const i = h("input", { type: "number", value: a[key] ?? "" });
            i.addEventListener("input", () => { a[key] = i.value === "" ? "" : Number(i.value); changed(); });
            return i;
        };
        const normal = h("input", { value: a.normalValue ?? "" });
        normal.addEventListener("input", () => { a.normalValue = normal.value; changed(); });
        el.appendChild(h("div", { class: "section-title", style: { marginTop: "18px" } }, "Alarm (Part 9 Alarms & Conditions)"));
        el.appendChild(h("div", { class: "form-grid" },
            field("Alarm type", type),
            field("Input / source variable", source, "Alarm is evaluated whenever this value changes"),
            field("Severity (1-1000)", num("severity")),
            a.type === "OffNormal"
                ? field("Normal value", normal, "Alarm is active while the input differs from this value")
                : [field("HighHigh limit", num("highHigh"), "Leave empty to omit"), field("High limit", num("high")), field("Low limit", num("low")), field("LowLow limit", num("lowLow"), "Leave empty to omit")]));
        el.appendChild(h("div", { class: "hint", style: { marginTop: "10px" } },
            "Alarms support Enable/Disable, Acknowledge, Confirm, AddComment and ConditionRefresh. Trigger them from Alarms & Events or by writing the input variable."));
    }
};

const V_NUMERIC = new Set(["SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64", "Float", "Double"]);

function defaultValue(dataType, valueRank) {
    if (valueRank >= 1) return "[]";
    if (V_NUMERIC.has(dataType)) return 0;
    return { Boolean: false, DateTime: new Date().toISOString(), Guid: "00000000-0000-0000-0000-000000000000", NodeId: "ns=0;i=0", StatusCode: "Good", ByteString: "hex:" }[dataType] ?? "";
}

function valueHint(dataType, valueRank) {
    if (valueRank >= 1) return "JSON array, e.g. [1, 2, 3] or [\"a\", \"b\"]";
    return {
        DateTime: "ISO 8601, e.g. 2024-01-31T12:00:00.000Z, or 'now'",
        ByteString: "Text, or hex:0a0b0c / base64:…",
        Guid: "e.g. 72962b91-fa75-4ae6-8d28-b404dc7daf63",
        NodeId: "e.g. ns=0;i=2253 or ns=2;s=MyNode",
        StatusCode: "Status code name, e.g. Good, BadSensorFailure",
        LocalizedText: "Text (locale en)",
        Int64: "Integer (safe range ±9 007 199 254 740 991)",
        UInt64: "Integer (0 … 9 007 199 254 740 991)"
    }[dataType] || "";
}
