"use strict";
/* Dashboard: server status, endpoints, sessions and diagnostics. */
const Dashboard = {
    mount(view) {
        const root = h("div", { class: "stack" });
        view.appendChild(root);
        // skip refreshes while the user is interacting with a control on the page
        const render = () => { if (!root.contains(document.activeElement) || document.activeElement.tagName === "BUTTON") this.render(root, App.serverStatus); };
        render();
        const poll = async () => {
            if (App.serverStatus.state === "running") {
                try { App.serverStatus = await api.server("getStatus"); } catch (_) { /* ignore */ }
            }
            render();
        };
        const timer = setInterval(poll, 2000);
        const offs = [App.on("server-status", render), App.on("start-busy", render), App.on("project-changed", render)];
        return () => { clearInterval(timer); offs.forEach((off) => off()); };
    },

    render(root, st) {
        clear(root);
        const cfg = App.project.server;
        const running = st.state === "running";

        // ---- hero
        const uptime = st.startTime ? fmtDuration(Date.now() - new Date(st.startTime).getTime()) : "—";
        root.appendChild(h("div", { class: "card" },
            h("div", { class: "card-body row wrap", style: { gap: "24px" } },
                h("div", { class: "stack", style: { gap: "4px", flex: "1", minWidth: "280px" } },
                    h("div", { class: "row" },
                        h("div", { class: `pill ${st.state}` }, h("span", { class: "dot" }), h("span", null, (st.state || "").toUpperCase())),
                        running && st.serverState ? h("span", { class: `badge ${st.serverState === "Running" ? "good" : "warn"}` }, `ServerState: ${st.serverState}`) : null,
                        running && st.simulationPaused ? h("span", { class: "badge warn" }, "Simulation paused") : null,
                        App.changedSinceStart && running ? h("span", { class: "badge warn" }, "Configuration changed — restart to apply") : null),
                    h("div", { style: { fontSize: "18px", fontWeight: 600, marginTop: "6px" } }, cfg.applicationName),
                    h("div", { class: "muted" }, cfg.applicationUri),
                    st.error ? h("div", { class: "badge bad", style: { marginTop: "6px", whiteSpace: "normal" } }, st.error) : null),
                h("div", { class: "stack", style: { gap: "6px" } },
                    h("div", { class: "muted small" }, "Uptime"),
                    h("div", { style: { fontSize: "20px", fontWeight: 600 } }, uptime)),
                h("div", { class: "btn-group" },
                    running
                        ? [h("button", { class: "btn danger", onclick: () => App.stopServer() }, "■ Stop"),
                            h("button", { class: "btn", onclick: () => App.restartServer() }, "↻ Restart"),
                            h("button", { class: "btn", onclick: () => this.shutdownDialog() }, "Shutdown with delay…")]
                        : h("button", { class: "btn primary", disabled: st.state === "starting" || !!App.starting, onclick: (e) => { e.currentTarget.disabled = true; App.startServer(); } }, "▶ Start Server"),
                    h("button", { class: "btn", onclick: () => App.navigate("config") }, "⚙ Configure")))));

        // ---- quick start (stopped)
        if (!running) {
            const step = (n, title, text) => h("div", { class: "card" }, h("div", { class: "card-body" },
                h("span", { class: "step-num" }, n), h("div", null, h("div", { style: { fontWeight: 600 } }, title), h("div", { class: "muted small" }, text))));
            root.appendChild(h("div", { class: "steps" },
                step("1", "Start the server", App.settings.autoStartServer ? "Press ▶ Start Server." : "Press ▶ Start Server. Enable auto-start in Configuration to skip this step next time."),
                step("2", "Copy an endpoint URL", "Shown below once running — use the IP address URL from other machines or VMs."),
                step("3", "Connect your client", `Log in with: ${loginSummary(cfg)}. Or try the built-in Client.`)));
            root.appendChild(h("div", { class: "card" }, h("div", { class: "card-body row wrap" },
                h("div", { style: { flex: 1, minWidth: "260px" } },
                    h("div", { style: { fontWeight: 600 } }, `Project “${App.project.name}” · port ${cfg.port}`),
                    h("div", { class: "muted small" },
                        `Security: ${cfg.securityPolicies.join(", ")} · Modes: ${cfg.securityModes.join(", ")} · Users: ${[cfg.allowAnonymous && "Anonymous", cfg.allowUsername && "Username", cfg.allowCertificate && "X509"].filter(Boolean).join(", ")}`)),
                h("button", { class: "btn", onclick: () => App.menu("new") }, "Choose another template…"),
                h("button", { class: "btn", onclick: () => App.navigate("help") }, "? Help"))));
            return;
        }

        // ---- endpoints (running)
        const urls = st.endpointUrls || [];
        const isIp = (u) => /^opc\.tcp:\/\/\d+\.\d+\.\d+\.\d+[:/]/.test(u);
        const local = App.localEndpointUrl();
        const remote = urls.filter(isIp);
        const named = urls.filter((u) => !isIp(u) && u !== local);
        const urlRow = (u, note) => h("div", { class: "endpoint-row" },
            h("span", { class: "code", style: { cursor: "pointer" }, title: "Click to copy", onclick: () => copyText(u) }, u),
            note ? h("span", { class: "muted small" }, note) : null,
            h("span", { class: "spacer" }),
            h("button", { class: "btn small", onclick: () => copyText(u) }, "Copy"),
            h("button", { class: "btn small", onclick: () => { App.clientPrefillUrl = u; App.navigate("client"); } }, "Open in Client"));
        root.appendChild(h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, "Connect your OPC UA client"),
                h("span", { class: "muted small" }, `Login: ${loginSummary(cfg)}`)),
            h("div", { class: "card-body" },
                h("div", { class: "section-title" }, "From this machine"),
                urlRow(local),
                h("div", { class: "section-title", style: { marginTop: "12px" } }, "From other machines / VMs"),
                remote.length ? remote.map((u) => urlRow(u)) : h("div", { class: "muted small" }, cfg.advertiseIpAddresses
                    ? "No IPv4 network address found on this machine — check the network adapter of the VM, or add a host name / advertised URL in Configuration."
                    : "No network address advertised (enable “Advertise IP addresses” in Configuration)."),
                named.map((u) => urlRow(u, "host name — works where it resolves via DNS")),
                h("div", { class: "hint", style: { marginTop: "8px" } }, `Allow TCP port ${App.servedPort()} in the firewall of this machine for remote clients. See Help for VM network tips.`))));

        // ---- stats
        const d = st.diagnostics || {};
        const stat = (label, value) => h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value ?? "—"));
        root.appendChild(h("div", { class: "stats" },
            stat("Sessions", d.currentSessionCount),
            stat("Subscriptions", d.currentSubscriptionCount),
            stat("Total sessions", d.cumulatedSessionCount),
            stat("Total subscriptions", d.cumulatedSubscriptionCount),
            stat("Rejected sessions", d.rejectedSessionCount),
            stat("Security rejected", d.securityRejectedSessionCount),
            stat("Session timeouts", d.sessionTimeoutCount),
            stat("Rejected requests", d.rejectedRequestsCount)));

        // ---- server state & sessions
        const stateSel = select(["Running", "Failed", "NoConfiguration", "Suspended", "Shutdown", "Test", "CommunicationFault", "Unknown"], st.serverState || "Running");
        root.appendChild(h("div", { class: "grid-2" },
            h("div", { class: "card" },
                h("div", { class: "card-head" }, h("h2", null, "Server Behaviour")),
                h("div", { class: "card-body stack" },
                    h("div", { class: "row" }, field("ServerStatus / State", stateSel, "Simulate server states reported in Server_ServerStatus_State"),
                        h("button", { class: "btn", style: { alignSelf: "center" }, onclick: () => attempt(() => api.server("setServerState", stateSel.value), `State set to ${stateSel.value}`) }, "Apply")),
                    h("div", { class: "row" },
                        h("button", { class: "btn", onclick: () => attempt(() => api.server("setPaused", "*", !st.simulationPaused)).then(() => api.server("getStatus").then((s) => { App.serverStatus = s; this.render(root, s); })) },
                            st.simulationPaused ? "▶ Resume all simulations" : [icon("pause"), "Pause all simulations"]),
                        h("button", { class: "btn", onclick: () => App.menu("exportNodeset") }, "Export NodeSet2 XML")),
                    st.discoveryServer ? h("div", { class: "badge info" }, `Local Discovery Server running on port ${cfg.discoveryServerPort}`) : null)),
            h("div", { class: "card" },
                h("div", { class: "card-head" }, h("h2", null, `Endpoints (${st.endpoints.length})`)),
                h("div", { class: "card-body flush table-wrap", style: { maxHeight: "240px" } },
                    h("table", null,
                        h("thead", null, h("tr", null, h("th", null, "Security Policy"), h("th", null, "Mode"), h("th", null, "Level"), h("th", null, "User tokens"))),
                        h("tbody", null, st.endpoints.map((e) => h("tr", null,
                            h("td", null, e.securityPolicy), h("td", null, e.securityMode), h("td", { class: "num" }, e.securityLevel),
                            h("td", null, [...new Set(e.userTokens)].join(", "))))))))));

        root.appendChild(h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h2", null, `Sessions (${st.sessions.length})`)),
            h("div", { class: "card-body flush table-wrap" },
                st.sessions.length === 0 ? h("div", { class: "empty" }, "No clients connected") :
                    h("table", null,
                        h("thead", null, h("tr", null, ["Session", "Client", "Remote", "Security", "User", "Subscriptions", "Created", ""].map((x) => h("th", null, x)))),
                        h("tbody", null, st.sessions.map((s) => h("tr", null,
                            h("td", null, s.name),
                            h("td", { title: s.clientUri }, s.client),
                            h("td", { class: "mono" }, s.remote),
                            h("td", null, `${s.securityPolicy} / ${s.securityMode}`),
                            h("td", null, s.user || "Anonymous"),
                            h("td", { class: "num" }, s.subscriptions),
                            h("td", null, fmtTime(s.created)),
                            h("td", { class: "actions" }, h("button", { class: "btn small", onclick: () => attempt(() => api.server("closeSession", s.id), "Session closed") }, "Close")))))))));
    },

    async shutdownDialog() {
        const input = h("input", { type: "number", value: 10, min: 0 });
        const ok = await modal({
            title: "Shutdown with delay",
            body: h("div", { class: "stack" },
                h("div", null, "The server announces the shutdown (ServerStatus.SecondsTillShutdown and ShutdownReason) and then stops. Useful to test client reconnection handling."),
                field("Delay (seconds)", input)),
            buttons: [{ label: "Cancel", value: false }, { label: "Shutdown", class: "danger", value: true }]
        });
        if (ok) App.stopServer(Number(input.value) * 1000);
    }
};
