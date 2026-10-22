# OPC UA Simulator

A desktop OPC UA **server simulator** with a built-in **test client**. Use it to test any OPC UA client
application (SCADA, MES, historian, gateway, edge agent and so on) against a server whose data, quality,
timestamps, alarms and security you control. It runs on Windows, macOS and Linux, with or without a
desktop, and in Docker.

---

## 1. Download and start

Pick the file for your machine. None of them need Node.js, admin rights or extra setup.

| System | File | How to start |
|---|---|---|
| **Windows 10/11** | `OPCUA-Simulator-Setup-<version>-x64.exe` | Double-click it. It installs for the current user (no admin), creates desktop and Start-menu shortcuts and opens the app. |
| Windows, no install | `OPCUA-Simulator-Portable-<version>-x64.exe` | Double-click it and it runs as is, for example from a USB stick or a shared folder. |
| **macOS** (Apple Silicon) | `OPCUA-Simulator-<version>-mac-arm64.dmg` | Open it and drag the app into *Applications*. |
| macOS (Intel) | `OPCUA-Simulator-<version>-mac-x64.dmg` | Same as above. |
| **Ubuntu / Debian** | `OPCUA-Simulator-<version>-linux-amd64.deb` (`arm64.deb` for ARM) | Double-click to open it in *Software*, or run `sudo apt install ./OPCUA-Simulator-*.deb`. Start it from the app menu or with `opcua-simulator`. |
| Any Linux | `OPCUA-Simulator-<version>-linux-x86_64.AppImage` | Run `chmod +x OPCUA-Simulator-*.AppImage`, then double-click it or run `./OPCUA-Simulator-*.AppImage`. |
| Any Linux (archive) | `OPCUA-Simulator-<version>-linux-x64.tar.gz` | Extract it and run `./opcua-simulator`. |
| **No desktop** (server VM, CI) | Docker image, or any of the Linux packages above | See [Headless and Docker](#5-headless-and-docker). |

### First launch of the unsigned builds

The installers are not code-signed yet, so the operating system asks once:

- **Windows SmartScreen** ("Windows protected your PC"): click **More info**, then **Run anyway**.
- **macOS** ("cannot be opened" / "Not Opened"): open **System Settings → Privacy & Security** and click **Open Anyway**.
  Or run `xattr -dr com.apple.quarantine "/Applications/OPC UA Simulator.app"` once.
- **Linux**: nothing to do. The packages include a launcher that handles the Chromium sandbox, root
  logins and VMs without a display automatically.

---

## 2. First start: the welcome wizard

On first start a short wizard asks for three things:

1. **What to simulate**:
   - *Demo plant*: signal generators, a boiler with alarms, every data type, arrays and methods.
   - *Load test*: hundreds to 50,000 changing tags.
   - *Empty project*.
   - *Open a project file* (`.opcuasim`) saved earlier, for example on another machine.
2. **Port and security**. The wizard checks that the port is free and offers the next free port if it isn't.
   Security presets: *Recommended* (unsecured and encrypted endpoints), *No security* or *Encrypted only*.
3. **Start automatically**. Tick this and the server is serving data as soon as the app opens, so launching
   the app is the only step.

You can re-open the wizard with **New** (top bar) or **Help → Show Welcome Screen**.

---

## 3. Connect your OPC UA client

The **Dashboard** lists the endpoint URLs with *Copy* and *Open in Client* buttons:

- From the same machine: `opc.tcp://localhost:4840/UA/Simulator`
- From other machines or VMs: `opc.tcp://<ip-address>:4840/UA/Simulator`. The app advertises all local IP
  addresses, so the URLs work even when the host name does not resolve.

Logins for the demo project: **Anonymous**, `admin/admin`, `operator/operator`, `viewer/viewer`, or an
X509 certificate. Change them in **Configuration → User Authentication**.

### Networking tips for VMs

- **Firewall**: allow TCP port 4840 (or your port).
  - Windows: accept the prompt on first start, or run as admin:
    `netsh advfirewall firewall add rule name="OPC UA Simulator" dir=in action=allow protocol=TCP localport=4840`
  - Ubuntu: `sudo ufw allow 4840/tcp`
  - RHEL/Fedora: `sudo firewall-cmd --add-port=4840/tcp --permanent && sudo firewall-cmd --reload`
- **NAT networking** (the VirtualBox / VMware / Hyper-V default): forward the host port to the VM, or switch
  the VM to bridged networking. With port forwarding, put the URL clients use
  (`opc.tcp://<host>:<port>`) under **Configuration → Startup & Network → Advertised endpoint URLs**.
- **Certificate host mismatch** (for example, the VM got a new IP): stop the server and use
  **Certificates → Regenerate server certificate**. Headless mode uses `--regenerate-cert` instead.

---

## 4. What you can simulate

| Area | What you can configure or simulate |
|---|---|
| Endpoint | Port, resource path, host names / IPs, advertised URLs, application name and URIs, build info |
| Security | Policies None, Basic128Rsa15, Basic256, Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss; modes None / Sign / SignAndEncrypt |
| User identity | Anonymous, username/password with roles, X509 certificate |
| Certificates | Server, user and client PKI: trust or reject clients, import CA certificates, auto-accept for testing, regenerate the server certificate |
| Address space | Folders, objects, variables, methods and alarms with custom NodeIds (`s=`, `i=`, `g=`, `b=`); bulk-add up to 10,000 tags |
| Data types | All 20 built-in scalar types plus arrays; AnalogItemType with EURange and EngineeringUnits; access levels |
| Simulation | Sine, triangle, sawtooth, square, random, random walk, ramp, counter, toggle, clock; pause per variable or for all |
| Manual values | Set value, **StatusCode** and **source/server timestamps** (incl. picoseconds); set a StatusCode on many tags at once, e.g. to simulate a device going offline |
| History | Historizing variables with HistoryRead |
| Alarms & Conditions | Exclusive / non-exclusive limit and off-normal alarms; enable, acknowledge, confirm, comment, ConditionRefresh, severity; one-click HH / H / Normal / L / LL triggers |
| Events | Raise standard event types from any object, singly or in bursts |
| Methods | Typed arguments, implemented in small JavaScript snippets |
| Information models | Bundled companion specs (DI, Machinery, Robotics, PackML, MachineTool, AutoID and more) or your own NodeSet2 XML |
| Server behaviour | ServerStatus.State (Running, Failed, Suspended …); shutdown with a delay; close sessions; export the address space as NodeSet2 XML |
| Discovery | Register with an LDS, or run a built-in Local Discovery Server |

The built-in **Client** connects to any OPC UA server, including this one. It does discovery, browse,
attributes, write (with StatusCode and timestamps), subscriptions with deadbands and trend charts,
events and alarms (acknowledge / confirm), method calls and history reads.

---

## 5. Headless and Docker

On a VM without a desktop, the same app runs without a window and prints the endpoint URLs.

```bash
opcua-simulator --headless                        # Linux .deb (also automatic when there is no display)
./OPCUA-Simulator-*.AppImage --headless           # Linux AppImage
"OPC UA Simulator.exe" --headless                 # Windows (from the install folder)
"/Applications/OPC UA Simulator.app/Contents/MacOS/OPC UA Simulator" --headless   # macOS
```

The **Help** view shows the exact command for your installation.

| Option | Environment variable | Meaning |
|---|---|---|
| `--project <file>` or just `<file>.opcuasim` | `OPCUA_PROJECT` | Serve a project saved from the desktop app |
| `--template demo\|empty\|load-test` | `OPCUA_TEMPLATE` | Built-in project when no file is given |
| `--tags <n>` | `OPCUA_TAGS` | Tag count for `load-test` |
| `--port <n>` | `OPCUA_PORT` | TCP port (default 4840) |
| `--hostname <name>` | `OPCUA_HOSTNAME` | Host name / IP used in endpoint URLs |
| `--alt-hostnames <a,b>` | `OPCUA_ALT_HOSTNAMES` | Extra host names / IPs |
| `--advertised-url <url>` | `OPCUA_ADVERTISED_URL` | Full URL clients use, e.g. behind NAT or with a different Docker port |
| `--no-security` | `OPCUA_NO_SECURITY=1` | Offer SecurityPolicy None only (logins stay possible) |
| `--regenerate-cert` | `OPCUA_REGENERATE_CERT=1` | Create a new server certificate for the current names / IPs |
| `--data-dir <dir>` | `OPCUA_DATA_DIR` | Certificates and logs |
| `--verbose` | `OPCUA_LOG_LEVEL=debug` | Debug logging |
| `--help` | | All options |

### Docker

```bash
docker build -t opcua-simulator .
docker run -d -p 4840:4840 -e OPCUA_HOSTNAME=<ip-of-the-docker-host> opcua-simulator
# different host port: tell clients the real URL
docker run -d -p 5000:4840 -e OPCUA_ADVERTISED_URL=opc.tcp://<host>:5000/UA/Simulator opcua-simulator
# or
OPCUA_HOSTNAME=<ip-of-the-docker-host> docker compose up -d
```

To serve your own project, put the `.opcuasim` file in `./projects` and set
`OPCUA_PROJECT=/projects/<file>.opcuasim` in `docker-compose.yml`. Certificates live in the `opcua-data`
volume.

---

## 6. Projects, settings and logs

- **New / Open / Save** are in the top bar. Projects are saved as `*.opcuasim` (JSON), and double-clicking
  one opens it in the simulator.
- Changes are kept automatically on this computer. **Save** updates the project file, which you can copy to
  another machine.
- Data folder (settings, certificates, logs; Help → Open Data Folder):
  - Windows: `%APPDATA%\OPC UA Simulator`
  - macOS: `~/Library/Application Support/OPC UA Simulator`
  - Linux: `~/.config/OPC UA Simulator`
- Logs: `logs/simulator.log` in the data folder, or `logs/headless.log` in headless mode.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| *Port is already in use* | Another program, or a second copy of the simulator, uses the port. The app offers the next free port. |
| Client on another machine cannot connect | Check the firewall and the VM network mode, and use the IP-based endpoint URL. |
| `BadSecurityChecksFailed` / certificate rejected | Trust the client in **Certificates → Server application PKI → Rejected**, or enable *Automatically trust unknown client certificates* in Configuration. |
| `BadUserAccessDenied` | Wrong user name or password, or that login type is disabled in Configuration. |
| Blank window in a VM | Start with `OPCUA_DISABLE_GPU=1` or `--disable-gpu`. |
| Linux: missing libraries | The launcher prints the exact `apt` / `dnf` command to run. The `.deb` installs them automatically. |
| Linux AppImage does not start | Use the `.deb` or `.tar.gz`, or extract it once: `./OPCUA-Simulator-*.AppImage --appimage-extract && ./squashfs-root/AppRun` |

---

## 8. Run from source and build the installers

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm start                 # desktop app
npm run headless -- --help
```

Double-click launchers (they install dependencies on first run): `Start Simulator.command` (macOS),
`Start Simulator.bat` (Windows), `start-simulator.sh` (Linux; falls back to headless when there is no display).

Build installers (output in `dist/`):

```bash
npm run dist:win      # Setup + portable .exe
npm run dist:mac      # .dmg + .zip (arm64 and x64)
npm run dist:linux    # .deb, AppImage, .tar.gz (x64 and arm64)
```

Each OS is best built on itself. The included GitHub Actions workflow (`.github/workflows/build.yml`)
does this for all three. Push a tag such as `v1.0.0` to get a GitHub release with every installer.
Signing: set a Developer ID / notarization (macOS) or a code-signing certificate (Windows) in
`package.json → build` to remove the first-launch warnings.

### Project layout
```
src/main/       Electron main process
  main.js            window, menus, IPC, settings, single instance, logs
  serverEngine.js    OPC UA server, simulation, alarms, events, history
  clientEngine.js    OPC UA client
  headless.js        headless runner (shared by cli.js and --headless)
  network.js         port checks, local addresses
  project.js         templates, project files
src/renderer/   UI (plain HTML/CSS/JS, no build step)
src/cli.js      headless entry point for Node.js / Docker
build/          icon and the Linux launcher hook (afterPack.js)
```
