"use strict";
/* Alarms & Conditions state, quick triggers and custom event generation. */
const Alarms = {
    mount(view) {
        const root = h("div", { class: "stack" });
        view.appendChild(root);
        if (App.serverStatus.state !== "running") {
            root.appendChild(h("div", { class: "card" }, h("div", { class: "card-body empty" },
                h("div", { class: "big" }, "⚠"), "Start the server to work with alarms and events.")));
            return App.on("server-status", (s) => { if (s.state === "running") App.navigate("alarms"); });
        }
        this.lastKey = null; // a new, empty table: the first poll fills it even when the alarms did not change
        this.alarmBody = h("div", { class: "card-body flush table-wrap" });
        root.appendChild(h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, "Alarms"), h("span", { class: "muted small" }, "Conditions defined in the Address Space designer")),
            this.alarmBody));
        root.appendChild(this.eventCard());
        root.appendChild(this.historyCard());
        this.poll();
        this.pollHistory();
        let tick = 0;
        const timer = setInterval(() => {
            this.poll();
            if (++tick % 2 === 0) this.pollHistory();
        }, 1000);
        const off = App.on("server-status", (s) => { if (s.state !== "running") App.navigate("alarms"); });
        return () => { clearInterval(timer); off(); this.historyBody = null; };
    },

    async poll() {
        let alarms;
        try { alarms = await api.server("getAlarms"); } catch (_) { return; }
        const key = JSON.stringify(alarms);
        if (key === this.lastKey) return;
        this.lastKey = key;
        this.render(alarms);
    },

    render(alarms) {
        clear(this.alarmBody);
        if (!alarms.length) {
            this.alarmBody.appendChild(h("div", { class: "empty" }, "No alarms configured. Add one in Address Space → + Alarm."));
            return;
        }
        const state = (on, yes, no, bad = "bad") => h("span", { class: `badge ${on ? bad : "good"}` }, on ? yes : no);
        this.alarmBody.appendChild(h("table", null,
            h("thead", null, h("tr", null, ["Alarm", "Input", "State", "Severity", "Message", "Trigger input", "Actions"].map((x) => h("th", null, x)))),
            h("tbody", null, alarms.map((a) => h("tr", null,
                h("td", null, h("div", null, a.path), h("div", { class: "muted small" }, `${a.type} · `, h("span", { class: "mono" }, a.nodeId))),
                h("td", { class: "small" }, a.source),
                h("td", null, h("div", { class: "btn-group", style: { gap: "4px", maxWidth: "200px" } },
                    h("span", { class: `badge ${a.enabled ? "good" : ""}` }, a.enabled ? "Enabled" : "Disabled"),
                    state(a.active, "Active", "Inactive"),
                    state(!a.acked, "Unacked", "Acked", "warn"),
                    state(!a.confirmed, "Unconfirmed", "Confirmed", "warn"))),
                h("td", { class: "num" }, a.severity),
                h("td", { class: "small", style: { maxWidth: "220px" } }, a.limitState ? h("span", { class: "badge bad" }, a.limitState) : null, " ", a.message),
                h("td", null, this.triggers(a)),
                h("td", { class: "actions" }, h("div", { class: "btn-group", style: { justifyContent: "flex-end", maxWidth: "190px", marginLeft: "auto" } },
                    h("button", { class: "btn small", onclick: () => this.action(a, a.enabled ? "disable" : "enable") }, a.enabled ? "Disable" : "Enable"),
                    h("button", { class: "btn small", disabled: a.acked || !a.enabled, onclick: () => this.action(a, "acknowledge") }, "Ack"),
                    h("button", { class: "btn small", disabled: a.confirmed || !a.acked || !a.enabled, onclick: () => this.action(a, "confirm") }, "Confirm"),
                    h("button", { class: "btn small", onclick: () => this.severityDialog(a) }, "Severity…"))))))));
    },

    // Buttons that drive the alarm's input variable to a value inside a given limit band.
    triggers(a) {
        const node = Designer.find(Designer.find(a.id)?.node?.alarm?.sourceId || "")?.node;
        if (!node) return null;
        const set = (value, label) => h("button", { class: "btn small", title: `Set input to ${value}`, onclick: () => this.setInput(node, value) }, label);
        if (a.type === "OffNormal") {
            const normal = Designer.find(a.id).node.alarm.normalValue;
            const dt = node.variable.dataType;
            const off = dt === "Boolean" ? String(!(String(normal) === "true")) : V_NUMERIC.has(dt) ? Number(normal) + 1 : `${normal}_off`;
            return h("div", { class: "btn-group" }, set(normal, "Normal"), set(off, "Off-normal"));
        }
        const l = a.limits;
        const n = (x) => (x === "" || x === undefined || x === null ? null : Number(x));
        const hh = n(l.highHigh), hi = n(l.high), lo = n(l.low), ll = n(l.lowLow);
        const mid = hi !== null && lo !== null ? (hi + lo) / 2 : 0;
        return h("div", { class: "btn-group", style: { flexWrap: "nowrap", gap: "4px" } },
            hh !== null ? set(hh + Math.max(1, Math.abs(hh) * 0.02), "HH") : null,
            hi !== null ? set(hh !== null ? (hi + hh) / 2 : hi + 1, "H") : null,
            set(mid, "Normal"),
            lo !== null ? set(ll !== null ? (lo + ll) / 2 : lo - 1, "L") : null,
            ll !== null ? set(ll - Math.max(1, Math.abs(ll) * 0.02), "LL") : null,
            h("button", { class: "btn small icon", title: "Resume input simulation", onclick: () => attempt(() => api.server("setPaused", node.id, false), "Simulation resumed") }, "▶"));
    },

    async setInput(node, value) {
        await attempt(() => api.server("setValue", { id: node.id, value, pauseSimulation: true }), `${node.name} = ${fmtValue(value)} (simulation paused)`);
        this.poll();
    },

    async action(a, action) {
        await attempt(() => api.server("alarmAction", a.id, action, ""), `${a.path}: ${action}`);
        this.poll();
    },

    async severityDialog(a) {
        const input = h("input", { type: "number", min: 1, max: 1000, value: a.severity });
        const ok = await modal({
            title: `Severity · ${a.path}`,
            body: field("Severity (1 = low … 1000 = critical)", input),
            buttons: [{ label: "Cancel", value: false }, { label: "Apply", class: "primary", value: true }]
        });
        if (ok) { await attempt(() => api.server("alarmAction", a.id, "severity", String(input.value))); this.poll(); }
    },

    // ------------------------------------------------------------ event history (saved on this computer)
    historyNotifier: "server",
    historyLimit: 200,

    historyCard() {
        this.historyKey = null; // a new, empty body: the next poll fills it even when the events did not change
        const sources = [{ value: "server", label: "Server (ns=0;i=2253) — every event" }, ...Designer.allContainers().map((c) => ({ value: c.id, label: c.path }))];
        if (!sources.some((x) => x.value === this.historyNotifier)) this.historyNotifier = "server";
        const notifier = select(sources, this.historyNotifier);
        notifier.addEventListener("change", () => { this.historyNotifier = notifier.value; this.historyKey = null; this.pollHistory(); });
        const limit = select([50, 200, 1000].map((n) => ({ value: String(n), label: `Latest ${n}` })), String(this.historyLimit));
        limit.addEventListener("change", () => { this.historyLimit = Number(limit.value); this.historyKey = null; this.pollHistory(); });
        this.historyBody = h("div", { class: "card-body flush table-wrap", style: { maxHeight: "420px" } });
        this.historyInfo = h("span", { class: "muted small" });
        const size = App.project?.server?.eventHistorySize ?? 100000;
        return h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, "Event history (saved on this computer)"),
                h("span", { class: "muted small" }, size > 0
                    ? `Kept across restarts, up to ${Number(size).toLocaleString()} events per object · clients read it with HistoryRead (events)`
                    : "Off — set “Events per object” in Configuration → History")),
            h("div", { class: "card-body", style: { paddingBottom: "10px" } },
                h("div", { class: "row wrap" }, field("Events of", notifier), field("Show", limit),
                    h("div", { class: "row", style: { alignSelf: "flex-end" } },
                        h("button", { class: "btn small", onclick: () => { this.historyKey = null; this.pollHistory(); } }, "↻ Refresh"),
                        h("button", { class: "btn small", onclick: () => this.clearHistoryDialog(sources.find((x) => x.value === this.historyNotifier)) }, icon("trash"), "Clear event history…")),
                    h("span", { class: "spacer" }), this.historyInfo)),
            this.historyBody);
    },

    async pollHistory() {
        if (!this.historyBody) return;
        const body = this.historyBody;
        const notifier = this.historyNotifier, limit = this.historyLimit;
        // an answer for another visit of the view, or for the object / limit chosen before, is dropped
        const stale = () => this.historyBody !== body || this.historyNotifier !== notifier || this.historyLimit !== limit;
        let events;
        try {
            events = await api.server("getEventHistory", { notifier, limit });
        } catch (err) {
            if (stale()) return;
            this.historyKey = null;
            this.historyInfo.textContent = "";
            clear(body).appendChild(h("div", { class: "empty" }, `Event history is not available: ${err.message}`));
            return;
        }
        if (stale()) return;
        events = (events || []).slice().sort((a, b) => String(b.time).localeCompare(String(a.time))); // newest first
        const key = JSON.stringify(events);
        if (key === this.historyKey) return;
        this.historyKey = key;
        this.historyInfo.textContent = events.length ? `${events.length} latest event(s), newest first` : "";
        clear(body);
        if (!events.length) {
            body.appendChild(h("div", { class: "empty" }, "No saved events yet. Raise an event above or trigger an alarm."));
            return;
        }
        body.appendChild(eventHistoryTable(events));
    },

    async clearHistoryDialog(source) {
        const label = source?.label?.replace(/ — every event$/, "") || "Server";
        const choice = await modal({
            title: "Clear event history",
            body: h("div", { class: "stack", style: { gap: "8px" } },
                h("div", null, "Delete saved events from the history database on this computer?"),
                h("div", null, "An event is saved for its source object and for every folder above it up to the Server object, so “", h("b", null, label), " only” keeps the copies saved for the other objects."),
                h("div", { class: "muted small" }, "This cannot be undone. OPC UA clients can then no longer read these events with HistoryRead. New events are recorded again from now on.")),
            buttons: [
                { label: "Cancel", value: null },
                { label: `Clear ${label.length > 28 ? "this object" : label} only`, value: "one" },
                { label: "Clear all event history", class: "danger", value: "all" }
            ]
        });
        if (!choice) return;
        const args = choice === "all" ? { all: true } : { notifier: this.historyNotifier };
        await attempt(() => api.server("clearEventHistory", args), choice === "all" ? "All event history cleared" : `Event history of ${label} cleared`);
        this.historyKey = null;
        this.pollHistory();
    },

    eventCard() {
        const type = select(App.meta.eventTypes, "BaseEventType");
        const sources = [{ value: "", label: "Server (ns=0;i=2253)" }, ...Designer.allContainers().map((c) => ({ value: c.id, label: c.path }))];
        const source = select(sources, "");
        const severity = h("input", { type: "number", value: 500, min: 1, max: 1000 });
        const message = h("input", { value: "Simulated event", style: { width: "100%" } });
        const count = h("input", { type: "number", value: 1, min: 1, max: 1000 });
        const fire = async () => {
            const n = Math.max(1, Number(count.value) || 1);
            for (let i = 0; i < n; i++) {
                const ok = await attempt(() => api.server("raiseEvent", { eventType: type.value, sourceId: source.value || null, severity: Number(severity.value), message: n > 1 ? `${message.value} #${i + 1}` : message.value }));
                if (ok === undefined && i === 0) return;
            }
            toast(`${n} event(s) raised`, "success");
        };
        return h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, "Raise Event"), h("span", { class: "muted small" }, "Events are reported to clients subscribed to the Server object or the source")),
            h("div", { class: "card-body stack" },
                h("div", { class: "form-grid" }, field("Event type", type), field("Source", source), field("Severity", severity), field("Count", count, "Raise a burst of events")),
                field("Message", message),
                h("div", null, h("button", { class: "btn primary", onclick: fire }, icon("lightning"), "Raise event"))));
    }
};
