"use strict";
/* Certificate (PKI) management for the server, user-token and client stores. */
const Certs = {
    store: "server",

    mount(view) {
        const root = h("div", { class: "stack" });
        view.appendChild(root);
        const render = async () => {
            clear(root);
            const tabs = h("div", { class: "tabs", style: { padding: 0 } },
                [["server", "Server application PKI"], ["user", "User certificates (X509 tokens)"], ["client", "Client application PKI"]].map(([id, label]) =>
                    h("button", { class: `tab ${this.store === id ? "active" : ""}`, onclick: () => { this.store = id; render(); } }, label)));
            root.appendChild(tabs);
            const autoAccept = !!App.project.server.autoAcceptCertificates;
            const help = {
                server: `Certificates of client applications connecting over Sign / SignAndEncrypt. ${autoAccept
                    ? "Unknown clients are trusted automatically while Configuration → Security → “Automatically trust unknown client application certificates” is on."
                    : "Unknown clients are refused and appear under Rejected — trust them to allow the connection."}`,
                user: "Certificates used as X509 user identity tokens (log-in with a certificate). User certificates are never trusted automatically, whatever the Configuration says: a refused log-in puts its certificate under Rejected — press Trust to allow that user.",
                client: "Certificates of servers the built-in client connects to, and the client's own application certificate. Server certificates are never trusted automatically: when the Client meets an unknown server certificate it shows it and asks you first (the simulator's own server is trusted without asking)."
            }[this.store];
            root.appendChild(h("div", { class: "muted" }, help));
            let data;
            try {
                data = this.store === "client" ? await api.app("clientCertificates") : await api.server("listCertificates", this.store);
            } catch (err) {
                root.appendChild(h("div", { class: "badge bad" }, err.message));
                return;
            }
            const act = async (action, file) => {
                const fn = this.store === "client" ? () => api.app("clientCertificateAction", action, file) : () => api.server("certificateAction", this.store, action, file);
                await attempt(fn, `Certificate ${action === "import" ? "imported" : action + "ed"}`);
                render();
            };
            const importCert = async (action) => {
                const f = await api.app("pickFile", "Select certificate", [{ name: "Certificate", extensions: ["der", "pem", "crt", "cer"] }]);
                if (f) act(action, f);
            };
            root.appendChild(h("div", { class: "toolbar" },
                h("span", { class: "code" }, data.rootDir),
                h("button", { class: "btn small", onclick: () => attempt(() => api.app("openFolder", `pki-${this.store}`)) }, "Open folder"),
                h("button", { class: "btn small", onclick: () => importCert("import") }, "Import trusted certificate…"),
                h("button", { class: "btn small", onclick: () => importCert("importIssuer") }, "Import CA / issuer…"),
                this.store === "server" ? h("button", { class: "btn small", title: "Creates a new self-signed certificate with the current host names and IP addresses on next start", onclick: async () => {
                    if (!(await confirmDialog("Regenerate server certificate", "Delete the server's own certificate? A new self-signed certificate (with current host names and IPs) is created on the next start. Clients that trusted the old certificate must trust the new one.", "Regenerate", true))) return;
                    await attempt(() => api.server("certificateAction", "server", "regenerateOwn", ""), "A new certificate is created on the next server start");
                    render();
                } }, "Regenerate server certificate") : null,
                h("button", { class: "btn small", onclick: render }, "↻ Refresh")));
            const table = (title, list, actions) => h("div", { class: "card" },
                h("div", { class: "card-head" }, h("h3", null, `${title} (${list.length})`)),
                h("div", { class: "card-body flush table-wrap" }, list.length === 0 ? h("div", { class: "empty" }, "None") :
                    h("table", null,
                        h("thead", null, h("tr", null, ["Subject", "Issuer", "Valid until", "Thumbprint", ""].map((x) => h("th", null, x)))),
                        h("tbody", null, list.map((c) => h("tr", null,
                            h("td", { class: "small", style: { maxWidth: "300px" }, title: `${c.subjectAltName || ""}\n${c.file}` }, c.subject, c.selfSigned ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "self-signed") : null),
                            h("td", { class: "small ellipsis", style: { maxWidth: "220px" }, title: c.issuer }, c.issuer),
                            h("td", null, c.validTo ? h("span", { class: `badge ${c.expired ? "bad" : "good"}` }, c.validTo.slice(0, 10)) : ""),
                            h("td", { class: "mono small", style: { cursor: "pointer" }, onclick: () => copyText(c.thumbprint) }, (c.thumbprint || "").slice(0, 16) + "…"),
                            h("td", { class: "actions" }, h("div", { class: "btn-group", style: { justifyContent: "flex-end" } }, actions(c)))))))));
            const showBtn = (c) => h("button", { class: "btn small", onclick: () => attempt(() => api.app("showItem", c.file)) }, "Show");
            // version 1.0.0 trusted unknown user certificates automatically: those stay trusted until deleted
            if (this.store === "user" && data.trusted.length) {
                root.appendChild(h("div", { class: "notice warn" }, "Check the trusted user certificates below: version 1.0.0 trusted unknown user certificates automatically. Delete any certificate you do not recognise — it lets its owner log in."));
            }
            root.appendChild(table("Own certificate", data.own, (c) => [showBtn(c)]));
            root.appendChild(table(this.store === "user" ? "Rejected (refused log-ins)" : "Rejected", data.rejected, (c) => [
                h("button", { class: "btn small primary", onclick: () => act("trust", c.file) }, "Trust"),
                h("button", { class: "btn small", onclick: () => act("delete", c.file) }, "Delete")]));
            root.appendChild(table("Trusted", data.trusted, (c) => [
                h("button", { class: "btn small", onclick: () => act("reject", c.file) }, "Reject"),
                h("button", { class: "btn small", onclick: () => act("delete", c.file) }, "Delete"), showBtn(c)]));
            root.appendChild(table("Issuers (CA)", data.issuers, (c) => [h("button", { class: "btn small", onclick: () => act("delete", c.file) }, "Delete")]));
        };
        render();
    }
};
