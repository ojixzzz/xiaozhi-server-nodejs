# Local Xiaozhi MQTT/UDP gateway

[Beranda Indonesia](../README.md) · [Instalasi](../docs/SETUP_ID.md) · [Semua dokumentasi](../docs/README.md)

**Ringkasan Bahasa Indonesia:** gateway adalah layanan penghubung agar perangkat
bisa memakai MQTT untuk kontrol/notifikasi dan UDP untuk suara. Compose sudah
menyediakannya melalui `--profile mqtt`; pengguna dashboard tidak perlu memasang
broker MQTT lain atau Redis. Referensi Inggris berikut ditujukan kepada
administrator yang mengatur jaringan dan kredensial gateway.

Run `node gateway/server.js` from the project root after configuring `.env`, or
use the repository's MQTT Compose profile. This service connects stock Xiaozhi
protocol-3 MQTT/UDP devices to this project's existing `/xiaozhi/v1/` WebSocket
backend. It also delivers private, authenticated idle notifications over the
long-lived MQTT control connection. No Redis service is involved.

## Required configuration

Both keys are supplied by the operator, must differ, and must be at least 32
characters. Placeholder values are rejected. The gateway never generates or
persists operator credentials.

| Variable | Purpose / default |
| --- | --- |
| `MQTT_SIGNATURE_KEY` | Mandatory HMAC-SHA256 secret, same as the Node OTA signer |
| `MQTT_GATEWAY_KEY` | Mandatory private service key, same as Node registry/adapter |
| `MQTT_REGISTRY_URL` | Registry base URL, `http://127.0.0.1:3000/internal/mqtt/devices/` |
| `MQTT_UPSTREAM_URL` | Fixed backend URL, `ws://127.0.0.1:3000/xiaozhi/v1/` |
| `MQTT_BIND_HOST` | MQTT listener, `127.0.0.1`; use `0.0.0.0` inside the container |
| `MQTT_PORT` | MQTT listener port, `8883` |
| `MQTT_UDP_BIND_HOST` | UDP listener, `0.0.0.0` |
| `MQTT_UDP_PORT` | UDP port, `8884`; publish this same port, without external remapping |
| `MQTT_PUBLIC_HOST` | Reachable UDP hostname/IPv4 advertised to the device; otherwise derived from `MQTT_ENDPOINT`; loopback only when neither is configured |
| `MQTT_HTTP_BIND_HOST` | Private HTTP listener, `127.0.0.1`; container `0.0.0.0` must remain unpublished |
| `MQTT_HTTP_PORT` | Private HTTP port, `3001` |
| `MQTT_TLS_CERT_FILE` | Operator-provided PEM certificate/chain path |
| `MQTT_TLS_KEY_FILE` | Operator-provided PEM key path |
| `MQTT_ALLOW_INSECURE` | Must be explicitly `true` to run without TLS; trusted-LAN testing only |
| `MQTT_AUDIO_ALLOWED_ORIGINS` | Comma-separated exact media origins; falls back to `NOTIFY_ALLOWED_AUDIO_ORIGINS` |
| `NOTIFY_ALLOW_HTTP` | Explicit `true` permits allowlisted HTTP media URLs; HTTPS is otherwise required |

Accepted aliases: `UDP_HOST`, `UDP_PORT`, `HTTP_HOST`, `HTTP_PORT`, `PUBLIC_IP`,
`MQTT_TLS_CERT`, `MQTT_TLS_KEY`. Canonical names above take precedence.

The Node app must have MQTT provisioning enabled, approve the device, give it a
per-device token, and store its exact signed MQTT client ID. A valid HMAC alone
is insufficient. Registry lookups fail closed and occur on MQTT CONNECT, each
new audio session, every notification, and each online query. Registry device
IDs are compared as normalized MAC addresses; the original registry spelling is
used in the upstream `Device-Id` header.

### TLS and network requirements

Stock firmware's inspected ESP Wi-Fi network component selects TLS **only when
the advertised MQTT port is 8883**; other ports use TCP. TLS therefore needs an
externally reachable port 8883 and a certificate for its hostname trusted by the
firmware's certificate bundle. This service does not create certificates or
change trust settings. For a deliberate trusted-LAN plaintext setup use port
1883 and `MQTT_ALLOW_INSECURE=true`. Do not advertise TLS on a custom port to stock
firmware. The OTA endpoint is `hostname:port`, without a URL scheme.

Keep the registry, upstream WebSocket, and HTTP forwarding listener on the
private service network. Never publish HTTP port 3001 to the Internet. MQTT and
UDP should reach this gateway directly: UDP packets must have the same source
IP as the MQTT socket, and the UDP source port is pinned after the first packet
for that session. A TCP/TLS-terminating proxy or different TCP/UDP NAT behavior
can violate this requirement. Docker Desktop and actual board/network behavior
require hardware verification. A new hello negotiates a fresh UDP endpoint/key.

## Private notification API

`POST /forward`, `Content-Type: application/json`, and
`Authorization: Bearer <MQTT_GATEWAY_KEY>`:

```json
{
  "method": "forward",
  "clientId": "GID_local@@@aa_bb_cc_dd_ee_ff@@@device-uuid",
  "params": {
    "type": "notify",
    "audio_url": "https://your-media-host.invalid/notice.mp3",
    "subtitles": [{"start_ms": 0, "text": "Your notification"}]
  }
}
```

The envelope has exactly those keys. Only `notify` is accepted, with the same
strict URL and timed-subtitle validator as `lib/notifications.js`: origin
allowlist, no credentials/fragments, at most 64 subtitles, bounded text, and an
8 KiB notification JSON cap. This gateway does not fetch the media URL.

A successful socket write returns HTTP 200 `{ "success": true }`. This is a
QoS-0 write result, **not playback confirmation**. An approved but offline device
returns HTTP 200 `{ "success": false }`, with no deferred/offline delivery.
Authentication, malformed payloads, and registry failures return non-2xx with
`success: false`. A connection/write failure can be uncertain; do not assume a
missing response means the device did not receive a notification.

`GET /online?clientId=<encoded-client-id>` uses the same service authorization and
registry validation and returns `{ "online": true|false }`. It reflects the MQTT
control connection, independently of whether an audio session is open.
`GET /health` returns only `{ "ok": true|false }`, without device data.

## Device protocol and lifecycle

- MQTT 3.1.1 CONNECT with mandatory signed credentials. CONNACK success is sent
  only after both HMAC and live registry checks succeed
- Client ID is `group@@@lowercase_mac_with_underscores@@@uuid`; username is Base64
  JSON; password is Base64 HMAC-SHA256 of `clientId + '|' + username`
- Device publishes control JSON to `device-server`. Gateway sends private
  downstream messages to `devices/p2p/<mac_with_underscores>` without requiring a
  SUBSCRIBE, matching stock firmware. Only that topic and legacy `null` receive
  successful SUBACK; wildcards and other devices' topics are rejected
- CONNECT, fragmented/coalesced input, QoS 0/1 uplink, SUBSCRIBE, UNSUBSCRIBE,
  PINGREQ/PINGRESP and DISCONNECT are supported. QoS 2, retained messages and
  durable MQTT sessions are not supported. Will fields are consumed but not
  broadcast. Reconnect replaces the previous connection and drops its audio
- A protocol-3 UDP hello with mono 16 kHz Opus opens the authenticated upstream
  WebSocket using the device's registry token, `Device-Id`, `Client-Id`, and
  `Protocol-Version: 1`. WebSocket binary payloads are raw Opus, without the
  upstream reference gateway's protocol-2 binary header. The Node backend does
  its existing 16 kHz input / 24 kHz output processing
- The server hello contains the upstream session ID, output audio parameters,
  UDP host/port, AES-128-CTR key and 16-byte nonce. MCP, listen and abort controls
  are relayed in the active session; device-originated `notify` is ignored
- UDP header: type byte 1; flags byte; payload length uint16 big-endian; route ID,
  timestamp, sequence as uint32 big-endian. The entire header is the CTR IV.
  Uplink flags are 0; downlink flags are 1, keeping direction IV spaces separate.
  Inspected stock firmware ignores incoming flags and decrypts with the full IV
- Keys and routing IDs are fresh per session. Old/duplicate sequences, stale
  routes, malformed lengths and wrong endpoints are discarded. Sequence overflow
  closes the audio session before reuse
- A device goodbye, upstream close, or audio timeout closes only the audio
  session. MQTT remains online for idle notifications. MQTT disconnect closes
  both. No MCP tool requests are made while idle
- Backend raw Opus does not preserve AEC timestamps. The gateway removes the
  `aec` feature upstream; server-side AEC is not supported by this bridge

**Trusted-network restriction:** use this stock-compatible UDP path only on a
trusted private network. Do not treat public Internet UDP exposure as a secure
deployment. Stock UDP uses AES-CTR without an authentication tag and has an
inherited counter-layout weakness when uplink timestamps repeat, so robust
confidentiality and packet authenticity are **not guaranteed**. Directional
flags prevent cross-direction IV collisions but do not fix that inherited
intra-direction weakness. Source-IP/port checks and sequence checks are limited
hardening measures. MQTT TLS protects the control connection and key exchange;
it does not add authentication or repair confidentiality for the UDP channel.
Stronger transport security requires a separately reviewed firmware/protocol
change, which this implementation does not make.

## Bounds and tests

Defaults include 256 MQTT connections, 16 KiB MQTT/control packets, 128 KiB
read/write buffers, at most 64 pending writes, 4 KiB UDP audio packets, 48 queued
audio packets before endpoint discovery, 64 pending UDP sends, 200 accepted UDP
packets/second/session, 120 MQTT control packets/second/client, 64 concurrent HTTP
requests, and bounded registry/hello/write deadlines. MQTT keepalive uses 1.5x
the requested interval; zero-keepalive clients have a one-hour inactivity cap.
Audio idle timeout is two minutes; maximum audio session duration is one hour.
Active control keepalives do not artificially extend audio lifetime.

Run `node --test gateway/unit.test.js test/gateway-integration.test.js`.
Tests are loopback-only with ephemeral secrets and mock media/providers; they
cover authenticated provisioning, idle notification, bidirectional encrypted
Opus, MCP/control forwarding, framing, reconnect, cleanup, timeouts, invalid
inputs and destination isolation. No paid API, production gateway or physical
speaker is used. See the root test report for hardware and deployment limits.

For embedded tests, `require('./gateway/server')` exports
`createGateway(options)` and `configFromEnv(env)`. A gateway exposes async
`start()`, async `close()`, `address()`, and a `connections` map. `start()` returns
`{ mqtt, udp, http }` listener addresses; zero ports allocate ephemeral listeners.
Tests must explicitly supply `allowInsecure: true` and, for HTTP media,
`allowHttpAudio: true`. See `gateway/unit.test.js` for the complete fixture.

## Firmware source evidence

The inspected firmware files `main/protocols/mqtt_protocol.cc`, `main/ota.cc`,
and `main/application.cc` were downloaded from official main on 2026-10-07 and
subsequently byte-compared with commit
`0d576d3d4c049c6f55eaf879725dc23e516511b4`; all three matched exactly.
This pins source-level assumptions, not the binary installed on any user's board.
OTA server timestamps are UTC epoch milliseconds; `timezone_offset` is integer
minutes. The configurable package default is 420 (WIB), not 28,800 seconds.
Physical firmware/network/audio validation remains required.
