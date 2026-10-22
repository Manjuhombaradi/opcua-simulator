"use strict";
/* Application shell: state, navigation, project handling and server control. */

const App = {
    meta: null,
    settings: {},
    project: null,
    projectPath: null,
    dirty: false,
    changedSinceStart: false,
    serverStatus: { state: "stopped" },
    clientStatus: { state: "disconnected" },
    logs: [],
    listeners: {},
    currentView: null,
    unmount: null,
    clientPrefillUrl: null,
    starting: null, // in-flight startServer() promise

    on(event, cb) {
        (this.listeners[event] = this.listeners[event] || []).push(cb);
        return () => { this.listeners[event] = this.listeners[event].filter((x) => x !== cb); };
    },
    emit(event, data) {
        for (const cb of this.listeners[event] || []) {
            try { cb(data); } catch (err) { console.error(err); }
        }
    },

    async updateSettings(patch) {
        this.settings = await api.app("setSettings", patch);
        return this.settings;
    },

    // ------------------------------------------------------------ project
    setProject(project, path) {
        this.project = project;
        this.projectPath = path || null;
        this.dirty = false;
        this.changedSinceStart = this.serverStatus.state === "running";
        Designer.selectedId = null;
        Designer.expanded.clear();
        this.refreshChrome();
        this.autosave();
        this.emit("project", project);
        if (this.currentView) this.navigate(this.currentView);
    },
    markDirty() {
        this.dirty = true;
        if (this.serverStatus.state === "running") this.changedSinceStart = true;
        this.refreshChrome();
        this.autosave();
    },
    // The renderer owns the project file path; main only stores what it is given.
    autosave: debounce(() => { api.app("autosave", App.project, App.projectPath, App.dirty).catch(() => {}); }, 800),

    async save(saveAs = false) {
        const file = await attempt(() => api.app("saveProject", this.project, saveAs, this.projectPath));
        if (file) {
            this.projectPath = file;
            this.dirty = false;
            this.refreshChrome();
            this.autosave();
            toast(`Project saved to ${file}`, "success");
        }
    },
    async confirmDiscard() {
        if (!this.dirty) return true;
        return confirmDialog("Unsaved changes", "The current project has unsaved changes. Discard them?", "Discard", true);
    },
    async openProject(file) {
        if (!(await this.confirmDiscard())) return;
        const r = await attempt(() => (file ? api.app("openProjectFile", file) : api.app("openProject")));
        if (r) {
            this.setProject(r.project, r.path);
            toast(`Opened ${r.path}`, "success");
            if (this.serverStatus.state === "running") toast("Restart the server to serve the opened project", "warn");
        }
    },
    async menu(command) {
        switch (command) {
            case "new": return Welcome.show({ mode: "new" }); // the wizard asks about unsaved changes on Apply
            case "open": return this.openProject();
            case "save": return this.save(false);
            case "saveAs": return this.save(true);
            case "exportNodeset": {
                const f = await attempt(() => api.app("exportNodeset"));
                if (f) toast(`Exported to ${f}`, "success");
                break;
            }
            case "startServer": return this.startServer();
            case "stopServer": return this.stopServer();
            case "restartServer": return this.restartServer();
            case "help": return this.navigate("help");
            case "welcome": return Welcome.show({ mode: "welcome" });
        }
    },

    // ------------------------------------------------------------ server control
    // Ports the server needs besides the main port (port suggestions must skip them).
    reservedPorts(cfg = this.project.server) {
        return cfg.runDiscoveryServer && cfg.discoveryServerPort ? [Number(cfg.discoveryServerPort)] : [];
    },
    // Returns a promise resolving to true when the server is running afterwards.
    // Calls made while a start is in progress (double click, menu + button) share the same promise.
    startServer(options) {
        if (!this.starting) {
            this.starting = this.startServerNow(options).finally(() => {
                this.starting = null;
                this.refreshChrome();
                this.emit("start-busy", false);
            });
            this.refreshChrome();
            this.emit("start-busy", true);
        }
        return this.starting;
    },
    async startServerNow({ quiet = false } = {}) {
        if (this.serverStatus.state === "running") return true;
        if (this.serverStatus.state === "starting") return false;
        const problems = Designer.validate(this.project.nodes);
        if (problems.length && !quiet) {
            const go = await confirmDialog("Address space problems",
                h("div", null, h("p", null, "These nodes will fail to be created:"), h("ul", null, problems.slice(0, 12).map((p) => h("li", null, p)))),
                "Start anyway");
            if (!go) return false;
        }
        if (!(await this.ensurePortFree())) return false;
        try {
            await api.server("start", this.project);
            this.changedSinceStart = false;
            this.refreshChrome();
            toast(`Server running — ${this.serverStatus.endpointUrls?.length || 0} endpoint URL(s) on port ${this.project.server.port}`, "success");
            return true;
        } catch (err) {
            const msg = err.message.replace(/ \[suggested-port:\d+\]$/, "");
            const suggested = Number((err.message.match(/\[suggested-port:(\d+)\]/) || [])[1]) || null;
            if (suggested) return (await this.portDialog(msg, suggested)) && this.startServerNow({ quiet: true });
            modal({
                title: "The server could not start",
                body: h("div", { class: "stack" }, h("div", null, msg),
                    h("div", { class: "muted small" }, "Details are in the Logs view. Check Configuration (port, NodeSet files) and try again.")),
                buttons: [{ label: "Open Logs", onClick: () => this.navigate("logs") }, { label: "Open Configuration", onClick: () => this.navigate("config") }, { label: "Close", class: "primary", value: null }]
            });
            return false;
        }
    },
    async ensurePortFree() {
        const port = this.project.server.port;
        const r = await api.app("checkPort", port, this.reservedPorts()).catch(() => ({ free: true }));
        if (r.free) return true;
        return this.portDialog(r.message, r.suggestedPort);
    },
    // Offers to switch to a free port; returns true when the project now uses suggestedPort.
    async portDialog(message, suggestedPort) {
        const choice = await modal({
            title: "Port not available",
            body: h("div", { class: "stack" }, h("div", null, message),
                suggestedPort ? h("div", null, "Port ", h("b", null, suggestedPort), " is free. Use it instead? Clients must then connect to the new port.") : null),
            buttons: [
                { label: "Cancel", value: null },
                { label: "Change in Configuration", value: "config" },
                suggestedPort ? { label: `Use port ${suggestedPort}`, class: "primary", value: "use" } : null
            ].filter(Boolean)
        });
        if (choice === "config") this.navigate("config");
        if (choice !== "use") return false;
        this.project.server.port = suggestedPort;
        this.markDirty();
        this.emit("project-changed", this.project);
        return true;
    },
    async stopServer(delay = 0) {
        if (this.serverStatus.state !== "running") return;
        await attempt(() => api.server("stop", delay), "Server stopped");
    },
    async restartServer() {
        if (this.serverStatus.state === "running") await this.stopServer();
        await this.startServer();
    },

    // While running, describe the server that is actually serving (it may run an older project version).
    servedPort() {
        return this.serverStatus.state === "running" && this.serverStatus.port ? this.serverStatus.port : this.project.server.port;
    },
    localEndpointUrl() {
        const running = this.serverStatus.state === "running";
        const resourcePath = running ? (this.serverStatus.resourcePath ?? "") : (this.project.server.resourcePath || "");
        return `opc.tcp://localhost:${this.servedPort()}${resourcePath}`;
    },

    // ------------------------------------------------------------ chrome
    refreshChrome() {
        document.getElementById("project-name").textContent = this.project?.name || "Untitled";
        document.getElementById("project-name").title = this.projectPath || "Not saved to a file yet";
        document.getElementById("dirty-flag").classList.toggle("hidden", !this.dirty);
        const st = this.serverStatus.state;
        const pill = document.getElementById("server-pill");
        pill.className = `pill ${st}`;
        const labels = { stopped: "Server stopped", starting: "Starting…", running: "Server running", stopping: "Stopping…", error: "Server error" };
        let text = labels[st] || st;
        if (st === "running") text += ` · port ${this.serverStatus.port || this.project.server.port}`;
        if (st === "running" && this.changedSinceStart) text += " · restart to apply changes";
        document.getElementById("server-pill-text").textContent = text;
        pill.title = this.serverStatus.error || (this.serverStatus.endpointUrls || []).join("\n");
        const running = st === "running" || st === "stopping";
        document.getElementById("btn-start").classList.toggle("hidden", running);
        document.getElementById("btn-start").disabled = st === "starting" || !!this.starting;
        document.getElementById("btn-restart").classList.toggle("hidden", !(running && this.changedSinceStart));
        document.getElementById("btn-stop").classList.toggle("hidden", !running);
        this.renderNav();
    },

    views: [
        { section: "Server" },
        { id: "dashboard", label: "Dashboard", icon: "◉" },
        { id: "config", label: "Configuration", icon: "⚙" },
        { id: "designer", label: "Address Space", svg: "folders" },
        { id: "live", label: "Live Values", icon: "≋" },
        { id: "alarms", label: "Alarms & Events", icon: "⚠" },
        { section: "Tools" },
        { id: "client", label: "Client", icon: "⇄" },
        { id: "certs", label: "Certificates", svg: "lock" },
        { id: "logs", label: "Logs", icon: "☰" },
        { id: "help", label: "Help", icon: "?" }
    ],

    renderNav() {
        const nav = clear(document.getElementById("nav"));
        for (const v of this.views) {
            if (v.section) { nav.appendChild(h("div", { class: "nav-section" }, v.section)); continue; }
            let count = null;
            if (v.id === "logs") {
                const errors = this.logs.filter((l) => l.level === "error").length;
                if (errors) count = h("span", { class: "count", title: `${errors} error(s)` }, errors);
            }
            if (v.id === "client" && this.clientStatus.state === "connected") count = h("span", { class: "count", title: "Connected" }, "●");
            nav.appendChild(h("button", { class: `nav-item ${this.currentView === v.id ? "active" : ""}`, onclick: () => this.navigate(v.id) },
                h("span", { class: "ico" }, v.svg ? icon(v.svg) : v.icon), v.label, count));
        }
    },

    navigate(id) {
        if (this.unmount) { try { this.unmount(); } catch (err) { console.error(err); } }
        this.unmount = null;
        this.currentView = id;
        const view = document.getElementById("view");
        clear(view);
        view.className = "";
        view.scrollTop = 0;
        const def = this.views.find((v) => v.id === id);
        document.getElementById("view-title").textContent = def?.label || "";
        const impl = { dashboard: Dashboard, config: Config, designer: Designer, live: Live, alarms: Alarms, client: ClientView, certs: Certs, logs: Logs, help: Help }[id];
        this.unmount = impl.mount(view) || null;
        this.renderNav();
    },

    toggleTheme() {
        const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = cur;
        try { localStorage.setItem("theme", cur); } catch (_) { /* ignore */ }
    },

    async init() {
        this.meta = await api.app("getInitialData");
        this.settings = this.meta.settings;
        this.project = this.meta.project;
        this.projectPath = this.meta.projectPath || null;
        this.dirty = !!this.meta.dirty; // unsaved edits from the last session (kept in last-project.json)
        let theme = null;
        try { theme = localStorage.getItem("theme"); } catch (_) { /* ignore */ }
        document.documentElement.dataset.theme = theme || (this.meta.darkMode ? "dark" : "light");
        document.getElementById("app-version").textContent = `v${this.meta.version}`;
        document.getElementById("theme-toggle").onclick = () => this.toggleTheme();
        document.getElementById("btn-start").onclick = () => this.startServer();
        document.getElementById("btn-restart").onclick = () => this.restartServer();
        document.getElementById("btn-stop").onclick = () => this.stopServer();
        document.getElementById("btn-save").onclick = () => this.save(false);
        document.getElementById("btn-open").onclick = () => this.openProject();
        document.getElementById("btn-new").onclick = () => this.menu("new");

        api.on("server-status", (s) => {
            this.serverStatus = s;
            this.refreshChrome();
            this.emit("server-status", s);
        });
        api.on("client-status", (s) => {
            this.clientStatus = s;
            this.renderNav();
            this.emit("client-status", s);
        });
        // main batches log entries (at most every 250 ms)
        api.on("log-batch", (batch) => {
            if (!Array.isArray(batch) || !batch.length) return;
            for (const l of batch) this.logs.push(l);
            if (this.logs.length > 5000) this.logs.splice(0, this.logs.length - 5000);
            if (batch.some((l) => l.level === "error")) this.renderNav();
            this.emit("log-batch", batch);
        });
        api.on("client-data", (b) => this.emit("client-data", b));
        api.on("client-event", (e) => this.emit("client-event", e));
        api.on("menu", (cmd) => this.menu(cmd));
        api.on("open-file", (file) => this.openProject(file));

        this.serverStatus = await api.server("getStatus");
        // a new window (or reload) while the server keeps running: say when it serves something else
        this.changedSinceStart = this.serverStatus.state === "running" &&
            (this.meta.projectSource === "file" || Number(this.serverStatus.port) !== Number(this.project.server.port));
        this.refreshChrome();
        this.navigate("dashboard");
        if (this.meta.projectError) toast(`Could not open project: ${this.meta.projectError}`, "error");
        // a project file was opened while the restored session has unsaved changes: ask before replacing it
        if (this.meta.openFile) await this.openProject(this.meta.openFile);

        // An explicit --start wins over the first-run wizard (unattended VM setups)
        if (this.meta.startRequested) {
            await this.startServer({ quiet: true });
            if (!this.settings.welcomeDone) await this.updateSettings({ welcomeDone: true });
        } else if (!this.settings.welcomeDone) {
            Welcome.show({ mode: "welcome" });
        } else if (this.settings.autoStartServer) {
            await this.startServer({ quiet: true });
        }
    }
};

window.addEventListener("DOMContentLoaded", () => App.init().catch((err) => {
    document.body.textContent = `Failed to start UI: ${err.message}`;
}));
