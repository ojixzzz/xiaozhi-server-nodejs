'use strict';

// Every filesystem and synchronous SQLite operation stays off the audio event loop.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData: options } = require('node:worker_threads');
const { _internals: { redactSecrets, timestamp, snapshot, copy, EPOCH } } = require('./memory');

const DAY_MS = 24 * 60 * 60 * 1000;
const APPLICATION_ID = 0x584d454d; // XMEM
const cache = new Map();
let database;
let statements;
let lastDataVersion;

function initialize() {
  fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(options.databasePath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(options.databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Memory database must be a regular file, not a symlink');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.chmodSync(options.databasePath, 0o600);
  database = new DatabaseSync(options.databasePath, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
  const version = database.prepare('PRAGMA user_version').get().user_version;
  const applicationId = database.prepare('PRAGMA application_id').get().application_id;
  if (version > 1 || (version !== 0 && version !== 1)) throw new Error('Unsupported memory database schema version');
  if (applicationId !== 0 && applicationId !== APPLICATION_ID) throw new Error('Unrecognized memory database application');
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  if (version === 0 && tables.length) throw new Error('Refusing to initialize a nonempty unrecognized database');
  if (version === 1 && applicationId !== APPLICATION_ID) throw new Error('Unrecognized memory database application');
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA wal_autocheckpoint = 100; PRAGMA journal_size_limit = 1048576;');
  if (version === 0) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE memory_devices (
        device_key TEXT PRIMARY KEY CHECK(length(device_key) = 64),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        epoch TEXT NOT NULL CHECK(length(epoch) = 36),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT;
      CREATE TABLE memory_facts (
        device_key TEXT NOT NULL REFERENCES memory_devices(device_key) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0 AND position < 100),
        text TEXT NOT NULL CHECK(length(text) > 0 AND length(text) <= 2000),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        PRIMARY KEY(device_key, position)
      ) STRICT;
      CREATE TABLE memory_turns (
        seq INTEGER PRIMARY KEY,
        device_key TEXT NOT NULL REFERENCES memory_devices(device_key) ON DELETE CASCADE,
        id TEXT NOT NULL CHECK(length(id) > 0 AND length(id) <= 128),
        user_text TEXT NOT NULL CHECK(length(user_text) > 0 AND length(user_text) <= 8000),
        assistant_text TEXT NOT NULL CHECK(length(assistant_text) > 0 AND length(assistant_text) <= 8000),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        UNIQUE(device_key, id)
      ) STRICT;
      CREATE INDEX memory_turns_device_seq ON memory_turns(device_key, seq);
      CREATE INDEX memory_turns_retention ON memory_turns(created_at);
      CREATE INDEX memory_facts_retention ON memory_facts(updated_at);
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  statements = {
    device: database.prepare('SELECT enabled, epoch, updated_at FROM memory_devices WHERE device_key = ?'),
    facts: database.prepare('SELECT substr(text, 1, 2001) AS text, updated_at FROM memory_facts WHERE device_key = ? ORDER BY position LIMIT 101'),
    turns: database.prepare('SELECT substr(id, 1, 129) AS id, substr(user_text, 1, 8001) AS user_text, substr(assistant_text, 1, 8001) AS assistant_text, created_at FROM memory_turns WHERE device_key = ? ORDER BY seq LIMIT 101'),
    upsert: database.prepare('INSERT INTO memory_devices(device_key, enabled, epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_key) DO UPDATE SET enabled = excluded.enabled, epoch = excluded.epoch, updated_at = excluded.updated_at'),
    deleteFacts: database.prepare('DELETE FROM memory_facts WHERE device_key = ?'),
    deleteTurns: database.prepare('DELETE FROM memory_turns WHERE device_key = ?'),
    expireFacts: database.prepare('DELETE FROM memory_facts WHERE device_key = ? AND updated_at <= ?'),
    expireTurns: database.prepare('DELETE FROM memory_turns WHERE device_key = ? AND created_at <= ?'),
    fact: database.prepare('INSERT INTO memory_facts(device_key, position, text, updated_at) VALUES (?, ?, ?, ?)'),
    turn: database.prepare('INSERT INTO memory_turns(device_key, id, user_text, assistant_text, created_at) VALUES (?, ?, ?, ?, ?)'),
    keys: database.prepare('SELECT device_key FROM memory_devices WHERE device_key > ? ORDER BY device_key LIMIT 100'),
  };
}

function empty(key, now, corrupt = false) {
  return { enabled: false, epoch: randomUUID(), facts: [], recentTurns: [], updatedAt: now, ...(corrupt ? { corrupt: true } : {}) };
}

function remember(key, record) {
  cache.delete(key);
  cache.set(key, record);
  while (cache.size > options.maxCacheEntries) cache.delete(cache.keys().next().value);
}

function valid(record) {
  if (typeof record.enabled !== 'boolean' || typeof record.epoch !== 'string' || !EPOCH.test(record.epoch) ||
      !timestamp(record.updatedAt) || record.facts.length > 100 || record.recentTurns.length > 100) return false;
  if (!record.enabled && (record.facts.length || record.recentTurns.length)) return false;
  if (!record.facts.every((fact) => typeof fact.text === 'string' && fact.text.trim() && fact.text.length <= 2000 && timestamp(fact.updatedAt))) return false;
  const ids = new Set();
  return record.recentTurns.every((turn) => {
    if (typeof turn.id !== 'string' || !turn.id.trim() || turn.id.length > 128 || /[\x00-\x1f\x7f]/.test(turn.id) || ids.has(turn.id) ||
        typeof turn.user !== 'string' || !turn.user.trim() || turn.user.length > 8000 ||
        typeof turn.assistant !== 'string' || !turn.assistant.trim() || turn.assistant.length > 8000 || !timestamp(turn.createdAt)) return false;
    ids.add(turn.id);
    return true;
  });
}

function load(key, now) {
  const cached = cache.get(key);
  if (cached) { remember(key, cached); return cached; }
  const row = statements.device.get(key);
  let record = row ? {
    enabled: row.enabled === 1,
    epoch: row.epoch,
    updatedAt: row.updated_at,
    facts: statements.facts.all(key).map((fact) => ({ text: fact.text, updatedAt: fact.updated_at })),
    recentTurns: statements.turns.all(key).map((turn) => ({ id: turn.id, user: turn.user_text, assistant: turn.assistant_text, createdAt: turn.created_at })),
  } : empty(key, now);
  if ((row && row.enabled !== 0 && row.enabled !== 1) || !valid(record)) record = empty(key, now, true);
  remember(key, record);
  return record;
}

function prune(record, now) {
  const cutoff = now - options.retentionDays * DAY_MS;
  const next = copy(record);
  next.facts = next.facts.filter((fact) => fact.updatedAt > cutoff).slice(0, options.maxFacts)
    .map((fact) => ({ ...fact, text: redactSecrets(fact.text).slice(0, options.maxFactChars) }));
  next.recentTurns = next.recentTurns.filter((turn) => turn.createdAt > cutoff).slice(-options.maxRecentTurns)
    .map((turn) => ({ ...turn, user: redactSecrets(turn.user).slice(0, options.maxTurnChars), assistant: redactSecrets(turn.assistant).slice(0, options.maxTurnChars) }));
  return next;
}

function save(key, record) {
  const next = { ...record };
  delete next.corrupt;
  statements.upsert.run(key, next.enabled ? 1 : 0, next.epoch, next.updatedAt);
  statements.deleteFacts.run(key);
  statements.deleteTurns.run(key);
  next.facts.forEach((fact, index) => statements.fact.run(key, index, fact.text, fact.updatedAt));
  next.recentTurns.forEach((turn) => statements.turn.run(key, turn.id, turn.user, turn.assistant, turn.createdAt));
  remember(key, next);
  return next;
}

function current(key, now) {
  const record = load(key, now);
  const next = prune(record, now);
  if (!record.corrupt && JSON.stringify(next) !== JSON.stringify(record)) return save(key, next);
  return next;
}

function transaction(action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    // Detect writes from another connection before consulting the bounded cache.
    const version = database.prepare('PRAGMA data_version').get().data_version;
    if (version !== lastDataVersion) { cache.clear(); lastDataVersion = version; }
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    cache.clear();
    throw error;
  }
}

function checkpoint() {
  // Logical erasure is immediate. Other readers/backups can still retain old bytes.
  database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
}

async function cleanup(now) {
  const result = { scanned: 0, updated: 0, corrupt: 0 };
  let after = '';
  while (true) {
    const keys = statements.keys.all(after).map((row) => row.device_key);
    if (!keys.length) break;
    transaction(() => {
      for (const key of keys) {
        const previous = load(key, now);
        result.scanned += 1;
        if (previous.corrupt) {
          result.corrupt += 1;
          // Invalid consent/epoch metadata must not keep otherwise dated text forever.
          const cutoff = now - options.retentionDays * DAY_MS;
          const facts = statements.expireFacts.run(key, cutoff).changes;
          const turns = statements.expireTurns.run(key, cutoff).changes;
          if (facts || turns) { result.updated += 1; cache.delete(key); }
          continue;
        }
        const next = prune(previous, now);
        if (JSON.stringify(next) !== JSON.stringify(previous)) { save(key, next); result.updated += 1; }
      }
    });
    after = keys[keys.length - 1];
    // Keep each read/write batch bounded; this still runs entirely in the worker.
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (result.updated) checkpoint();
  return result;
}

async function dispatch(action, payload) {
  if (action === 'cleanup') return cleanup(payload.now);
  if (action === 'flush') { database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); return { flushed: true }; }
  if (action === 'stats') return { cacheEntries: cache.size };
  if (action === 'close') { checkpoint(); database.close(); return { closed: true }; }
  const { key, now } = payload;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || !timestamp(now)) throw new TypeError('Invalid memory operation');
  const result = transaction(() => {
    if (action === 'clear') {
      const previous = load(key, now);
      return snapshot(save(key, { ...empty(key, now), enabled: previous.enabled }));
    }
    const previous = current(key, now);
    if (action === 'get') return snapshot(previous);
    if (action === 'configure') {
      const next = copy(previous);
      const enabled = payload.enabled === undefined ? previous.enabled : payload.enabled;
      if (!enabled && payload.facts && payload.facts.length) throw new TypeError('enable device memory before adding facts');
      if (enabled !== previous.enabled || payload.enabled === false) next.epoch = randomUUID();
      next.enabled = enabled;
      if (!enabled) { next.facts = []; next.recentTurns = []; }
      if (payload.facts !== undefined) next.facts = payload.facts.map((text) => ({ text, updatedAt: now }));
      next.updatedAt = now;
      return snapshot(save(key, next));
    }
    if (action === 'append') {
      if (!previous.enabled) return { stored: false, reason: 'disabled' };
      if (previous.epoch !== payload.expectedEpoch) return { stored: false, reason: 'stale' };
      if (previous.recentTurns.some((turn) => turn.id === payload.turn.id)) return { stored: false, reason: 'duplicate' };
      const next = copy(previous);
      next.recentTurns.push({ ...payload.turn, createdAt: now });
      next.recentTurns = next.recentTurns.slice(-options.maxRecentTurns);
      next.updatedAt = now;
      save(key, next);
      return { stored: true };
    }
    throw new TypeError('Unknown memory operation');
  });
  if (action === 'clear' || (action === 'configure' && payload.enabled === false)) checkpoint();
  return result;
}

// Startup errors surface as worker errors. A future call can retry after the operator fixes storage.
initialize();
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(async () => {
    try {
      const result = await dispatch(message.action, message.payload);
      parentPort.postMessage({ id: message.id, result });
      if (message.action === 'close') parentPort.close();
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: { name: error.name, code: error.code, message: error.message } });
    }
  });
});
