'use strict';

// Filesystem and synchronous SQLite work is restricted to this worker, never audio I/O.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData: options } = require('node:worker_threads');
const { _internals: { UUID, STATUSES, timestamp } } = require('./inbox');

const APPLICATION_ID = 0x58494e42; // XINB: separate from conversation memory.
const DAY = 86400000;
let database;
let poisoned;
let statements;

function corrupt(message) { return Object.assign(new Error(message), { code: 'INBOX_CORRUPT' }); }
function secureFile(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt('Inbox database and sidecars must be regular files, not symlinks');
    fs.chmodSync(filename, 0o600);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function secureFiles() { for (const suffix of ['', '-wal', '-shm']) secureFile(options.databasePath + suffix); }

function initialize() {
  fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(options.databasePath, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  secureFiles();
  database = new DatabaseSync(options.databasePath, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
  database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  try {
    // Inspect/create the schema under the same lock, including first-open races.
    const version = database.prepare('PRAGMA user_version').get().user_version;
    const app = database.prepare('PRAGMA application_id').get().application_id;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if ((version !== 0 && version !== 1) || (version === 0 && (tables.length || (app !== 0 && app !== APPLICATION_ID))) || (version === 1 && app !== APPLICATION_ID)) {
      throw corrupt('Unsupported or unrecognized notification inbox database');
    }
    const check = database.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw corrupt('Notification inbox integrity check failed');
    if (version === 0) database.exec(`
        CREATE TABLE notification_devices (
          device_key TEXT PRIMARY KEY CHECK(length(device_key) = 64)
        ) STRICT;
        CREATE TABLE notification_inbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE CHECK(length(id) = 36),
          device_key TEXT NOT NULL REFERENCES notification_devices(device_key) ON DELETE CASCADE,
          sender TEXT NOT NULL CHECK(length(sender) > 0 AND length(sender) <= 128),
          title TEXT NOT NULL CHECK(length(title) <= 120),
          text TEXT NOT NULL CHECK(length(text) > 0 AND length(text) <= 2000),
          idempotency_key TEXT CHECK(idempotency_key IS NULL OR (length(idempotency_key) > 0 AND length(idempotency_key) <= 128)),
          created_at INTEGER NOT NULL CHECK(created_at >= 0),
          read_at INTEGER CHECK(read_at IS NULL OR read_at >= 0),
          beep_status TEXT NOT NULL CHECK(beep_status IN ('published', 'not_published', 'unknown')),
          beep_reason TEXT NOT NULL CHECK(length(beep_reason) <= 240),
          beep_updated_at INTEGER CHECK(beep_updated_at IS NULL OR beep_updated_at >= 0),
          UNIQUE(device_key, sender, idempotency_key)
        ) STRICT;
        CREATE INDEX notification_inbox_device_seq ON notification_inbox(device_key, seq DESC);
        CREATE INDEX notification_inbox_retention ON notification_inbox(created_at);
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
    `);
    database.exec('COMMIT');
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA wal_autocheckpoint = 100; PRAGMA journal_size_limit = 1048576;');
  if (database.prepare('PRAGMA foreign_key_check').all().length) throw corrupt('Inbox foreign key check failed');
  const columns = 'seq, substr(id,1,37) AS id, substr(sender,1,129) AS sender, substr(title,1,121) AS title, substr(text,1,2001) AS text, created_at, read_at, substr(beep_status,1,14) AS beep_status, substr(beep_reason,1,241) AS beep_reason, beep_updated_at';
  statements = {
    scoped: database.prepare(`SELECT ${columns} FROM notification_inbox WHERE device_key = ? AND id = ?`),
    duplicate: database.prepare(`SELECT ${columns} FROM notification_inbox WHERE device_key = ? AND sender = ? AND idempotency_key = ?`),
    count: database.prepare('SELECT count(*) AS count FROM notification_inbox WHERE device_key = ?'),
    unread: database.prepare('SELECT count(*) AS count FROM notification_inbox WHERE device_key = ? AND read_at IS NULL'),
    reminderCandidate: database.prepare(`SELECT ${columns} FROM notification_inbox
      WHERE device_key = ? AND read_at IS NULL
      AND (SELECT max(max(created_at, coalesce(beep_updated_at, created_at)))
        FROM notification_inbox WHERE device_key = ?) <= ?
      ORDER BY seq DESC LIMIT 1`),
    list: database.prepare(`SELECT ${columns} FROM notification_inbox WHERE device_key = ? AND (? = 0 OR read_at IS NULL) AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`),
    expire: database.prepare('DELETE FROM notification_inbox WHERE device_key = ? AND created_at <= ?'),
    expired: database.prepare('SELECT count(*) AS count, coalesce(sum(read_at IS NULL),0) AS unread FROM notification_inbox WHERE created_at <= ?'),
    expireAll: database.prepare('DELETE FROM notification_inbox WHERE created_at <= ?'),
    clearDevice: database.prepare('DELETE FROM notification_devices WHERE device_key = ?'),
    removeEmpty: database.prepare('DELETE FROM notification_devices WHERE NOT EXISTS (SELECT 1 FROM notification_inbox WHERE notification_inbox.device_key = notification_devices.device_key)'),
    device: database.prepare('INSERT OR IGNORE INTO notification_devices(device_key) VALUES (?)'),
    insert: database.prepare("INSERT INTO notification_inbox(id,device_key,sender,title,text,idempotency_key,created_at,read_at,beep_status,beep_reason,beep_updated_at) VALUES (?,?,?,?,?,?,?,NULL,'not_published','not_attempted',NULL)"),
    markRead: database.prepare('UPDATE notification_inbox SET read_at = coalesce(read_at, ?) WHERE device_key = ? AND id = ?'),
    beep: database.prepare('UPDATE notification_inbox SET beep_status = ?, beep_reason = ?, beep_updated_at = ? WHERE device_key = ? AND id = ?'),
  };
  secureFiles();
}

function record(row, preview = false) {
  if (!row) return null;
  if (!Number.isSafeInteger(row.seq) || row.seq < 1 || !UUID.test(row.id) || typeof row.sender !== 'string' || !row.sender.trim() || row.sender.length > 128 || /[\x00-\x1f\x7f]/.test(row.sender) ||
      typeof row.title !== 'string' || row.title.length > 120 || /[\x00-\x1f\x7f]/.test(row.title) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.text) ||
      !timestamp(row.created_at) || (row.read_at !== null && !timestamp(row.read_at)) || !STATUSES.includes(row.beep_status) || typeof row.beep_reason !== 'string' || row.beep_reason.length > 240 || /[\x00-\x1f\x7f]/.test(row.beep_reason) ||
      (row.beep_updated_at !== null && !timestamp(row.beep_updated_at))) throw corrupt('Invalid stored notification; refusing to return or change it');
  return {
    id: row.id, sender: row.sender, title: row.title,
    ...(preview ? { preview: row.text.slice(0, 240) } : { text: row.text }),
    createdAt: row.created_at, readAt: row.read_at,
    beep: { status: row.beep_status, reason: row.beep_reason, updatedAt: row.beep_updated_at },
  };
}
function transaction(action) {
  database.exec('BEGIN IMMEDIATE');
  try { const result = action(); database.exec('COMMIT'); secureFiles(); return result; }
  catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
}
function dispatch(action, p) {
  if (poisoned) throw poisoned;
  if (action === 'close') { database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); database.close(); return { closed: true }; }
  if (!timestamp(p.now)) throw new TypeError('Invalid inbox timestamp');
  if (action === 'cleanup') {
    const result = transaction(() => {
      const cutoff = p.now - options.retentionDays * DAY;
      const expired = statements.expired.get(cutoff);
      statements.expireAll.run(cutoff);
      statements.removeEmpty.run();
      return { expired: expired.count, expiredUnread: expired.unread };
    });
    database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    return result;
  }
  if (typeof p.key !== 'string' || !/^[0-9a-f]{64}$/.test(p.key)) throw new TypeError('Invalid inbox scope');
  if (action === 'clear') {
    const result = transaction(() => {
      const deleted = statements.count.get(p.key).count;
      statements.clearDevice.run(p.key);
      return { deleted };
    });
    database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return result;
  }
  return transaction(() => {
    // All paths enforce retention. An expired unread record is intentionally no longer available.
    statements.expire.run(p.key, p.now - options.retentionDays * DAY);
    if (action === 'enqueue') {
      if (p.idempotencyKey !== null) {
        const existing = record(statements.duplicate.get(p.key, p.sender, p.idempotencyKey));
        if (existing) {
          if (existing.title !== p.title || existing.text !== p.text) throw Object.assign(new Error('This idempotency key was already used with different notification content'), { code: 'INBOX_IDEMPOTENCY_CONFLICT' });
          return { notification: existing, duplicate: true };
        }
      }
      if (statements.count.get(p.key).count >= options.maxPerDevice) throw Object.assign(new Error('Notification inbox is full; retained records are never silently evicted'), { code: 'INBOX_CAPACITY' });
      const id = randomUUID();
      statements.device.run(p.key);
      statements.insert.run(id, p.key, p.sender, p.title, p.text, p.idempotencyKey, p.now);
      return { notification: record(statements.scoped.get(p.key, id)), duplicate: false };
    }
    if (action === 'list') {
      const rows = statements.list.all(p.key, p.unreadOnly ? 1 : 0, p.before, p.before, p.limit + 1);
      const page = rows.slice(0, p.limit);
      return {
        notifications: page.map((row) => record(row, true)),
        nextCursor: rows.length > p.limit ? Buffer.from(JSON.stringify({ v: 1, key: p.key, unreadOnly: p.unreadOnly, before: page[page.length - 1].seq })).toString('base64url') : null,
        unreadCount: statements.unread.get(p.key).count,
      };
    }
    if (action === 'reminderCandidate') {
      if (!Number.isSafeInteger(p.intervalMs) || p.intervalMs < 1 || p.intervalMs > DAY) throw new TypeError('Invalid reminder interval');
      return record(statements.reminderCandidate.get(p.key, p.key, p.now - p.intervalMs));
    }
    const previous = record(statements.scoped.get(p.key, p.notificationId));
    if (action === 'get' || !previous) return previous;
    if (action === 'markRead') statements.markRead.run(p.now, p.key, p.notificationId);
    else if (action === 'updateBeep') statements.beep.run(p.status, p.reason, p.now, p.key, p.notificationId);
    else throw new TypeError('Unknown inbox operation');
    return record(statements.scoped.get(p.key, p.notificationId));
  });
}

try { initialize(); }
catch (error) {
  try { database?.close(); } catch {}
  if (error.errcode === 11 || error.errcode === 26 || error.code === undefined) error.code = 'INBOX_CORRUPT';
  throw error;
}
parentPort.on('message', (message) => {
  try {
    const result = dispatch(message.action, message.payload);
    parentPort.postMessage({ id: message.id, result });
    if (message.action === 'close') parentPort.close();
  } catch (error) {
    if (error.code === 'INBOX_CORRUPT' || error.errcode === 11 || error.errcode === 26) {
      error.code = 'INBOX_CORRUPT';
      poisoned = error;
    }
    parentPort.postMessage({ id: message.id, error: { name: error.name, code: error.code, message: error.message } });
  }
});
