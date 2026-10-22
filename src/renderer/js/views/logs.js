"use strict";
/* Log viewer for server and client activity. */
const Logs = {
    level: "all",
    source: "all",
    search: "",
    follow: true,

    mount(view) {
        view.className = "fill";
        const levelSel = select([{ value: "all", label: "All levels" }, "debug", "info", "warn", "error"], this.level);
        const sourceSel = select([{ value: "all", label: "All sources" }, "server", "client"], this.source);
        const search = h("input", { class: "search", placeholder: "Search…", value: this.search });
        const list = h("div", { class: "pane-scroll", style: { background: "var(--panel)" } });
        const count = h("span", { class: "muted small" });
        const matches = (l) => (this.level === "all" || l.level === this.level) && (this.source === "all" || l.source === this.source)
            && (!this.search || l.message.toLowerCase().includes(this.search.toLowerCase()));
        const line = (l) => h("div", { class: "log-line" },
            h("span", { class: "t" }, fmtTime(l.time)), h("span", { class: `lv lv-${l.level}` }, l.level),
            h("span", { class: "src" }, l.source), h("span", null, l.message));
        const render = () => {
            clear(list);
            const shown = App.logs.filter(matches).slice(-2000);
            shown.forEach((l) => list.appendChild(line(l)));
            if (!shown.length) list.appendChild(h("div", { class: "empty" }, "No log entries"));
            count.textContent = `${shown.length} of ${App.logs.length} entries`;
            if (this.follow) list.scrollTop = list.scrollHeight;
        };
        levelSel.addEventListener("change", () => { this.level = levelSel.value; render(); });
        sourceSel.addEventListener("change", () => { this.source = sourceSel.value; render(); });
        search.addEventListener("input", debounce(() => { this.search = search.value; render(); }, 200));
        view.appendChild(h("div", { class: "toolbar" }, levelSel, sourceSel, search,
            checkbox("Follow", this.follow, (v) => { this.follow = v; }),
            h("button", { class: "btn small", onclick: () => { App.logs.length = 0; render(); App.renderNav(); } }, "Clear"),
            h("button", { class: "btn small", onclick: () => attempt(() => api.app("saveText", "opcua-simulator.log",
                App.logs.map((l) => `${l.time}\t${l.level}\t${l.source}\t${l.message}`).join("\n")), (f) => f && `Saved to ${f}`) }, "Export…"),
            h("span", { class: "spacer" }), count));
        view.appendChild(h("div", { class: "card pane", style: { flex: 1, overflow: "hidden" } }, list));
        render();
        // entries arrive in batches (at most every 250 ms); append them in one DOM update
        const off = App.on("log-batch", (batch) => {
            const shown = batch.filter(matches).slice(-2000);
            if (!shown.length) return;
            const empty = list.querySelector(".empty");
            if (empty) empty.remove();
            const frag = document.createDocumentFragment();
            shown.forEach((l) => frag.appendChild(line(l)));
            list.appendChild(frag);
            while (list.childNodes.length > 2000) list.removeChild(list.firstChild);
            count.textContent = `${list.childNodes.length} of ${App.logs.length} entries`;
            if (this.follow) list.scrollTop = list.scrollHeight;
        });
        return off;
    }
};
