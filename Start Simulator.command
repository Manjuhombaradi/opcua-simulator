#!/bin/bash
# macOS: double-click to run the simulator from source (installs dependencies on first run).
cd "$(dirname "$0")" || exit 1
fail() {
    osascript -e "display alert \"OPC UA Simulator\" message \"$1\"" >/dev/null 2>&1
    echo "$1"
    read -r -p "Press Enter to close"
    exit 1
}
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js 22.13 or newer is required: install the LTS version from https://nodejs.org, or use the ready-made OPC UA Simulator .dmg instead."
fi
# node-opcua and Electron's installer need Node.js >= 22.13
if ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)' 2>/dev/null; then
    fail "Node.js 22.13 or newer is required (found $(node -v 2>/dev/null)): install the LTS version from https://nodejs.org, or use the ready-made OPC UA Simulator .dmg instead."
fi

# node_modules must match this Mac (Electron's binary is platform specific): a folder copied from
# or shared with another machine is reinstalled once.
SYSTEM="$(uname -s)-$(uname -m)"
INSTALL=""
if [ ! -d node_modules ]; then
    INSTALL="First run: installing dependencies (one time, needs internet)..."
elif [ "$(cat node_modules/.installed-for 2>/dev/null)" != "$SYSTEM" ]; then
    if [ -f node_modules/.installed-for ] || { [ -f node_modules/electron/path.txt ] && [ "$(cat node_modules/electron/path.txt)" != "Electron.app/Contents/MacOS/Electron" ]; }; then
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
    npm install --no-audit --no-fund || fail "npm install failed - check the internet connection and try again."
    echo "$SYSTEM" > node_modules/.installed-for
fi
npm start -- "$@"
