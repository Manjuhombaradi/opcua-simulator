"use strict";
/* Small DOM + UI helpers shared by all views. All text goes into text nodes (no HTML parsing of any value). */

function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
            else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === "value") el.value = v;
            else if (k === "checked") el.checked = !!v;
            else if (k === "dataset") Object.assign(el.dataset, v);
            else el.setAttribute(k, v === true ? "" : v);
        }
    }
    appendChildren(el, children);
    return el;
}

function appendChildren(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

function toast(message, type = "info", timeout = 3500) {
    const el = h("div", { class: `toast ${type}` }, message);
    document.getElementById("toasts").appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? Math.max(timeout, 6000) : timeout);
}

// Runs an async action and reports errors as toasts. Returns the result or undefined.
async function attempt(fn, successMessage) {
    try {
        const r = await fn();
        if (successMessage) toast(typeof successMessage === "function" ? successMessage(r) : successMessage, "success");
        return r;
    } catch (err) {
        toast(err.message || String(err), "error");
        return undefined;
    }
}

/**
 * Opens a modal. `buttons` is a list of { label, class, value, onClick }.
 * Returns a promise resolving with the clicked button's value (or onClick result), or null when dismissed.
 * onClick may return false to keep the modal open.
 */
function modal({ title, body, buttons = [{ label: "Close", value: null }], wide = false }) {
    return new Promise((resolve) => {
        const root = document.getElementById("modal-root");
        const close = (v) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
        // Escape closes only the topmost modal (a dialog opened from another dialog must not close both)
        const onKey = (e) => {
            if (e.key !== "Escape" || root.lastElementChild !== backdrop) return;
            e.stopImmediatePropagation();
            close(null);
        };
        const foot = h("div", { class: "modal-foot" });
        for (const b of buttons) {
            const btn = h("button", { class: `btn ${b.class || ""}` }, b.label);
            btn.addEventListener("click", async () => {
                if (b.onClick) {
                    btn.disabled = true;
                    try {
                        const r = await b.onClick();
                        if (r === false) { btn.disabled = false; return; }
                        close(r === undefined ? b.value : r);
                    } catch (err) {
                        toast(err.message, "error");
                        btn.disabled = false;
                    }
                } else close(b.value);
            });
            foot.appendChild(btn);
        }
        const backdrop = h("div", { class: "modal-backdrop" },
            h("div", { class: `modal ${wide ? "wide" : ""}` },
                h("div", { class: "modal-head" }, h("h3", null, title), h("button", { class: "btn ghost icon", onclick: () => close(null) }, "✕")),
                h("div", { class: "modal-body" }, body),
                foot));
        backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(null); });
        document.addEventListener("keydown", onKey);
        root.appendChild(backdrop);
        const first = backdrop.querySelector("input, select, textarea");
        if (first) setTimeout(() => first.focus(), 30);
    });
}

function confirmDialog(title, message, okLabel = "OK", danger = false) {
    return modal({
        title,
        body: h("div", null, message),
        buttons: [{ label: "Cancel", value: false }, { label: okLabel, class: danger ? "danger" : "primary", value: true }]
    });
}

function field(label, input, hint) {
    return h("div", { class: "field" }, h("label", null, label), input, hint ? h("div", { class: "hint" }, hint) : null);
}

function select(options, value, attrs = {}) {
    const el = h("select", attrs);
    for (const o of options) {
        const opt = typeof o === "object" ? o : { value: o, label: o };
        el.appendChild(h("option", { value: opt.value }, opt.label));
    }
    if (value !== undefined) el.value = value;
    return el;
}

function checkbox(label, checked, onChange) {
    const input = h("input", { type: "checkbox", checked });
    if (onChange) input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "check" }, input, label);
}

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

// "1 method script", "3 method scripts"
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

function fmtTime(iso, withDate = false) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    const today = new Date().toDateString() === d.toDateString();
    return withDate || !today ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

// Value for <input type="datetime-local" step="0.001">
function toLocalInput(date) {
    const d = date ? new Date(date) : new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Most times one "values at specific times" read may ask for (the client sends them in requests of 1000).
const MAX_AT_TIMES = 10000;
// Most stored values one raw history read returns (clientEngine.historyRead maxValues default).
const RAW_READ_MAX = 100000;

// Times typed one per line -> ISO strings. Accepts "2026-10-22 14:05:30.250" / "2026-10-22T14:05:30" (local time),
// ISO times with Z or an offset, "14:05:30" (today, local), epoch milliseconds, and "-30s" / "-5m" / "+1h" (relative to now).
function parseTimeList(text) {
    const out = [];
    const now = Date.now();
    String(text || "").split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line) return;
        let d = null;
        let m;
        if ((m = line.match(/^([+-]\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i))) {
            d = new Date(now + Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()]);
        } else if ((m = line.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/))) {
            d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +(m[7] || "0").padEnd(3, "0"));
            // no silent roll-over (2026-02-30 -> March 2)
            if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3] || d.getHours() !== +m[4] || d.getMinutes() !== +m[5]) d = null;
        } else if ((m = line.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/))) {
            d = +m[1] < 24 && +m[2] < 60 && +(m[3] || 0) < 60 ? new Date(now) : null;
            if (d) d.setHours(+m[1], +m[2], +(m[3] || 0), +(m[4] || "0").padEnd(3, "0"));
        } else if (/^\d{11,}$/.test(line)) {
            d = new Date(Number(line));
        } else {
            d = new Date(line);
        }
        if (!d || isNaN(d.getTime())) throw new Error(`Line ${i + 1}: “${line}” is not a time`);
        out.push(d.toISOString());
    });
    if (!out.length) throw new Error("Enter at least one time");
    if (out.length > MAX_AT_TIMES) throw new Error(`${out.length.toLocaleString()} times; at most ${MAX_AT_TIMES.toLocaleString()} per read`);
    return out;
}

// Table of saved events [{ time, eventType, sourceName, severity, message, conditionName }] (event history views).
function eventHistoryTable(events) {
    const sev = (s) => (s === null || s === undefined || s === "" ? "" : h("span", { class: `badge ${s >= 700 ? "bad" : s >= 400 ? "warn" : "info"}` }, s));
    return h("table", null,
        h("thead", null, h("tr", null, ["Time", "Type", "Source", "Severity", "Message", "Condition"].map((x) => h("th", null, x)))),
        h("tbody", null, events.map((e) => h("tr", null,
            h("td", { class: "mono small", style: { whiteSpace: "nowrap" } }, fmtTime(e.time, true)),
            h("td", { class: "small" }, e.eventType || ""),
            h("td", null, e.sourceName || ""),
            h("td", { class: "num" }, sev(e.severity)),
            h("td", { class: "small", style: { maxWidth: "320px", overflowWrap: "anywhere" } }, e.message || ""),
            h("td", { class: "small" }, e.conditionName || "")))));
}

// 1536 -> "1.5 KB"
function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let x = v / 1024, i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (d ? `${d}d ` : "") + `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function fmtValue(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

// A stored history entry without value that marks a stop of the recording (BadDataLost: the server stopped, or a run
// ended without stopping, e.g. a crash), not a value of the variable.
function isHistoryGap(d) {
    return !!d && (d.value === null || d.value === undefined) && /^BadDataLost/.test(String(d.statusCode || ""));
}

// Table cell content for the value of a history entry
function historyValueCell(d) {
    if (isHistoryGap(d)) return h("span", { class: "muted", title: "BadDataLost: no values were recorded from here until the next value (the server was stopped, or value history was off)" }, "— server stopped");
    // a Bad entry without value (e.g. BadBoundNotFound)
    if ((d.value === null || d.value === undefined) && /^Bad/.test(String(d.statusCode || ""))) return h("span", { class: "muted" }, "—");
    return fmtValue(d.value);
}

function statusClass(name) {
    if (!name || name === "Good" || name.startsWith("Good")) return "good";
    if (name.startsWith("Uncertain")) return "warn";
    return "bad";
}

function statusBadge(name) {
    return h("span", { class: `badge ${statusClass(name)}` }, name || "Good");
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Through main: the page itself has no clipboard permission.
function copyText(text) {
    api.app("copyText", String(text)).then(() => toast(`Copied: ${text}`, "success", 1800), (err) => toast(err.message, "error"));
}

// True when a user still has one of the well-known demo log-ins (admin/admin, operator/operator, viewer/viewer).
function isDemoLogin(u) {
    return (App.meta?.demoUsers || []).some((d) => d.username === u.username && d.password === u.password);
}

// Logins offered by a server configuration, e.g. "Anonymous, admin/admin · operator/operator".
// Only the public demo passwords are shown; a password the user set appears as "name (own password)".
function loginSummary(cfg) {
    const users = cfg.allowUsername ? (cfg.users || []).filter((u) => u.username) : [];
    const parts = [];
    if (cfg.allowAnonymous) parts.push(cfg.anonymousAccess === "readonly" ? "Anonymous (read only)" : "Anonymous");
    if (users.length) parts.push(users.slice(0, 4).map((u) => (isDemoLogin(u) ? `${u.username}/${u.password}` : `${u.username} (own password)`)).join(" · ") + (users.length > 4 ? ` · +${users.length - 4} more` : ""));
    if (cfg.allowCertificate) parts.push("X509 certificate");
    return parts.join(", ") || "no login type enabled (see Configuration → User Authentication)";
}

// Password input, masked, with a show / hide button. `onInput(value)` runs on every change.
function passwordInput(value, onInput, attrs = {}) {
    const input = h("input", { type: "password", value: value ?? "", autocomplete: "off", spellcheck: "false", ...attrs });
    if (onInput) input.addEventListener("input", () => onInput(input.value));
    const toggle = h("button", { type: "button", class: "btn ghost icon small", title: "Show password", "aria-label": "Show password", disabled: attrs.disabled }, icon("eye"));
    toggle.addEventListener("click", () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        toggle.title = show ? "Hide password" : "Show password";
        toggle.setAttribute("aria-label", toggle.title);
        toggle.classList.toggle("active", show);
    });
    return h("span", { class: "password-field" }, input, toggle);
}

// A random password that is easy to type (no look-alike characters).
function randomPassword(length = 16) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return [...bytes].map((b) => chars[b % chars.length]).join("");
}

// The "Secure (for organisations)" preset (from the engine) applied to a server configuration.
function applySecurePreset(cfg) {
    for (const [k, v] of Object.entries(App.meta.securePreset || {})) cfg[k] = Array.isArray(v) ? [...v] : v;
    return cfg;
}
// True when the server configuration has every setting of the secure preset.
function matchesSecurePreset(cfg) {
    const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x));
    const preset = App.meta.securePreset || {};
    return Object.keys(preset).length > 0 && Object.entries(preset).every(([k, v]) => (Array.isArray(v) ? same(cfg[k] || [], v) : cfg[k] === v));
}
// What the secure preset changes, in words (shown before applying it).
const SECURE_PRESET_TEXT = [
    "Only signed and encrypted endpoints (Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss; Sign, SignAndEncrypt) — no SecurityPolicy None.",
    "No anonymous login; clients log in with a user name and password or an X509 user certificate.",
    "Unknown client certificates are rejected until you trust them in Certificates.",
    "No registration with a Local Discovery Server and no built-in discovery server."
];

// List of security warnings [{ text, level }] (or strings).
function warningList(warnings) {
    return h("ul", { class: "warning-list" }, (warnings || []).map((w) => {
        const text = typeof w === "string" ? w : w.text;
        const level = typeof w === "string" ? "warn" : w.level || "warn";
        return h("li", { class: `warning-item ${level === "info" ? "info" : "warn"}` }, text);
    }));
}

/*
 * Inline SVG icons (24×24 grid, drawn in currentColor, 1em in size).
 * Used instead of emoji, which show up as empty boxes on Linux desktops / VNC sessions without an emoji font.
 * Each entry is a list of path data strings or [tag, attributes] pairs.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
    folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
    folders: ["M7 6V5a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2",
        "M3 10a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
    "folder-open": ["M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1",
        "M5 19l2.6-7.2A1.5 1.5 0 0 1 9 11h11.5a1 1 0 0 1 .9 1.4L19 18a1.6 1.6 0 0 1-1.5 1z"],
    lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], "M8 11V7a4 4 0 0 1 8 0v4", "M12 15v2"],
    factory: ["M3 21V11l5 3v-3l5 3v-3l4 2.5V3h4v18z", "M7 17h2M11 17h2M15 17h2"],
    chart: ["M3 3v18h18", "M7 15l4-4 3 3 6-7"],
    eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", ["circle", { cx: 12, cy: 12, r: 3 }]],
    clock: [["circle", { cx: 12, cy: 12, r: 9 }], "M12 7v5l3 2"],
    trash: ["M3 6h18", "M8 6V4h8v2", "M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14", "M10 11v6M14 11v6"],
    search: [["circle", { cx: 11, cy: 11, r: 7 }], "M20 20l-4-4"],
    pause: [["rect", { x: 6, y: 5, width: 4, height: 14, rx: 1, fill: "currentColor", stroke: "none" }],
        ["rect", { x: 14, y: 5, width: 4, height: 14, rx: 1, fill: "currentColor", stroke: "none" }]],
    lightning: [["path", { d: "M13 2L4 14h7l-1 8 9-12h-7z", fill: "currentColor" }]],
    duplicate: [["rect", { x: 8, y: 8, width: 13, height: 13, rx: 2 }], "M4 16V5a2 2 0 0 1 2-2h11"],
    square: [["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2 }]]
};
function icon(name, attrs = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const base = { viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    for (const [k, v] of Object.entries({ ...base, ...attrs })) if (k !== "class") svg.setAttribute(k, v);
    svg.setAttribute("class", `svg-icon ${attrs.class || ""}`.trim());
    for (const part of ICONS[name] || []) {
        const [tag, a] = typeof part === "string" ? ["path", { d: part }] : part;
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
        svg.appendChild(el);
    }
    return svg;
}

// Text glyphs (all covered by DejaVu Sans) or ICONS names
const KIND_ICONS = { folder: "folder", object: "◆", variable: "●", method: "ƒ", alarm: "⚠", ObjectType: "▣", VariableType: "▢", DataType: "T", ReferenceType: "↔", View: "eye" };
function kindIcon(kind) {
    const k = { Object: "object", Variable: "variable", Method: "method" }[kind] || kind;
    const cls = { folder: "ic-folder", object: "ic-object", variable: "ic-variable", method: "ic-method", alarm: "ic-alarm" }[k] || "ic-type";
    const glyph = KIND_ICONS[k] || "•";
    return h("span", { class: `tree-icon ${cls}` }, ICONS[glyph] ? icon(glyph) : glyph);
}
