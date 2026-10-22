"use strict";
/* Live values: current value of every server variable, manual overrides (value, status, timestamps). */
const LIVE_HISTORY_MAX = 10000; // values returned by ServerEngine.getHistory (the latest of the range)
const Live = {
    filter: "",
    selected: new Set(),
    charted: new Set(),

    mount(view) {
        view.className = "fill";
        if (App.serverStatus.state !== "running") {
            view.appendChild(h("div", { class: "card" }, h("div", { class: "card-body empty" },
                h("div", { class: "big" }, "≋"), h("div", null, "Start the server to see and override live values."),
                // the server-status listener below re-opens this view once the server runs
                h("button", { class: "btn primary", style: { marginTop: "12px" }, disabled: !!App.starting, onclick: (e) => { const btn = e.currentTarget; btn.disabled = true; App.startServer().finally(() => { btn.disabled = false; }); } }, "▶ Start Server"))));
            const off = App.on("server-status", (s) => { if (s.state === "running") App.navigate("live"); });
            return off;
        }
        this.rows = new Map();
        this.values = [];
        const search = h("input", { class: "search", placeholder: "Filter by path, NodeId, type or simulation…", value: this.filter });
        search.addEventListener("input", () => { this.filter = search.value; this.buildTable(); });
        this.pauseBtn = h("button", { class: "btn" }, icon("pause"), "Pause all");
        this.pauseBtn.onclick = async () => { await attempt(() => api.server("setPaused", "*", !this.pausedAll)); this.poll(); };
        this.countEl = h("span", { class: "muted small" });
        this.bulkBtn = h("button", { class: "btn", disabled: true, onclick: () => this.bulkStatusDialog() }, "Set status for selected…");
        this.tbody = h("tbody");
        this.selectAll = h("input", { type: "checkbox" });
        this.selectAll.addEventListener("change", () => {
            for (const v of this.visible()) this.selectAll.checked ? this.selected.add(v.id) : this.selected.delete(v.id);
            this.buildTable();
        });
        const tableCard = h("div", { class: "card pane", style: { flex: 1 } },
            h("div", { class: "card-body flush pane-scroll" },
                h("table", null,
                    h("thead", null, h("tr", null, h("th", { style: { width: "28px" } }, this.selectAll),
                        ["Variable", "Type", "Value", "Status", "Source / server timestamp", "Simulation", ""].map((x) => h("th", null, x)))),
                    this.tbody)));
        const chartHost = h("div", { class: "card-body" });
        this.chartCard = h("div", { class: "card", style: { flexShrink: 0 } },
            h("div", { class: "card-head" }, h("h3", null, "Trend"), h("span", { class: "muted small" }, "Toggle ", icon("chart"), " on rows to plot them (last 60 s)"),
                h("button", { class: "btn small", onclick: () => { this.charted.clear(); this.chart.clearSeries(); this.buildTable(); } }, "Clear")),
            chartHost);
        view.appendChild(h("div", { class: "toolbar" }, search, this.pauseBtn, this.bulkBtn, h("span", { class: "spacer" }), this.countEl));
        view.appendChild(h("div", { class: "split", style: { flexDirection: "column", gap: "12px" } }, tableCard, this.chartCard));
        this.chart = new TrendChart(chartHost);
        this.chartCard.classList.toggle("hidden", this.charted.size === 0);
        this.poll();
        const timer = setInterval(() => this.poll(), 1000);
        const off = App.on("server-status", (s) => { if (s.state !== "running") App.navigate("live"); });
        return () => { clearInterval(timer); off(); this.chart.destroy(); };
    },

    visible() {
        const f = this.filter.trim().toLowerCase();
        if (!f) return this.values;
        return this.values.filter((v) => `${v.path} ${v.nodeId} ${v.dataType} ${v.simulation} ${v.statusCode}`.toLowerCase().includes(f));
    },

    async poll() {
        let res;
        try { res = await api.server("getLiveValues"); } catch (_) { return; }
        const ids = res.values.map((v) => v.id).join();
        const structureChanged = ids !== this.values.map((v) => v.id).join();
        this.values = res.values;
        this.pausedAll = res.pausedAll;
        if (this.pauseBtn.dataset.paused !== String(!!this.pausedAll)) {
            this.pauseBtn.dataset.paused = String(!!this.pausedAll);
            appendChildren(clear(this.pauseBtn), [this.pausedAll ? "▶ Resume all" : [icon("pause"), "Pause all"]]);
        }
        this.pauseBtn.classList.toggle("primary", this.pausedAll);
        if (structureChanged || !this.rows.size) this.buildTable();
        else this.updateCells();
        for (const v of this.values) if (this.charted.has(v.id)) this.chart.add(v.id, v.path, v.sourceTimestamp, v.valueRank >= 1 ? v.value?.[0] : v.value);
    },

    buildTable() {
        if (!this.tbody) return;
        clear(this.tbody);
        this.rows.clear();
        const vis = this.visible();
        for (const v of vis) {
            const cb = h("input", { type: "checkbox", checked: this.selected.has(v.id) });
            cb.addEventListener("change", () => { cb.checked ? this.selected.add(v.id) : this.selected.delete(v.id); this.updateBulk(); });
            const cells = {
                value: h("td", { class: "value" }), status: h("td"), src: h("div"), srv: h("div", { class: "muted" }), sim: h("td"),
                pause: h("button", { class: "btn small icon", title: "Pause / resume simulation" })
            };
            cells.pause.onclick = () => attempt(() => api.server("setPaused", v.id, !this.values.find((x) => x.id === v.id)?.paused)).then(() => this.poll());
            const chartBtn = h("button", { class: `btn small icon ${this.charted.has(v.id) ? "primary" : ""}`, title: "Plot in trend" }, icon("chart"));
            chartBtn.onclick = () => {
                if (this.charted.has(v.id)) { this.charted.delete(v.id); this.chart.removeSeries(v.id); } else this.charted.add(v.id);
                chartBtn.classList.toggle("primary", this.charted.has(v.id));
                this.chartCard.classList.toggle("hidden", this.charted.size === 0);
            };
            const tr = h("tr", { ondblclick: () => this.setValueDialog(v.id) },
                h("td", null, cb),
                h("td", { style: { maxWidth: "300px" } }, h("div", { class: "ellipsis", title: v.path }, v.path), h("div", { class: "muted small mono ellipsis", title: v.nodeId }, v.nodeId)),
                h("td", null, `${v.dataType}${v.valueRank >= 1 ? "[]" : ""}`, v.access === "r" ? h("span", { class: "badge", style: { marginLeft: "4px" } }, "RO") : null),
                cells.value, cells.status, h("td", { class: "mono small" }, cells.src, cells.srv), cells.sim,
                h("td", { class: "actions" },
                    h("button", { class: "btn small", onclick: () => this.setValueDialog(v.id) }, "Set…"), " ",
                    cells.pause, " ", chartBtn, " ",
                    v.historizing ? h("button", { class: "btn small icon", title: "History", onclick: () => this.historyDialog(v) }, icon("clock")) : null));
            this.rows.set(v.id, { tr, cells, last: null });
            this.tbody.appendChild(tr);
        }
        if (!vis.length) this.tbody.appendChild(h("tr", null, h("td", { colspan: 8, class: "empty" }, "No variables match")));
        this.updateCells();
        this.updateBulk();
    },

    updateBulk() {
        const n = this.selected.size;
        this.bulkBtn.disabled = n === 0;
        this.bulkBtn.textContent = n ? `Set status for ${n} selected…` : "Set status for selected…";
        this.countEl.textContent = `${this.visible().length} of ${this.values.length} variables`;
    },

    updateCells() {
        for (const v of this.values) {
            const r = this.rows.get(v.id);
            if (!r) continue;
            const key = `${JSON.stringify(v.value)}|${v.statusCode}|${v.sourceTimestamp}|${v.paused}`;
            if (r.last === key) continue;
            r.last = key;
            r.cells.value.textContent = fmtValue(v.value) + (v.unit ? ` ${v.unit}` : "");
            r.cells.value.title = fmtValue(v.value);
            clear(r.cells.status).appendChild(statusBadge(v.statusCode));
            r.cells.src.textContent = fmtTime(v.sourceTimestamp);
            r.cells.srv.textContent = fmtTime(v.serverTimestamp);
            clear(r.cells.sim);
            if (v.simulation !== "none") r.cells.sim.appendChild(h("span", { class: `badge ${v.paused || this.pausedAll ? "warn" : "info"}` }, v.paused ? `${v.simulation} (paused)` : v.simulation));
            else r.cells.sim.appendChild(h("span", { class: "muted small" }, "—"));
            if (r.paused !== !!v.paused) {
                r.paused = !!v.paused;
                appendChildren(clear(r.cells.pause), [v.paused ? "▶" : icon("pause")]);
            }
            r.cells.pause.disabled = v.simulation === "none";
            r.cells.value.classList.remove("flash");
            void r.cells.value.offsetWidth;
            r.cells.value.classList.add("flash");
        }
    },

    // Shared "set value" dialog: value + StatusCode + source/server timestamps + picoseconds.
    async setValueDialog(id, preset = {}) {
        const v = (this.values || []).find((x) => x.id === id) || preset.variable;
        if (!v) return;
        const isArray = v.valueRank >= 1;
        let valueInput;
        if (v.dataType === "Boolean" && !isArray) valueInput = select(["true", "false"], String(preset.value ?? v.value));
        else if (isArray) valueInput = h("textarea", { rows: 3, value: JSON.stringify(preset.value ?? v.value) });
        else valueInput = h("input", { class: "mono", value: preset.value ?? (typeof v.value === "object" ? JSON.stringify(v.value) : v.value ?? "") });
        const status = select(App.meta.statusCodes, v.statusCode && App.meta.statusCodes.includes(v.statusCode) ? v.statusCode : "Good");
        const tsMode = (label) => select([{ value: "now", label: "Now" }, { value: "custom", label: "Custom" }, { value: "keep", label: "Keep current" }, { value: "null", label: "Null (MinDate)" }], "now", { "aria-label": label });
        const srcMode = tsMode("source");
        const srvMode = tsMode("server");
        const srcInput = h("input", { type: "datetime-local", step: "0.001", value: toLocalInput(v.sourceTimestamp), class: "hidden" });
        const srvInput = h("input", { type: "datetime-local", step: "0.001", value: toLocalInput(v.serverTimestamp), class: "hidden" });
        srcMode.addEventListener("change", () => srcInput.classList.toggle("hidden", srcMode.value !== "custom"));
        srvMode.addEventListener("change", () => srvInput.classList.toggle("hidden", srvMode.value !== "custom"));
        const srcPico = h("input", { type: "number", value: 0, min: 0, max: 9999 });
        const srvPico = h("input", { type: "number", value: 0, min: 0, max: 9999 });
        const pause = checkbox("Pause simulation of this variable (otherwise the next tick overwrites the value)", v.simulation !== "none");
        const offsetBtns = h("div", { class: "btn-group" },
            [["-1 h", -3600e3], ["-1 min", -60e3], ["-10 s", -10e3], ["+10 s", 10e3], ["+1 h", 3600e3]].map(([label, ms]) =>
                h("button", { class: "btn small", onclick: () => { srcMode.value = "custom"; srcInput.classList.remove("hidden"); srcInput.value = toLocalInput(new Date(Date.now() + ms)); } }, label)));
        const resolveTs = (mode, input, current) => {
            if (mode === "now") return undefined;
            if (mode === "custom") return new Date(input.value).toISOString();
            if (mode === "keep") return current || undefined;
            return null;
        };
        return modal({
            title: `Set value · ${v.path}`,
            wide: true,
            body: h("div", { class: "stack" },
                h("div", { class: "muted small mono" }, `${v.nodeId} · ${v.dataType}${isArray ? "[]" : ""}`),
                field("Value", valueInput, valueHint(v.dataType, v.valueRank)),
                h("div", { class: "form-grid two" },
                    field("StatusCode", status, "Quality of the value (Good / Uncertain / Bad …)"),
                    h("div"),
                    field("Source timestamp", h("div", { class: "row" }, srcMode, srcInput)),
                    field("Server timestamp", h("div", { class: "row" }, srvMode, srvInput)),
                    field("Source picoseconds (×10 ps)", srcPico),
                    field("Server picoseconds (×10 ps)", srvPico)),
                h("div", null, h("div", { class: "label", style: { marginBottom: "4px" } }, "Quick source timestamp offsets"), offsetBtns),
                v.simulation !== "none" ? pause : null),
            buttons: [
                { label: "Cancel", value: null },
                {
                    label: "Apply", class: "primary", onClick: async () => {
                        const raw = valueInput.value;
                        const res = await api.server("setValue", {
                            id,
                            value: v.dataType === "Boolean" && !isArray ? raw === "true" : raw,
                            statusCode: status.value,
                            sourceTimestamp: resolveTs(srcMode.value, srcInput, v.sourceTimestamp),
                            serverTimestamp: resolveTs(srvMode.value, srvInput, v.serverTimestamp),
                            sourcePicoseconds: Number(srcPico.value) || 0,
                            serverPicoseconds: Number(srvPico.value) || 0,
                            pauseSimulation: v.simulation !== "none" ? pause.querySelector("input").checked : undefined
                        });
                        toast(`${v.path} = ${fmtValue(res.value)} [${res.statusCode}]`, "success");
                        if (this.tbody) this.poll();
                        return res;
                    }
                }
            ]
        });
    },

    async bulkStatusDialog() {
        const status = select(App.meta.statusCodes, "BadCommunicationError");
        const pause = checkbox("Pause simulation of these variables", true);
        const ok = await modal({
            title: `Set StatusCode for ${this.selected.size} variable(s)`,
            body: h("div", { class: "stack" },
                h("div", { class: "muted" }, "Keeps current values and applies a new StatusCode with current timestamps — e.g. simulate a device going offline."),
                field("StatusCode", status), pause),
            buttons: [{ label: "Cancel", value: false }, { label: "Apply", class: "primary", value: true }]
        });
        if (!ok) return;
        let n = 0;
        for (const id of this.selected) {
            const v = this.values.find((x) => x.id === id);
            if (!v) continue;
            const ok2 = await attempt(() => api.server("setValue", { id, value: v.value, statusCode: status.value, pauseSimulation: pause.querySelector("input").checked }));
            if (ok2) n++;
        }
        toast(`StatusCode ${status.value} applied to ${n} variable(s)`, "success");
        this.poll();
    },

    async historyDialog(v) {
        const start = h("input", { type: "datetime-local", step: "1", value: toLocalInput(Date.now() - 3600e3).slice(0, 19) });
        const end = h("input", { type: "datetime-local", step: "1", value: toLocalInput(Date.now() + 60e3).slice(0, 19) });
        const out = h("div");
        const chartHost = h("div");
        let chart = null;
        const load = async () => {
            const values = await attempt(() => api.server("getHistory", v.id, new Date(start.value).toISOString(), new Date(end.value).toISOString()));
            if (!values) return false;
            clear(out);
            if (!chart) chart = new TrendChart(chartHost);
            chart.clearSeries();
            // a stop marker (no value) breaks the line
            chart.setPoints("h", v.path, values.map((d) => [d.sourceTimestamp, isHistoryGap(d) ? null : Array.isArray(d.value) ? d.value[0] : d.value]));
            const stops = values.filter(isHistoryGap).length;
            out.appendChild(h("div", { class: "muted small", style: { margin: "8px 0" } },
                values.length >= LIVE_HISTORY_MAX ? `The latest ${LIVE_HISTORY_MAX.toLocaleString()} values of this range (choose an earlier end time for older ones)` : `${values.length.toLocaleString()} value(s)`,
                stops ? ` · ${plural(stops, "gap")} where the server was stopped (no values recorded)` : "",
                values.length > 500 ? " · the table shows the latest 500" : ""));
            out.appendChild(h("div", { class: "table-wrap", style: { maxHeight: "260px" } }, h("table", null,
                h("thead", null, h("tr", null, h("th", null, "Source timestamp"), h("th", null, "Value"), h("th", null, "Status"))),
                h("tbody", null, values.slice(-500).reverse().map((d) => h("tr", null, h("td", { class: "mono small" }, fmtTime(d.sourceTimestamp, true)), h("td", { class: "value" }, historyValueCell(d)), h("td", null, statusBadge(d.statusCode))))))));
            return false;
        };
        const clearBtn = h("button", { class: "btn small", title: "Delete the saved values of this variable from the history database", onclick: async () => {
            const ok = await confirmDialog("Clear this variable's history",
                h("div", { class: "stack", style: { gap: "8px" } },
                    h("div", null, `Delete every saved value of ${v.path} from the history database on this computer?`),
                    h("div", { class: "muted small" }, "This cannot be undone. OPC UA clients can then no longer read these values with HistoryRead. New values are recorded again from now on.")),
                "Clear history", true);
            if (!ok) return;
            const r = await attempt(() => api.server("clearHistory", { variableId: v.id }), `History of ${v.path} cleared`);
            if (r !== undefined) load();
        } }, icon("trash"), "Clear this variable's history");
        const size = App.project?.server?.valueHistorySize ?? 100000;
        setTimeout(load, 50);
        await modal({
            title: `History · ${v.path}`,
            wide: true,
            body: h("div", null,
                h("div", { class: "row wrap" }, field("Start", start), field("End", end), h("span", { class: "spacer" }), h("div", { style: { alignSelf: "flex-end" } }, clearBtn)),
                h("div", { class: "hint", style: { margin: "6px 0 4px" } }, size > 0
                    ? `Saved on this computer and kept across restarts (the latest ${Number(size).toLocaleString()} values per variable; Configuration → History).`
                    : "Value history is off (Configuration → History): no new values are recorded."),
                chartHost, out),
            buttons: [{ label: "Read", class: "primary", onClick: load }, { label: "Close", value: null }]
        });
        if (chart) chart.destroy();
    }
};
