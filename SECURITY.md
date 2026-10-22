# Security notes for OPC UA Simulator

This document is for security teams and administrators who evaluate or deploy OPC UA Simulator. It
describes version **1.1.0** (desktop app for Windows, macOS and Linux, headless mode and Docker image).
Version 1.1.0 contains the fixes from an independent security review in October 2026.

**Short version**

- The application makes **no network connections of its own**: no telemetry, usage statistics, update
  checks, crash reports or downloads, and nothing at startup. The network is used only by the OPC UA
  server you start and by connections you make in the built-in client.
- The **default (demo) settings are made for test labs** and are not secure (anonymous read/write, an
  unencrypted endpoint, well-known demo passwords). One click applies the **secure preset**
  (see [Hardening guide](#hardening-guide-for-organisations)).
- Everything the app stores stays in one data folder that is private to your user account.
- Method scripts from project files run in an isolated **QuickJS (WebAssembly) sandbox**, and only after
  you trusted them.
- Installers are **not code-signed yet**. Every release has `SHA256SUMS.txt`, a CycloneDX SBOM and a
  GitHub build-provenance attestation, so you can check a download (see [Unsigned builds](#unsigned-builds-and-how-to-verify-them)).

Contents: [Network behaviour](#network-behaviour) · [Data on disk](#data-stored-on-disk) ·
[Default settings](#default-settings-and-their-risks) · [Hardening guide](#hardening-guide-for-organisations) ·
[Method scripts](#method-scripts) · [Electron hardening](#electron-hardening) · [Linux sandbox](#linux-sandbox) ·
[Third-party components](#third-party-components) · [Unsigned builds](#unsigned-builds-and-how-to-verify-them) ·
[Reporting a vulnerability](#reporting-a-vulnerability)

---

## Network behaviour

This is the complete list of network activity.

| When | What | Direction |
|---|---|---|
| App start (desktop, headless, Docker) | Nothing. Chromium's background services are switched off (`disable-background-networking`, `disable-component-update`, `disable-domain-reliability`, `no-pings`), the spell checker is off (no dictionary download) and every permission request (camera, microphone, location, notifications ...) is refused. | – |
| You start the OPC UA server | Listens on TCP port 4840 (or the port you choose) on **all network interfaces**, or on 127.0.0.1 only with *Listen on: This computer only* / `--listen localhost`. To build its endpoint URLs and certificate the server looks up this machine's own host name and IP addresses through the operating system's resolver; depending on your DNS setup that lookup can reach your local DNS server. | inbound |
| Optional, **off by default**: *Register with a Local Discovery Server* | Connects to the LDS URL you configure (default `opc.tcp://localhost:4840`). | outbound |
| Optional, **off by default**: *Run a Local Discovery Server* | Listens on TCP port 4841 (per the listen setting). node-opcua's discovery server also announces itself with multicast DNS (mDNS, UDP port 5353) on the local network and listens for other servers' mDNS announcements. | inbound / multicast |
| You connect in the built-in **Client** | Connects only to the endpoint URL you enter (GetEndpoints, session, browse, subscriptions ...). | outbound |
| You click a link (Help menu, *SECURITY.md* button) | Opens the https link in your default browser. Only https links are allowed; the app window never navigates away or opens new windows. | browser |

What the review measured (packet capture of all non-loopback traffic, fresh profile, no user action):
the headless simulator and the Docker image produced **zero** packets (no DNS, no outbound TCP, no
multicast). Version 1.0.0 of the desktop app downloaded the spell-check dictionary from
`redirector.gvt1.com` (Google) on its first start; 1.1.0 turns the spell checker and the download off.
We recommend that you verify this yourself with a firewall or packet capture.

Headless mode on Linux and the Docker image start no Chromium at all (the packaged Linux app runs
`src/cli.js` with Electron's built-in Node.js; the Docker image uses plain Node.js).

---

## Data stored on disk

Everything lives in one data folder:

| Mode | Folder |
|---|---|
| Desktop, Windows | `%APPDATA%\OPC UA Simulator` |
| Desktop, macOS | `~/Library/Application Support/OPC UA Simulator` |
| Desktop, Linux | `~/.config/OPC UA Simulator` (or `$XDG_CONFIG_HOME/OPC UA Simulator`) |
| Headless, installed app (`opcua-simulator --headless`) | the same folder as the desktop app on that system, or `--data-dir` / `OPCUA_DATA_DIR` |
| Headless from source (`node src/cli.js`) | `~/.opcua-simulator`, or `--data-dir` / `OPCUA_DATA_DIR` |
| Docker | `/data` (the `opcua-data` volume) |

| File / folder | Contents |
|---|---|
| `settings.json` | Window position, welcome / auto-start flags, and the SHA-256 hashes of method-script sets you trusted on this computer (never part of project files). |
| `last-project.json` | Automatic copy of the open project (desktop), **including server user names and passwords**. |
| `*.opcuasim` | Project files you save, wherever you save them. They contain the full configuration, including user names, **passwords** and method scripts. |
| `logs/simulator.log`, `logs/headless.log` | Server start/stop, sessions (client application names, user names, client IP addresses), values written by clients, errors. Rotated at 5 MB, one older file kept. Control characters in log text (for example in names a client sends) are escaped and long text is cut, so a client cannot forge log lines. |
| `history/history.db` (+ `-wal`, `-shm`) | Recorded value history of historizing variables and the event history of the Server object and project objects (by default up to 100 000 values per variable and 100 000 events per object; any limit from 0 = off to 1 000 000 in *Configuration → History*, or headless `--value-history-size` / `--event-history-size`). Kept across restarts; nothing is sent anywhere. Deleted only when you use *Clear …* in the app or start headless with `--clear-history` (or delete the folder). Event history contains event messages and source names, which can include values clients wrote. |
| `pki/server` | The server's application certificate and **private key**, trusted / rejected client application certificates, imported CA certificates. |
| `pki/user` | Trusted / rejected X.509 user certificates. |
| `pki/client` | The built-in client's certificate and private key, trusted / rejected server certificates. |
| Chromium profile (desktop) | Local storage (theme, recently used client URLs), caches. The app stores no cookies; the cookie store would be encrypted with the operating system's key store (Electron fuse, see below). |

Protection:

- **macOS / Linux**: the data folder is `0700` and the files the app writes (settings, project copies,
  saved projects, logs, history database, private keys) are `0600`, so other local users cannot read them. The Docker
  image's `/data` is owned by the unprivileged `node` user (uid 1000, group 0, no access for others).
- **Windows**: the folder is inside your user profile and protected by its permissions.
- The app does **not encrypt** passwords at rest: the OPC UA server has to compare them. Do not reuse
  real passwords in a simulator project, use full-disk encryption, and remember that a project file you
  share contains its user passwords. Logs and the banner never print passwords (except the well-known
  demo passwords, as a hint that they are in use).

---

## Default settings and their risks

The demo template is optimised for "start and connect in one minute". The app shows a warning card on
the Dashboard (and the headless banner prints warnings) whenever one of the risky settings below is active.

| Setting | Demo default | Risk | Secure preset / recommendation |
|---|---|---|---|
| Security policies | None **and** Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss | `None` sends values unencrypted and unsigned. | Only the three encrypted policies, modes Sign and SignAndEncrypt. |
| Anonymous login | allowed, **read and write** | Anyone who reaches the port can write values, call methods and acknowledge or disable alarms. | Anonymous off; if you need it, *Anonymous users can: Only read*. |
| Demo users | `admin/admin`, `operator/operator`, `viewer/viewer` | Well-known passwords. | Delete them or set strong passwords (Configuration → User Authentication). |
| Roles | admin = ConfigureAdmin, operator = Operator, viewer = Observer | – | Observer can only read; Operator, Engineer, Supervisor, ConfigureAdmin and SecurityAdmin can read, write and call methods; a user without a role can read and write. |
| Unknown client application certificates | trusted automatically | Any client certificate is accepted. | Off: trust each client in Certificates → Server application PKI → Rejected. |
| X.509 user certificates | **never** trusted automatically | – | Trust them in Certificates → User → Rejected. |
| Listen address | all network interfaces | Reachable from the network. | *This computer only* when all clients run on the same machine. |
| Advertise IP addresses | on | Endpoint URLs show the machine's IP addresses. | Set host names / advertised URLs explicitly. |
| LDS registration / discovery server | off | – | Keep off. |
| Method scripts | run; scripts of templates and of your own edits are trusted, scripts in project files from others need your approval | A script is code from the project author. | Review in the trust dialog, or start with scripts disabled (`--no-scripts`). |
| Built-in client: server certificates | never trusted automatically (you are asked; the simulator's own server certificate is accepted) | – | Check the thumbprint before you trust a server. |
| Start server automatically | off | – | – |

---

## Hardening guide for organisations

1. **Secure preset.** Welcome wizard → *Secure (for organisations)*, or Configuration → Security →
   *Apply secure settings*. It allows only encrypted endpoints (Sign / SignAndEncrypt), turns anonymous
   login off (anonymous access read-only if you turn it back on), stops trusting unknown client
   certificates automatically, and turns LDS registration and the discovery server off.
2. **Listen address.** Configuration → Startup & Network → *Listen on: This computer only* when clients
   run on the same machine. Otherwise allow the port in the firewall only from the client hosts.
3. **Users.** Replace the demo users with your own, with strong passwords, and give read-only users the
   Observer role.
4. **Certificates.** Keep automatic trust off. Trust client application certificates and X.509 user
   certificates explicitly (Certificates view), or import your CA. After a host name / IP change use
   *Regenerate server certificate*.
5. **Method scripts.** Review scripts in the trust dialog before you start a project from someone else,
   or choose *Start with scripts disabled*. Headless: `--no-scripts`.
6. **Headless servers** (systemd, VMs):
   ```bash
   opcua-simulator --headless --secure --listen localhost --no-scripts --project /srv/plant.opcuasim
   # or with environment variables: OPCUA_SECURE=1 OPCUA_LISTEN=localhost OPCUA_NO_SCRIPTS=1
   ```
   Run it as a dedicated unprivileged user; the data folder is created private to that user.
7. **Docker.** `OPCUA_SECURE=1 docker compose up -d`. The image runs as uid 1000 without Linux
   capabilities (`cap_drop: ALL`, `no-new-privileges` in `docker-compose.yml`), has no npm / yarn, and its
   base image is pinned by digest. To expose it only to the Docker host, publish
   `127.0.0.1:4840:4840`. Inside the container keep listening on all interfaces (do not set
   `OPCUA_LISTEN=localhost` there, the published port would not reach it).
8. **CI pipelines.** Start the simulator next to your tests with `--listen localhost` and a project file
   from your repository, so nothing outside the runner can connect, e.g.
   `node src/cli.js --listen localhost --port 4840 --project test/plant.opcuasim`.
9. **Developer tools** are off in installed builds. For troubleshooting only, start the app with the
   environment variable `OPCUA_SIM_DEVTOOLS=1`.
10. **Logs** contain user names, client IP addresses and written values; apply your retention rules to
    the `logs` folder.

---

## Method scripts

Methods can be implemented with small JavaScript snippets stored in the project. Since 1.1.0 they run in
**QuickJS compiled to WebAssembly** (`quickjs-emscripten`), not in the app's own JavaScript engine:

- The script sees only its `inputs` and three functions: `getValue(path)`, `setValue(path, value)` and
  `log(message)`. Values cross the boundary as JSON. No files, network, processes, `require` or host objects.
- Per call: 1 second time limit, 32 MB memory limit, at most 10,000 host calls. A script that breaks a
  limit or throws makes the method return `BadInternalError` and writes a log line.
- **Trust:** when a project has scripts that were not written or approved on this computer (for example
  a project file from someone else), the app lists every script and asks *Trust and start*, *Start with
  scripts disabled* or *Cancel*. The approval is stored as a hash in `settings.json`; a changed script
  needs a new approval. With scripts disabled, methods that have a script return `BadUserAccessDenied`.
- Headless mode has no prompt: use `--no-scripts` for projects you did not write.

---

## Electron hardening

The desktop app is an Electron 45 application:

- One window with `contextIsolation`, renderer `sandbox`, no Node.js in the renderer, a fixed preload
  API, and a Content-Security-Policy that allows only the app's own files (no remote scripts, styles,
  fonts, frames or connections).
- Navigation and new windows are blocked; external links open in the browser and must be https.
- Every permission request (camera, microphone, geolocation, notifications, ...) is refused.
- Spell checker and Chromium background networking are off (see [Network behaviour](#network-behaviour)).
- Developer tools are not available in installed builds unless `OPCUA_SIM_DEVTOOLS=1` is set.

### Electron fuses

Fuses are switches compiled into the Electron binary that cannot be changed at runtime. The installers
are built with:

| Fuse | Setting | Effect |
|---|---|---|
| RunAsNode | **on** (needed) | `ELECTRON_RUN_AS_NODE=1` turns the binary into a Node.js interpreter. The Linux packages need it: `opcua-simulator --headless` (and the automatic headless mode when there is no display) runs the simulator with Electron's built-in Node.js, so servers start no Chromium processes and need no graphical libraries at runtime. Consequence: a local user who can already run programs can use the installed binary like `node`; take this into account in application-control (AppLocker / WDAC / Santa) rules, as you would for an allowed `node.exe`. |
| EnableNodeOptionsEnvironmentVariable | off | `NODE_OPTIONS` (and `NODE_EXTRA_CA_CERTS`) are ignored, so no code can be injected into the app through the environment. |
| EnableNodeCliInspectArguments | off | `--inspect` / `--inspect-brk` and `SIGUSR1` cannot attach a debugger to the running app. |
| EnableEmbeddedAsarIntegrityValidation | on | macOS and Windows check the hash of `app.asar` at startup and of every file read from it; a modified archive stops the app. (Without a code signature an attacker who can write the app folder can also update the stored hash; the check becomes a real protection together with code signing.) |
| OnlyLoadAppFromAsar | on | The app code is loaded only from `app.asar`, never from a planted `app` folder. |
| EnableCookieEncryption | on | Chromium's cookie store is encrypted with the operating system's key store (the app itself stores no cookies). |
| GrantFileProtocolExtraPrivileges | default (on) | The UI is loaded from `file://` inside `app.asar`, which needs this; turning it off would require serving the UI from a custom protocol. |

Check the fuses of an installed copy with
`npx @electron/fuses read --app "/Applications/OPC UA Simulator.app"` (Windows: the `.exe`; Linux:
`/opt/OPC UA Simulator/opcua-simulator.bin`). CI checks them after every build (`scripts/verify-build.js`).

### Linux sandbox

Chromium's sandbox isolates the window's renderer process from the system. On Linux it needs
unprivileged user namespaces (or a root-owned SUID helper). The launcher in front of the Linux binary
(`build/afterPack.js`) keeps the sandbox **on** and turns it off only when it cannot work:

- the app runs as **root** (Chromium refuses to start sandboxed as root), or
- user namespaces are not available: disabled in the kernel (`kernel.unprivileged_userns_clone=0`,
  `user.max_user_namespaces=0`), not allowed in a container (`unshare -Ur true` fails), or Ubuntu
  23.10+'s AppArmor restriction (`kernel.apparmor_restrict_unprivileged_userns=1`) applies because the
  program has no AppArmor profile — and no usable SUID `chrome-sandbox` helper exists either.

In those cases the launcher prints one line (`Chromium sandbox disabled: <reason>`) and adds it to
`logs/simulator.log`; normally it prints nothing. `--no-sandbox` or `ELECTRON_DISABLE_SANDBOX=1` turn the
sandbox off on request (e.g. in containers).

How to keep the sandbox on:

- **.deb**: installs an AppArmor profile (`/etc/apparmor.d/opcua-simulator`) that allows user namespaces
  for the app, so the sandbox works on Ubuntu 23.10+ for normal users.
- **AppImage / .tar.gz on Ubuntu 23.10+**: extract the app to a fixed folder (e.g. `/opt/opcua-simulator`)
  and add a profile named `opcua-simulator`, then `sudo apparmor_parser -r /etc/apparmor.d/opcua-simulator`:
  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile opcua-simulator /opt/opcua-simulator/opcua-simulator{,.bin} flags=(unconfined) {
    userns,
    include if exists <local/opcua-simulator>
  }
  ```
- Other distributions (Debian, Fedora, RHEL 8+, ...) allow user namespaces by default.
- Start the desktop app as a normal user, not as root.

The sandbox setting does not affect headless mode, which starts no Chromium processes.

---

## Third-party components

| Component | Version | Notes |
|---|---|---|
| Electron (desktop installers only) | 45.0.0: Chromium 156.0.8078.48, Node.js 24.22.0 | Newest Electron at release time. Node.js 24.22.1 (2026-10-20, TLS / DNS fixes) is not in any Electron release yet; the simulator uses OPC UA over `opc.tcp` with node-opcua's own cryptography, not Node's TLS or `dns.resolve`. Updated when Electron ships it. |
| node-opcua, node-opcua-crypto | 2.187.x, 6.2.x | OPC UA stack (server, client, PKI). About 140 transitive npm packages, all with permissive licences (MIT, BSD, ISC, Apache-2.0, 0BSD, Unlicense). |
| quickjs-emscripten-core, @jitl/quickjs-wasmfile-release-sync | 0.32.0 | QuickJS in WebAssembly for method scripts (MIT). |
| Docker base image | `node:22-bookworm-slim`, pinned by digest | npm, npx, yarn and corepack are removed from the runtime image. |

- **SBOM:** every release has `OPCUA-Simulator-<version>-sbom.cdx.json` (CycloneDX 1.6). It lists exactly
  the npm packages inside `app.asar` (generated with `@cyclonedx/cyclonedx-npm`; `npm sbom` misses
  packages) plus the bundled Electron, Chromium and Node.js with CPE identifiers for vulnerability scanners.
- **Licence notices:** `LICENSE.electron.txt` and `LICENSES.chromium.html` are in every installation
  (macOS: inside the app, `Contents/Resources`). Three old packages without a licence field are declared
  in the SBOM from their licence files: dequeue (BSD-2-Clause), humanize (MIT), precond (MIT). Electron's
  media library (libffmpeg) is included by Electron but not used by the app.
- **Dormant code:** node-opcua-pki contains a Windows helper that would download OpenSSL from GitHub
  without a checksum, but only for its OpenSSL-based certificate-authority tools. The app never uses
  them (it uses the pure-JavaScript certificate code), and CI fails if `src/` ever references them.
- **Build pipeline** (`.github/workflows/build.yml`): read-only token except for the release step;
  every GitHub Action pinned to a commit SHA; `npm ci` with the lockfile (sha512 integrity for every
  package) and without install scripts; `npm audit --omit=dev --audit-level=high` and
  `npm audit signatures` must pass; Dependabot proposes npm, GitHub Actions and Docker updates weekly.
- **Running from source** (`Start Simulator` scripts, `npm install`) needs internet access once: npm
  installs the locked versions from registry.npmjs.org, and Electron's binary is downloaded from GitHub
  and checked against the checksums shipped in the `electron` package. Air-gapped sites should use the
  installers or the Docker image.

---

## Unsigned builds and how to verify them

The installers are not signed with a paid certificate yet: the macOS app has only an ad-hoc signature
and is not notarised, the Windows `.exe` files have no Authenticode signature. macOS Gatekeeper and
Windows SmartScreen therefore ask once before the first start, and publisher-based allow rules cannot
be used. Before you allow the start, check the file:

1. **Checksum** — download `SHA256SUMS.txt` from the same release and run, in the download folder:
   - Linux: `sha256sum -c SHA256SUMS.txt --ignore-missing`
   - macOS: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`
   - Windows (PowerShell): `Get-FileHash .\OPCUA-Simulator-Setup-1.1.0-x64.exe` and compare the hash
     with the line in `SHA256SUMS.txt`.
2. **Build provenance** — proves the file was built by this repository's GitHub Actions workflow from
   the tagged commit (Sigstore-signed attestation):
   `gh attestation verify OPCUA-Simulator-Setup-1.1.0-x64.exe --repo Manjuhombaradi/opcua-simulator`
3. **Allow-listing** — use hash rules with the values from `SHA256SUMS.txt` (they change with every
   release).

Organisations that need signed builds can build from source and sign with their own certificate:
electron-builder supports Apple Developer ID signing with `mac.hardenedRuntime: true` and notarisation,
and Windows Authenticode / Azure Trusted Signing (`win.signtoolOptions`, `win.azureSignOptions`) in the
`build` section of `package.json`. With a signature, the ASAR integrity check above also protects
against modified app files.

---

## Reporting a vulnerability

Please report security problems privately through GitHub: open
<https://github.com/Manjuhombaradi/opcua-simulator>, go to the **Security** tab and click
**Report a vulnerability**. Do not open a public issue for security problems.

If you cannot use GitHub, e-mail Manjunagouda Hombaradi at <manjuhombaradi@gmail.com> (please do not include real secrets or customer data).

Include the version, operating system, what an attacker can do, and steps or a project file to
reproduce it. You will get an answer as soon as possible; fixes are published as a new release with a
note in the release text. Only the latest release receives security fixes.
