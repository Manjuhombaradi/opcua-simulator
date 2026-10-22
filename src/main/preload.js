"use strict";
const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, method, args) {
    const res = await ipcRenderer.invoke(channel, method, args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
}

// Channels main sends to the window (nothing else can be subscribed to).
const EVENTS = new Set(["server-status", "client-status", "client-data", "client-event", "client-keepalive", "log-batch", "menu", "open-file"]);

contextBridge.exposeInMainWorld("api", {
    server: (method, ...args) => call("server", method, args),
    client: (method, ...args) => call("client", method, args),
    app: (method, ...args) => call("app", method, args),
    on: (channel, cb) => {
        if (!EVENTS.has(channel)) throw new Error(`Unknown event channel ${channel}`);
        const listener = (_e, data) => cb(data);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    }
});
