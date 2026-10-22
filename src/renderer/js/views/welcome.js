"use strict";
/* First-run welcome / "New project" wizard: template, port, security preset, network access, auto-start. */
const SECURITY_PRESETS = {
    all: {
        label: "Recommended — unsecured and encrypted endpoints",
        desc: "Clients can connect with SecurityPolicy None or Basic256Sha256 / Aes128 / Aes256 (Sign, SignAndEncrypt).",
        policies: ["None", "Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss"], modes: ["None", "Sign", "SignAndEncrypt"]
    },
    none: {
        label: "No security — quickest to connect",
        desc: "Only SecurityPolicy None. No certificates involved; good for first tests.",
        policies: ["None"], modes: ["None"]
    },
    secure: {
        label: "Encrypted only",
        desc: "Only signed / encrypted endpoints, to test certificate handling of your client.",
        policies: ["Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss"], modes: ["Sign", "SignAndEncrypt"]
    },
    // applies the engine's SECURE_PRESET (more than policies and modes, see applySecurePreset)
    org: {
        label: "Secure (for organisations)",
        desc: "Encrypted endpoints only, no anonymous login, unknown client certificates are rejected until you trust them (Certificates), no discovery registration. Clients log in with a user name and password or an X509 certificate.",
        policies: null, modes: null
    }
};

function detectSecurityPreset(cfg) {
    if (matchesSecurePreset(cfg)) return "org";
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    for (const [key, p] of Object.entries(SECURITY_PRESETS)) {
        if (p.policies && same(cfg.securityPolicies || [], p.policies) && same(cfg.securityModes || [], p.modes)) return key;
    }
    return "custom";
}

const Welcome = {
    async show({ mode = "welcome" } = {}) {
        const isWelcome = mode === "welcome";
        const cfg = App.project.server;
        // Server settings of a fresh template (logins, discovery port) for the hints below
        const defaults = await api.app("defaultServerSettings").catch(() => null);
        // "Continue with current" only for a real project: opened from a file, restored from the last session, or one
        // the user already worked with (wizard reopened later) — not the built-in demo on a clean first run.
        const hasCurrent = isWelcome && (App.meta.projectSource !== "default" || !!App.settings.welcomeDone || !!App.projectPath || App.dirty);
        const templates = [
            ...(hasCurrent ? [{ id: "current", glyph: "✓", title: `Continue with “${App.project.name}”`, desc: App.projectPath ? `Keep the current project (${App.projectPath}) and its settings.` : "Keep the current project and its settings." }] : []),
            { id: "demo", svg: "factory", title: "Demo plant", desc: "Signal generators, a boiler with alarms, every data type, arrays and methods. Best for a first look.", badge: "Recommended" },
            { id: "load-test", svg: "chart", title: "Load test", desc: "Hundreds or thousands of changing tags to test client performance." },
            { id: "empty", svg: "square", title: "Empty project", desc: "Start from scratch and design your own address space." },
            { id: "open", svg: "folder-open", title: "Open project file…", desc: "Load a .opcuasim project saved earlier (for example on another machine)." }
        ];
        let choice = templates[0].id;
        let openedProject = null;
        // server settings the chosen option will run with
        const targetServer = () => (choice === "open" && openedProject ? openedProject.project.server : choice === "current" ? cfg : defaults || cfg);
        const tagCount = h("input", { type: "number", value: 1000, min: 1, max: 50000, style: { width: "110px" } });
        const tagRow = h("div", { class: "row hidden", style: { marginTop: "8px" } }, h("span", { class: "small" }, "Number of tags"), tagCount);
        const grid = h("div", { class: "choice-grid" });
        const renderChoices = () => {
            clear(grid);
            for (const t of templates) {
                grid.appendChild(h("button", { class: `choice ${choice === t.id ? "selected" : ""}`, onclick: () => pick(t.id) },
                    h("div", { class: "choice-title" }, h("span", null, t.svg ? icon(t.svg) : t.glyph), t.title, t.badge ? h("span", { class: "badge info" }, t.badge) : null),
                    h("div", { class: "choice-desc" }, t.id === "open" && openedProject ? `Selected: ${openedProject.path}` : t.desc)));
            }
            tagRow.classList.toggle("hidden", choice !== "load-test");
        };
        // Nothing is applied until Apply / Start: browsing a file only fills the form with its port and security.
        const pick = async (id) => {
            if (id === "open") {
                const r = await attempt(() => api.app("openProject"));
                // a project from a file: its security settings are shown before anything is used
                if (!r || !(await App.reviewOpenedProject(r))) return;
                openedProject = r;
                port.value = r.project.server.port || 4840;
                setSecurityFrom(r.project.server, "Keep the project's custom settings");
                setAccessFrom(r.project.server);
            } else if (choice === "open") {
                // switching away from the opened file: back to the current project's values
                port.value = cfg.port || 4840;
                setSecurityFrom(cfg, "Keep current custom settings");
                setAccessFrom(cfg);
            }
            choice = id;
            renderChoices();
            updateHints();
            checkPortNow();
        };

        const port = h("input", { type: "number", min: 1, max: 65535, value: cfg.port || 4840, style: { width: "110px" } });
        const portState = h("span", { class: "port-state" });
        let suggested = null;
        const checkPortNow = debounce(async () => {
            const p = Number(port.value);
            if (App.serverStatus.state === "running" && p === Number(App.serverStatus.port)) {
                portState.className = "port-state ok";
                portState.textContent = "✓ used by the running simulator";
                return;
            }
            const reserved = App.reservedPorts(targetServer());
            if (reserved.includes(p)) {
                portState.className = "port-state bad";
                portState.textContent = `✗ Port ${p} is used by the built-in Local Discovery Server of this project (Configuration → Discovery)`;
                return;
            }
            const r = await api.app("checkPort", p, reserved).catch(() => ({ free: true }));
            clear(portState);
            suggested = r.suggestedPort;
            if (r.free) {
                portState.className = "port-state ok";
                portState.textContent = "✓ port is free";
            } else {
                portState.className = "port-state bad";
                portState.appendChild(h("span", null, `✗ ${r.message}`));
                if (suggested) portState.appendChild(h("button", { class: "btn small", onclick: () => { port.value = suggested; checkPortNow(); } }, `Use ${suggested}`));
            }
        }, 250);
        port.addEventListener("input", checkPortNow);

        const security = h("select");
        const secDesc = h("div", { class: "hint" });
        const updateSecDesc = () => {
            secDesc.textContent = SECURITY_PRESETS[security.value]?.desc || "Security settings from the project are kept (see Configuration).";
            lockAnonForOrg();
            updateHints();
        };
        // The secure preset only allows read access for anonymous users (and turns anonymous login off). The choice made
        // before it is remembered, so that only looking at the secure preset does not leave anonymous clients read-only.
        let anonBeforeOrg = null;
        const lockAnonForOrg = () => {
            const org = security.value === "org";
            if (org && anonBeforeOrg === null) {
                anonBeforeOrg = anonAccess.value;
                anonAccess.value = "readonly";
            } else if (!org && anonBeforeOrg !== null) {
                anonAccess.value = anonBeforeOrg;
                anonBeforeOrg = null;
            }
            anonAccess.disabled = org;
            anonHint.textContent = org
                ? "“Secure (for organisations)” lets anonymous clients only read. Pick another Security option to choose again."
                : "Applies to clients that connect without logging in. Users with the Observer role can only read.";
        };
        // Fills the dropdown for a server configuration; "custom" is offered only when it matches no preset.
        const setSecurityFrom = (srv, customLabel) => {
            const preset = detectSecurityPreset(srv);
            clear(security);
            for (const [value, p] of Object.entries(SECURITY_PRESETS)) security.appendChild(h("option", { value }, p.label));
            if (preset === "custom") security.appendChild(h("option", { value: "custom" }, customLabel));
            security.value = preset;
            updateSecDesc();
        };
        // who can reach the server, and what anonymous clients may do
        const listen = select([
            { value: "all", label: "All network interfaces — other machines can connect" },
            { value: "localhost", label: "This computer only (localhost)" }
        ], "all");
        const anonAccess = select([
            { value: "readwrite", label: "Read, write and call methods" },
            { value: "readonly", label: "Only read" }
        ], "readwrite");
        const anonHint = h("span");
        const setAccessFrom = (srv) => {
            listen.value = srv.listenAddress === "localhost" ? "localhost" : "all";
            anonAccess.value = srv.anonymousAccess === "readonly" ? "readonly" : "readwrite";
            // a new starting point: its own value is the one to restore when leaving the secure preset
            anonBeforeOrg = null;
            lockAnonForOrg();
        };
        setAccessFrom(cfg);
        listen.addEventListener("change", () => updateHints());
        anonAccess.addEventListener("change", () => updateHints());
        security.addEventListener("change", updateSecDesc);

        // Auto-start is pre-ticked only on a real first run; later the saved choice is kept.
        const autoStart = checkbox("Start the server automatically every time the application opens", App.settings.welcomeDone ? !!App.settings.autoStartServer : true);
        const net = App.meta.network || { addresses: [] };
        const loginHint = h("span");
        const reachHint = h("span");
        const listenHint = h("div", { class: "hint" });
        const demoHint = h("div", { class: "notice warn small hidden", style: { marginTop: "6px" } });
        // the server settings as they will be after Apply (for the hints)
        const previewServer = () => {
            const t = { ...targetServer() };
            if (security.value === "org") applySecurePreset(t);
            t.listenAddress = listen.value;
            t.anonymousAccess = anonAccess.value;
            return t;
        };
        const updateHints = () => {
            const t = previewServer();
            loginHint.textContent = `Clients log in with: ${loginSummary(t)}. `;
            reachHint.textContent = listen.value === "localhost"
                ? "Only programs on this computer can connect (opc.tcp://localhost:<port>)."
                : net.addresses.length ? `Other machines connect via ${net.addresses.map((a) => `opc.tcp://${a}:<port>`).join(" or ")}.` : "";
            listenHint.textContent = listen.value === "localhost"
                ? "Other machines cannot reach the server; the endpoint URLs use localhost."
                : "Anyone on your network who can reach this port can connect. Choose “This computer only” when only local programs need the server.";
            const demo = t.allowUsername && (t.users || []).some(isDemoLogin);
            demoHint.textContent = "The demo log-ins (admin/admin, operator/operator, viewer/viewer) are publicly known — change their passwords in Configuration → User Authentication before other machines can reach this server.";
            demoHint.classList.toggle("hidden", !(demo && security.value === "org"));
        };
        setSecurityFrom(cfg, "Keep current custom settings");

        const body = h("div", { class: "stack", style: { gap: "18px" } },
            isWelcome ? h("div", { class: "muted" }, "Simulate an OPC UA server to test your client applications. Pick a starting point, check the port and press Start — your client can connect right away.") : null,
            h("div", null, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "1"), "What do you want to simulate?"), grid, tagRow),
            h("div", null, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "2"), "Server settings"),
                h("div", { class: "form-grid two" },
                    field("TCP port", h("div", { class: "row wrap" }, port, portState), "OPC UA default is 4840. Allow it in the firewall to connect from other machines."),
                    field("Security", security, null)),
                secDesc,
                h("div", { class: "form-grid two", style: { marginTop: "12px" } },
                    field("Listen on", listen, listenHint),
                    field("Anonymous users can", anonAccess, anonHint)),
                h("div", { class: "hint", style: { marginTop: "6px" } }, loginHint, reachHint),
                demoHint),
            h("div", null, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "3"), "Start"), autoStart));
        renderChoices();
        updateHints();
        checkPortNow();

        // A busy port is sorted out before anything is applied, so Back / Escape returns to the wizard.
        const resolvePort = async () => {
            const p = Number(port.value) || 4840;
            if (App.serverStatus.state === "running" && p === Number(App.serverStatus.port)) return true;
            const r = await api.app("checkPort", p, App.reservedPorts(targetServer())).catch(() => ({ free: true }));
            if (r.free) return true;
            const use = await modal({
                title: "Port not available",
                body: h("div", { class: "stack" }, h("div", null, r.message),
                    r.suggestedPort ? h("div", null, "Port ", h("b", null, r.suggestedPort), " is free. Use it instead? Clients must then connect to the new port.") : null),
                buttons: [{ label: "Back", value: false }, r.suggestedPort ? { label: `Use port ${r.suggestedPort}`, class: "primary", value: true } : null].filter(Boolean)
            });
            if (use) port.value = r.suggestedPort;
            checkPortNow();
            return !!use;
        };

        const apply = async (start) => {
            if (choice === "open" && !openedProject) { toast("Choose a project file first", "warn"); return false; }
            if (start && !(await resolvePort())) return false;
            if (choice !== "current") {
                if (!(await App.confirmDiscard())) return false;
                if (choice === "open") {
                    App.setProject(openedProject.project, openedProject.path, { scriptsTrusted: openedProject.scriptsTrusted });
                    if (openedProject.securePresetApplied) App.markDirty();
                } else {
                    // the built-in templates are part of the app: their method scripts are trusted
                    App.setProject(await api.app("newFromTemplate", choice, { count: Number(tagCount.value) }), null, { scriptsTrusted: true });
                }
            }
            const s = App.project.server;
            const snapshot = () => JSON.stringify([s.port, [...(s.securityPolicies || [])].sort(), [...(s.securityModes || [])].sort(),
                s.listenAddress, s.anonymousAccess, s.allowAnonymous, s.autoAcceptCertificates, s.registerToLds, s.runDiscoveryServer]);
            const before = snapshot();
            s.port = Number(port.value) || 4840;
            const p = SECURITY_PRESETS[security.value];
            if (security.value === "org") {
                applySecurePreset(s);
            } else if (p) {
                s.securityPolicies = [...p.policies];
                s.securityModes = [...p.modes];
            } else if (choice !== "current" && choice !== "open") {
                // "Keep current custom settings" for a new template: take them over from the previous project
                s.securityPolicies = [...(cfg.securityPolicies || [])];
                s.securityModes = [...(cfg.securityModes || [])];
            }
            s.listenAddress = listen.value;
            if (security.value !== "org") s.anonymousAccess = anonAccess.value;
            // only an actual change makes the project "unsaved"
            if (snapshot() !== before) {
                App.markDirty();
                App.emit("project-changed", App.project);
            }
            await App.updateSettings({ welcomeDone: true, autoStartServer: autoStart.querySelector("input").checked });
            if (start) {
                if (App.serverStatus.state === "running") await App.stopServer();
                // keep a view the user picked in the port dialog ("Change in Configuration")
                if (await App.startServer({ quiet: true })) App.navigate("dashboard");
                return undefined;
            }
            App.navigate(choice === "empty" ? "designer" : "dashboard");
            return undefined;
        };

        await modal({
            title: isWelcome ? "Welcome to OPC UA Simulator" : "New project",
            wide: true,
            body,
            buttons: [
                { label: isWelcome ? "Skip" : "Cancel", onClick: async () => { if (isWelcome) await App.updateSettings({ welcomeDone: true }); } },
                { label: "Apply without starting", onClick: () => apply(false) },
                { label: "▶ Start Server", class: "primary", onClick: () => apply(true) }
            ]
        });
    }
};
