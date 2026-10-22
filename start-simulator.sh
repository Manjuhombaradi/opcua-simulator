#!/usr/bin/env bash
# Linux/macOS: run the simulator from source (installs dependencies on first run).
#   ./start-simulator.sh              desktop window
#   ./start-simulator.sh --headless   no window (servers / VMs without desktop)
cd "$(dirname "$0")" || exit 1
ALTERNATIVES="Or use a ready-made package instead: .deb / AppImage (Linux), .dmg (macOS), or Docker (docker compose up -d)."
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 22.13 or newer is required: https://nodejs.org (Linux: https://github.com/nodesource/distributions)."
    echo "$ALTERNATIVES"
    exit 1
fi
# node-opcua and Electron's installer need Node.js >= 22.13 (distribution packages are often older)
if ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)' 2>/dev/null; then
    echo "Node.js 22.13 or newer is required, found $(node -v 2>/dev/null || echo "an unknown version")."
    echo "Install the current LTS from https://nodejs.org (Linux: https://github.com/nodesource/distributions)."
    echo "$ALTERNATIVES"
    exit 1
fi

# node_modules must match this OS / CPU (Electron's binary is platform specific): a folder copied from
# or shared with another machine is reinstalled once.
SYSTEM="$(uname -s)-$(uname -m)"
if [ "$(uname -s)" = "Darwin" ]; then ELECTRON_BINARY="Electron.app/Contents/MacOS/Electron"; else ELECTRON_BINARY="electron"; fi
INSTALL=""
if [ ! -d node_modules ]; then
    INSTALL="First run: installing dependencies (one time, needs internet)..."
elif [ "$(cat node_modules/.installed-for 2>/dev/null)" != "$SYSTEM" ]; then
    if [ -f node_modules/.installed-for ] || { [ -f node_modules/electron/path.txt ] && [ "$(cat node_modules/electron/path.txt)" != "$ELECTRON_BINARY" ]; }; then
        INSTALL="node_modules was installed on another system - reinstalling for $SYSTEM (one time, needs internet)..."
        # Electron downloads the binary for this system on the next start
        rm -rf node_modules/electron/dist node_modules/electron/path.txt
    else
        # no marker yet: an earlier install may have been interrupted - npm install completes it (quick when complete)
        INSTALL="Checking dependencies (one time)..."
    fi
fi
if [ -n "$INSTALL" ]; then
    echo "$INSTALL"
    npm install --no-audit --no-fund || exit 1
    echo "$SYSTEM" > node_modules/.installed-for
fi

for ARG in "$@"; do
    if [ "$ARG" = "--headless" ]; then exec node src/cli.js "$@"; fi
done
# no display: fall back to headless mode instead of failing
if [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
    echo "No graphical display found - starting in headless mode (use --help for options)."
    exec node src/cli.js "$@"
fi
exec npm start -- "$@"
