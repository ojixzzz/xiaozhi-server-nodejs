# Durable notification inbox

[Beranda](../README.md) · [Panduan pengguna](panduan-pengguna.md#membaca-inbox-dari-dashboard) · [Semua dokumentasi](README.md)

**Ringkasan Bahasa Indonesia:** inbox menyimpan pesan agent sebelum beep dicoba.
Saat Anda menyapa perangkat, Gemini membacakan judul dahulu; judul pada respons
audio yang selesai ditandai read oleh server. Membuka detail dashboard saja
belum menandai read; gunakan **Mark read**. Read tidak menghapus pesan. Bawaan
inbox adalah 100 pesan/perangkat dan retensi 30 hari, termasuk unread.
Referensi Inggris berikut menjelaskan penyimpanan dan API secara rinci.

This local SQLite inbox stores an approved sender's notification text before the
relay attempts a best-effort device chime. Later, a fresh Gemini session can
retrieve the text when the person using that device asks about notifications.
Conversation memory does not need to be enabled for this inbox to work.

## Scope and consent

- The application must explicitly enable incoming notifications, authenticate the
  external sender, and verify that the sender is allowed to address the approved
  device. `NotificationInbox` is a storage component, not an authentication layer.
- Pass the authenticated registry device ID and configured sender ID to the
  store. Neither scope may come from model-generated tool arguments or a claimed
  sender in an untrusted request body.
- Storage is device-scoped, not person-scoped. Everyone able to use a shared device
  may be able to ask Gemini for that device's notifications. It is not speaker
  verification. Choose appropriate notification content and device placement.
- Sender text is untrusted data, even when its sender is authenticated. Text in a
  notification cannot grant permissions, change tools, or become a new user
  instruction. Do not automatically execute instructions found in it.
- Inbox data stays local until the application retrieves it for the relevant
  session. That retrieval shares the returned content with the configured model
  provider. The structured tool formatter labels the content as untrusted.

## Storage and limits

The application uses `DATA_DIR/notifications.sqlite`, separately from
`memory.sqlite`. Node.js 24+ native SQLite runs only inside an asynchronous worker
thread. No SQLite or filesystem call is placed on the audio event loop.

The storage library defaults and hard bounds are:

| Setting | Default / bound |
| --- | --- |
| Retention | 30 days from server-assigned `createdAt` |
| Records per device | 100 total, including read records |
| Title | Optional; at most 120 JavaScript string characters |
| Notification text | Required; at most 2,000 JavaScript string characters |
| Authenticated sender ID | 1–128 characters |
| Idempotency key | Optional; 1–128 characters |
| List page | 5 records by default; maximum 20 |
| List preview | At most 240 characters |
| Beep reason | At most 240 characters |
| Outstanding store requests | 256 by default, across devices |
| Entire formatted tool result | At most 6,000 serialized JSON characters |

The application applies stricter public limits: HTTP/MCP ingress requires an
idempotency key, and Gemini lists three records by default (maximum five) with a
4,000-character formatted-result budget. See [the notification integration
guide](notifications.md) for those external contracts.

Lengths count JavaScript UTF-16 code units, so emoji can count as two characters.
Malformed Unicode and binary/control payloads are rejected; text permits tabs and newlines. There is no
silent text truncation during enqueue. The helper can shorten text in a tool
result to satisfy the complete JSON budget and sets `truncated: true`.

An inbox at capacity rejects new notifications *before* the caller should attempt
a chime. No unexpired record is silently evicted, including read records. This
preserves idempotency for the whole retention window. Marking a record read does
not free a capacity slot. Change the configured capacity or wait for expiry;
there is no automatic read-record eviction.

**Unread records expire too.** Retention is enforced on device operations and by
`cleanup()`. Inactive-device expiry is physically processed when the application
calls cleanup; the application should schedule it. The expiry boundary is
`createdAt <= now - retentionDays`. The default is not indefinite delivery or an
unlimited archive. Retention days and per-device capacity are constructor options.

SQLite uses transactions, WAL, `synchronous=FULL`, foreign keys, strict tables,
uniqueness and check constraints. New data directories are created with mode
`0700`; the database and WAL/SHM files use `0600` on POSIX systems. Existing parent
directory permissions are not changed. Keep that directory private, and protect
backups, volume mounts and host access. This is not application-level encryption.
Only a SHA-256 hash of the device identifier is stored as its key; hashing is
pseudonymization, not encryption.

Wrong database application IDs, unsupported schemas, corrupt files and invalid
stored records fail closed. The component does not replace a damaged database or
silently fall back to an in-memory inbox. Fix/restore storage explicitly before
restarting it. A SQLite commit acknowledgment establishes local durability; it
does not prove delivery to the device.

## Lifecycle and outcome semantics

1. Authenticate sender, check opt-in and verify the allowed device
2. Commit `enqueue()` to the inbox
3. If it is a new notification, attempt the configured chime once
4. Save that attempt with `updateBeep()`
5. List or retrieve the notification only for its authenticated device session
6. Mark it read only when explicitly requested or acknowledged through the
   application's completed title-announcement action

`readAt: null` means unread. Ordinary listing, retrieving or changing beep status
never changes `readAt`. `markRead()` sets it once; repeated calls keep
the original timestamp. Read notifications remain retrievable until expiry or
administrator device deletion.

The relay checks unread messages every five seconds and sends at most one reminder
chime per idle approved MQTT device per `NOTIFY_REMINDER_INTERVAL_MS` (default
60,000 ms; `0` disables reminders). The device's most recent message creation or
beep-attempt timestamp determines the next due time, so restarting resumes unread
reminders without immediately repeating a recent attempt. No schema migration or
additional inbox message is needed. Expired/read messages stop reminders; active
voice sessions pause them. Offline and uncertain attempts can be tried again on
the next interval; a beep still has no physical playback acknowledgment.

In an authenticated Gemini conversation, a greeting such as “halo”, “apa” or
“ada apa” causes `notifications_announce` to return up to five unread titles,
without previews or message bodies. Gemini reads the exact titles first and
offers details. The relay marks only titles found in its output transcription
after the audio response finishes sending. Empty titles are announced as
“Notifikasi tanpa judul”. Opening a connection, calling the tool, partial audio,
an interrupted response or a notification arriving after that batch does not
acknowledge unseen titles. This is the application's read policy, not proof a
person physically heard the speaker. Input/output transcription is enabled
internally for this flow even when dashboard subtitles or memory are disabled.
Afterward, `notifications_get` can retrieve the full message even if it is read.

Beep status is a separate object:

- `not_published`: no successful publication is recorded; initial reason is
  `not_attempted`, with `updatedAt: null`
- `published`: the gateway reported publication; this is not verified physical
  playback and is not a read acknowledgment
- `unknown`: the attempt outcome cannot be established

The store does not enqueue audio, retry a chime, or infer delivery. A crash after
committing text but before updating beep status can leave `not_attempted` even
when publication happened. Treat that as absence of a recorded outcome, not proof
that no beep occurred. A duplicate submission must not trigger another chime.

On administrator device deletion, the application revokes the registry entry
first, closes its sessions, then calls `clear(deviceId)`. This removes only that
device's messages and dedupe history, with a WAL checkpoint. It does not expose a
public purge tool. A failed purge must be reported without restoring ingress
access. SQLite secure deletion/checkpointing does not guarantee forensic erasure
from snapshots, backups, storage firmware or other readers.

## JavaScript API

```js
const { NotificationInbox, buildInboxToolResult } = require('./lib/inbox');
const inbox = new NotificationInbox({
  databasePath: '/private/data/notifications.sqlite',
  retentionDays: 30,
  maxPerDevice: 100,
});

const { notification, duplicate } = await inbox.enqueue(authenticatedDeviceId, {
  sender: authenticatedSenderId,
  title: 'Reminder',
  text: 'The package is ready for pickup.',
  idempotencyKey: 'event-123',
});

// Only for a new record, after the actual gateway result is known:
if (!duplicate) {
  await inbox.updateBeep(authenticatedDeviceId, notification.id, {
    status: 'published',
    reason: 'gateway_publish',
  });
}

const page = await inbox.list(authenticatedDeviceId, {
  unreadOnly: true, // default
  limit: 5,        // default; range 1..20
  // cursor: pageFromEarlier.nextCursor,
});
const full = await inbox.get(authenticatedDeviceId, notification.id);
const safeToolResult = buildInboxToolResult(full); // JSON object, not a prompt

// Only on an explicit read action, not after listing or playing audio:
await inbox.markRead(authenticatedDeviceId, notification.id);
await inbox.cleanup();
await inbox.close();
```

All storage methods return promises. `enqueue` returns
`{ notification, duplicate }`. Full records are:

```json
{
  "id": "7a77c351-902e-4f2f-84f1-2365c12f0188",
  "sender": "configured-hermes-sender",
  "title": "Reminder",
  "text": "The package is ready for pickup.",
  "createdAt": 1700000000000,
  "readAt": null,
  "beep": {
    "status": "not_published",
    "reason": "not_attempted",
    "updatedAt": null
  }
}
```

IDs are server-generated UUIDs. Times are server-generated millisecond timestamps;
external submissions cannot override them. `list()` returns
`{ notifications, nextCursor, unreadCount }`, newest first, using sequence-based
pagination even when timestamps tie. List records replace `text` with `preview`.
`unreadCount` counts all currently retained unread records for the device, not
just the page. Cursors are bound to the device and `unreadOnly` filter. They are
opaque navigation tokens, not authorization credentials.

`get(deviceId,id)`, `markRead(deviceId,id)` and
`updateBeep(deviceId,id,{status,reason})` return the full record or `null` for a
missing, expired or other-device record. `cleanup()` returns
`{ expired, expiredUnread }`. Internal administrator `clear(deviceId)` returns
`{ deleted }`. `close()` drains accepted requests and is idempotent. Revocation
must block new ingress before `clear()`; the storage component does not maintain
its own device allowlist.

`buildInboxToolResult(result,{maxChars:6000})` accepts a list, full record, `null`,
or `{notification}`. It whitelists fields and returns an object containing
`untrusted`, `notice`, `truncated`, and the relevant `notification` or
`notifications` / count / cursor fields. The budget includes the complete
`JSON.stringify()` result, including escaping and metadata. A tiny budget that
cannot hold metadata returns a bounded error instructing the caller to ask for
fewer records or a larger budget; it never returns a cursor that silently skips
omitted records. The budget is characters, not model tokens or UTF-8 bytes.

## Idempotency and errors

Persisted dedupe uses `(device hash, authenticated sender ID, idempotency key)`.
Concurrent requests, including separate store workers using the same database,
commit at most one matching notification. An exact retry returns the original
record and current read/beep status with `duplicate: true`, even when full.
Reusing the key with different title or text rejects with a conflict. Different
senders and different devices have separate key namespaces. Omit the key only
when deliberate repeated messages should be separate records.

Dedupe lasts as long as its record. Retention expiry or administrator deletion
removes it; reuse after that boundary creates a new notification. Configuration
should be consistent across processes sharing a database.

| Error code | Meaning |
| --- | --- |
| `INBOX_CAPACITY` | Device's retained-record limit reached; no insert/chime |
| `INBOX_IDEMPOTENCY_CONFLICT` | Same scoped key with different title/text |
| `INBOX_BACKPRESSURE` | Worker request queue full; retry later with the same key |
| `INBOX_CORRUPT` | Unrecognized/corrupt/invalid storage; fail closed |
| `INBOX_CLOSED` | Store closing or closed |
| `INBOX_WORKER_EXIT` | Worker exited unexpectedly; no success may be inferred |
| `TypeError` | Invalid identifier, payload, cursor, bounds or options |

Other filesystem/SQLite failures are surfaced, not reported as successful
storage. Do not emit notification contents or credentials in logs. If a caller
loses the commit response, retry with the same idempotency key rather than
assuming the message was not stored.

## Verification

Run `node --test test/inbox.test.js` for isolated temporary-database checks:
restart persistence, cross-worker dedupe and capacity, device isolation, explicit
read semantics, beep independence, retention boundaries, private WAL/schema
settings, corrupt-file/record and symlink rejection, bounded queueing, scoped
device deletion and full tool-JSON budgeting. These tests do not contact an
external sender, Gemini or a physical device, and do not prove audible playback.

## Dashboard access

Use **Memory & Notify → Notification inbox** to browse saved text, filter unread
entries, page through previews, open details and explicitly mark a message read.
**Save message & beep** stores a manual test message with source
`@dashboard-admin`, using the same durable publisher as external senders and no
external sender token. **Retry beep only** addresses an existing record and never
creates another inbox entry or changes its read state. Opening details is read-only.
The separate audio-only test does not save text. See
[the Indonesian setup guide](SETUP_ID.md#7-coba-inbox-lalu-hubungkan-agent).
