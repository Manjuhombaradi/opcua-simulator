"use strict";
// Helpers to inspect and manage a node-opcua PKI folder (own / trusted / rejected / issuers).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function describeCertificate(file) {
    const buf = fs.readFileSync(file);
    try {
        const cert = new crypto.X509Certificate(buf);
        return {
            file,
            fileName: path.basename(file),
            subject: cert.subject.replace(/\n/g, ", "),
            issuer: cert.issuer.replace(/\n/g, ", "),
            validFrom: new Date(cert.validFrom).toISOString(),
            validTo: new Date(cert.validTo).toISOString(),
            expired: new Date(cert.validTo) < new Date(),
            thumbprint: cert.fingerprint.replace(/:/g, "").toLowerCase(),
            subjectAltName: cert.subjectAltName || "",
            selfSigned: cert.subject === cert.issuer
        };
    } catch (err) {
        return { file, fileName: path.basename(file), subject: "(unreadable certificate)", error: err.message };
    }
}

function listFolder(folder) {
    if (!folder || !fs.existsSync(folder)) return [];
    return fs.readdirSync(folder)
        .filter((f) => /\.(der|pem|crt|cer)$/i.test(f))
        .map((f) => describeCertificate(path.join(folder, f)));
}

function listCertificates(cm) {
    return {
        rootDir: cm.rootDir,
        own: listFolder(cm.ownCertFolder),
        trusted: listFolder(cm.trustedFolder),
        rejected: listFolder(cm.rejectedFolder),
        issuers: listFolder(cm.issuersCertFolder)
    };
}

function readDer(file) {
    const buf = fs.readFileSync(file);
    return Buffer.from(new crypto.X509Certificate(buf).raw);
}

async function certificateAction(cm, action, file) {
    switch (action) {
        case "trust":
            await cm.trustCertificate(readDer(file));
            if (path.dirname(file) === cm.rejectedFolder && fs.existsSync(file)) fs.unlinkSync(file);
            break;
        case "reject":
            await cm.rejectCertificate(readDer(file));
            if (path.dirname(file) === cm.trustedFolder && fs.existsSync(file)) fs.unlinkSync(file);
            break;
        case "delete":
            if (fs.existsSync(file)) fs.unlinkSync(file);
            break;
        case "import":
            await cm.trustCertificate(readDer(file));
            break;
        case "importIssuer":
            await cm.addIssuer(readDer(file), false, true);
            break;
        default:
            throw new Error(`Unknown certificate action ${action}`);
    }
}

module.exports = { listCertificates, certificateAction, describeCertificate };
