# MQTT gateway and audio notifications

[Beranda](../README.md) · [Panduan pengguna](panduan-pengguna.md) · [Instalasi](SETUP_ID.md)

**Ringkasan Bahasa Indonesia:** halaman ini membahas jalur MQTT dan audio yang
membuat perangkat idle berbunyi. Penyimpanan inbox tetap bisa berhasil meskipun
beep gagal. Untuk mencoba pesan lengkap, gunakan **Save message & beep**;
**Send notification** pada bagian audio hanya mengirim rekaman tanpa pesan inbox.
`published` bukan bukti suara sudah terdengar. Referensi Inggris berikut untuk
administrator/pengembang; pemakaian dashboard ada di panduan pengguna.

For the primary **text notification inbox → beep → ask Gemini later** workflow,
see [inbox behavior](inbox.md) and [Hermes/HTTP/MCP sender setup](hermes-mcp.md).
This page documents the gateway and best-effort audio leg of that workflow, plus
manual audio testing. Audio publication and durable text storage are separate
outcomes.

The repository now includes the actual MQTT/UDP-to-WebSocket gateway, its private
HTTP forwarding API, OTA provisioning, device transport selection, and signed
local audio downloads. **Redis and an external broker are not required.**
MQTT and audio sending are opt-in; text ingress separately requires configured
sender credentials/device allowlists. Existing devices remain on WebSocket until
an administrator explicitly changes their transport. Disabling MQTT/audio does
not itself disable text ingress or delete the inbox.

For deployment, start with [the Indonesian setup guide](SETUP_ID.md) and
[Docker instructions](docker.md). These are setup instructions, not evidence of a
completed production deployment or physical-device playback test.

## Components and data flow

- `app.js`: existing relay/dashboard, approved-device registry, signed MQTT OTA
  configuration, Gemini memory, and authenticated notification endpoints
- `gateway/server.js`: persistent MQTT control connection, encrypted UDP audio
  bridge to the relay's existing WebSocket voice path, and private `/forward` API
- `lib/mqtt-integration.js`: MQTT provisioning/credential helpers and the built-in
  HTTP gateway adapter
- `lib/notifications.js`: destination authorization, payload validation, expiry,
  bounded attempts, idempotency and truthful publication results
- `lib/notification-audio.js`: administrator-selected local Ogg Opus assets served
  through expiring signed links; no external-URL fetching or TTS

A configured sender submits text through `POST /api/notifications` or the
stateless MCP endpoint `POST /mcp/notifications`. The application persists it in
`DATA_DIR/notifications.sqlite` and can request the fixed `NOTIFY_BEEP_ASSET`
(default `sample-chime.ogg`). The device can retrieve the text later through
Gemini's notification tools, even if it missed the beep. The inbox is separate
from optional conversation memory and does not require automatically speaking
incoming text. Configure authorized sender tokens/device allowlists as described
in [hermes-mcp.md](hermes-mcp.md); the sender cannot supply an arbitrary audio URL
for this text-ingress path.

The Gemini tools are `notifications_announce`, `notifications_list`, `notifications_get` and
`notifications_mark_read`. They use the authenticated device scope and require
dedicated device authentication; conversation memory may remain disabled. The
default tool-result bound is 4,000 characters (`INBOX_TOOL_MAX_CHARS`), not a cap
on the whole Gemini session. Listing/getting/beeping never marks an entry read;
explicit mark-read requires the current user's request. After a user greeting or
notification question, `notifications_announce` returns titles only; the server
acknowledges titles present in a completed audio response. Details are retrieved
only when asked. See [read and reminder semantics](inbox.md#lifecycle-and-outcome-semantics).
Text retrieval also works
over an ordinary WebSocket conversation, even without MQTT beep support.
Retrieved text is shared with the configured Gemini provider. When conversation
memory is enabled, completed discussion of a notification may also be retained
as transcript turns; deleting the source inbox record would not itself clear
those separate turns or backups.

A conversation travels from the device over MQTT control and UDP audio to the
gateway, then over an internal WebSocket to the relay/provider. An idle
notification uses only the already-connected MQTT control channel. The device
downloads its audio directly from the configured HTTP(S) audio origin; sending a
notification does not open the microphone or start a provider session.

This gateway implements the Xiaozhi-specific control/audio path. It is not a
general-purpose MQTT broker or a retained-message queue.
Its firmware-compatible UDP AES-CTR format lacks authenticated integrity and
depends on firmware nonce behavior for confidentiality. MQTT TLS covers the
control connection, not UDP; keep the audio path on trusted networks with
appropriate access restrictions. TCP and UDP source addresses must remain
consistent for the gateway's peer matching.

## Device provisioning and authentication

1. First establish an ordinary WebSocket conversation with one owned, approved
   device. The relay needs that device's real UUID and a dedicated per-device
   token, distinct from the legacy shared token and other devices' tokens.
2. Configure and start the bundled gateway. In **Memory & Notify**, select
   **MQTT gateway** and **Save transport** for that device.
3. Reboot the device or make it fetch its OTA configuration again. Saving a
   dashboard setting alone does not reboot or flash it.

The relay saves the client ID for this approved device and supplies HMAC-signed
credentials through OTA. The gateway validates them and consults the private
registry before allowing the device or forwarding a notification. Its upstream
WebSocket uses that device's own token. Administrators do not need to invent
client IDs or maintain `NOTIFY_CLIENT_IDS_JSON` for the bundled path.

`MQTT_SIGNATURE_KEY` and `MQTT_GATEWAY_KEY` must be distinct, operator-provided
secrets of at least 32 characters. The former signs device credentials; the latter
authenticates the private gateway/registry calls and derives a separate audio-link
signing key. Do not commit, log or expose either key to dashboard users or public
URLs. Keep the gateway HTTP port 3001 private. A secret change requires coordinated
service reconfiguration; existing signed links or MQTT credentials may cease to
work.

## Configuration

Essential bundled-path settings are:

```dotenv
MQTT_ENABLED=true
MQTT_SIGNATURE_KEY=
MQTT_GATEWAY_KEY=
MQTT_ENDPOINT=relay.example.com:8883
MQTT_PUBLIC_HOST=relay.example.com
MQTT_GATEWAY_URL=http://gateway:3001
MQTT_REGISTRY_URL=http://xiaozhi:3000/internal/mqtt/devices/
MQTT_UPSTREAM_URL=ws://xiaozhi:3000/xiaozhi/v1/
MQTT_PORT=8883
MQTT_UDP_PORT=8884
MQTT_ALLOW_INSECURE=false
MQTT_TLS_CERT_FILE=/run/mqtt-tls/fullchain.pem
MQTT_TLS_KEY_FILE=/run/mqtt-tls/privkey.pem

NOTIFY_ENABLED=true
NOTIFY_AUDIO_BASE_URL=https://relay.example.com
NOTIFY_ALLOWED_AUDIO_ORIGINS=https://relay.example.com
MQTT_AUDIO_ALLOWED_ORIGINS=https://relay.example.com
NOTIFY_ALLOW_HTTP=false
NOTIFY_TIMEOUT_MS=5000
```

Supply the two blank secrets yourself before startup. These service names are for
Docker Compose; native processes need reachable loopback/internal URLs instead.
`MQTT_ENDPOINT` is **host:port, with no `mqtt://` or other scheme**.
`MQTT_PUBLIC_HOST` contains only the device-reachable hostname or IPv4 address.
The published UDP port must match the gateway's advertised UDP port.

TLS on port 8883 is the default. For an explicitly trusted, private LAN test only,
port 1883 requires `MQTT_ALLOW_INSECURE=true` and blank TLS paths. HTTP audio also
requires `NOTIFY_ALLOW_HTTP=true` and matching exact HTTP origins in both
allowlists. Those opt-ins expose credentials/audio to network observers; never use
the LAN template for an internet-facing service.

Origins are exact scheme/host/port combinations, without a path, credentials,
query, fragment or wildcard. Restart/recreate services after environment changes.
Audio reachability and trust in the supplied TLS certificate must be tested on the
actual device, not inferred from a desktop browser.

## Firmware message and private forwarding API

The [official firmware notification specification](https://github.com/78/xiaozhi-esp32/blob/main/docs/notify.md)
describes one-way notification playback on a compatible idle device. Check the
installed firmware version/build for support; the setup does not install firmware.

The bundled gateway accepts this JSON at private `POST /forward`, authenticated
with `Authorization: Bearer <MQTT_GATEWAY_KEY>`:

```json
{
  "method": "forward",
  "clientId": "the-client-id-provisioned-by-this-relay",
  "params": {
    "type": "notify",
    "audio_url": "https://relay.example.com/notification-audio/example.ogg?expires=...&signature=...",
    "subtitles": [{ "start_ms": 0, "text": "Test notification" }]
  }
}
```

Only `params` is sent to the device. Local request IDs, send deadlines and
idempotency keys are never added to that firmware message. The bundled gateway's
`{ "success": true }` reports an MQTT socket write, not receipt, playback or proof
that anyone heard it. The text inbox has periodic unread reminders, defaulting to
one new chime attempt per minute per idle MQTT device. There is no offline audio
queue; an offline or uncertain attempt may be followed by another reminder later.
Direct audio-only requests have no automatic retry. Beeps do not change read state.

The official firmware document describes a Redis RPC transport for `xz-mqtt`.
This repository implements its own authenticated HTTP transport around the same
forwarding envelope. It does not assume that the public upstream gateway has a
working Redis RPC interface, nor require Redis to be installed.

## Local audio and prerecorded speech

The bundled `notification-audio/sample-chime.ogg` is a one-second **test tone with
no speech**. In the dashboard choose it under **Local prerecorded audio**, then
click **Use local audio**. That issues a five-minute download URL without sending
anything to the device. Review the device, URL and optional subtitle, then click
**Send notification** separately.

You can install your own trusted, short mono Ogg Opus recordings in
`notification-audio/`, or set `NOTIFY_AUDIO_DIR` to another operator-managed
directory. The Compose mount is read-only. Listing/issuing URLs requires the
administrator session; the expiring download URL is a bearer link readable by
anyone who possesses it until expiry. Do not log or share its query string.

Files are limited to 5 MiB; names are restricted to safe `.ogg` basenames. The
server rejects symbolic links and checks the mono Opus identification header.
That check is not a full decoder validation. Validate complete recordings before
installing them. A direct external URL can also be used if its origin is allowed;
the relay/gateway do not fetch, transcode or proxy it. See
[audio preparation](../notification-audio/README.md) for the tested sample format
and optional offline FFmpeg conversion commands.

There is no built-in speech synthesis, reminder scheduler or background task
runner. A subtitle is display text, not synthesized speech. To hear a spoken
manual audio notification, provide a recording containing those words. For
incoming agent notifications, the normal flow is a fixed beep followed by Gemini
retrieving the saved text when the user asks; no prerecorded speech is needed.

## Dashboard API

Routes require the authenticated administrator session. Mutation routes also
require JSON and `X-Requested-With: XiaozhiDashboard`; per-device routes require
an approved device and a unique administrator password of at least 12 characters.

- `GET /api/mqtt/status`: configuration flags, reason, audio availability and
  notification-service configuration. **Not a gateway connectivity/playback probe**
- `POST /api/devices/:mac/transport`: `{ "transport": "mqtt" }` or
  `{ "transport": "websocket" }`; closes an existing voice session and returns
  `reconnect_required: true`. Reboot/fetch OTA to apply the selected transport
- `GET /api/notification-audio`: configured state and available local assets
- `POST /api/notification-audio/url`: `{ "name": "sample-chime.ogg" }`; returns
  `audio_url` and an ISO-formatted link `expires_at`
- `POST /api/devices/:mac/notifications`: accepts `audio_url`, optional
  `subtitles`, `idempotency_key`, and `expires_at`. Here `expires_at` is a **Unix
  timestamp in milliseconds for the send deadline**, not the audio endpoint's
  ISO string. Omit it to use the default 30-second send deadline

The private registry route `/internal/mqtt/devices/:mac` requires the gateway
service key and returns only a matching approved MQTT device. Do not expose this
route through a public reverse proxy. The dashboard is single-administrator;
it does not provide multi-tenant access isolation.

## Results and bounded behavior

- `published`: the adapter received the positive gateway write result
- `not_published`: the gateway explicitly reported no publication, or the local
  deadline elapsed before forwarding
- `unknown`: timeout, transport failure or unrecognized response; a later unread
  reminder is a new attempt and may repeat a beep that already sounded

Every result carries `id`, `reason`, `playback: "unknown"` and `duplicate`.
Application-side expiry is not a firmware expiry and cannot retract an already
written message. The default timeout is five seconds, configurable up to 30
seconds; explicit send deadlines may be at most ten minutes ahead.

Idempotency keys deduplicate matching requests per device for ten minutes after
completion. A key reused for different content returns a conflict. Reuse the
same key if retrying an uncertain HTTP response. Deduplication is bounded and
process-local, lost on restart, and not an exactly-once guarantee. Run one relay
process per data directory. Requests without a key are independent attempts.

These limits describe **audio attempts**, not durable inbox ingestion. Text
ingress requires an idempotency key and persists its deduplication alongside the
record, scoped to the device and authenticated sender for the retention period.
See [inbox.md](inbox.md) for those separate semantics.

Default bounds are 1,000 retained attempt records, 16 outstanding RPC operations,
and one new attempt per device per second. Capacity errors queue nothing.
Unsettled operations continue consuming a slot after timeout until they settle.
Payload limits are 2,048 UTF-8 URL bytes, 64 subtitles, 512 UTF-8 bytes per subtitle,
subtitle times from zero to ten minutes and 8,192 serialized JSON bytes. Unknown
fields and control characters are rejected; subtitles are sorted by `start_ms`.

## Optional custom adapter

Earlier versions of this branch contained only a fail-closed adapter contract.
That is no longer the standard setup: leaving `NOTIFY_ADAPTER_MODULE` unset uses
the bundled gateway when MQTT is configured.

An administrator may instead supply a trusted local CommonJS module through
`NOTIFY_ADAPTER_MODULE`. It must export `rpc(envelope, { signal })` and return the
actual gateway `{ success: boolean }` result. This override also needs the explicit
`NOTIFY_CLIENT_IDS_JSON` mapping and independently verified transport,
authentication, correlation and audio/conversation integration. The module is
loaded once at trusted startup, never from a request parameter. A callable export
or HTTP 200 by itself does not prove delivery; do not reinterpret queue acceptance
as publication. Invalid optional adapter configuration disables notification
sending without preventing the ordinary voice server from starting.

## Verification and attribution

Run `npm run check` and `npm test` for local checks. Gateway integration tests use
local sockets and fake provider responses; they do not establish real-device
compatibility. See [TEST_RESULTS.md](../TEST_RESULTS.md) for the final run status
and explicit untested stages. Hardware verification must include an ordinary
conversation, idle test-sound playback, busy/offline behavior and rollback.

The gateway is derived from the MIT-licensed
[78/xiaozhi-mqtt-gateway at c5e3235df8db8f06d1710074ec10e870159e0844](https://github.com/78/xiaozhi-mqtt-gateway/tree/c5e3235df8db8f06d1710074ec10e870159e0844),
with the upstream copyright/license retained in
[`gateway/LICENSE.upstream`](../gateway/LICENSE.upstream). The private HTTP API,
approved-device registry integration and bounded forwarding behavior here are
repository-specific additions, not claims about upstream's public API.

## Dashboard inbox and complete manual test

The approved-device **Memory & Notify** panel contains a **Notification inbox**
with All/Unread filtering, cursor paging, text-only details, separate beep/read
status, and explicit **Mark read**. **Test message & beep → Save message & beep**
uses the administrator session to store text and attempt the configured short
beep. It does not require Hermes or an external sender token. Its publisher is
the same store-before-beep path used by authorized HTTP/MCP senders; the stored
source is server-derived `@dashboard-admin`, never supplied by the browser.

The dashboard retains an idempotency key for an uncertain save and exposes
**Start a new message** for an intentional new entry. **Retry beep only** targets
an existing message with an explicit confirmation and attempt ID; it never
enqueues another message or changes read state. Same-attempt retries are bounded
and deduplicated in process for ten minutes, not exactly-once across a restart.
An unknown earlier attempt may already have sounded, so explicit retry can produce
another beep. Separately, the unread reminder scheduler creates fresh attempts
every `NOTIFY_REMINDER_INTERVAL_MS`, pauses during a voice session, and stops
when the inbox has no unread entries. Set this variable to `0` to disable it.

Administrator routes require login, approved device scope, a strong configured
admin password and the same-origin JSON header `X-Requested-With: XiaozhiDashboard`
for writes:

- POST `/api/devices/:mac/inbox`: `{title?,text,idempotency_key}`
- GET `/api/devices/:mac/inbox?unread_only=false&cursor=...`: paged previews
- GET `/api/devices/:mac/inbox/:id`: full bounded text
- POST `/api/devices/:mac/inbox/:id/read`: `{confirm:true}`
- POST `/api/devices/:mac/inbox/:id/beep`: `{confirm:true,attempt_id}`

The original audio panel is now labeled **Audio-only test (no inbox message)**.
Its Send notification button still sends audio only; an optional subtitle is not
an inbox message. Sender credentials, allowlists and numeric limits stay in server
configuration. No per-message hard-delete control was added.

## Firmware and standby-power evidence

See [firmware-compatibility.md](firmware-compatibility.md) for the pinned source
and independently compiled original Ogg parser check. Installed firmware is not
verified. A Spotpear 1.28 Box matching the audited source may shut down after
290 idle seconds on battery; charging disables that timer. Notifications require
a powered, network-online Idle board; MQTT cannot wake deep sleep. No power-policy
change or firmware flash is performed by this server.
