# Device memory: SQLite, consent, bounds and privacy

[Beranda](../README.md) · [Panduan pengguna](panduan-pengguna.md#memori-percakapan-opsional) · [Semua dokumentasi](README.md)

**Ringkasan Bahasa Indonesia:** memori percakapan awalnya nonaktif. Untuk
mengaktifkannya, buka **Memory & Notify**, centang **Enable shared memory for this
device**, lalu **Save memory**. Fitur ini menyimpan giliran Gemini yang selesai
dan catatan yang Anda masukkan. Semua pengguna perangkat berbagi memori yang sama.
Mematikan dan menyimpan memori menghapus data memori, bukan inbox. Bagian Inggris
berikut adalah referensi batas, privasi, dan API untuk administrator/pengembang.

Memory is **off by default for every device**. An authenticated administrator can
turn it on in the **Memory & Notify** dashboard for an approved device. The
administrator password must be unique and at least 12 characters. This feature
currently collects and reuses completed **Gemini** transcript turns only.

Memory additionally requires a dedicated per-device token, distinct from the
shared `CLIENT_AUTH_TOKEN` and not duplicated across registered devices. Legacy
shared-token voice connections continue to work. Enabling memory returns 409 and
Gemini memory injection stays off until the operator provisions dedicated device
authentication. Authenticated administrators can still review, clear or disable
existing memory without a dedicated token, so erasure is never blocked by that
requirement. This implementation does not generate or change credentials.

## What is remembered

- Text from a completed turn, with both a user transcript and assistant transcript
- Notes explicitly entered by the administrator; no automatic fact extraction,
  profiling, paid summarization call, embedding model or vector database
- Consent state, a revocation epoch, turn IDs, and retention timestamps

This is **device-scoped memory, not person identification**. The application
passes the exact device identifier from its authenticated device registry. The
SQLite key is a SHA-256 hash of that identifier; the raw device identifier is not
written by the memory module. A hash is pseudonymization, not encryption. People
sharing a device also share its memory. Never assume a recalled preference or
conversation belongs to the current speaker.

Memory stores no raw audio and does not read or copy server API keys, device
tokens, environment credentials or provider session objects. Only the explicit
note strings and transcript strings passed to its API enter the store. Gemini
transcription is enabled for memory even when transcript display is disabled.
Memory therefore adds text persistence and additional saved context sent to the
configured Gemini provider on a subsequent connection. Normal provider usage
and context costs can still apply; there is no separate model call for memory.

Best-effort redaction masks obvious Bearer tokens, common API/access-key formats,
PEM private keys, and explicitly labeled password/token values before persistence.
**It cannot detect every secret, especially dictated credentials or personal
information. Do not dictate secrets while memory is enabled.** This feature does
not scrub existing application logs, provider-side history or other backups.

## Storage and persistence

The application stores its database at:

```text
$DATA_DIR/memory.sqlite
```

With the supplied container, this is `/app/data/memory.sqlite` in the persistent
data volume. SQLite may create adjacent `memory.sqlite-wal` and
`memory.sqlite-shm` files while running. Keep the database and its sidecars on the
same writable local volume. Do not copy only the live main file as a backup:
shut down cleanly first, or use a SQLite-consistent backup procedure.

The implementation uses Node's built-in `node:sqlite` on Node 24 or newer, with no
new database dependency. Its `DatabaseSync` connection and all filesystem/database
work run in `lib/memory-worker.js` on a worker thread. Audio callbacks only append
bounded strings in memory; they never run synchronous SQLite queries or disk I/O.
A memory read is awaited before Gemini session setup, and completed turns are
written asynchronously.

Database protections:

- WAL mode, `synchronous=FULL`, 5-second busy timeout, foreign keys and explicit
  transactions
- Schema version 1 (`PRAGMA user_version`) and an application-ID guard; unknown
  future schemas and unrelated databases are rejected, never reset automatically
- `0600` database permissions, `0700` for newly created parent directories,
  parameterized statements, and hashed per-device keys
- Per-device operation ordering, a bounded 100-device LRU cache, and SQLite
  `data_version` checks before using cached state
- Atomic mutation rollback: an unsuccessful write rejects its caller, leaves the
  committed state intact, and does not poison subsequent writes or retries

Use one application process per data directory. SQLite protects transactions
across connections, but live voice sessions and dashboard state belong to the
application process. A database error causes memory to fail closed; the voice
connection can continue without saved memory. Invalid records are flagged as
corrupt and never injected into prompts. Investigate or restore storage through
an operator-controlled procedure; there is no silent database recreation.

**Earlier development JSON memory files are not imported or deleted.** If any
exist from a previous local prototype, they are unused by this SQLite version.
Review and remove or archive them explicitly according to your retention policy.
No production JSON migration is implied.

## Context and storage limits

The application defaults are:

| Setting | Default | Application bounds |
| --- | ---: | --- |
| `MEMORY_CONTEXT_MAX_CHARS` | 6,000 | 256–24,000 |
| `MEMORY_MAX_TURNS` | 8 complete turns | 1–24 |
| `MEMORY_TURN_MAX_CHARS` | 1,200 per side | 100–2,000 |
| Administrator notes | 20 | 500 characters per note |
| Retention | 30 days | Fixed by this application's configuration |
| Cached devices | 100 | Bounded independently of stored devices |

Malformed environment settings fall back to conservative defaults with a warning.
Facts beyond their count or length limit are rejected as one atomic request.
Transcripts are truncated to their per-side bound before storage.

The context cap includes the **entire injected memory section**, including its
fixed warning, JSON encoding, escaped characters and closing delimiter. Selection
is deterministic: administrator notes in their saved order have priority, then
recent turns are considered newest first. Only complete entries that fit are
included; selected turns are rendered chronologically. Older or oversized
entries are omitted rather than producing broken JSON. A budget too small for the
framing and any entry produces no memory section.

These are JavaScript string-character bounds (UTF-16 code units), **not exact
model-token counts**. Unicode and JSON escaping are included in the actual final
string measurement. The limit bounds this memory addition, not the existing
system prompt, tools, audio or the ongoing Gemini Live conversation. It does not
guarantee a fixed maximum total live-session context size.

The section explicitly labels saved material as untrusted, fallible device data,
not instructions or proof of identity. Text is JSON-escaped and angle brackets are
escaped before inclusion. This reduces accidental boundary confusion; it is not
a guarantee that a model is immune to prompt injection. Never put trusted policy,
authorization decisions or executable instructions in saved notes.

## Retention, clearing and disabling

Facts expire 30 days after being explicitly saved; turns expire 30 days after
completion. Expired content is pruned on access and by startup/hourly cleanup,
including devices absent from the cache. Cleanup scans database keys in batches
of 100, avoiding an unbounded in-memory list of all records.

- **Clear memory** removes all notes and turns while preserving the enabled flag.
  The administrator must confirm the exact device ID. The application closes that
  device's active voice sessions so already-loaded memory is no longer used.
  If still enabled, a new connection can remember new completed turns
- **Disable and save** removes all notes and turns, turns memory off, rotates the
  epoch, and closes active voice sessions. Re-enabling starts with empty memory
- Both operations rotate the persisted epoch. A turn buffered under an older
  epoch cannot write after a successful clear/disable, even if it arrives late or
  the cache has evicted the device
- Small device consent/epoch rows remain after text deletion. They contain no
  remembered conversation and prevent stale sessions from recreating erased text

`secure_delete=ON` is enabled and clear/disable/retention cleanup attempt a WAL
checkpoint. Deletion is nevertheless **logical deletion, not a forensic erasure
guarantee**: active readers, database/WAL copies, filesystem snapshots, storage
hardware and backups may retain old bytes. Protect the volume with appropriate
access controls and encryption, and include backups and unused legacy files in
retention/deletion procedures. Restoring a backup can restore forgotten data.

## Module API

`lib/memory.js` exports `MemoryStore`, `TurnBuffer`, `buildMemoryContext` and
`DEFAULTS`. The library default per-side turn bound is 2,000 characters; `app.js`
uses the more conservative 1,200-character default above.

```js
const { MemoryStore, TurnBuffer } = require('./lib/memory');
const store = new MemoryStore({
  databasePath: '/your/private/data/memory.sqlite',
  maxContextChars: 6000,
  maxRecentTurns: 8,
  maxTurnChars: 1200,
});

// deviceId MUST be the identifier already verified by device authentication.
const saved = await store.configure(deviceId, {
  enabled: true,
  facts: ['Prefers short answers'],
});
const sessionMemory = await store.get(deviceId);
const context = store.context(sessionMemory);
const collector = new TurnBuffer({
  store, deviceId, epoch: sessionMemory.epoch,
});
collector.addInput('A complete question');
collector.addOutput('A complete answer');
await collector.complete();

// On interruption: collector.discard()
// On disconnect/provider replacement: collector.close()
// On shutdown, after stopping new sessions:
await store.close();
```

A compatibility constructor `{directory: '/private/memory'}` selects
`/private/memory/memory.sqlite`; it does not use JSON persistence.

- `get(deviceId)` returns `{enabled, epoch, facts, recentTurns, updatedAt}` and
  optional `corrupt: true`; returned objects cannot mutate stored state
- `configure(deviceId, {enabled, facts})` validates and saves both atomically;
  either field can be omitted at the module level
- `setFacts(deviceId, facts)` replaces explicit notes on an enabled device
- `clear(deviceId)` returns the empty snapshot with a new epoch
- `appendTurn(deviceId, {id, user, assistant}, {expectedEpoch})` requires the epoch
  captured when that session loaded memory; it resolves to `{stored: true}` or
  `{stored: false, reason: 'disabled' | 'stale' | 'duplicate'}`
- `cleanup()` returns scan/update/corruption counts
- `flush()` drains accepted work and checkpoints; mutation promises still report
  their individual errors. `close()` prevents new work, drains, and closes the
  worker. It is idempotent

`TurnBuffer` only accepts text. It bounds chunks as they arrive, requires both
sides before completion, resets synchronously before a write, and ignores
chunks after `close()`. Repeated completion signals cannot save the same buffered
turn twice. `discard()` removes an interrupted/incomplete turn. Completed turns
already accepted for persistence may finish during shutdown; incomplete turns
are discarded. Integration must detach or guard late events from replaced
providers; transcript events have no speaker-identity guarantee.

A failed `complete()` rejects and is logged by the application. It is not silently
reported as saved, and discarded transcript buffers are not replayed on reconnect.
For direct module callers, retrying `appendTurn` with the same ID and epoch is
safe while that turn remains in the bounded duplicate-detection window.

## Dashboard HTTP API

These routes require the administrator session, a strong configured admin
password and an approved device. Mutation requests require JSON plus
`X-Requested-With: XiaozhiDashboard`; they are not public/device-token endpoints.

- `GET /api/devices/:mac/memory`: returns `enabled`, `facts`, `turns`,
  `retentionDays`, `contextMaxChars` and `maxRecentTurns`
- `PUT /api/devices/:mac/memory`: accepts exactly `{"enabled":true,"facts":[...]}`
  (both fields required at the HTTP layer)
- `DELETE /api/devices/:mac/memory`: accepts `{"confirm":"exact-device-id"}`

Memory responses are not cacheable. Invalid input returns 400; unavailable
storage returns 503; enabling a device lacking dedicated authentication returns
409. Review, clear and disable remain available to the authenticated administrator.
Turning memory on affects collection and context on the next
Gemini connection. See the dashboard's privacy text before enabling a shared
device.

## Verification

Run `node --test test/memory.test.js` for temporary-directory-only SQLite tests,
including isolation, opt-in defaults, schema/version guards, retention, restart,
transaction rollback/retry, bounded cache/context, Unicode escaping, epoch races,
interruption/duplicate handling, worker shutdown and unchanged legacy JSON.
`npm test` also exercises the app's local authenticated HTTP integration.
No live provider, audio hardware, real credential or paid API call is required.

Reference: [Node.js 24 SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
