"use strict";
// Persistent history of the simulated server: values of historizing variables and events that reached an event
// notifier, kept in one SQLite database per data folder (<data folder>/history/history.db) so they survive restarts.
// Entries are removed only by the capacity limits (oldest first) and by an explicit "clear".
//
// Uses Node's built-in node:sqlite (DatabaseSync; Node >= 22.13 and Electron's main process). Writes are queued and
// committed in batches (every 500 ms or 1000 rows, in one transaction); every read writes the queue first, so it
// sees everything recorded so far. While another program holds the write lock the queue is kept (up to
// MAX_QUEUED_ROWS) and written later. A damaged file is detected when it is opened (and whenever SQLite reports it)
// and then no longer used. Several simulators may share one data folder. This module stores opaque payloads (base64
// Variants, event field blobs); historyAccess.js turns them into OPC UA values.
const fs = require("fs");
const path = require("path");

const DEFAULT_HISTORY_SIZE = 100000; // values per historizing variable / events per notifier
const MAX_HISTORY_SIZE = 1000000;
const FLUSH_INTERVAL_MS = 500;
const FLUSH_ROWS = 1000;
const BUSY_TIMEOUT_MS = 50; // a batch waits this long for another program's write lock, then it is retried later
const LONG_BUSY_TIMEOUT_MS = 2000; // opening, clearing and the last write before closing wait longer
const RETRY_MAX_MS = 2000; // longest pause between two attempts while the database stays locked
const MAX_QUEUED_ROWS = 100000; // kept while the database is locked; beyond that the oldest entries are dropped
const SYNC_CHECK_MAX_BYTES = 256 * 1024 * 1024; // a larger file is checked in a worker thread (opening stays fast)
const MIN_TIME = -8640000000000000; // earliest / latest time a JavaScript Date can hold (ms)
const MAX_TIME = 8640000000000000;
const BAD_STATUS = 0x80000000; // status codes >= this have severity Bad

// A configured capacity (project setting) -> integer 0..MAX_HISTORY_SIZE; 0 means "do not record".
function historySize(value, fallback = DEFAULT_HISTORY_SIZE) {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(MAX_HISTORY_SIZE, n);
}

// node:sqlite prints "SQLite is an experimental feature" once when it is loaded (Node 22): that one warning is
// suppressed, every other warning still reaches the console.
let sqliteModule = null;
function loadSqlite() {
    if (sqliteModule) return sqliteModule;
    const emitWarning = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
        const name = type || (warning && warning.name);
        const text = typeof warning === "string" ? warning : warning && warning.message;
        if (name === "ExperimentalWarning" && /sqlite/i.test(String(text))) return undefined;
        return emitWarning.call(process, warning, ...rest);
    };
    try {
        sqliteModule = require("node:sqlite");
    } finally {
        process.emitWarning = emitWarning;
    }
    return sqliteModule;
}

// SQLite primary result code of a node:sqlite error (errcode may be an extended code), or null
function sqliteCode(err) {
    return err && typeof err.errcode === "number" ? err.errcode & 0xff : null;
}

// SQLITE_CORRUPT / SQLITE_NOTADB: the file is damaged
function isDamagedError(err) {
    const code = sqliteCode(err);
    return code === 11 || code === 26 || /malformed|not a database|corrupt/i.test((err && err.message) || "");
}

// SQLITE_BUSY / SQLITE_LOCKED: another connection holds the lock, worth trying again later
function isBusyError(err) {
    const code = sqliteCode(err);
    return code === 5 || code === 6 || /database (table )?is locked/i.test((err && err.message) || "");
}

function damagedError(problem) {
    const text = String(problem).replace(/\*\*\* in database \w+ \*\*\*/g, "").replace(/\s+/g, " ").trim();
    return new Error(`database disk image is malformed (${text.length > 160 ? `${text.slice(0, 157)}...` : text})`);
}

// "ok" rows of PRAGMA quick_check -> null, else the problems found
function integrityProblem(rows) {
    const text = rows.map((r) => Object.values(r)[0]).join("; ");
    return text === "ok" ? null : text || "no result";
}

// identifies one state of a file: a damaged file is not opened again until it changed (replaced, deleted)
function fileSignature(file) {
    try {
        const s = fs.statSync(file);
        return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch (_) {
        return "missing";
    }
}

// PRAGMA quick_check of a large file in a worker thread; posts null (fine or not checkable) or the problems found
const CHECK_WORKER_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
    const text = typeof warning === "string" ? warning : warning && warning.message;
    if ((type || (warning && warning.name)) === "ExperimentalWarning" && /sqlite/i.test(String(text))) return undefined;
    return emitWarning.call(process, warning, ...rest);
};
let problem = null;
try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.file);
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        const text = db.prepare("PRAGMA quick_check(5)").all().map((r) => Object.values(r)[0]).join("; ");
        if (text !== "ok") problem = text || "no result";
    } finally {
        db.close();
    }
} catch (err) {
    if (/malformed|not a database|corrupt/i.test(err.message || "")) problem = err.message;
}
parentPort.postMessage(problem);
`;

// Variable and notifier keys ("<namespace URI>|<identifier>") live once in value_series / notifiers (rows are kept
// when history is cleared, so their ids stay valid for every process using the file); the history rows reference
// them by number. `ns` points to the namespace table in effect when the row was written, so NodeIds inside stored
// values can be mapped to the current namespace indexes after companion nodesets changed.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS namespace_sets (id INTEGER PRIMARY KEY, uris TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS value_series (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS value_history (
    series INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    pico INTEGER NOT NULL DEFAULT 0,
    server_ts INTEGER,
    server_pico INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 0,
    ns INTEGER,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS value_history_series_ts ON value_history (series, ts, pico);
CREATE TABLE IF NOT EXISTS notifiers (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    time INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    type_name TEXT,
    condition_id TEXT,
    condition_name TEXT,
    source_name TEXT,
    message TEXT,
    severity INTEGER,
    ns INTEGER,
    fields BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS event_refs (notifier INTEGER NOT NULL, time INTEGER NOT NULL, event_id INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS event_refs_notifier_time ON event_refs (notifier, time, event_id);
CREATE INDEX IF NOT EXISTS event_refs_event ON event_refs (event_id);
`;

const VALUE_COLUMNS = "rowid AS id, ts, pico, server_ts, server_pico, status, ns, value";
const EVENT_COLUMNS = "r.time AS time, r.event_id AS id, e.event_type, e.type_name, e.condition_id, e.condition_name, e.source_name, e.message, e.severity, e.ns, e.fields";

class HistoryStore {
    // dir: <data folder>/history; log(level, message) receives problems (a failed write never throws to the caller)
    constructor(dir, { log } = {}) {
        this.dir = dir;
        this.file = path.join(dir, "history.db");
        this.log = log || (() => {});
        this.db = null;
        this.st = null;
        this.valueLimit = DEFAULT_HISTORY_SIZE;
        this.eventLimit = DEFAULT_HISTORY_SIZE;
        this.series = new Map(); // key -> { id, key, n } (cache; another process may add keys)
        this.notifiers = new Map(); // key -> { id, key, n }
        this.nsSets = new Map(); // id -> [uri]
        this.valueQueue = []; // { key, ts, pico, serverTs, serverPico, status, ns, value }
        this.eventQueue = []; // event records not inserted yet ({ ..., notifiers: [key] })
        this.refQueue = []; // { event, key }: a notifier reached by an event that is already in the database
        this.timer = null;
        this.retryAt = 0; // while the database is locked by another program: time of the next attempt (ms)
        this.retryDelay = 0;
        this.lastProblemLog = 0;
        this.lockReported = false; // the "locked" warning was logged: say when it can be written again
        this.droppedRows = 0;
        this.damaged = null; // { message, sig }: this file is damaged and not used until it changes
        this.onPruned = null; // (Set of value keys whose oldest values were removed) => void
        this.exitHook = () => this.close();
    }

    get isOpen() {
        return !!this.db;
    }

    open() {
        if (this.db) return this;
        const { DatabaseSync } = loadSqlite();
        // the history can contain everything clients wrote: private to this user, like logs and PKI (SS-14)
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(this.dir, 0o700); } catch (_) { /* e.g. Windows: modes are not enforced */ }
        // a file found damaged before is not checked again (that can take a while) until it was replaced
        if (this.damaged && this.damaged.sig === fileSignature(this.file)) throw new Error(this.damaged.message);
        this.damaged = null;
        // created before SQLite opens it; SQLite gives its -wal and -shm files the mode of the database file
        fs.closeSync(fs.openSync(this.file, "a", 0o600));
        try { fs.chmodSync(this.file, 0o600); } catch (_) { /* best effort */ }
        let size = 0;
        try { size = fs.statSync(this.file).size; } catch (_) { /* checked by SQLite */ }
        let db = null;
        try {
            db = new DatabaseSync(this.file);
            db.exec(`PRAGMA busy_timeout = ${LONG_BUSY_TIMEOUT_MS}`);
            // A file with a valid header but damaged pages opens fine and fails later (every write rolled back):
            // checked now. A large file is checked in the background, see checkInBackground().
            if (size <= SYNC_CHECK_MAX_BYTES) {
                const problem = integrityProblem(db.prepare("PRAGMA quick_check(5)").all());
                if (problem) throw damagedError(problem);
            }
            // only takes effect on a new file: lets "clear" give the space back to the file system
            db.exec("PRAGMA auto_vacuum = INCREMENTAL");
            db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA synchronous = NORMAL");
            // deleted entries (pruned, cleared) are overwritten, not left readable in the file
            db.exec("PRAGMA secure_delete = ON");
            db.exec(SCHEMA);
            db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
            this.db = db;
            this.prepare();
            this.loadKeys();
        } catch (err) {
            this.db = null;
            this.st = null;
            try { if (db) db.close(); } catch (_) { /* ignore */ }
            if (isDamagedError(err)) this.damaged = { message: err.message, sig: fileSignature(this.file) };
            throw err;
        }
        for (const f of [`${this.file}-wal`, `${this.file}-shm`]) {
            try { fs.chmodSync(f, 0o600); } catch (_) { /* not created yet / no POSIX modes */ }
        }
        this.retryAt = 0;
        this.retryDelay = 0;
        // a normal quit always writes the queue (process.exit included)
        process.on("exit", this.exitHook);
        if (size > SYNC_CHECK_MAX_BYTES) this.checkInBackground();
        return this;
    }

    // quick_check of a large file without blocking: the store works meanwhile; damage found closes it
    checkInBackground() {
        let worker;
        try {
            const { Worker } = require("worker_threads");
            worker = new Worker(CHECK_WORKER_SOURCE, { eval: true, workerData: { file: this.file } });
        } catch (_) {
            return; // no worker threads: damaged pages are still noticed when SQLite reads or writes them
        }
        const db = this.db;
        worker.unref();
        worker.once("message", (problem) => {
            if (problem && this.db === db) this.markDamaged(damagedError(problem));
        });
        worker.once("error", () => { /* not checkable: as above */ });
    }

    // Writes what is queued and closes the database. The store can be opened again.
    close() {
        if (!this.db) return;
        this.setBusyTimeout(LONG_BUSY_TIMEOUT_MS);
        this.flush({ force: true });
        if (!this.db) return; // the last write found the file damaged
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.pendingRows()) {
            this.log("error", `History: ${this.pendingRows()} entries could not be saved to ${this.file} before closing it (the database is locked by another program)`);
        }
        try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (_) { /* another connection may be reading */ }
        this.closeConnection();
    }

    closeConnection() {
        process.removeListener("exit", this.exitHook);
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        try { this.db.close(); } catch (_) { /* ignore */ }
        this.db = null;
        this.st = null;
        this.valueQueue = [];
        this.eventQueue = [];
        this.refQueue = [];
        this.retryAt = 0;
        this.retryDelay = 0;
        this.droppedRows = 0;
        this.lockReported = false;
        this.series.clear();
        this.notifiers.clear();
        this.nsSets.clear();
    }

    // SQLite reported damaged pages: nothing more is read from or written to this file (what is queued is lost).
    // The file is not opened again until it changed; clearing all history replaces it (serverEngine).
    markDamaged(err) {
        if (!this.db) return;
        const lost = this.pendingRows();
        this.closeConnection();
        this.damaged = { message: err.message, sig: fileSignature(this.file) };
        this.log("error", `History: the database ${this.file} is damaged (${err.message}): history is not saved any more${lost ? ` (${lost} entries lost)` : ""}. Clearing all history replaces the file with a new, empty one.`);
    }

    // runs fn; an error that shows the file is damaged closes the store (and is thrown on)
    guard(fn) {
        try {
            return fn();
        } catch (err) {
            if (isDamagedError(err)) this.markDamaged(err);
            throw err;
        }
    }

    setBusyTimeout(ms) {
        try { this.db.exec(`PRAGMA busy_timeout = ${ms}`); } catch (_) { /* keeps the current one */ }
    }

    // fn with the long busy timeout (rare writes the caller waits for: clear, capacities, namespace table)
    withLongWait(fn) {
        this.setBusyTimeout(LONG_BUSY_TIMEOUT_MS);
        try {
            return fn();
        } finally {
            if (this.db) this.setBusyTimeout(BUSY_TIMEOUT_MS);
        }
    }

    prepare() {
        const p = (sql) => this.db.prepare(sql);
        this.st = {
            seriesAll: p("SELECT id, key, n FROM value_series"),
            seriesByKey: p("SELECT id, key, n FROM value_series WHERE key = ?"),
            // another simulator on the same data folder may have created the key meanwhile
            seriesInsert: p("INSERT INTO value_series (key, n) VALUES (?, 0) ON CONFLICT(key) DO NOTHING"),
            seriesAdd: p("UPDATE value_series SET n = n + ? WHERE id = ? RETURNING n"),
            seriesCount: p("UPDATE value_series SET n = ? WHERE id = ?"),
            seriesOver: p("SELECT id, key, n FROM value_series WHERE n > ?"),
            seriesTotal: p("SELECT COALESCE(SUM(n), 0) AS n FROM value_series"),
            seriesMax: p("SELECT COALESCE(MAX(n), 0) AS n FROM value_series"),
            seriesReset: p("UPDATE value_series SET n = 0"),
            valueInsert: p("INSERT INTO value_history (series, ts, pico, server_ts, server_pico, status, ns, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
            valuePrune: p("DELETE FROM value_history WHERE rowid IN (SELECT rowid FROM value_history WHERE series = ? ORDER BY ts, pico, rowid LIMIT ?)"),
            valuesAsc: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts >= ? AND ts <= ? AND (ts, pico, rowid) > (?, ?, ?) ORDER BY ts, pico, rowid LIMIT ?`),
            valuesDesc: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts >= ? AND ts <= ? AND (ts, pico, rowid) < (?, ?, ?) ORDER BY ts DESC, pico DESC, rowid DESC LIMIT ?`),
            valueAt: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts = ? ORDER BY pico DESC, rowid DESC LIMIT 1`),
            valueBefore: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts < ? ORDER BY ts DESC, pico DESC, rowid DESC LIMIT 1`),
            valueBeforeNotBad: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts < ? AND status < ${BAD_STATUS} ORDER BY ts DESC, pico DESC, rowid DESC LIMIT 1`),
            valueAfter: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts > ? ORDER BY ts, pico, rowid LIMIT 1`),
            valueAfterNotBad: p(`SELECT ${VALUE_COLUMNS} FROM value_history WHERE series = ? AND ts > ? AND status < ${BAD_STATUS} ORDER BY ts, pico, rowid LIMIT 1`),
            valueOldest: p("SELECT ts FROM value_history WHERE series = ? ORDER BY ts, pico, rowid LIMIT 1"),
            valueClear: p("DELETE FROM value_history WHERE series = ?"),
            notifierAll: p("SELECT id, key, n FROM notifiers"),
            notifierByKey: p("SELECT id, key, n FROM notifiers WHERE key = ?"),
            notifierInsert: p("INSERT INTO notifiers (key, n) VALUES (?, 0) ON CONFLICT(key) DO NOTHING"),
            notifierAdd: p("UPDATE notifiers SET n = n + ? WHERE id = ? RETURNING n"),
            notifierCount: p("UPDATE notifiers SET n = ? WHERE id = ?"),
            notifiersOver: p("SELECT id, key, n FROM notifiers WHERE n > ?"),
            notifierTotal: p("SELECT COALESCE(SUM(n), 0) AS n FROM notifiers"),
            notifierMax: p("SELECT COALESCE(MAX(n), 0) AS n FROM notifiers"),
            notifierReset: p("UPDATE notifiers SET n = 0"),
            eventInsert: p("INSERT INTO events (time, event_type, type_name, condition_id, condition_name, source_name, message, severity, ns, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
            refInsert: p("INSERT INTO event_refs (notifier, time, event_id) VALUES (?, ?, ?)"),
            refPrune: p("DELETE FROM event_refs WHERE rowid IN (SELECT rowid FROM event_refs WHERE notifier = ? ORDER BY time, event_id LIMIT ?) RETURNING event_id"),
            refClear: p("DELETE FROM event_refs WHERE notifier = ? RETURNING event_id"),
            eventDeleteOrphan: p("DELETE FROM events WHERE id = ? AND NOT EXISTS (SELECT 1 FROM event_refs WHERE event_id = ?)"),
            eventsAsc: p(`SELECT ${EVENT_COLUMNS} FROM event_refs r JOIN events e ON e.id = r.event_id WHERE r.notifier = ? AND r.time >= ? AND r.time <= ? AND (r.time, r.event_id) > (?, ?) ORDER BY r.time, r.event_id LIMIT ?`),
            eventsDesc: p(`SELECT ${EVENT_COLUMNS} FROM event_refs r JOIN events e ON e.id = r.event_id WHERE r.notifier = ? AND r.time >= ? AND r.time <= ? AND (r.time, r.event_id) < (?, ?) ORDER BY r.time DESC, r.event_id DESC LIMIT ?`),
            eventCount: p("SELECT COUNT(*) AS n FROM events"),
            nsAll: p("SELECT id, uris FROM namespace_sets"),
            nsGet: p("SELECT uris FROM namespace_sets WHERE id = ?"),
            nsFind: p("SELECT id FROM namespace_sets WHERE uris = ?"),
            nsInsert: p("INSERT INTO namespace_sets (uris) VALUES (?) ON CONFLICT(uris) DO NOTHING")
        };
    }

    loadKeys() {
        this.series.clear();
        this.notifiers.clear();
        this.nsSets.clear();
        for (const r of this.st.seriesAll.all()) this.series.set(r.key, { id: r.id, key: r.key, n: r.n });
        for (const r of this.st.notifierAll.all()) this.notifiers.set(r.key, { id: r.id, key: r.key, n: r.n });
        for (const r of this.st.nsAll.all()) {
            try { this.nsSets.set(r.id, JSON.parse(r.uris)); } catch (_) { this.nsSets.set(r.id, []); }
        }
    }

    // ------------------------------------------------------------ capacity

    // Capacities per variable / per notifier (0 = not recorded). Lowering one removes the oldest entries at once
    // (when the database is locked meanwhile: with the next entries written for that variable / notifier).
    setLimits({ values, events } = {}) {
        this.valueLimit = historySize(values);
        this.eventLimit = historySize(events);
        if (!this.db) return;
        this.flush();
        const pruned = new Set();
        try {
            this.guard(() => this.withLongWait(() => {
                const series = this.valueLimit > 0 ? this.st.seriesOver.all(this.valueLimit) : [];
                const notifiers = this.eventLimit > 0 ? this.st.notifiersOver.all(this.eventLimit) : [];
                if (!series.length && !notifiers.length) return;
                this.transaction(() => {
                    for (const s of series) {
                        this.st.valuePrune.run(s.id, s.n - this.valueLimit);
                        this.st.seriesCount.run(this.valueLimit, s.id);
                        pruned.add(s.key);
                    }
                    for (const n of notifiers) this.pruneNotifier(n, n.n - this.eventLimit, this.eventLimit);
                });
                for (const s of series) if (this.series.has(s.key)) this.series.get(s.key).n = this.valueLimit;
                for (const n of notifiers) if (this.notifiers.has(n.key)) this.notifiers.get(n.key).n = this.eventLimit;
                this.reclaimSpace();
            }));
        } catch (err) {
            if (this.db) this.log("warn", `History: the new capacities could not be applied to ${this.file} now (${err.message}); they apply when the next entries are saved`);
            return;
        }
        if (pruned.size && this.onPruned) {
            try { this.onPruned(pruned); } catch (_) { /* informational only */ }
        }
    }

    // removes the `count` oldest references of a notifier and the events no notifier references any more
    pruneNotifier(notifier, count, remaining) {
        const ids = this.st.refPrune.all(notifier.id, count).map((r) => r.event_id);
        for (const id of ids) this.st.eventDeleteOrphan.run(id, id);
        this.st.notifierCount.run(remaining, notifier.id);
    }

    // ------------------------------------------------------------ writing

    // A write transaction (IMMEDIATE: takes the write lock at once, so a locked database fails here, before anything
    // was done). Cached keys created inside a failed transaction are gone again: they are looked up anew.
    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (err) {
            try { this.db.exec("ROLLBACK"); } catch (_) { /* already rolled back */ }
            this.series.clear();
            this.notifiers.clear();
            throw err;
        }
    }

    // id of the namespace table `uris` (namespace array of a running server), created on first use
    namespaceSetId(uris) {
        if (!this.db) return null;
        const json = JSON.stringify(uris || []);
        return this.guard(() => {
            let row = this.st.nsFind.get(json);
            if (!row) {
                this.withLongWait(() => this.st.nsInsert.run(json));
                row = this.st.nsFind.get(json);
            }
            this.nsSets.set(row.id, JSON.parse(json));
            return row.id;
        });
    }

    namespaceUris(id) {
        if (id === null || id === undefined) return null;
        if (this.nsSets.has(id)) return this.nsSets.get(id);
        if (!this.db) return null;
        try {
            // written by another simulator sharing the data folder
            const row = this.st.nsGet.get(id);
            if (!row) return null;
            const uris = JSON.parse(row.uris);
            this.nsSets.set(id, uris);
            return uris;
        } catch (_) {
            return null;
        }
    }

    queueValue(key, row) {
        if (!this.db || this.valueLimit <= 0) return;
        row.key = key;
        this.valueQueue.push(row);
        this.schedule();
    }

    // event: { time, eventType, typeName, conditionId, conditionName, sourceName, message, severity, ns, fields };
    // firstKey: the notifier it reached first (others: addEventNotifier). Never writes at once: an event without
    // notifier would be skipped, so the 1000-row write waits for addEventNotifier.
    queueEvent(event, firstKey = null) {
        if (!this.db || this.eventLimit <= 0) return;
        event.notifiers = event.notifiers || [];
        if (firstKey !== null && !event.notifiers.includes(firstKey)) event.notifiers.push(firstKey);
        event.queued = true;
        this.eventQueue.push(event);
        this.schedule(false);
    }

    // records that `event` (queued with queueEvent) reached the notifier `key`
    addEventNotifier(event, key) {
        if (!this.db || this.eventLimit <= 0) return;
        if (event.id) {
            this.refQueue.push({ event, key });
        } else {
            event.notifiers = event.notifiers || [];
            if (event.notifiers.includes(key)) return;
            event.notifiers.push(key);
            if (!event.queued) {
                // written before without notifier (all of them cleared meanwhile): queued again
                event.queued = true;
                this.eventQueue.push(event);
            }
        }
        this.schedule();
    }

    pendingRows() {
        return this.valueQueue.length + this.eventQueue.length + this.refQueue.length;
    }

    // urgent: write at once when FLUSH_ROWS are queued (else with the timer)
    schedule(urgent = true) {
        if (this.retryAt) {
            // locked by another program: the retry timer writes; the queue is kept within its limit
            if (this.pendingRows() > MAX_QUEUED_ROWS * 1.1) this.trimQueue();
            if (!this.timer) this.armTimer(this.retryAt - Date.now());
            return;
        }
        if (urgent && this.pendingRows() >= FLUSH_ROWS) {
            this.flush();
            return;
        }
        if (!this.timer) this.armTimer(FLUSH_INTERVAL_MS);
    }

    armTimer(ms) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, Math.max(0, ms));
        if (typeof this.timer.unref === "function") this.timer.unref();
    }

    // drops the oldest queued entries beyond MAX_QUEUED_ROWS (values first) -> number dropped
    trimQueue() {
        let over = this.pendingRows() - MAX_QUEUED_ROWS;
        if (over <= 0) return 0;
        const dropped = over;
        const v = Math.min(over, this.valueQueue.length);
        this.valueQueue.splice(0, v);
        over -= v;
        if (over > 0) {
            const r = Math.min(over, this.refQueue.length);
            this.refQueue.splice(0, r);
            over -= r;
        }
        if (over > 0) {
            for (const e of this.eventQueue.splice(0, over)) {
                e.queued = false;
                e.notifiers = [];
            }
        }
        this.droppedRows += dropped;
        return dropped;
    }

    seriesFor(key) {
        let s = this.series.get(key);
        if (!s) {
            this.st.seriesInsert.run(key);
            const row = this.st.seriesByKey.get(key);
            s = { id: row.id, key, n: row.n };
            this.series.set(key, s);
        }
        return s;
    }

    notifierFor(key) {
        let n = this.notifiers.get(key);
        if (!n) {
            this.st.notifierInsert.run(key);
            const row = this.st.notifierByKey.get(key);
            n = { id: row.id, key, n: row.n };
            this.notifiers.set(key, n);
        }
        return n;
    }

    // Commits the queue in one transaction and removes what exceeds the capacities. Never throws. While another
    // program holds the write lock the entries stay queued and are retried (backing off up to RETRY_MAX_MS); a
    // damaged file closes the store; other failures (e.g. disk full) are logged and their entries dropped.
    // force: also during a retry pause (closing).
    flush({ force = false } = {}) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.db || !this.pendingRows()) return;
        if (!force && this.retryAt > Date.now()) {
            this.armTimer(this.retryAt - Date.now());
            return;
        }
        const values = this.valueQueue;
        const events = this.eventQueue;
        const refs = this.refQueue;
        this.valueQueue = [];
        this.eventQueue = [];
        this.refQueue = [];
        const st = this.st;
        const eventIds = new Map(); // event record -> id, set on the records once committed
        const counts = []; // [cached key entry, count], set once committed
        const pruned = new Set();
        try {
            this.transaction(() => {
                const valueAdds = new Map(); // series -> values added
                const refAdds = new Map(); // notifier -> references added
                const addRef = (key, time, id) => {
                    const n = this.notifierFor(key);
                    st.refInsert.run(n.id, time, id);
                    refAdds.set(n, (refAdds.get(n) || 0) + 1);
                };
                for (const r of values) {
                    const s = this.seriesFor(r.key);
                    st.valueInsert.run(s.id, r.ts, r.pico, r.serverTs, r.serverPico, r.status, r.ns, r.value);
                    valueAdds.set(s, (valueAdds.get(s) || 0) + 1);
                }
                for (const e of events) {
                    if (!e.notifiers || !e.notifiers.length) continue; // every notifier it reached was cleared meanwhile
                    const id = Number(st.eventInsert.run(e.time, e.eventType, e.typeName ?? null, e.conditionId ?? null, e.conditionName ?? null,
                        e.sourceName ?? null, e.message ?? null, e.severity ?? null, e.ns ?? null, e.fields).lastInsertRowid);
                    eventIds.set(e, id);
                    for (const key of e.notifiers) addRef(key, e.time, id);
                }
                for (const ref of refs) {
                    if (ref.event.id) addRef(ref.key, ref.event.time, ref.event.id);
                }
                // counts in the database (another simulator may write to the same file)
                for (const [s, added] of valueAdds) {
                    const row = st.seriesAdd.get(added, s.id);
                    let n = row ? row.n : added;
                    if (this.valueLimit > 0 && n > this.valueLimit) {
                        st.valuePrune.run(s.id, n - this.valueLimit);
                        st.seriesCount.run(this.valueLimit, s.id);
                        n = this.valueLimit;
                        pruned.add(s.key);
                    }
                    counts.push([s, n]);
                }
                for (const [nf, added] of refAdds) {
                    const row = st.notifierAdd.get(added, nf.id);
                    let n = row ? row.n : added;
                    if (this.eventLimit > 0 && n > this.eventLimit) {
                        this.pruneNotifier(nf, n - this.eventLimit, this.eventLimit);
                        n = this.eventLimit;
                    }
                    counts.push([nf, n]);
                }
            });
        } catch (err) {
            this.writeFailed(err, values, events, refs);
            return;
        }
        for (const e of events) e.queued = false;
        for (const [e, id] of eventIds) {
            e.id = id;
            e.notifiers = null; // notifiers reached later are queued as refs
        }
        for (const [entry, n] of counts) entry.n = n;
        if (this.lockReported || this.droppedRows) {
            const dropped = this.droppedRows || 0;
            this.log(dropped ? "warn" : "info", `History: ${this.file} can be written again${dropped ? ` (${dropped} entries were dropped while it was locked)` : ""}`);
        }
        this.retryAt = 0;
        this.retryDelay = 0;
        this.droppedRows = 0;
        this.lockReported = false;
        if (pruned.size && this.onPruned) {
            try { this.onPruned(pruned); } catch (_) { /* informational only */ }
        }
    }

    writeFailed(err, values, events, refs) {
        if (isDamagedError(err)) {
            // counted as lost in the message
            this.valueQueue = values.concat(this.valueQueue);
            this.eventQueue = events.concat(this.eventQueue);
            this.refQueue = refs.concat(this.refQueue);
            this.markDamaged(err);
            return;
        }
        if (isBusyError(err) && this.db) {
            // another program holds the write lock (e.g. a database browser with an open transaction): kept, retried
            this.valueQueue = values.concat(this.valueQueue);
            this.eventQueue = events.concat(this.eventQueue);
            this.refQueue = refs.concat(this.refQueue);
            const first = !this.retryDelay;
            this.trimQueue();
            this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay ? this.retryDelay * 2 : FLUSH_INTERVAL_MS);
            this.retryAt = Date.now() + this.retryDelay;
            this.armTimer(this.retryDelay);
            if (first && this.logProblem("warn", `History: ${this.file} is locked by another program: ${this.pendingRows()} entries wait to be saved (up to ${MAX_QUEUED_ROWS} are kept, then the oldest are dropped)`)) {
                this.lockReported = true;
            }
            return;
        }
        for (const e of events) e.queued = false;
        this.logProblem("error", `History: cannot save ${values.length} value(s) and ${events.length} event(s) to ${this.file}: ${err.message}`);
    }

    // at most one message per minute -> whether it was logged
    logProblem(level, message) {
        const now = Date.now();
        if (now - this.lastProblemLog <= 60000) return false;
        this.lastProblemLog = now;
        this.log(level, message);
        return true;
    }

    // ------------------------------------------------------------ reading values

    // Rows of one variable in [start, end] (ms, null = open), ascending (or descending with `reverse`), after the
    // row `after` (keyset paging), at most `limit` (0 = all).
    valueRows(key, { start = null, end = null, reverse = false, after = null, limit = 0 } = {}) {
        const s = this.lookupSeries(key);
        if (!s) return [];
        const lo = start === null ? MIN_TIME : start;
        const hi = end === null ? MAX_TIME : end;
        const max = limit > 0 ? limit : -1;
        return this.guard(() => {
            if (reverse) {
                const c = after || { ts: MAX_TIME, pico: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
                return this.st.valuesDesc.all(s.id, lo, hi, c.ts, c.pico, c.id, max);
            }
            const c = after || { ts: MIN_TIME, pico: -1, id: -1 };
            return this.st.valuesAsc.all(s.id, lo, hi, c.ts, c.pico, c.id, max);
        });
    }

    // the most recent row at exactly `ms`, or null
    valueAt(key, ms) {
        const s = this.lookupSeries(key);
        return (s && this.guard(() => this.st.valueAt.get(s.id, ms))) || null;
    }

    // nearest row before / after `ms` (strictly); notBad skips rows whose status is Bad
    valueBefore(key, ms, notBad = false) {
        const s = this.lookupSeries(key);
        return (s && this.guard(() => (notBad ? this.st.valueBeforeNotBad : this.st.valueBefore).get(s.id, ms))) || null;
    }

    valueAfter(key, ms, notBad = false) {
        const s = this.lookupSeries(key);
        return (s && this.guard(() => (notBad ? this.st.valueAfterNotBad : this.st.valueAfter).get(s.id, ms))) || null;
    }

    oldestValueTime(key) {
        const s = this.lookupSeries(key);
        const row = s && this.guard(() => this.st.valueOldest.get(s.id));
        return row ? row.ts : null;
    }

    valueCount(key) {
        const s = this.lookupSeries(key);
        const row = s && this.guard(() => this.st.seriesByKey.get(key));
        return row ? row.n : 0;
    }

    // the cached key entry, else from the database (written by another simulator sharing the data folder)
    lookupSeries(key) {
        if (!this.db) return null;
        this.flush();
        if (!this.db) return null;
        let s = this.series.get(key);
        if (!s) {
            const row = this.guard(() => this.st.seriesByKey.get(key));
            if (!row) return null;
            s = { id: row.id, key, n: row.n };
            this.series.set(key, s);
        }
        return s;
    }

    lookupNotifier(key) {
        if (!this.db) return null;
        this.flush();
        if (!this.db) return null;
        let n = this.notifiers.get(key);
        if (!n) {
            const row = this.guard(() => this.st.notifierByKey.get(key));
            if (!row) return null;
            n = { id: row.id, key, n: row.n };
            this.notifiers.set(key, n);
        }
        return n;
    }

    // ------------------------------------------------------------ reading events

    // Events that reached notifier `key` with lo <= time <= hi (ms), ordered by time (then recording order),
    // after the cursor `after` ({ time, id }), at most `limit`.
    eventRows(key, { lo = MIN_TIME, hi = MAX_TIME, reverse = false, after = null, limit = 500 } = {}) {
        const n = this.lookupNotifier(key);
        if (!n) return [];
        return this.guard(() => {
            if (reverse) {
                const c = after || { time: MAX_TIME, id: Number.MAX_SAFE_INTEGER };
                return this.st.eventsDesc.all(n.id, lo, hi, c.time, c.id, limit);
            }
            const c = after || { time: MIN_TIME, id: -1 };
            return this.st.eventsAsc.all(n.id, lo, hi, c.time, c.id, limit);
        });
    }

    // ------------------------------------------------------------ clearing

    // key: one variable, null: all variables. Returns the number of values removed. Deleted values are overwritten
    // in the file (secure_delete) and the space is given back.
    clearValues(key = null) {
        if (!this.db) return 0;
        this.valueQueue = key === null ? [] : this.valueQueue.filter((r) => r.key !== key);
        this.flush();
        if (!this.db) return 0;
        return this.guard(() => this.withLongWait(() => {
            let removed = 0;
            if (key === null) {
                removed = this.st.seriesTotal.get().n;
                this.transaction(() => {
                    this.db.exec("DELETE FROM value_history");
                    this.st.seriesReset.run();
                });
                for (const s of this.series.values()) s.n = 0;
            } else {
                const row = this.st.seriesByKey.get(key);
                if (!row) return 0;
                removed = row.n;
                this.transaction(() => {
                    this.st.valueClear.run(row.id);
                    this.st.seriesCount.run(0, row.id);
                });
                if (this.series.has(key)) this.series.get(key).n = 0;
            }
            this.reclaimSpace();
            return removed;
        }));
    }

    // key: one notifier, null: all notifiers. Returns the number of entries removed for the notifier(s).
    clearEvents(key = null) {
        if (!this.db) return 0;
        if (key === null) {
            for (const e of this.eventQueue) e.queued = false;
            this.eventQueue = [];
            this.refQueue = [];
        } else {
            this.refQueue = this.refQueue.filter((r) => r.key !== key);
            for (const e of this.eventQueue) e.notifiers = (e.notifiers || []).filter((k) => k !== key);
        }
        this.flush();
        if (!this.db) return 0;
        return this.guard(() => this.withLongWait(() => {
            let removed = 0;
            if (key === null) {
                removed = this.st.notifierTotal.get().n;
                this.transaction(() => {
                    this.db.exec("DELETE FROM event_refs");
                    this.db.exec("DELETE FROM events");
                    this.st.notifierReset.run();
                });
                for (const n of this.notifiers.values()) n.n = 0;
            } else {
                const row = this.st.notifierByKey.get(key);
                if (!row) return 0;
                removed = row.n;
                this.transaction(() => {
                    const ids = this.st.refClear.all(row.id).map((r) => r.event_id);
                    for (const id of ids) this.st.eventDeleteOrphan.run(id, id);
                    this.st.notifierCount.run(0, row.id);
                });
                if (this.notifiers.has(key)) this.notifiers.get(key).n = 0;
            }
            this.reclaimSpace();
            return removed;
        }));
    }

    // gives freed pages back to the file system (databases created by this version use incremental auto-vacuum)
    // and empties the WAL file, which still holds the old pages
    reclaimSpace() {
        try {
            this.db.exec("PRAGMA incremental_vacuum");
            this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (_) { /* another connection may be reading: the space is reused anyway */ }
    }

    // ------------------------------------------------------------ status

    // -> { file, sizeBytes, values, events, maxValuesPerVariable, maxEventsPerNotifier } (events: distinct recorded
    // events; the max counts: of the fullest variable / notifier, so a lower limit deletes entries only when it is
    // below them); `error` when the database cannot be used, `pending` while entries wait for another program's
    // write lock. Never throws.
    stats() {
        const size = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
        const out = { file: this.file, sizeBytes: 0, values: 0, events: 0, maxValuesPerVariable: 0, maxEventsPerNotifier: 0 };
        if (this.db) {
            try {
                this.flush();
                if (this.db) {
                    out.values = this.guard(() => this.st.seriesTotal.get().n);
                    out.events = this.guard(() => this.st.eventCount.get().n);
                    out.maxValuesPerVariable = this.guard(() => this.st.seriesMax.get().n);
                    out.maxEventsPerNotifier = this.guard(() => this.st.notifierMax.get().n);
                }
            } catch (err) {
                out.error = err.message;
            }
            if (this.db && this.retryAt) out.pending = this.pendingRows();
        }
        if (!this.db && this.damaged) out.error = this.damaged.message;
        out.sizeBytes = size(this.file) + size(`${this.file}-wal`);
        return out;
    }
}

module.exports = { HistoryStore, historySize, loadSqlite, isDamagedError, isBusyError, DEFAULT_HISTORY_SIZE, MAX_HISTORY_SIZE, MIN_TIME, MAX_TIME };
