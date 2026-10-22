"use strict";
/* Minimal real-time trend chart drawn on a canvas. */
const CHART_COLORS = ["#2563eb", "#16a34a", "#f97316", "#a855f7", "#dc2626", "#0891b2", "#ca8a04", "#db2777"];

class TrendChart {
    constructor(container, { windowMs = 60000 } = {}) {
        this.windowMs = windowMs;
        this.series = new Map(); // key -> { label, color, points: [[t, v]] }
        this.box = h("div", { class: "chart-box" });
        this.canvas = h("canvas");
        this.box.appendChild(this.canvas);
        this.legend = h("div", { class: "legend" });
        container.appendChild(this.box);
        container.appendChild(this.legend);
        this.raf = null;
        this.resizeObserver = new ResizeObserver(() => this.draw());
        this.resizeObserver.observe(this.box);
        this.timer = setInterval(() => this.draw(), 500);
    }

    destroy() {
        clearInterval(this.timer);
        this.resizeObserver.disconnect();
    }

    ensureSeries(key, label) {
        if (!this.series.has(key)) {
            const color = CHART_COLORS[this.series.size % CHART_COLORS.length];
            this.series.set(key, { label, color, points: [] });
            this.renderLegend();
        }
        return this.series.get(key);
    }

    removeSeries(key) {
        this.series.delete(key);
        this.renderLegend();
        this.draw();
    }

    clearSeries() {
        this.series.clear();
        this.renderLegend();
        this.draw();
    }

    renderLegend() {
        clear(this.legend);
        for (const s of this.series.values()) this.legend.appendChild(h("span", { style: { "--c": s.color } }, s.label));
    }

    // Accepts numbers and booleans; other values are ignored.
    add(key, label, time, value) {
        let v = value;
        if (typeof v === "boolean") v = v ? 1 : 0;
        if (typeof v !== "number" || !isFinite(v)) return;
        const s = this.ensureSeries(key, label);
        s.points.push([new Date(time || Date.now()).getTime(), v]);
        const cutoff = Date.now() - this.windowMs * 2;
        while (s.points.length && s.points[0][0] < cutoff) s.points.shift();
    }

    // points: [[time, value, hollow?]]; a truthy third element draws that point as an open circle (e.g. interpolated).
    // A value of null breaks the line at that time (e.g. a history entry without value written when the server stopped).
    setPoints(key, label, points) {
        const s = this.ensureSeries(key, label);
        const all = points
            .filter(([t]) => t !== null && t !== undefined)
            .map(([t, v, hollow]) => [new Date(t).getTime(), typeof v === "boolean" ? (v ? 1 : 0) : v, !!hollow])
            .filter(([t]) => isFinite(t));
        s.points = all
            .filter(([, v]) => typeof v === "number" && isFinite(v))
            .sort((a, b) => a[0] - b[0]); // times typed in any order (ReadAtTime lists) are drawn left to right
        s.breaks = all.filter(([, v]) => v === null).map(([t]) => t).sort((a, b) => a - b);
        s.gap = gapThreshold(s.points);
        this.fixedRange = true;
        this.draw();
    }

    draw() {
        const c = this.canvas;
        const rect = this.box.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const dpr = window.devicePixelRatio || 1;
        c.width = rect.width * dpr;
        c.height = rect.height * dpr;
        const ctx = c.getContext("2d");
        ctx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;
        const pad = { l: 56, r: 12, t: 10, b: 24 };
        const css = getComputedStyle(document.documentElement);
        const gridColor = css.getPropertyValue("--border").trim();
        const textColor = css.getPropertyValue("--muted").trim();
        ctx.clearRect(0, 0, W, H);

        let tMax = Date.now(), tMin = tMax - this.windowMs;
        const all = [...this.series.values()].flatMap((s) => s.points);
        if (this.fixedRange && !all.length) {
            // a history read without numeric values: no axes (a time axis of "the last minute" would be made up)
            ctx.fillStyle = textColor;
            ctx.font = "11px -apple-system, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No numeric data to plot", W / 2, H / 2);
            return;
        }
        // loops, not Math.min(...list): history reads can return 100 000 points (too many call arguments)
        const range = (list, i) => list.reduce(([lo, hi], p) => [p[i] < lo ? p[i] : lo, p[i] > hi ? p[i] : hi], [Infinity, -Infinity]);
        if (this.fixedRange && all.length) {
            [tMin, tMax] = range(all, 0);
            if (tMax === tMin) tMax = tMin + 1000;
        }
        const visible = all.filter((p) => p[0] >= tMin);
        let [vMin, vMax] = range(visible, 1);
        if (!visible.length) { vMin = 0; vMax = 1; }
        if (vMin === vMax) { vMin -= 1; vMax += 1; }
        const span = vMax - vMin;
        vMin -= span * 0.05; vMax += span * 0.05;

        const x = (t) => pad.l + ((t - tMin) / (tMax - tMin)) * (W - pad.l - pad.r);
        const y = (v) => pad.t + (1 - (v - vMin) / (vMax - vMin)) * (H - pad.t - pad.b);

        ctx.font = "11px -apple-system, sans-serif";
        ctx.fillStyle = textColor;
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const v = vMin + ((vMax - vMin) * i) / 4;
            const yy = Math.round(y(v)) + 0.5;
            ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
            ctx.textAlign = "right";
            ctx.fillText(Math.abs(v) >= 1000 ? v.toExponential(2) : v.toFixed(2), pad.l - 6, yy + 4);
        }
        ctx.textAlign = "center";
        let lastLabel = null;
        for (let i = 0; i <= 4; i++) {
            const t = tMin + ((tMax - tMin) * i) / 4;
            const label = timeLabel(new Date(t), tMax - tMin);
            if (label === lastLabel) continue;
            lastLabel = label;
            // the first and last labels stay inside the canvas instead of being cut off at its edges
            const half = ctx.measureText(label).width / 2;
            ctx.fillText(label, Math.max(half + 2, Math.min(W - half - 2, x(t))), H - 6);
        }

        for (const s of this.series.values()) {
            const pts = s.points.filter((p) => p[0] >= tMin - 5000);
            if (!pts.length) continue;
            // history charts: no line across a stretch without samples (e.g. while the server was stopped)
            const gap = this.fixedRange && s.gap ? s.gap : Infinity;
            const lonely = []; // points with a gap on both sides: no line reaches them, so they get a dot
            // a break (null value) between two points, or at the time of one of them, also cuts the line
            const breaks = s.breaks || [];
            let b = 0;
            const cut = pts.map(([t], i) => {
                if (i === 0) return true;
                const prev = pts[i - 1][0];
                if (t - prev > gap) return true;
                while (b < breaks.length && breaks[b] < prev) b++;
                return b < breaks.length && breaks[b] <= t;
            });
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            pts.forEach(([t, v], i) => {
                if (cut[i]) ctx.moveTo(x(t), y(v));
                else ctx.lineTo(x(t), y(v));
                if (cut[i] && (i === pts.length - 1 || cut[i + 1])) lonely.push(pts[i]);
            });
            ctx.stroke();
            const markers = pts.length < 60 || (pts.length <= 2000 && pts.some((p) => p[2]));
            if (!markers && lonely.length) {
                ctx.fillStyle = s.color;
                for (const [t, v] of lonely) { ctx.beginPath(); ctx.arc(x(t), y(v), 1.8, 0, Math.PI * 2); ctx.fill(); }
            }
            if (markers) {
                ctx.fillStyle = s.color;
                const r = pts.length < 200 ? 2.6 : 1.6;
                for (const [t, v, hollow] of pts) {
                    ctx.beginPath();
                    ctx.arc(x(t), y(v), hollow ? r + 0.6 : r, 0, Math.PI * 2);
                    if (hollow) {
                        ctx.fillStyle = css.getPropertyValue("--panel").trim() || "#fff";
                        ctx.fill();
                        ctx.lineWidth = 1.4;
                        ctx.stroke();
                        ctx.fillStyle = s.color;
                    } else ctx.fill();
                }
            }
        }
        if (!all.length) {
            ctx.fillStyle = textColor;
            ctx.textAlign = "center";
            ctx.fillText("No numeric data to plot yet", W / 2, H / 2);
        }
    }
}

function pad2(n) { return String(n).padStart(2, "0"); }

// Axis label for a time; the visible range decides the precision (milliseconds below 10 s, the date from one day).
function timeLabel(d, rangeMs) {
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (rangeMs >= 86400e3) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
    const hms = `${hm}:${pad2(d.getSeconds())}`;
    return rangeMs < 10e3 ? `${hms}.${String(d.getMilliseconds()).padStart(3, "0")}` : hms;
}

// Time difference above which two neighbouring points of a history series are not joined by a line: ten times the
// usual (median) sample spacing. Needs a few spacings to know what is usual; Infinity = always join.
function gapThreshold(points) {
    const steps = [];
    for (let i = 1; i < points.length; i++) {
        const d = points[i][0] - points[i - 1][0];
        if (d > 0) steps.push(d);
    }
    if (steps.length < 3) return Infinity;
    const sorted = Float64Array.from(steps).sort();
    return sorted[Math.floor(sorted.length / 2)] * 10;
}
