"use strict";
/* Built-in quick start guide and troubleshooting. */
const Help = {
    mount(view) {
        const cfg = App.project.server;
        const net = App.meta.network || { addresses: [], hostname: "" };
        const port = cfg.port;
        const ips = net.addresses.length ? net.addresses : ["<this-machine-ip>"];
        const code = (t) => h("code", null, t);
        // Commands are built from the real launcher of this installation (main sends it, quoted when needed).
        // From source, "npm run headless --" is already the headless entry point and "npm start --" the desktop app.
        const packaged = App.meta.isPackaged !== false;
        const launch = App.meta.launchCommand || ({ win32: "\"OPC UA Simulator.exe\"", darwin: "\"/Applications/OPC UA Simulator.app/Contents/MacOS/OPC UA Simulator\"" }[App.meta.platform] || "opcua-simulator");
        const headless = packaged ? `${launch} --headless` : launch;
        const desktop = packaged ? launch : "npm start --";
        const mod = App.meta.platform === "darwin" ? "⌘" : "Ctrl"; // ⌘ only on macOS, whose fonts have it
        // an example host port that really differs from the server port
        const altPort = port + 10000 <= 65535 ? port + 10000 : port - 10000;
        const section = (title, ...content) => h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, title)), h("div", { class: "card-body help" }, ...content));

        view.appendChild(h("div", { class: "stack", style: { maxWidth: "980px" } },
            h("div", { class: "row wrap" },
                h("button", { class: "btn primary", onclick: () => Welcome.show({ mode: "welcome" }) }, "Open the welcome wizard"),
                h("button", { class: "btn", onclick: () => api.app("openFolder", App.meta.logDir) }, "Open log folder"),
                h("button", { class: "btn", onclick: () => api.app("openFolder", App.meta.dataDir) }, "Open data folder"),
                h("span", { class: "spacer" }),
                h("span", { class: "muted small" }, `Version ${App.meta.version} · ${App.meta.platform} · data in ${App.meta.dataDir}`)),

            section("Quick start",
                h("ol", null,
                    h("li", null, "Press ", h("b", null, "▶ Start Server"), " (top right). The default project simulates changing values, alarms and methods."),
                    h("li", null, "Copy an endpoint URL from the ", h("b", null, "Dashboard"), " — e.g. ", code(`opc.tcp://localhost:${port}${cfg.resourcePath || ""}`), "."),
                    h("li", null, "Connect your OPC UA client (your application, UaExpert, …). Log in with: ", code(loginSummary(cfg)), "."),
                    h("li", null, "Change values, quality (StatusCode) and timestamps in ", h("b", null, "Live Values"), "; trigger alarms in ", h("b", null, "Alarms & Events"), "."),
                    h("li", null, "Use the built-in ", h("b", null, "Client"), " to check what a client sees.")),
                h("p", null, "Tick “Start the server automatically” in the welcome wizard or in Configuration → Startup & Network, and the simulator is serving data as soon as the application opens.")),

            section("Connecting from another machine or VM",
                h("ul", null,
                    h("li", null, "Use the IP address of this machine: ", ips.map((ip, i) => [i ? " or " : "", code(`opc.tcp://${ip}:${port}${cfg.resourcePath || ""}`)])),
                    h("li", null, "Allow TCP port ", code(port), " in the firewall. On Windows accept the firewall prompt on first start, or run (as administrator): ",
                        code(`netsh advfirewall firewall add rule name="OPC UA Simulator" dir=in action=allow protocol=TCP localport=${port}`)),
                    h("li", null, "Linux: ", code(`sudo ufw allow ${port}/tcp`), " (Ubuntu) or ", code(`sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`), "."),
                    h("li", null, "VM with NAT networking (VirtualBox, VMware, Hyper-V default switch): forward host port ", code(port), " to the VM, or switch the VM to bridged networking. Add the host's name/IP under Configuration → Startup & Network → Extra host names."),
                    h("li", null, "When the forwarded port differs from the server port (host ", code(altPort), " → VM ", code(port), "), enter the URL clients use under Configuration → Startup & Network → Advertised endpoint URLs, e.g. ", code(`opc.tcp://<host-ip>:${altPort}`), "."),
                    h("li", null, "If a client rejects the server certificate because of a host name/IP mismatch (the VM got a new IP), stop the server and use Certificates → Regenerate server certificate."))),

            section("Running without a desktop (headless VM, server, CI)",
                h("p", null, "The same application runs without a window and prints the endpoint URLs",
                    packaged ? "" : " (from the source folder)",
                    App.meta.platform === "linux" && packaged ? ". On Linux without a desktop (no DISPLAY) the launcher switches to this mode automatically" : "", ":"),
                h("ul", null,
                    h("li", null, code(`${headless} --port ${port}`)),
                    h("li", null, "Serve a project saved from this app: ", code(`${headless} --project myplant.opcuasim`)),
                    h("li", null, "Load-test template: ", code(`${headless} --template load-test --tags 5000`)),
                    h("li", null, "New server certificate (e.g. the VM got a new IP): ", code(`${headless} --regenerate-cert`), "; more detail in the log: ", code("--verbose")),
                    h("li", null, "Behind NAT / port forwarding: ", code(`${headless} --advertised-url opc.tcp://<host-ip>:${altPort}`)),
                    h("li", null, "Docker: ", code("docker run -p 4840:4840 -e OPCUA_HOSTNAME=<host-ip> opcua-simulator"), ", or when the ports differ ",
                        code(`docker run -p ${altPort}:4840 -e OPCUA_ADVERTISED_URL=opc.tcp://<host-ip>:${altPort} opcua-simulator`), " (see README)."),
                    h("li", null, "All options: ", code(`${headless} --help`)),
                    App.meta.platform === "win32" && launch.startsWith("\"")
                        ? h("li", null, "PowerShell needs ", code("&"), " in front of a quoted program path: ", code(`& ${headless} --port ${port}`), " (cmd.exe works as shown).")
                        : null)),

            section("Command line options for the desktop app",
                h("ul", null,
                    h("li", null, code(`${desktop} --start`), " start the server immediately after launch (also on the first launch, without the welcome wizard)"),
                    h("li", null, code(`${desktop} <file>.opcuasim`), " open a project file (double-clicking a project file does the same)"),
                    h("li", null, "Environment ", code("OPCUA_DISABLE_GPU=1"), " — use if the window stays blank in a VM without 3D acceleration"))),

            section("Troubleshooting",
                h("ul", null,
                    h("li", null, h("b", null, "“Port is already in use”"), " — another program (or a second simulator) uses the port. The app offers the next free port."),
                    h("li", null, h("b", null, "Client cannot connect from another machine"), " — check the firewall, the VM network mode, and that you use the IP-based endpoint URL."),
                    h("li", null, h("b", null, "BadSecurityChecksFailed / certificate rejected"), " — trust the client in Certificates → Server application PKI → Rejected, or enable “Automatically trust unknown client certificates” in Configuration."),
                    h("li", null, h("b", null, "BadUserAccessDenied"), " — wrong user name/password, or the identity type is disabled in Configuration → User Authentication."),
                    h("li", null, h("b", null, "Blank window in a VM"), " — start with ", code("OPCUA_DISABLE_GPU=1"), " or the command line switch ", code("--disable-gpu"), "."),
                    h("li", null, h("b", null, "Linux"), " — the packages start through a launcher that handles the Chromium sandbox, running as root and machines without a display automatically."),
                    h("li", null, h("b", null, "Linux: missing libraries"), " — the launcher prints the exact install command, e.g. ",
                        code("sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1 libx11-xcb1 libxss1 libxtst6"), " (use ", code("libasound2"), " on Ubuntu 22.04) or ",
                        code("sudo dnf install gtk3 nss alsa-lib mesa-libgbm libX11-xcb libXScrnSaver libXtst"), "."),
                    h("li", null, h("b", null, "Linux AppImage does not start"), " — make it executable (", code("chmod +x"), "). If it still fails (e.g. no FUSE), use the .deb package, or extract it once: ",
                        code("./OPCUA-Simulator-*.AppImage --appimage-extract && ./squashfs-root/AppRun"), ".")),
                h("p", null, "Logs are written to ", code(App.meta.logDir), ".")),

            section("Keyboard shortcuts",
                h("div", { class: "kv" },
                    ...[["Start server", `${mod} + R`], ["Stop server", `${mod} + .`], ["Restart server", `${mod} + Shift + R`], ["New project", `${mod} + N`],
                        ["Open project", `${mod} + O`], ["Save project", `${mod} + S`], ["Help", "F1"]].flatMap(([a, b]) => [h("div", null, a), h("div", null, h("kbd", null, b))])))));
    }
};
