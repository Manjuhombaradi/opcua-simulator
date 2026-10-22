"use strict";
/* Server configuration form bound to App.project.server. */
const HISTORY_SIZE_DEFAULT = 100000; // values per variable / events per object (project.js, historyStore.js)
const HISTORY_SIZE_MAX = 1000000;
const Config = {
    mount(view) {
        const changed = () => App.markDirty();
        const root = h("div", { class: "stack", style: { maxWidth: "1100px" } });
        view.appendChild(root);
        // App.project.server is re-read on every render: Restore defaults, the port dialog or the wizard may change it
        let cfg = App.project.server;
        let refreshEndpoint = () => {};

        const text = (key, attrs = {}) => {
            const el = h("input", { value: cfg[key] ?? "", ...attrs });
            el.addEventListener("input", () => { cfg[key] = attrs.type === "number" ? Number(el.value) : el.value; changed(); refreshEndpoint(); });
            return el;
        };
        const flag = (key, label) => checkbox(label, !!cfg[key], (v) => { cfg[key] = v; changed(); render(); });
        const listToggle = (key, item, label) => checkbox(label || item, (cfg[key] || []).includes(item), (v) => {
            const set = new Set(cfg[key] || []);
            v ? set.add(item) : set.delete(item);
            cfg[key] = [...set];
            changed();
        });
        const card = (title, sub, ...body) => h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, title), sub ? h("span", { class: "muted small" }, sub) : null),
            h("div", { class: "card-body stack" }, ...body));

        const render = () => {
            cfg = App.project.server;
            clear(root);
            const running = App.serverStatus.state === "running";
            root.appendChild(h("div", { class: "row wrap" },
                running ? h("div", { class: "badge warn", style: { padding: "8px 12px", fontSize: "12px" } }, "Server is running. Changes are applied on the next (re)start.")
                    : h("div", { class: "muted" }, "Changes are kept automatically on this computer and used on the next server start; use Save to update the project file."),
                h("span", { class: "spacer" }),
                running ? h("button", { class: "btn primary", onclick: () => App.restartServer() }, "↻ Restart server now") : null,
                h("button", { class: "btn", onclick: async () => {
                    if (!(await confirmDialog("Restore defaults", "Reset all server settings (port, security, users, limits, models, discovery) to their defaults? The address space is not changed.", "Restore defaults", true))) return;
                    // keep the object (and the project file link): copy fresh defaults into it
                    const fresh = await attempt(() => api.app("defaultServerSettings"));
                    if (!fresh) return;
                    Object.assign(App.project.server, fresh);
                    changed();
                    render();
                    toast("Server settings restored to defaults", "success");
                } }, "Restore defaults")));

            const projectName = h("input", { value: App.project.name || "" });
            projectName.addEventListener("input", () => { App.project.name = projectName.value; changed(); App.refreshChrome(); });

            root.appendChild(card("General", null,
                h("div", { class: "form-grid" },
                    field("Project name", projectName),
                    field("Application name", text("applicationName")),
                    field("Application URI", text("applicationUri", { class: "mono" }), "Must match the URI in the server certificate"),
                    field("Product URI", text("productUri", { class: "mono" })),
                    field("Manufacturer", text("manufacturerName")),
                    field("Product name", text("productName")),
                    field("Software version", text("softwareVersion")))));

            const endpointLine = h("div", { class: "muted small" });
            refreshEndpoint = () => {
                const host = cfg.listenAddress === "localhost" ? "localhost" : cfg.hostname || "<hostname>";
                endpointLine.textContent = `Endpoint: opc.tcp://${host}:${cfg.port}${cfg.resourcePath || ""}`;
            };
            refreshEndpoint();
            root.appendChild(card("Endpoint", null,
                h("div", { class: "form-grid" },
                    field("Port", text("port", { type: "number", min: 1, max: 65535 }), "Default OPC UA port is 4840"),
                    field("Resource path", text("resourcePath", { class: "mono", placeholder: "/UA/Simulator" }), "Appended to the URL, may be empty"),
                    field("Hostname (optional)", text("hostname", { placeholder: "auto-detect" }), "Advertised host name in endpoint URLs")),
                endpointLine));

            const portState = h("span", { class: "port-state" });
            const listen = select([
                { value: "all", label: "All network interfaces — other machines can connect" },
                { value: "localhost", label: "This computer only (localhost)" }
            ], cfg.listenAddress === "localhost" ? "localhost" : "all");
            listen.addEventListener("change", () => { cfg.listenAddress = listen.value; changed(); render(); });
            const localOnly = cfg.listenAddress === "localhost";
            const autoStart = checkbox("Start the server automatically when the application opens", !!App.settings.autoStartServer,
                (v) => App.updateSettings({ autoStartServer: v }).then(() => toast(v ? "Server will start automatically on launch" : "Auto-start disabled", "success", 1800)));
            const net = App.meta.network || { addresses: [] };
            root.appendChild(card("Startup & Network", "How the simulator starts and how other machines reach it",
                autoStart,
                h("div", { class: "form-grid two" }, field("Listen on", listen, localOnly
                    ? "Only programs on this computer can connect (opc.tcp://localhost). Endpoint URLs use localhost; the IP and host name settings below are not used."
                    : "The server accepts connections on every network interface: anyone who can reach the port can connect. Use “This computer only” when only local programs need it.")),
                h("div", { class: "row wrap" },
                    h("button", { class: "btn small", onclick: async () => {
                        const r = await api.app("checkPort", cfg.port, App.reservedPorts(cfg));
                        clear(portState);
                        if (running && Number(App.serverStatus.port) === Number(cfg.port)) { portState.className = "port-state ok"; portState.textContent = "✓ used by this simulator"; return; }
                        portState.className = `port-state ${r.free ? "ok" : "bad"}`;
                        portState.appendChild(h("span", null, r.free ? `✓ Port ${cfg.port} is free` : `✗ ${r.message}`));
                        if (!r.free && r.suggestedPort) portState.appendChild(h("button", { class: "btn small", onclick: () => { cfg.port = r.suggestedPort; changed(); render(); } }, `Use ${r.suggestedPort}`));
                    } }, "Check port"), portState),
                flag("advertiseIpAddresses", `Advertise IP addresses in endpoint URLs (recommended for VMs) — ${net.addresses.join(", ") || "no network address found"}`),
                field("Extra host names / IPs (optional)", text("alternateHostnames", { class: "mono", placeholder: "e.g. my-vm.local, 10.0.0.5, public-host.example.com" }),
                    "Comma separated. Use for NAT / port forwarding / DNS names so clients get reachable endpoint URLs."),
                field("Advertised endpoint URLs (NAT / port forwarding / Docker)", text("advertisedUrls", { class: "mono", placeholder: `e.g. opc.tcp://203.0.113.5:${cfg.port}, opc.tcp://docker-host:14840` }),
                    "Comma separated opc.tcp:// URLs. Use when clients reach the server through a different host or port than it listens on (port forwarding, docker run -p 14840:4840); these URLs are returned in GetEndpoints."),
                h("div", { class: "hint" }, "After changing host names, regenerate the server certificate (Certificates) so it matches the new names.")));

            const secure = matchesSecurePreset(cfg);
            root.appendChild(card("Security", "Message security of the secure channel",
                h("div", { class: `notice ${secure ? "good" : ""}` },
                    h("div", { class: "row wrap" },
                        h("div", { style: { flex: 1, minWidth: "260px" } },
                            h("b", null, secure ? "The secure preset for organisations is active." : "Secure preset for organisations"),
                            h("div", { class: "small" }, secure
                                ? "Encrypted endpoints only, no anonymous login, unknown client certificates are rejected, discovery is off."
                                : "One click to settings suitable outside a test lab: encrypted endpoints only, no anonymous login, unknown client certificates rejected, no discovery.")),
                        secure ? null : h("button", { class: "btn primary small", onclick: () => this.applySecure(changed, render) }, "Apply secure settings…"))),
                h("div", null, h("div", { class: "section-title" }, "Security policies"),
                    h("div", { class: "checks" }, App.meta.securityPolicies.map((p) =>
                        listToggle("securityPolicies", p, ["Basic128Rsa15", "Basic256"].includes(p) ? `${p} (deprecated)` : p)))),
                h("div", null, h("div", { class: "section-title" }, "Message security modes"),
                    h("div", { class: "checks" }, App.meta.securityModes.map((m) => listToggle("securityModes", m)))),
                h("div", { class: "hint" }, "An endpoint is created for each combination of policy and mode. Policy None only pairs with mode None."),
                flag("autoAcceptCertificates", "Automatically trust unknown client application certificates (convenient for testing; disable to test certificate rejection)"),
                h("div", { class: "hint" }, cfg.autoAcceptCertificates
                    ? "Any client can then open a signed / encrypted connection without you trusting it first. X509 user certificates (log-in) are never trusted automatically."
                    : "Unknown client certificates are refused and listed in Certificates → Server application PKI → Rejected, where you can trust them. X509 user certificates are never trusted automatically.")));

            const usersBody = h("tbody");
            (cfg.users || []).forEach((u, i) => {
                const name = h("input", { value: u.username });
                name.addEventListener("input", () => { u.username = name.value; changed(); refreshDemoHint(); });
                const pw = passwordInput(u.password, (v) => { u.password = v; changed(); refreshDemoHint(); });
                const role = select(App.meta.roles, u.role);
                role.addEventListener("change", () => { u.role = role.value; changed(); });
                usersBody.appendChild(h("tr", null, h("td", null, name), h("td", null, pw), h("td", null, role),
                    h("td", { class: "actions" }, h("button", { class: "btn small", onclick: () => { cfg.users.splice(i, 1); changed(); render(); } }, "Remove"))));
            });
            // the well-known demo log-ins (admin/admin, ...) are fine in a lab, not on a reachable network
            const demoHint = h("div", { class: "notice warn" });
            const refreshDemoHint = () => {
                const demo = (cfg.users || []).filter(isDemoLogin);
                clear(demoHint);
                demoHint.classList.toggle("hidden", !cfg.allowUsername || !demo.length);
                if (!demo.length) return;
                demoHint.appendChild(h("div", { class: "row wrap" },
                    h("div", { style: { flex: 1, minWidth: "260px" } },
                        `${demo.map((u) => `${u.username}/${u.password}`).join(", ")}: demo log-in${demo.length > 1 ? "s" : ""} that everybody knows. Fine for a test lab — change the password${demo.length > 1 ? "s" : ""} before other machines can reach this server.`),
                    h("button", { class: "btn small", onclick: () => {
                        for (const u of cfg.users || []) if (isDemoLogin(u)) u.password = randomPassword();
                        changed();
                        render();
                        toast("Random passwords set. Use the eye button to see them; clients need the new passwords.", "success", 6000);
                    } }, "Set random passwords")));
            };
            refreshDemoHint();
            const anonAccess = select([
                { value: "readwrite", label: "Read, write and call methods" },
                { value: "readonly", label: "Only read" }
            ], cfg.anonymousAccess === "readonly" ? "readonly" : "readwrite");
            anonAccess.addEventListener("change", () => { cfg.anonymousAccess = anonAccess.value; changed(); });
            root.appendChild(card("User Authentication", "UserIdentityTokens offered by every endpoint",
                h("div", { class: "checks" },
                    flag("allowAnonymous", "Anonymous"),
                    flag("allowUsername", "Username / password"),
                    flag("allowCertificate", "X509 certificate")),
                cfg.allowAnonymous ? h("div", { class: "form-grid" },
                    field("Anonymous users can", anonAccess, "Clients that connect without logging in.")) : null,
                cfg.allowUsername ? h("div", null,
                    h("table", null, h("thead", null, h("tr", null, h("th", null, "Username"), h("th", null, "Password"), h("th", null, "Role"), h("th", null, ""))), usersBody),
                    h("button", { class: "btn small", style: { marginTop: "8px" }, onclick: () => {
                        cfg.users = cfg.users || [];
                        cfg.users.push({ username: `user${cfg.users.length + 1}`, password: randomPassword(), role: "Operator" });
                        changed();
                        render();
                        toast("New user with a random password — use the eye button to see it, or type your own.", "info", 5000);
                    } }, "+ Add user")) : null,
                cfg.allowUsername ? demoHint : null,
                h("div", { class: "hint" }, "Roles: Observer can only read. Operator, Engineer, Supervisor, ConfigureAdmin and SecurityAdmin can read, write values and call methods. ",
                    "X509 users without a role can read and write values."),
                cfg.allowCertificate ? h("div", { class: "hint" }, "X509 user certificates are checked against the User PKI and are never trusted automatically: a refused certificate appears in Certificates → User certificates → Rejected, where you can trust it.") : null));

            root.appendChild(card("Limits & Capabilities", null,
                h("div", { class: "form-grid" },
                    field("Max sessions", text("maxSessions", { type: "number", min: 1 })),
                    field("Max subscriptions", text("maxSubscriptions", { type: "number", min: 1 })),
                    field("Max connections per endpoint", text("maxConnectionsPerEndpoint", { type: "number", min: 1 })),
                    field("Min supported sample rate (ms)", text("minSupportedSampleRate", { type: "number", min: 0 }))),
                flag("isAuditing", "Enable auditing (Server.Auditing = true, audit events are generated)")));

            root.appendChild(this.historyCard(cfg, changed));

            const nodesetList = h("div", { class: "stack", style: { gap: "6px" } });
            (cfg.customNodesetFiles || []).forEach((f, i) => nodesetList.appendChild(h("div", { class: "row" },
                h("span", { class: "code ellipsis", style: { flex: 1 } }, f),
                h("button", { class: "btn small", onclick: () => { cfg.customNodesetFiles.splice(i, 1); changed(); render(); } }, "Remove"))));
            root.appendChild(card("Namespaces & Information Models", "Loaded on start, in dependency order",
                field("Simulation namespace URI", text("namespaceUri", { class: "mono" }), "Namespace for the nodes of the Address Space designer"),
                h("div", null, h("div", { class: "section-title" }, "Companion specifications (bundled)"),
                    h("div", { class: "checks" }, App.meta.nodesets.map((k) => {
                        const deps = App.meta.nodesetDependencies[k] || [];
                        return h("span", { title: deps.length ? `Also loads: ${deps.join(", ")}` : "" }, listToggle("companionNodesets", k));
                    }))),
                h("div", { class: "hint" }, "Required dependencies (e.g. DI for Machinery) are added automatically. Large models increase start-up time."),
                h("div", null, h("div", { class: "section-title" }, "Custom NodeSet2 XML files"), nodesetList,
                    h("button", { class: "btn small", style: { marginTop: "8px" }, onclick: async () => {
                        const f = await api.app("pickFile", "Select NodeSet2 XML", [{ name: "NodeSet2 XML", extensions: ["xml"] }]);
                        if (f) { cfg.customNodesetFiles = [...(cfg.customNodesetFiles || []), f]; changed(); render(); }
                    } }, "+ Add NodeSet2 file"))));

            root.appendChild(card("Discovery", null,
                flag("registerToLds", "Register this server with a Local Discovery Server (RegisterServer2)"),
                cfg.registerToLds ? field("LDS endpoint URL", text("ldsUrl", { class: "mono" }),
                    "On start the server connects to this URL and sends its description (application URI, host names and IP addresses).") : null,
                flag("runDiscoveryServer", "Run a built-in Local Discovery Server"),
                cfg.runDiscoveryServer ? field("Discovery server port", text("discoveryServerPort", { type: "number" }),
                    "Must differ from the server port; standard LDS port is 4840. Registered servers are announced on the local network (multicast DNS).") : null));
        };
        render();
        const off = App.on("project-changed", render);
        // the database grows while the server records: refresh its size now and then
        const timer = setInterval(() => this.refreshHistoryStats(), 5000);
        return () => { off(); clearInterval(timer); this.historyStatsEl = null; };
    },

    // ------------------------------------------------------------ history (saved on this computer)
    historyCard(cfg, changed) {
        // 0 = off, any whole number up to 1 000 000; projects from older versions have no value yet (default 100 000).
        // A value is only taken on "change" (Enter / leaving the field), so typing "1500" or "0.5" key by key never
        // saves an intermediate value or switches history off. Only an explicit 0 switches it off: an empty field,
        // text, a fraction or a negative number is not taken (the last valid limit stays and is written back).
        const presets = h("datalist", { id: "history-size-presets" }, [1000, 10000, 100000, 1000000].map((v) => h("option", { value: v }, v.toLocaleString())));
        const limitInput = (key) => {
            const el = h("input", { type: "number", min: 0, max: HISTORY_SIZE_MAX, step: 1, list: "history-size-presets", placeholder: "e.g. 1000", value: cfg[key] ?? HISTORY_SIZE_DEFAULT });
            const parse = () => {
                const text = el.value.trim(); // "" also for text a number field cannot hold
                const n = Number(text);
                if (text === "" || !Number.isInteger(n) || n < 0 || n > HISTORY_SIZE_MAX) return null;
                return n;
            };
            let busy = false; // a confirmation or the apply call is open: a further "change" (focus moving) is not a new value
            el.addEventListener("change", async () => {
                if (busy) return;
                const n = parse();
                const current = cfg[key] ?? HISTORY_SIZE_DEFAULT;
                if (n === null) {
                    toast(`Enter a whole number from 0 (off) to ${HISTORY_SIZE_MAX.toLocaleString()}, e.g. 1000`, "warn");
                    el.value = current;
                } else if (n !== current) {
                    busy = true;
                    try { await this.applyHistoryLimit(cfg, key, n, el, changed); } finally { busy = false; }
                } else el.value = current;
            });
            return el;
        };
        this.historyStatsEl = h("div", { class: "kv card", style: { boxShadow: "none" } });
        const clearButton = (what) => h("button", { class: "btn small", onclick: () => this.clearHistoryDialog(what) }, icon("trash"), what === "values" ? "Clear all value history…" : "Clear all event history…");
        const card = h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, "History"), h("span", { class: "muted small" }, "Values and events for HistoryRead, saved on this computer")),
            h("div", { class: "card-body stack" },
                presets,
                h("div", { class: "form-grid" },
                    field("Values kept per variable", limitInput("valueHistorySize"), "For each variable with “Historizing”. The oldest values are removed beyond this. Any whole number, e.g. 1000; 0 = off, at most 1 000 000."),
                    field("Events kept per object", limitInput("eventHistorySize"), "For the Server object and each folder / object (event notifier). The oldest events are removed beyond this. 0 = off, at most 1 000 000.")),
                h("div", { class: "hint" }, "History is kept in a database file in the data folder, not in the project file, and survives restarts of the server and of the application. It is only deleted when you clear it here, in Live Values (one variable), in Alarms & Events, with the headless option --clear-history, or when you lower a limit. ",
                    "A new limit applies at once while the server runs (a lower one deletes the oldest values beyond it); otherwise on the next server start."),
                this.historyStatsEl,
                h("div", { class: "row wrap" }, clearButton("values"), clearButton("events"),
                    h("button", { class: "btn small", onclick: () => this.refreshHistoryStats() }, "↻ Refresh"),
                    h("button", { class: "btn small", title: "Show the history database in the file manager", onclick: async () => {
                        const stats = await attempt(() => api.server("getHistoryStats"));
                        if (stats?.file) attempt(() => api.app("showItem", stats.file));
                    } }, icon("folder"), "Show database file"))));
        this.refreshHistoryStats();
        return card;
    },

    // A new history limit from the field: a lower one that deletes stored entries is confirmed first; while the server
    // runs it is applied at once (ServerEngine.setHistoryLimits), otherwise on the next start.
    async applyHistoryLimit(cfg, key, n, el, changed) {
        const values = key === "valueHistorySize";
        const unit = values ? "values per variable" : "events per object";
        const current = cfg[key] ?? HISTORY_SIZE_DEFAULT;
        const running = App.serverStatus.state === "running";
        if (n > 0 && (current === 0 || n < current)) {
            // the most entries of one variable / object when the store reports it, else all of them (an upper bound)
            const stats = await api.server("getHistoryStats").catch(() => null);
            const most = values ? stats?.maxValuesPerVariable ?? stats?.values : stats?.maxEventsPerNotifier ?? stats?.events;
            if (Number(most) > n) {
                const ok = await confirmDialog("Lower the history limit",
                    h("div", { class: "stack", style: { gap: "8px" } },
                        h("div", null, `Keep only the newest ${n.toLocaleString()} ${unit}? Older ${values ? "values" : "events"} are deleted.`),
                        h("div", { class: "muted small" }, running
                            ? "This cannot be undone. OPC UA clients can then no longer read the deleted entries with HistoryRead."
                            : "They are deleted when the server starts next. This cannot be undone.")),
                    "Lower the limit", true);
                if (!ok) { el.value = cfg[key] ?? HISTORY_SIZE_DEFAULT; return; }
            }
        }
        const restartPending = App.changedSinceStart;
        cfg[key] = n;
        el.value = n;
        changed();
        const what = n === 0 ? `${values ? "Value" : "Event"} history off` : `History limit set to ${n.toLocaleString()} ${unit}`;
        if (!running) {
            toast(`${what}: applies on the next server start`, "success");
            this.refreshHistoryStats();
            return;
        }
        let r;
        try {
            r = await api.server("setHistoryLimits", {
                valueHistorySize: cfg.valueHistorySize ?? HISTORY_SIZE_DEFAULT,
                eventHistorySize: cfg.eventHistorySize ?? HISTORY_SIZE_DEFAULT
            });
        } catch (err) {
            toast(`${what}: applies on the next server start (${err.message})`, "warn", 6000);
            this.refreshHistoryStats();
            return;
        }
        if (r?.restartRequired) toast(`${what}: applies on the next server start`, "info", 5000);
        else {
            // applied to the running server: no restart needed for it
            App.changedSinceStart = restartPending;
            App.refreshChrome();
            toast(n === 0
                ? `History limit applied: no new ${values ? "values" : "events"} are recorded (saved ones are kept)`
                : `History limit applied: keeps ${n.toLocaleString()} ${unit}${n < current ? ` (older ${values ? "values" : "events"} removed)` : ""}`, "success", 5000);
        }
        this.refreshHistoryStats(r?.stats);
    },

    async refreshHistoryStats(given) {
        const el = this.historyStatsEl;
        if (!el) return;
        let stats = given || null, error = null;
        if (!stats) {
            try { stats = await api.server("getHistoryStats"); } catch (err) { error = err.message; }
        }
        if (this.historyStatsEl !== el) return;
        const n = (x) => (x === undefined || x === null ? "—" : Number(x).toLocaleString());
        clear(el);
        if (!stats) {
            el.appendChild(h("div", null, "Database"));
            el.appendChild(h("div", null, error ? `not available (${error})` : "—"));
            return;
        }
        if (stats.error) {
            const running = App.serverStatus.state === "running";
            // inMemory: the running server keeps this run's value history in memory only and records no events (event
            // history needs the database); otherwise it recorded into the file, which now fails, so new entries are
            // lost. While stopped the next start falls back to memory.
            const effect = !running ? "When the server starts, it keeps the value history of that run in memory only (lost when it stops); events are not recorded."
                : stats.inMemory ? "The running server keeps its value history in memory only until it stops; events are not recorded."
                    : "New values and events are not saved.";
            el.append(h("div", null, "Problem"), h("div", { style: { color: "var(--bad)" } },
                `The history database cannot be used (${stats.error}). ${effect}${stats.hint ? ` ${stats.hint}` : ""}`));
        }
        // with a problem the counts are those of the database file, not what the running server holds in memory
        const inFile = stats.error ? " in the file" : "";
        el.append(
            h("div", null, "Database file"), h("div", null, stats.file || "—"),
            h("div", null, "Size on disk"), h("div", null, fmtBytes(stats.sizeBytes)),
            h("div", null, `Saved values${inFile}`), h("div", null, n(stats.values)),
            h("div", null, `Saved events${inFile}`), h("div", null, n(stats.events)));
        if (stats.error && stats.inMemory && App.serverStatus.state === "running") {
            el.append(h("div", null, "Values in memory"), h("div", { class: "muted" }, "kept by the running server, not counted here; lost when it stops"));
        }
        if (stats.pending) el.append(h("div", null, "Waiting to be saved"), h("div", null, `${n(stats.pending)} (another program holds the database lock)`));
    },

    async clearHistoryDialog(what) {
        const values = what === "values";
        const ok = await confirmDialog(values ? "Clear all value history" : "Clear all event history",
            h("div", { class: "stack", style: { gap: "8px" } },
                h("div", null, values
                    ? "Delete the saved values of every historizing variable from the history database on this computer?"
                    : "Delete every saved event (Server object, folders and objects) from the history database on this computer?"),
                h("div", { class: "muted small" }, `This cannot be undone. OPC UA clients can then no longer read ${values ? "these values" : "these events"} with HistoryRead. While the server runs, new ${values ? "values" : "events"} are recorded again.`)),
            values ? "Clear all value history" : "Clear all event history", true);
        if (!ok) return;
        const r = await attempt(() => api.server(values ? "clearHistory" : "clearEventHistory", { all: true }));
        if (r?.replaced) toast("The damaged history database was replaced by a new, empty one: all saved values and all saved events were removed", "warn", 8000);
        else if (r) toast(values ? "All value history cleared" : "All event history cleared", "success");
        this.refreshHistoryStats(r);
    },

    async applySecure(changed, render) {
        const ok = await confirmDialog("Apply secure settings",
            h("div", { class: "stack", style: { gap: "10px" } },
                h("div", null, "These settings are changed:"),
                h("ul", { style: { margin: 0, paddingLeft: "20px" } }, SECURE_PRESET_TEXT.map((t) => h("li", null, t))),
                h("div", { class: "muted small" }, "Clients that used SecurityPolicy None or anonymous login must then use an encrypted endpoint and log in. Also consider “Listen on: This computer only” and changing demo passwords. Applied on the next server (re)start.")),
            "Apply secure settings");
        if (!ok) return;
        applySecurePreset(App.project.server);
        changed();
        render();
        toast("Secure settings applied — restart the server to use them", "success");
    }
};
