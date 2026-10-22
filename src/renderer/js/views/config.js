"use strict";
/* Server configuration form bound to App.project.server. */
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
            refreshEndpoint = () => { endpointLine.textContent = `Endpoint: opc.tcp://${cfg.hostname || "<hostname>"}:${cfg.port}${cfg.resourcePath || ""}`; };
            refreshEndpoint();
            root.appendChild(card("Endpoint", null,
                h("div", { class: "form-grid" },
                    field("Port", text("port", { type: "number", min: 1, max: 65535 }), "Default OPC UA port is 4840"),
                    field("Resource path", text("resourcePath", { class: "mono", placeholder: "/UA/Simulator" }), "Appended to the URL, may be empty"),
                    field("Hostname (optional)", text("hostname", { placeholder: "auto-detect" }), "Advertised host name in endpoint URLs")),
                endpointLine));

            const portState = h("span", { class: "port-state" });
            const autoStart = checkbox("Start the server automatically when the application opens", !!App.settings.autoStartServer,
                (v) => App.updateSettings({ autoStartServer: v }).then(() => toast(v ? "Server will start automatically on launch" : "Auto-start disabled", "success", 1800)));
            const net = App.meta.network || { addresses: [] };
            root.appendChild(card("Startup & Network", "How the simulator starts and how other machines reach it",
                autoStart,
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

            root.appendChild(card("Security", "Message security of the secure channel",
                h("div", null, h("div", { class: "section-title" }, "Security policies"),
                    h("div", { class: "checks" }, App.meta.securityPolicies.map((p) =>
                        listToggle("securityPolicies", p, ["Basic128Rsa15", "Basic256"].includes(p) ? `${p} (deprecated)` : p)))),
                h("div", null, h("div", { class: "section-title" }, "Message security modes"),
                    h("div", { class: "checks" }, App.meta.securityModes.map((m) => listToggle("securityModes", m)))),
                h("div", { class: "hint" }, "An endpoint is created for each combination of policy and mode. Policy None only pairs with mode None."),
                flag("autoAcceptCertificates", "Automatically trust unknown client certificates (convenient for testing; disable to test certificate rejection)")));

            const usersBody = h("tbody");
            (cfg.users || []).forEach((u, i) => {
                const name = h("input", { value: u.username });
                const pw = h("input", { value: u.password, type: "text" });
                name.addEventListener("input", () => { u.username = name.value; changed(); });
                pw.addEventListener("input", () => { u.password = pw.value; changed(); });
                const role = select(App.meta.roles, u.role);
                role.addEventListener("change", () => { u.role = role.value; changed(); });
                usersBody.appendChild(h("tr", null, h("td", null, name), h("td", null, pw), h("td", null, role),
                    h("td", { class: "actions" }, h("button", { class: "btn small", onclick: () => { cfg.users.splice(i, 1); changed(); render(); } }, "Remove"))));
            });
            root.appendChild(card("User Authentication", "UserIdentityTokens offered by every endpoint",
                h("div", { class: "checks" },
                    flag("allowAnonymous", "Anonymous"),
                    flag("allowUsername", "Username / password"),
                    flag("allowCertificate", "X509 certificate")),
                cfg.allowUsername ? h("div", null,
                    h("table", null, h("thead", null, h("tr", null, h("th", null, "Username"), h("th", null, "Password"), h("th", null, "Role"), h("th", null, ""))), usersBody),
                    h("button", { class: "btn small", style: { marginTop: "8px" }, onclick: () => { cfg.users = cfg.users || []; cfg.users.push({ username: `user${cfg.users.length + 1}`, password: "password", role: "Operator" }); changed(); render(); } }, "+ Add user")) : null,
                cfg.allowCertificate ? h("div", { class: "hint" }, "X509 user certificates are validated against the User PKI (see Certificates).") : null));

            root.appendChild(card("Limits & Capabilities", null,
                h("div", { class: "form-grid" },
                    field("Max sessions", text("maxSessions", { type: "number", min: 1 })),
                    field("Max subscriptions", text("maxSubscriptions", { type: "number", min: 1 })),
                    field("Max connections per endpoint", text("maxConnectionsPerEndpoint", { type: "number", min: 1 })),
                    field("Min supported sample rate (ms)", text("minSupportedSampleRate", { type: "number", min: 0 }))),
                flag("isAuditing", "Enable auditing (Server.Auditing = true, audit events are generated)")));

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
                cfg.registerToLds ? field("LDS endpoint URL", text("ldsUrl", { class: "mono" })) : null,
                flag("runDiscoveryServer", "Run a built-in Local Discovery Server"),
                cfg.runDiscoveryServer ? field("Discovery server port", text("discoveryServerPort", { type: "number" }), "Must differ from the server port; standard LDS port is 4840") : null));
        };
        render();
        return App.on("project-changed", render);
    }
};
