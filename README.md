# Xiaozhi Universal Relay: Gemini Memory & Notification Inbox

A Node.js relay for [Xiaozhi ESP32 devices](https://github.com/78/xiaozhi-esp32),
with Gemini, Qwen and local LFM provider adapters. This branch adds opt-in,
device-scoped SQLite memory, a durable notification inbox for Hermes/other agents,
and a bundled MQTT/UDP gateway while preserving the existing WebSocket path.

The intended flow is: an authorized agent sends **text** through HTTP or MCP →
the relay stores it → Xiaozhi plays a short beep when possible, repeating every
60 seconds while unread → the user opens a conversation and says “halo”, “apa”,
or “ada apa” → Gemini reads the titles first and offers details. Titles acknowledged
in a completed audio response become read; full message text is spoken only when
the user asks for details. Incoming text is not inserted into conversation memory.
The same complete flow
can be tested without Hermes: open **Memory & Notify → Test message & beep**,
then **Save message & beep**. The dashboard also shows the saved inbox, read status
and an explicit **Retry beep only** action without creating another message.

**Mulai di sini: [Panduan setup Bahasa Indonesia](docs/SETUP_ID.md).**
The guide covers a one-device LAN test, TLS configuration, verification and
rollback. See the [pinned firmware compatibility evidence](docs/firmware-compatibility.md)
for source/parser checks and the Spotpear battery-sleep caveat. The package includes the gateway and a test chime; it does not require
Redis or a separate MQTT broker.

## What is included

- Existing Xiaozhi WebSocket voice relay and per-device provider/voice dashboard
- Gemini conversation memory stored in SQLite, off by default per device
- Administrator-entered explicit facts, review, retention and clear/disable controls
- A separate persistent SQLite inbox for per-device text notifications, with
  sender authentication, an explicit device allowlist and unread/read state
- Dashboard inbox with filters/details/read status and a complete **Save message & beep** test, requiring no Hermes or external sender token
- HTTP and stateless MCP ingress for configured senders; Gemini announces titles
  after a greeting, acknowledges completed title responses and retrieves details
- A configurable reminder chime for unread messages, paused during voice sessions
- MQTT control server with a UDP-to-WebSocket voice bridge in `gateway/`
- Explicit per-device WebSocket/MQTT selection and signed, approved-device OTA
  configuration; saving a transport does not reboot or flash the device
- Authenticated internal HTTP notification forwarding, bounded requests and
  process-local idempotency
- Signed five-minute downloads for local mono Ogg Opus recordings, plus a bundled
  one-second two-beep `sample-chime.ogg` test tone with no speech
- Docker Compose with an optional `mqtt` profile and persistent relay data volume

Memory is shared by everyone using a device; it does not identify the speaker.
The defaults retain eight completed Gemini turns, at most 1,200 characters per
side, and cap the entire injected memory section at 6,000 characters. This is
not a token count or a cap on total live-session context. See
[memory/privacy details](docs/memory.md).

The inbox lives in `DATA_DIR/notifications.sqlite`, independently of
`memory.sqlite`, with default 30-day retention, including unread entries, and a
maximum of 100 records per device. A full inbox rejects a new message rather than
silently evicting an unexpired record. A beep, list or get does not mark it read.
Text stays stored
when the device is busy/offline or a beep cannot be delivered. See
[inbox semantics](docs/inbox.md) before relying on retention/read state.

The immediate beep requires compatible `notify` firmware, an online idle device,
reachable audio and explicitly selected MQTT transport. `published` means a
gateway socket write, **not verified playback**. There is no offline audio queue.
`NOTIFY_REMINDER_INTERVAL_MS=60000` controls periodic unread reminders; set it to
`0` to disable them. The scheduler recovers from SQLite after restart and can
repeat an uncertain earlier publication. The chime contains no speech; Gemini
reads titles after the user greets it and message details only when asked. No live Hermes
account/agent connection has been configured or tested here.

## Quick start

Requires Node >=24.0.0 for native execution, or Docker with Compose for containers.
For a fresh checkout and the default WebSocket path:

```sh
# Do not overwrite an existing .env; merge settings manually instead.
test -e .env || cp .env.example .env
# Edit .env with your provider key, unique admin password (>=12 characters),
# and a device-reachable WEBSOCKET_URL_FOR_ALLOWED_DEVICE.
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
```

Ports bind to loopback by default. Configure an appropriate private LAN interface
or existing TLS reverse proxy before connecting hardware. Do not expose the
plaintext dashboard to the internet.

For **memory + MQTT notifications**, follow [SETUP_ID.md](docs/SETUP_ID.md), fill
in `.env.mqtt.example` with your own settings/secrets, and run:

```sh
docker compose --profile mqtt up -d --build
```

That template is explicitly for a trusted private LAN and uses plaintext
MQTT/HTTP; it is not a production internet configuration. TLS on MQTT port 8883
uses operator-supplied certificates and two distinct operator-supplied secrets.
Test normal conversation on one device before switching it to MQTT and trying
an idle notification. Existing devices remain on WebSocket until changed in the
dashboard and rebooted/fetched OTA again.

For native processes, use `npm ci --ignore-scripts`, `npm start`, and optionally
`npm run start:gateway`; see [native/Docker configuration](docs/docker.md).

## Documentation

- [Indonesian step-by-step setup and rollback](docs/SETUP_ID.md)
- [Memory limits, retention, privacy and API](docs/memory.md)
- [Persistent notification inbox and read state](docs/inbox.md)
- [Hermes/agent HTTP and MCP sender setup](docs/hermes-mcp.md)
- [MQTT provisioning, notification API and result semantics](docs/notifications.md)
- [Docker, native startup, persistence and deployment checklist](docs/docker.md)
- [Preparing local audio recordings](notification-audio/README.md)
- [Operator-supplied MQTT TLS certificates](certs/README.md)
- [Local verification report and untested stages](TEST_RESULTS.md)

## Provider and audio notes

The existing provider adapters include Google Gemini Live, Alibaba Qwen Omni /
Realtime, and local LFM through a compatible llama.cpp audio server. Availability
is determined by your provider configuration; verify current models and voices
on your own account. Memory collection/injection currently applies to completed
Gemini transcript turns only. MCP tool support depends on the provider; local
LFM tool support remains incomplete.

Normal device speech uses mono Opus, with relay-side PCM transcoding for provider
input/output. Idle notifications instead let the device download prerecorded Ogg
Opus directly. The bundled gateway bridges regular conversation audio to the
existing relay path; it is not a general-purpose MQTT broker.

## Tests and deployment status

```sh
npm run check
npm test
```

Local tests cover isolated SQLite/HTTP behavior, synthetic gateway protocol/audio
traffic, notification handling and dashboard DOM interactions. They do not call
live Gemini, connect a real Hermes agent, flash firmware or prove physical audio
playback. Actual Docker
build/run was unavailable in the implementation environment; the real browser
launch was also blocked. Exact results and limitations are recorded in
[TEST_RESULTS.md](TEST_RESULTS.md).

No production server or device configuration is changed simply by obtaining
this repository. Keep your old OTA/configuration and data backup until the
one-device acceptance and rollback checks pass.

## Attribution

The bundled gateway derives from the MIT-licensed
[78/xiaozhi-mqtt-gateway, commit c5e3235df8db8f06d1710074ec10e870159e0844](https://github.com/78/xiaozhi-mqtt-gateway/tree/c5e3235df8db8f06d1710074ec10e870159e0844).
Its upstream license is retained in [gateway/LICENSE.upstream](gateway/LICENSE.upstream).
The authenticated HTTP forwarding API and relay integration are local additions;
this project does not rely on an assumed upstream Redis RPC service.
