"use strict";
const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, method, args) {
    const res = await ipcRenderer.invoke(channel, method, args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
}

contextBridge.exposeInMainWorld("api", {
    server: (method, ...args) => call("server", method, args),
    client: (method, ...args) => call("client", method, args),
    app: (method, ...args) => call("app", method, args),
    on: (channel, cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    }
});
