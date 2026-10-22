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

    setPoints(key, label, points) {
        const s = this.ensureSeries(key, label);
        s.points = points
            .map(([t, v]) => [new Date(t).getTime(), typeof v === "boolean" ? (v ? 1 : 0) : v])
            .filter(([, v]) => typeof v === "number" && isFinite(v));
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
        if (this.fixedRange && all.length) {
            tMin = Math.min(...all.map((p) => p[0]));
            tMax = Math.max(...all.map((p) => p[0]));
            if (tMax === tMin) tMax = tMin + 1000;
        }
        const visible = all.filter((p) => p[0] >= tMin);
        let vMin = Math.min(...visible.map((p) => p[1]));
        let vMax = Math.max(...visible.map((p) => p[1]));
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
        for (let i = 0; i <= 4; i++) {
            const t = tMin + ((tMax - tMin) * i) / 4;
            const d = new Date(t);
            ctx.fillText(`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, x(t), H - 6);
        }

        for (const s of this.series.values()) {
            const pts = s.points.filter((p) => p[0] >= tMin - 5000);
            if (!pts.length) continue;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
            ctx.stroke();
            if (pts.length < 60) {
                ctx.fillStyle = s.color;
                for (const [t, v] of pts) { ctx.beginPath(); ctx.arc(x(t), y(v), 2.2, 0, Math.PI * 2); ctx.fill(); }
            }
        }
        if (!this.series.size) {
            ctx.fillStyle = textColor;
            ctx.textAlign = "center";
            ctx.fillText("No numeric data to plot yet", W / 2, H / 2);
        }
    }
}

function pad2(n) { return String(n).padStart(2, "0"); }
