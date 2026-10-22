"use strict";
/* Built-in OPC UA client: connect to any server, browse, read/write, monitor, events, methods, history. */
const ClientView = {
    conn: {
        url: "", securityPolicy: "None", securityMode: "None", authType: "Anonymous", username: "", password: "",
        certFile: "", keyFile: "", publishingInterval: 500, sessionTimeout: 60000, autoReconnect: true
    },
    endpoints: [],
    items: new Map(),
    events: [],
    expanded: new Set(["ns=0;i=84", "ns=0;i=85"]),
    children: new Map(),
    selected: null,
    tab: "items",
    installed: false,
    recentUrls: [],

    install() {
        if (this.installed) return;
        this.installed = true;
        try { this.recentUrls = JSON.parse(localStorage.getItem("recentUrls") || "[]"); } catch (_) { this.recentUrls = []; }
        App.on("client-data", (batch) => {
            for (const c of batch) {
                const it = this.items.get(c.itemId);
                if (!it) continue;
                it.dv = c;
                it.count++;
                if (it.charted && this.chart) this.chart.add(it.itemId, it.name, c.sourceTimestamp || c.serverTimestamp, Array.isArray(c.value) ? c.value[0] : c.value);
            }
            if (this.mounted) this.updateItemCells();
        });
        App.on("client-event", (e) => {
            this.events.unshift({ ...e, receivedAt: new Date().toISOString() });
            if (this.events.length > 1000) this.events.length = 1000;
            if (this.mounted && this.tab === "events") this.renderEvents();
            if (this.mounted) this.renderTabs();
        });
        App.on("client-status", (s) => {
            if (s.state === "disconnected") {
                this.items.clear();
                this.children.clear();
                this.selected = null;
                if (this.chart) this.chart.clearSeries();
            }
            if (this.mounted) this.renderAll();
        });
    },

    connected() { return App.clientStatus.state === "connected" || App.clientStatus.state === "reconnecting"; },

    mount(view) {
        this.install();
        view.className = "fill";
        if (!this.conn.url) this.conn.url = App.localEndpointUrl();
        if (App.clientPrefillUrl) { this.conn.url = App.clientPrefillUrl; App.clientPrefillUrl = null; }
        this.connEl = h("div", { class: "card", style: { flexShrink: 0, marginBottom: "12px" } });
        this.treeEl = h("div", { class: "tree pane-scroll", style: { padding: "8px" } });
        this.detailEl = h("div", { class: "pane-scroll", style: { padding: "14px 16px" } });
        this.tabsEl = h("div", { class: "tabs" });
        this.bottomEl = h("div", { class: "pane-scroll" });
        const chartHost = h("div", { style: { padding: "8px 12px" } });
        this.chartPane = h("div", { class: "pane", style: { width: "36%", borderLeft: "1px solid var(--border)" } }, chartHost);
        view.appendChild(this.connEl);
        view.appendChild(h("div", { class: "split", style: { flexDirection: "column", gap: "12px" } },
            h("div", { class: "split", style: { flex: "1 1 50%" } },
                h("div", { class: "card pane", style: { width: "340px", flexShrink: 0 } },
                    h("div", { class: "card-head" }, h("h3", null, "Address Space"),
                        h("button", { class: "btn small", title: "Refresh", onclick: () => { this.children.clear(); this.renderTree(); } }, "↻")),
                    this.treeEl),
                h("div", { class: "card pane", style: { flex: 1 } }, this.detailEl)),
            h("div", { class: "card pane", style: { flex: "1 1 42%" } },
                this.tabsEl,
                h("div", { class: "split", style: { gap: 0 } }, h("div", { class: "pane", style: { flex: 1 } }, this.bottomEl), this.chartPane))));
        this.chart = new TrendChart(chartHost);
        for (const it of this.items.values()) if (it.charted && it.dv) this.chart.add(it.itemId, it.name, it.dv.sourceTimestamp, it.dv.value);
        this.mounted = true;
        this.renderAll();
        return () => { this.mounted = false; this.chart.destroy(); this.chart = null; };
    },

    renderAll() {
        this.renderConnection();
        this.renderTree();
        this.renderDetail();
        this.renderTabs();
        this.renderBottom();
    },

    // ------------------------------------------------------------ connection
    renderConnection() {
        const el = clear(this.connEl);
        const c = this.conn;
        const st = App.clientStatus.state;
        const isConn = this.connected();
        const bind = (key, attrs = {}) => {
            const i = h("input", { value: c[key], ...attrs });
            i.addEventListener("input", () => { c[key] = attrs.type === "number" ? Number(i.value) : i.value; });
            return i;
        };
        const listId = "recent-urls";
        const url = bind("url", { class: "mono", list: listId, style: { flex: 1, minWidth: "280px" }, disabled: isConn });
        const datalist = h("datalist", { id: listId }, [...new Set([App.localEndpointUrl(), ...this.recentUrls])].map((u) => h("option", { value: u })));
        const combos = this.endpoints.length
            ? this.endpoints.map((e) => `${e.securityPolicy}|${e.securityMode}`)
            : App.meta.securityPolicies.flatMap((p) => (p === "None" ? ["None|None"] : ["Sign", "SignAndEncrypt"].map((m) => `${p}|${m}`)));
        const sec = select([...new Set(combos)].map((x) => ({ value: x, label: x.replace("|", " · ") })), `${c.securityPolicy}|${c.securityMode}`, { disabled: isConn });
        sec.addEventListener("change", () => { [c.securityPolicy, c.securityMode] = sec.value.split("|"); this.renderConnection(); });
        if (!combos.includes(sec.value) && combos.length) { [c.securityPolicy, c.securityMode] = combos[0].split("|"); sec.value = combos[0]; }
        const ep = this.endpoints.find((e) => e.securityPolicy === c.securityPolicy && e.securityMode === c.securityMode);
        const authTypes = ep ? [...new Set(ep.userTokens.map((t) => t.type))] : ["Anonymous", "UserName", "Certificate"];
        if (!authTypes.includes(c.authType)) c.authType = authTypes[0] || "Anonymous";
        const auth = select(authTypes.map((t) => ({ value: t, label: { Anonymous: "Anonymous", UserName: "Username / password", Certificate: "X509 certificate" }[t] || t })), c.authType, { disabled: isConn });
        auth.addEventListener("change", () => { c.authType = auth.value; this.renderConnection(); });
        const pickBtn = (key, title, ext) => h("button", { class: "btn small", disabled: isConn, onclick: async () => {
            const f = await api.app("pickFile", title, [{ name: title, extensions: ext }]);
            if (f) { c[key] = f; this.renderConnection(); }
        } }, c[key] ? c[key].split(/[\\/]/).pop() : title);

        const pillText = { connected: "Connected", connecting: "Connecting…", reconnecting: "Reconnecting…", disconnected: "Disconnected" }[st] || st;
        el.appendChild(h("div", { class: "card-body stack", style: { gap: "10px" } },
            h("div", { class: "row wrap" },
                url, datalist,
                h("button", { class: "btn", disabled: isConn, onclick: () => this.discover() }, icon("search"), "Endpoints"),
                h("div", { class: `pill ${st === "connected" ? "running" : st}` }, h("span", { class: "dot" }), pillText),
                isConn ? h("button", { class: "btn danger", onclick: () => attempt(() => api.client("disconnect")) }, "Disconnect")
                    : h("button", { class: "btn primary", disabled: st === "connecting", onclick: () => this.connect() }, "Connect")),
            h("div", { class: "row wrap" },
                field("Security", sec),
                field("User identity", auth),
                c.authType === "UserName" ? [field("Username", bind("username", { disabled: isConn, style: { width: "140px" } })),
                    field("Password", passwordInput(c.password, (v) => { c.password = v; }, { disabled: isConn, style: { width: "140px" } }))] : null,
                c.authType === "Certificate" ? field("Certificate & key (default: client app certificate)", h("div", { class: "row" }, pickBtn("certFile", "Certificate (.pem/.der)", ["pem", "der", "crt"]), pickBtn("keyFile", "Private key (.pem)", ["pem", "key"]),
                    c.certFile || c.keyFile ? h("button", { class: "btn small ghost", disabled: isConn, onclick: () => { c.certFile = c.keyFile = ""; this.renderConnection(); } }, "Reset") : null)) : null,
                field("Publishing interval (ms)", h("div", { class: "row" }, bind("publishingInterval", { type: "number", min: 0, style: { width: "100px" } }),
                    isConn ? h("button", { class: "btn small", onclick: () => attempt(() => api.client("setPublishingInterval", c.publishingInterval), (v) => `Publishing interval: ${v} ms`) }, "Apply") : null)),
                field("Session timeout (ms)", bind("sessionTimeout", { type: "number", min: 1000, disabled: isConn, style: { width: "110px" } })),
                h("div", { style: { alignSelf: "flex-end", paddingBottom: "6px" } }, checkbox("Auto reconnect", c.autoReconnect, (v) => { c.autoReconnect = v; })),
                App.clientStatus.error && !isConn ? h("span", { class: "badge bad", style: { alignSelf: "flex-end", whiteSpace: "normal" } }, App.clientStatus.error.replace(/^\[untrusted-server-certificate\]\s*/, "")) : null),
            // a password over an unsecured channel: say what protects it (and what does not)
            c.authType === "UserName" && c.securityMode === "None" && !isConn
                ? h("div", { class: "hint" }, "Security None: the connection is not signed or encrypted and the server's certificate is not checked. Use a Sign & Encrypt endpoint to send the password only to a server you trust.")
                : null));
    },

    async discover() {
        const eps = await attempt(() => api.client("getEndpoints", this.conn.url));
        if (!eps) return;
        this.endpoints = eps;
        const body = h("div", { class: "table-wrap" }, h("table", null,
            h("thead", null, h("tr", null, h("th", null, "Policy"), h("th", null, "Mode"), h("th", null, "Level"), h("th", null, "User tokens"), h("th", null, ""))),
            h("tbody", null, eps.map((e) => h("tr", null, h("td", null, e.securityPolicy), h("td", null, e.securityMode), h("td", { class: "num" }, e.securityLevel),
                h("td", null, [...new Set(e.userTokens.map((t) => t.type))].join(", ")),
                h("td", { class: "actions" }, h("button", { class: "btn small primary", "data-ep": `${e.securityPolicy}|${e.securityMode}` }, "Use")))))));
        const head = h("div", { class: "muted small", style: { marginBottom: "8px" } }, `${eps[0]?.serverName || ""} · ${eps[0]?.applicationUri || ""}`);
        const p = modal({ title: `Endpoints of ${this.conn.url}`, wide: true, body: h("div", null, head, body), buttons: [{ label: "Close", value: null }] });
        body.querySelectorAll("button[data-ep]").forEach((b) => b.addEventListener("click", () => {
            [this.conn.securityPolicy, this.conn.securityMode] = b.dataset.ep.split("|");
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            this.renderConnection();
        }));
        await p;
        this.renderConnection();
    },

    async connect() {
        const c = this.conn;
        this.recentUrls = [c.url, ...this.recentUrls.filter((u) => u !== c.url)].slice(0, 10);
        try { localStorage.setItem("recentUrls", JSON.stringify(this.recentUrls)); } catch (_) { /* ignore */ }
        try {
            await api.client("connect", { ...c });
        } catch (err) {
            this.renderConnection();
            // unknown server certificate: show it and let the user decide (no log-in was sent to the server yet)
            if (String(err.message).startsWith("[untrusted-server-certificate]")) {
                if (await this.trustServerDialog(err.message)) return this.connect();
                return;
            }
            toast(err.message || String(err), "error");
            return;
        }
        toast("Connected", "success");
        this.events = [];
        this.children.clear();
        await attempt(() => api.client("monitorEvents", "ns=0;i=2253"));
        this.renderAll();
    },

    // Shows the server certificate the client refused. Resolves true when the user trusted it (then connect again).
    async trustServerDialog(message) {
        const cert = await api.client("lastRejectedServerCertificate").catch(() => null);
        const text = String(message).replace(/^\[untrusted-server-certificate\]\s*/, "");
        if (!cert) {
            toast(text || "The server certificate is not trusted. Trust it in Certificates → Client application PKI → Rejected.", "error");
            return false;
        }
        const day = (d) => (d ? fmtTime(d, true).slice(0, 10) : "—");
        const colons = (hex) => String(hex || "").toUpperCase().replace(/(..)(?!$)/g, "$1:");
        return modal({
            title: "Unknown server certificate",
            wide: true,
            body: h("div", { class: "stack", style: { gap: "12px" } },
                h("div", null, `The server at ${this.conn.url} presented a certificate this computer does not trust yet. The connection was stopped before any log-in or data was sent. `,
                    "Trust it only if it belongs to the server you meant to reach — if possible, compare the thumbprint with the one shown on that server. ",
                    "An unexpected certificate can mean that someone is intercepting the connection."),
                h("div", { class: "cert-facts" },
                    h("div", null, "Subject"), h("div", null, cert.subject || "—"),
                    h("div", null, "Issuer"), h("div", null, cert.issuer || "—"),
                    cert.thumbprint256 ? [h("div", null, "SHA-256"), h("div", null, colons(cert.thumbprint256))] : null,
                    h("div", null, "Thumbprint (SHA-1)"), h("div", null, colons(cert.thumbprint) || "—"),
                    h("div", null, "Valid"), h("div", null, `${day(cert.validFrom)} to ${day(cert.validTo)}`)),
                h("div", { class: "muted small" }, "Trusted certificates are kept in Certificates → Client application PKI → Trusted, where you can remove them again.")),
            buttons: [
                { label: "Cancel", value: false },
                { label: "Trust and connect", class: "primary", onClick: async () => { await api.client("trustServerCertificate", cert.der); return true; } }
            ]
        }).then((r) => r === true);
    },

    // ------------------------------------------------------------ tree
    async loadChildren(nodeId) {
        if (!this.children.has(nodeId)) this.children.set(nodeId, await api.client("browse", nodeId));
        return this.children.get(nodeId);
    },

    async renderTree() {
        const el = this.treeEl;
        if (!el) return;
        if (!this.connected()) {
            clear(el).appendChild(h("div", { class: "empty" }, h("div", { class: "big" }, "⇄"), "Connect to a server to browse its address space."));
            return;
        }
        const scroll = el.scrollTop;
        const frag = h("div");
        const renderNode = async (ref, container, depth) => {
            const open = this.expanded.has(ref.nodeId);
            const row = h("div", { class: `tree-node ${this.selected?.nodeId === ref.nodeId ? "selected" : ""}` },
                h("span", { class: "tree-toggle" }, ref.hasChildren ? (open ? "▼" : "▶") : ""),
                kindIcon(ref.nodeClass), h("span", { class: "tree-label", title: ref.nodeId }, ref.displayName));
            row.querySelector(".tree-toggle").addEventListener("click", (e) => {
                e.stopPropagation();
                open ? this.expanded.delete(ref.nodeId) : this.expanded.add(ref.nodeId);
                this.renderTree();
            });
            row.addEventListener("click", () => { this.selected = ref; this.renderTree(); this.renderDetail(); });
            row.addEventListener("dblclick", () => {
                if (ref.nodeClass === "Variable") this.monitor(ref);
                else if (ref.nodeClass === "Method") this.callDialog(ref);
            });
            container.appendChild(row);
            if (open && ref.hasChildren && depth < 30) {
                const box = h("div", { class: "tree-children" });
                container.appendChild(box);
                let kids = [];
                try { kids = await this.loadChildren(ref.nodeId); } catch (err) { box.appendChild(h("div", { class: "small", style: { color: "var(--bad)" } }, err.message)); }
                if (!kids.length) row.querySelector(".tree-toggle").textContent = "";
                for (const k of kids) await renderNode(k, box, depth + 1);
            }
        };
        await renderNode({ nodeId: "ns=0;i=84", displayName: "Root", nodeClass: "Object", hasChildren: true }, frag, 0);
        clear(el).appendChild(frag);
        el.scrollTop = scroll;
    },

    // ------------------------------------------------------------ details
    async renderDetail() {
        const el = this.detailEl;
        if (!el) return;
        clear(el);
        const ref = this.selected;
        if (!this.connected() || !ref) {
            el.appendChild(h("div", { class: "empty" }, h("div", { class: "big" }, "ℹ"), "Select a node to see its attributes. Double-click a variable to monitor it, or a method to call it."));
            return;
        }
        el.appendChild(h("div", { class: "muted" }, "Reading attributes…"));
        let data;
        try { data = await api.client("readAttributes", ref.nodeId); } catch (err) { clear(el).appendChild(h("div", { class: "badge bad" }, err.message)); return; }
        if (this.selected !== ref) return;
        clear(el);
        const isVar = data.info.nodeClass === "Variable";
        const isMethod = data.info.nodeClass === "Method";
        const eventNotifier = data.attributes.find((a) => a.name === "EventNotifier");
        el.appendChild(h("div", { class: "row wrap", style: { marginBottom: "12px" } },
            kindIcon(data.info.nodeClass), h("h2", { style: { margin: 0, fontSize: "16px" } }, data.info.displayName || ref.displayName),
            h("span", { class: "badge" }, data.info.nodeClass),
            h("span", { class: "code", style: { cursor: "pointer" }, title: "Copy NodeId", onclick: () => copyText(ref.nodeId) }, ref.nodeId),
            h("span", { class: "spacer" }),
            h("div", { class: "btn-group" },
                h("button", { class: "btn small", onclick: () => this.renderDetail() }, "↻ Read"),
                isVar ? h("button", { class: "btn small", disabled: !data.info.writable, title: data.info.writable ? "" : "UserAccessLevel does not allow writing", onclick: () => this.writeDialog(ref.nodeId, data.info, data.value) }, "✎ Write…") : null,
                isVar ? h("button", { class: "btn small primary", onclick: () => this.monitor(ref) }, "+ Monitor") : null,
                isVar ? h("button", { class: "btn small", onclick: () => this.monitorDialog(ref) }, "Monitor…") : null,
                isVar && data.info.historizing ? h("button", { class: "btn small", onclick: () => this.historyDialog(ref) }, icon("clock"), "History…") : null,
                isMethod ? h("button", { class: "btn small primary", onclick: () => this.callDialog(ref) }, "ƒ Call…") : null,
                eventNotifier && /SubscribeToEvents/.test(eventNotifier.value) ? h("button", { class: "btn small", onclick: () => attempt(() => api.client("monitorEvents", ref.nodeId), `Subscribed to events of ${ref.displayName}`) }, "Subscribe events") : null,
                // EventNotifier bit 2 (value 4): the node keeps an event history that HistoryRead (ReadEventDetails) can read
                (data.info.eventNotifier || 0) & 4 ? h("button", { class: "btn small", onclick: () => this.eventHistoryDialog(ref) }, icon("clock"), "Event history…") : null)));
        if (data.value) {
            const v = data.value;
            el.appendChild(h("div", { class: "card", style: { marginBottom: "12px", boxShadow: "none" } }, h("div", { class: "card-body" },
                h("div", { class: "row wrap", style: { gap: "18px" } },
                    h("div", null, h("div", { class: "label" }, "Value"), h("div", { class: "mono", style: { fontSize: "15px", wordBreak: "break-all" } }, fmtValue(v.value))),
                    h("div", null, h("div", { class: "label" }, "Type"), h("div", null, `${v.dataType}${v.arrayType !== "Scalar" ? "[]" : ""}`)),
                    h("div", null, h("div", { class: "label" }, "Status"), statusBadge(v.statusCode)),
                    h("div", null, h("div", { class: "label" }, "Source timestamp"), h("div", { class: "mono small" }, fmtTime(v.sourceTimestamp, true))),
                    h("div", null, h("div", { class: "label" }, "Server timestamp"), h("div", { class: "mono small" }, fmtTime(v.serverTimestamp, true)))))));
        }
        el.appendChild(h("div", { class: "section-title" }, "Attributes"));
        el.appendChild(h("div", { class: "kv card", style: { boxShadow: "none" } }, data.attributes.flatMap((a) => [h("div", null, a.name), h("div", null, String(a.value ?? ""))])));
        if (data.properties.length) {
            el.appendChild(h("div", { class: "section-title", style: { marginTop: "14px" } }, "Properties"));
            el.appendChild(h("div", { class: "kv card", style: { boxShadow: "none" } }, data.properties.flatMap((p) => [h("div", { title: p.nodeId }, p.name), h("div", null, p.value)])));
        }
    },

    // ------------------------------------------------------------ monitored items
    async monitor(ref, opts = {}) {
        const res = await attempt(() => api.client("monitor", { nodeId: ref.nodeId, samplingInterval: 250, queueSize: 10, ...opts }));
        if (!res) return;
        this.items.set(res.itemId, { itemId: res.itemId, nodeId: ref.nodeId, name: ref.displayName, dv: null, count: 0, charted: true, settings: { ...opts, revisedSamplingInterval: res.revisedSamplingInterval, revisedQueueSize: res.revisedQueueSize } });
        this.tab = "items";
        this.renderTabs();
        this.renderBottom();
        toast(`Monitoring ${ref.displayName} (sampling ${res.revisedSamplingInterval} ms)`, "success", 1800);
    },

    async monitorDialog(ref) {
        const sampling = h("input", { type: "number", value: 250, min: -1 });
        const queue = h("input", { type: "number", value: 10, min: 0 });
        const discard = checkbox("Discard oldest", true);
        const trigger = select(["Status", "StatusValue", "StatusValueTimestamp"], "StatusValue");
        const dbType = select(["None", "Absolute", "Percent"], "None");
        const dbValue = h("input", { type: "number", value: 0, min: 0, step: "any" });
        const ok = await modal({
            title: `Monitor · ${ref.displayName}`,
            body: h("div", { class: "form-grid two" },
                field("Sampling interval (ms)", sampling, "0 = fastest, -1 = publishing interval"),
                field("Queue size", queue),
                field("Data change trigger", trigger),
                field("Deadband type", dbType, "Percent requires an EURange (AnalogItem)"),
                field("Deadband value", dbValue),
                h("div", { style: { alignSelf: "end" } }, discard)),
            buttons: [{ label: "Cancel", value: false }, { label: "Monitor", class: "primary", value: true }]
        });
        if (!ok) return;
        this.monitor(ref, {
            samplingInterval: Number(sampling.value), queueSize: Number(queue.value), discardOldest: discard.querySelector("input").checked,
            trigger: trigger.value, deadbandType: dbType.value, deadbandValue: Number(dbValue.value)
        });
    },

    renderTabs() {
        const el = this.tabsEl;
        if (!el) return;
        clear(el);
        const tab = (id, label) => h("button", { class: `tab ${this.tab === id ? "active" : ""}`, onclick: () => { this.tab = id; this.renderTabs(); this.renderBottom(); } }, label);
        el.appendChild(tab("items", `Monitored Items (${this.items.size})`));
        el.appendChild(tab("events", `Events & Alarms (${this.events.length})`));
        this.chartPane.classList.toggle("hidden", this.tab !== "items");
    },

    renderBottom() {
        if (!this.bottomEl) return;
        if (this.tab === "events") return this.renderEvents();
        const el = clear(this.bottomEl);
        this.itemRows = new Map();
        if (!this.items.size) {
            el.appendChild(h("div", { class: "empty" }, this.connected() ? "Double-click a variable in the tree or use “+ Monitor” to subscribe to it." : "Not connected"));
            return;
        }
        const tbody = h("tbody");
        for (const it of this.items.values()) {
            const cells = { value: h("td", { class: "value" }), status: h("td"), src: h("div"), srv: h("div", { class: "muted" }), count: h("td", { class: "num" }) };
            const chartBtn = h("button", { class: `btn small icon ${it.charted ? "primary" : ""}`, title: "Plot" }, icon("chart"));
            chartBtn.onclick = () => { it.charted = !it.charted; chartBtn.classList.toggle("primary", it.charted); if (!it.charted) this.chart.removeSeries(it.itemId); };
            tbody.appendChild(h("tr", null,
                h("td", { title: it.nodeId }, h("div", null, it.name), h("div", { class: "muted small mono" }, it.nodeId)),
                cells.value, cells.status, h("td", { class: "mono small" }, cells.src, cells.srv), cells.count,
                h("td", { class: "small muted" }, `${it.settings.revisedSamplingInterval ?? "?"} ms`),
                h("td", { class: "actions" },
                    h("button", { class: "btn small", onclick: () => this.writeDialog(it.nodeId, null, it.dv) }, "Write…"), " ",
                    chartBtn, " ",
                    h("button", { class: "btn small icon", title: "Remove", onclick: async () => {
                        await attempt(() => api.client("unmonitor", it.itemId));
                        this.items.delete(it.itemId);
                        this.chart?.removeSeries(it.itemId);
                        this.renderTabs();
                        this.renderBottom();
                    } }, "✕"))));
            this.itemRows.set(it.itemId, { cells, last: null });
        }
        el.appendChild(h("table", null,
            h("thead", null, h("tr", null, ["Node", "Value", "Status", "Source / server timestamp", "Changes", "Sampling", ""].map((x) => h("th", null, x)))), tbody));
        this.updateItemCells();
    },

    updateItemCells() {
        if (this.tab !== "items" || !this.itemRows) return;
        for (const it of this.items.values()) {
            const r = this.itemRows.get(it.itemId);
            if (!r || !it.dv) continue;
            const key = `${it.count}`;
            if (r.last === key) continue;
            r.last = key;
            r.cells.value.textContent = fmtValue(it.dv.value);
            clear(r.cells.status).appendChild(statusBadge(it.dv.statusCode));
            r.cells.src.textContent = fmtTime(it.dv.sourceTimestamp);
            r.cells.srv.textContent = fmtTime(it.dv.serverTimestamp);
            r.cells.count.textContent = it.count;
            r.cells.value.classList.remove("flash");
            void r.cells.value.offsetWidth;
            r.cells.value.classList.add("flash");
        }
    },

    // ------------------------------------------------------------ events
    renderEvents() {
        const el = clear(this.bottomEl);
        el.appendChild(h("div", { class: "toolbar", style: { padding: "8px 12px 0" } },
            h("button", { class: "btn small", disabled: !this.connected(), onclick: () => attempt(() => api.client("conditionRefresh"), "ConditionRefresh requested") }, "↻ ConditionRefresh"),
            h("button", { class: "btn small", onclick: () => { this.events = []; this.renderTabs(); this.renderEvents(); } }, "Clear"),
            h("span", { class: "muted small" }, "Subscribed to Server (ns=0;i=2253) events after connect")));
        if (!this.events.length) {
            el.appendChild(h("div", { class: "empty" }, "No events received yet"));
            return;
        }
        const yesNo = (v, yes, no, cls) => (v === null || v === undefined ? "" : h("span", { class: `badge ${v ? cls : "good"}` }, v ? yes : no));
        el.appendChild(h("table", null,
            h("thead", null, h("tr", null, ["Time", "Type", "Source", "Severity", "Message", "Condition", "Active", "Acked", "Confirmed", ""].map((x) => h("th", null, x)))),
            h("tbody", null, this.events.slice(0, 300).map((e) => h("tr", null,
                h("td", { class: "mono small" }, fmtTime(e.Time)),
                h("td", { class: "small" }, e.EventTypeName || e.EventType),
                h("td", null, e.SourceName),
                h("td", { class: "num" }, h("span", { class: `badge ${e.Severity >= 700 ? "bad" : e.Severity >= 400 ? "warn" : "info"}` }, e.Severity)),
                h("td", { class: "small", style: { maxWidth: "320px" } }, e.Message),
                h("td", { class: "small" }, e.ConditionName || ""),
                h("td", null, yesNo(e["ActiveState.Id"], "Active", "Inactive", "bad")),
                h("td", null, yesNo(e["AckedState.Id"] === null || e["AckedState.Id"] === undefined ? null : !e["AckedState.Id"], "No", "Yes", "warn")),
                h("td", null, yesNo(e["ConfirmedState.Id"] === null || e["ConfirmedState.Id"] === undefined ? null : !e["ConfirmedState.Id"], "No", "Yes", "warn")),
                h("td", { class: "actions" }, e.ConditionId ? h("div", { class: "btn-group", style: { justifyContent: "flex-end" } },
                    h("button", { class: "btn small", disabled: e["AckedState.Id"] !== false, onclick: () => this.conditionAction(e, "acknowledge") }, "Ack"),
                    h("button", { class: "btn small", disabled: e["ConfirmedState.Id"] !== false || e["AckedState.Id"] === false, onclick: () => this.conditionAction(e, "confirm") }, "Confirm"),
                    h("button", { class: "btn small", onclick: () => this.conditionAction(e, "addComment") }, "Comment…")) : null))))));
    },

    async conditionAction(e, action) {
        let comment = `${action} from OPC UA Simulator client`;
        if (action === "addComment") {
            const input = h("input", { value: "", placeholder: "Comment", style: { width: "100%" } });
            const ok = await modal({ title: `Comment · ${e.ConditionName}`, body: input, buttons: [{ label: "Cancel", value: false }, { label: "Add comment", class: "primary", value: true }] });
            if (!ok) return;
            comment = input.value;
        }
        await attempt(() => api.client("conditionMethod", { conditionId: e.ConditionId, eventId: e.EventId, comment, action }), (s) => `${action}: ${s}`);
    },

    // ------------------------------------------------------------ write / call / history
    async writeDialog(nodeId, info, current) {
        if (!info) {
            const data = await attempt(() => api.client("readAttributes", nodeId));
            if (!data) return;
            info = data.info;
            current = data.value;
        }
        const isArray = info.valueRank >= 0;
        const dataType = info.dataType;
        let valueInput;
        const cur = current?.value;
        if (dataType === "Boolean" && !isArray) valueInput = select(["true", "false"], String(!!cur));
        else if (isArray) valueInput = h("textarea", { rows: 3, value: JSON.stringify(cur ?? []) });
        else valueInput = h("input", { class: "mono", value: cur === null || cur === undefined ? "" : typeof cur === "object" ? JSON.stringify(cur) : cur });
        const incStatus = checkbox("Write StatusCode", false);
        const status = select(App.meta.statusCodes, "Good");
        const incSrc = checkbox("Write source timestamp", false);
        const src = h("input", { type: "datetime-local", step: "0.001", value: toLocalInput() });
        const incSrv = checkbox("Write server timestamp", false);
        const srv = h("input", { type: "datetime-local", step: "0.001", value: toLocalInput() });
        const indexRange = h("input", { class: "mono", placeholder: "e.g. 2 or 0:3 (optional)" });
        const chk = (c) => c.querySelector("input").checked;
        await modal({
            title: `Write · ${info.displayName || nodeId}`,
            wide: true,
            body: h("div", { class: "stack" },
                h("div", { class: "muted small mono" }, `${nodeId} · ${dataType}${isArray ? "[]" : ""}`),
                field("Value", valueInput, valueHint(dataType, isArray ? 1 : -1)),
                h("div", { class: "form-grid two" },
                    h("div", { class: "stack", style: { gap: "6px" } }, incStatus, status),
                    field("Index range", indexRange, "NumericRange to write part of an array"),
                    h("div", { class: "stack", style: { gap: "6px" } }, incSrc, src),
                    h("div", { class: "stack", style: { gap: "6px" } }, incSrv, srv)),
                h("div", { class: "hint" }, "Servers may reject StatusCode/timestamp writes with BadWriteNotSupported — useful to test that behaviour.")),
            buttons: [
                { label: "Cancel", value: null },
                {
                    label: "Write", class: "primary", onClick: async () => {
                        const raw = valueInput.value;
                        const r = await api.client("write", {
                            nodeId, dataType, valueRank: info.valueRank, indexRange: indexRange.value || undefined,
                            value: dataType === "Boolean" && !isArray ? raw === "true" : raw,
                            includeStatus: chk(incStatus), statusCode: status.value,
                            includeSourceTimestamp: chk(incSrc), sourceTimestamp: new Date(src.value).toISOString(),
                            includeServerTimestamp: chk(incSrv), serverTimestamp: new Date(srv.value).toISOString()
                        });
                        toast(`Write result: ${r}`, r === "Good" ? "success" : "warn");
                        if (this.selected?.nodeId === nodeId) this.renderDetail();
                        return r === "Good" ? r : false;
                    }
                }
            ]
        });
    },

    async callDialog(ref) {
        const info = await attempt(() => api.client("getMethodInfo", ref.nodeId));
        if (!info) return;
        const inputs = info.inputs.map((a) => {
            const el = a.dataType === "Boolean" && a.valueRank < 0 ? select(["true", "false"], "false")
                : h("input", { class: "mono", value: a.valueRank >= 0 ? "[]" : V_NUMERIC.has(a.dataType) ? "0" : "" });
            return { a, el };
        });
        const out = h("div");
        const objectId = h("input", { class: "mono", value: info.objectId });
        await modal({
            title: `Call · ${ref.displayName}`,
            wide: true,
            body: h("div", { class: "stack" },
                field("Object (ObjectId)", objectId),
                inputs.length ? h("div", { class: "form-grid two" }, inputs.map(({ a, el }) => field(`${a.name} : ${a.dataTypeName}${a.valueRank >= 0 ? "[]" : ""}`, el, a.description !== a.name ? a.description : ""))) : h("div", { class: "muted" }, "This method has no input arguments."),
                out),
            buttons: [
                { label: "Close", value: null },
                {
                    label: "Call", class: "primary", onClick: async () => {
                        const res = await api.client("callMethod", {
                            objectId: objectId.value, methodId: info.methodId,
                            inputs: inputs.map(({ a, el }) => ({ dataType: a.dataType, valueRank: a.valueRank, value: a.dataType === "Boolean" && a.valueRank < 0 ? el.value === "true" : el.value }))
                        });
                        clear(out).appendChild(h("div", { class: "card", style: { boxShadow: "none" } }, h("div", { class: "card-body stack", style: { gap: "6px" } },
                            h("div", null, "Result: ", statusBadge(res.statusCode)),
                            res.inputArgumentResults.some((s) => s !== "Good") ? h("div", { class: "small" }, `Input argument results: ${res.inputArgumentResults.join(", ")}`) : null,
                            res.outputs.map((o, i) => h("div", { class: "row" }, h("span", { class: "label" }, info.outputs[i]?.name || `Output ${i}`), h("span", { class: "mono" }, fmtValue(o.value)), h("span", { class: "muted small" }, o.dataType))))));
                        return false;
                    }
                }
            ]
        });
    },

    // HistoryRead of a historizing variable: raw values (ReadRawModifiedDetails) or the values at chosen times
    // (ReadAtTimeDetails, exact samples or interpolated by the server).
    async historyDialog(ref) {
        const now = Date.now();
        const local = (ms) => toLocalInput(ms).slice(0, 19);
        const mode = select([{ value: "raw", label: "Raw values" }, { value: "attime", label: "Values at specific times" }], this.historyMode || "raw");
        const start = h("input", { type: "datetime-local", step: "1", value: local(now - 3600e3) });
        const end = h("input", { type: "datetime-local", step: "1", value: local(now + 60e3) });
        const timesHow = select([{ value: "every", label: "Every N seconds from start to end" }, { value: "list", label: "List of times (one per line)" }], "every");
        const atStart = h("input", { type: "datetime-local", step: "1", value: local(Math.floor((now - 300e3) / 1000) * 1000) });
        const atEnd = h("input", { type: "datetime-local", step: "1", value: local(Math.floor(now / 1000) * 1000) });
        const every = h("input", { type: "number", min: 0.001, step: "any", value: 10, style: { width: "110px" } });
        const list = h("textarea", { rows: 6, spellcheck: "false", value: [60, 45, 30, 15, 5].map((s) => fmtTime(Math.floor((now - s * 1000) / 1000) * 1000, true)).join("\n") });
        const simple = checkbox("Use simple bounds", true);
        const count = h("span", { class: "muted small", style: { alignSelf: "flex-end", paddingBottom: "8px" } });
        const everyPanel = h("div", { class: "row wrap" }, field("Start", atStart), field("End", atEnd), field("Every (seconds)", every), count);
        const listPanel = field("Times", list, "One per line: 2026-10-22 14:05:30.250 (local time), an ISO time with Z or offset, 14:05:30 (today), or relative to now: -30s, -5m, -2h.");
        const rawPanel = h("div", { class: "row wrap" }, field("Start", start), field("End", end));
        const atPanel = h("div", { class: "stack", style: { gap: "10px" } },
            h("div", { class: "row wrap" }, field("Times", timesHow), h("div", { style: { alignSelf: "flex-end", paddingBottom: "6px" }, title: "UseSimpleBounds of ReadAtTimeDetails: the server interpolates from the nearest stored values around each time" }, simple)),
            everyPanel, listPanel);
        const chartHost = h("div", { style: { marginTop: "10px" } });
        const out = h("div");
        let chart = null;

        const generated = () => {
            const a = new Date(atStart.value).getTime();
            const b = new Date(atEnd.value).getTime();
            const step = Number(every.value) * 1000;
            if (!isFinite(a) || !isFinite(b)) throw new Error("Enter a start and an end time");
            if (!(step > 0)) throw new Error("Enter an interval greater than 0 seconds");
            if (b < a) throw new Error("The end time is before the start time");
            const n = Math.floor((b - a) / step + 1e-9) + 1;
            if (n > MAX_AT_TIMES) throw new Error(`That is ${n.toLocaleString()} times; at most ${MAX_AT_TIMES.toLocaleString()} per read (choose a longer interval or a shorter range)`);
            return Array.from({ length: n }, (_, i) => new Date(a + i * step).toISOString());
        };
        const times = () => (timesHow.value === "every" ? generated() : parseTimeList(list.value));
        const updateCount = () => {
            try { count.textContent = `→ ${plural(generated().length, "time")}`; count.style.color = ""; } catch (err) { count.textContent = err.message; count.style.color = "var(--bad)"; }
        };
        [atStart, atEnd, every].forEach((el) => el.addEventListener("input", updateCount));
        const showMode = () => {
            this.historyMode = mode.value;
            rawPanel.classList.toggle("hidden", mode.value !== "raw");
            atPanel.classList.toggle("hidden", mode.value !== "attime");
            everyPanel.classList.toggle("hidden", timesHow.value !== "every");
            listPanel.classList.toggle("hidden", timesHow.value !== "list");
            updateCount();
        };
        mode.addEventListener("change", () => { clear(out); chart?.clearSeries(); showMode(); });
        timesHow.addEventListener("change", showMode);
        showMode();

        const loadRaw = async () => {
            const values = await attempt(() => api.client("historyRead", { nodeId: ref.nodeId, startTime: new Date(start.value).toISOString(), endTime: new Date(end.value).toISOString() }));
            if (!values) return;
            if (!chart) chart = new TrendChart(chartHost);
            chart.clearSeries();
            // a stop marker of the simulator (BadDataLost without value) breaks the line
            chart.setPoints("h", ref.displayName, values.map((d) => [d.sourceTimestamp, isHistoryGap(d) ? null : Array.isArray(d.value) ? d.value[0] : d.value]));
            // bounding values (start / end time: interpolated or BadBoundNotFound) are not stored values
            const bounds = values.filter((d) => /^BadBound|#HistorianInterpolated/.test(d.statusCode)).length;
            const stored = values.length - bounds;
            clear(out).appendChild(h("div", { class: "muted small", style: { margin: "8px 0" } },
                `${stored.toLocaleString()} value(s)${bounds ? ` and ${plural(bounds, "bounding value")}` : ""} returned by HistoryRead (ReadRawModifiedDetails)`,
                stored >= RAW_READ_MAX ? ` · limit of ${RAW_READ_MAX.toLocaleString()} values reached, choose a shorter range for the rest` : "",
                values.length > 500 ? " · the table shows the latest 500" : ""));
            out.appendChild(h("div", { class: "table-wrap", style: { maxHeight: "260px" } }, h("table", null,
                h("thead", null, h("tr", null, h("th", null, "Source timestamp"), h("th", null, "Value"), h("th", null, "Status"))),
                h("tbody", null, values.slice(-500).reverse().map((d) => h("tr", null, h("td", { class: "mono small" }, fmtTime(d.sourceTimestamp, true)), h("td", { class: "value" }, historyValueCell(d)), h("td", null, statusBadge(d.statusCode))))))));
        };
        const loadAtTime = async () => {
            let timestamps;
            try { timestamps = times(); } catch (err) { toast(err.message, "error"); return; }
            const rows = await attempt(() => api.client("historyReadAtTime", { nodeId: ref.nodeId, timestamps, useSimpleBounds: simple.querySelector("input").checked }));
            if (!rows) return;
            const usable = rows.filter((r) => !/^Bad/.test(r.statusCode));
            const interpolated = usable.filter((r) => r.interpolated).length;
            if (!chart) chart = new TrendChart(chartHost);
            chart.clearSeries();
            // a time without data (Bad, e.g. BadDataLost while the server was stopped) breaks the line
            chart.setPoints("t", `${ref.displayName} (● stored sample, ○ interpolated)`, rows.map((r) => [r.requested, /^Bad/.test(r.statusCode) ? null : Array.isArray(r.value) ? r.value[0] : r.value, r.interpolated]));
            clear(out).appendChild(h("div", { class: "muted small", style: { margin: "8px 0" } },
                `${plural(rows.length, "time")} read with HistoryRead (ReadAtTimeDetails): ${usable.length - interpolated} stored sample(s), ${interpolated} interpolated, ${rows.length - usable.length} without data`,
                rows.length > 2000 ? " · the table shows the first 2000" : ""));
            out.appendChild(h("div", { class: "table-wrap", style: { maxHeight: "260px" } }, h("table", null,
                h("thead", null, h("tr", null, ["Requested time", "Value", "Status", "Source timestamp"].map((x) => h("th", null, x)))),
                h("tbody", null, rows.slice(0, 2000).map((r) => h("tr", null,
                    h("td", { class: "mono small" }, fmtTime(r.requested, true)),
                    h("td", { class: "value", title: fmtValue(r.value) }, /^Bad/.test(r.statusCode) ? h("span", { class: "muted" }, "—") : fmtValue(r.value)),
                    h("td", null, h("div", { class: "btn-group", style: { gap: "4px" } }, statusBadge(r.statusCode),
                        // only a Good / Uncertain value was interpolated or calculated (a Bad result can carry the bits too)
                        r.interpolated && !/^Bad/.test(r.statusCode) ? h("span", { class: "badge info", title: "HistorianInterpolated: the server computed this value from the stored values around the requested time" }, "interpolated") : null,
                        r.calculated && !/^Bad/.test(r.statusCode) ? h("span", { class: "badge info" }, "calculated") : null)),
                    h("td", { class: "mono small" }, fmtTime(r.sourceTimestamp, true))))))));
        };
        const load = async () => {
            await (mode.value === "raw" ? loadRaw() : loadAtTime());
            return false;
        };
        if (mode.value === "raw") setTimeout(load, 50);
        await modal({
            title: `HistoryRead · ${ref.displayName}`,
            wide: true,
            body: h("div", { class: "stack", style: { gap: "12px" } }, h("div", { class: "row wrap" }, field("Read", mode)), rawPanel, atPanel, h("div", null, chartHost, out)),
            buttons: [{ label: "Read", class: "primary", onClick: load }, { label: "Close", value: null }]
        });
        if (chart) chart.destroy();
    },

    // HistoryRead with ReadEventDetails on an event notifier whose EventNotifier attribute has the HistoryRead bit.
    async eventHistoryDialog(ref) {
        const now = Date.now();
        const local = (ms) => toLocalInput(ms).slice(0, 19);
        const start = h("input", { type: "datetime-local", step: "1", value: local(now - 24 * 3600e3) });
        const end = h("input", { type: "datetime-local", step: "1", value: local(now + 60e3) });
        const order = select([{ value: "reverse", label: "Newest first" }, { value: "forward", label: "Oldest first" }], "reverse");
        const max = h("input", { type: "number", min: 1, max: 100000, value: 1000, style: { width: "110px" } });
        const out = h("div");
        const load = async () => {
            const iso = (el) => (el.value ? new Date(el.value).toISOString() : null);
            let a = iso(start), b = iso(end);
            if (a && b && a > b) [a, b] = [b, a];
            // Part 11: start after end reads backwards (newest first); an empty start or end is an open-ended read
            const range = a && b && order.value === "reverse" ? { startTime: b, endTime: a } : { startTime: a, endTime: b };
            const limit = Math.max(1, Math.min(100000, Math.floor(Number(max.value)) || 1000));
            const events = await attempt(() => api.client("historyReadEvents", { nodeId: ref.nodeId, ...range, maxEvents: limit }));
            if (!events) return false;
            clear(out).appendChild(h("div", { class: "muted small", style: { margin: "8px 0" } },
                `${events.length.toLocaleString()} event(s) returned by HistoryRead (ReadEventDetails)`,
                events.length >= limit ? ` · limit of ${limit.toLocaleString()} reached, there may be more` : "",
                events.length > 2000 ? " · the table shows the first 2000" : ""));
            if (!events.length) {
                out.appendChild(h("div", { class: "empty" }, "No events in this time range"));
                return false;
            }
            out.appendChild(h("div", { class: "table-wrap", style: { maxHeight: "380px" } }, eventHistoryTable(events.slice(0, 2000).map((e) => ({
                time: e.Time, eventType: e.EventTypeName || e.EventType, sourceName: e.SourceName, severity: e.Severity, message: e.Message, conditionName: e.ConditionName
            })))));
            return false;
        };
        setTimeout(load, 50);
        await modal({
            title: `Event history · ${ref.displayName}`,
            wide: true,
            body: h("div", { class: "stack", style: { gap: "10px" } },
                h("div", { class: "row wrap" }, field("Start", start), field("End", end), field("Order", order), field("Max events", max)),
                h("div", { class: "hint" }, "Leave Start or End empty for an open-ended read (forward from Start, or backward from End). The client follows continuation points until Max events, then releases the rest."),
                out),
            buttons: [{ label: "Read", class: "primary", onClick: load }, { label: "Close", value: null }]
        });
    }
};
