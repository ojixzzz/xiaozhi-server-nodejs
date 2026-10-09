# Docker, native startup and local verification

[Beranda Indonesia](../README.md) · [English overview](../README.en.md) · [Semua dokumentasi](README.md)

## Mulai di sini — Bahasa Indonesia

Docker menjalankan server dalam container, sedangkan volume menyimpan data agar
tetap ada saat container diganti. Compose bawaan menjalankan `xiaozhi` untuk
server/dashboard dan, bila profil `mqtt` dipilih, `gateway` untuk koneksi perangkat.

| Keperluan | Cara |
| --- | --- |
| Memasang dari source | Ikuti [panduan instalasi](SETUP_ID.md); perintah `up -d --build` membangun image di mesin Anda |
| Memakai image yang dibangun GitHub | Gunakan langkah GHCR di bawah; image tersedia untuk **AMD64 saja** |
| Mengaktifkan gateway untuk beep | Tambahkan `--profile mqtt`; perangkat tetap perlu dipilih ke MQTT di dashboard |
| Mengubah `.env` | Jalankan `up -d` dengan berkas/profil yang sama agar container diperbarui; `restart` saja tidak memuat env baru |
| Mempertahankan inbox dan memori | Pakai volume dan nama proyek Compose yang sama; jangan gunakan `down -v` |

Jika server sudah berjalan, pertahankan `.env`, volume, dan konfigurasi jaringan
lama. Contoh di repo tidak selalu sama dengan instalasi Anda, terutama bila
memakai `network_mode: host`. Jangan mengganti konfigurasi yang berfungsi hanya
untuk mengikuti contoh ini.

### Memakai image GHCR tanpa build lokal

Langkah berikut untuk Compose bawaan `compose.yaml`. Siapkan `.env` sesuai
[panduan instalasi](SETUP_ID.md) terlebih dahulu. Buat berkas tambahan
`compose.ghcr.yaml` di folder proyek dengan isi berikut:

```yaml
services:
  xiaozhi:
    image: ghcr.io/ojixzzz/xiaozhi-server-nodejs:latest
  gateway:
    image: ghcr.io/ojixzzz/xiaozhi-server-nodejs:latest
```

Kemudian jalankan di Terminal:

```sh
docker compose -f compose.yaml -f compose.ghcr.yaml --profile mqtt pull
docker compose -f compose.yaml -f compose.ghcr.yaml --profile mqtt up -d --no-build
docker compose -f compose.yaml -f compose.ghcr.yaml --profile mqtt ps
```

Hilangkan `--profile mqtt` jika hanya memakai percakapan WebSocket. Jika image
bersifat privat, login GHCR dengan akun yang berhak sebelum `pull`. Jika ingin
versi tertentu, ganti `latest` pada **kedua layanan** dengan tag `sha-…` yang sama
yang sudah tersedia di registry. Untuk pembaruan, ulangi `pull` lalu `up -d --no-build`
dengan berkas, profil, dan nama proyek yang sama.

Image baru tersedia setelah workflow publishing berhasil. Perintah di atas
adalah petunjuk pemakaian; tidak dijalankan saat merapikan dokumentasi ini.
Referensi teknis berbahasa Inggris berikut menjelaskan jaringan, persistensi,
migrasi, dan opsi tanpa Docker secara lengkap.

For the full device-by-device workflow, use
[the Indonesian setup guide](SETUP_ID.md). The repository has two Compose services:
`xiaozhi` (relay/dashboard/memory/audio hosting) and the opt-in `gateway`
(MQTT/UDP-to-WebSocket bridge/private forwarding API). Redis and a separate MQTT
broker are not needed.

The main notification workflow stores text from an authorized HTTP/MCP sender,
attempts a short fixed beep, and lets the user ask Gemini for the saved content
later. The persistent inbox is independent of whether that beep plays. See
[inbox behavior](inbox.md) and [Hermes/agent sender setup](hermes-mcp.md).

## Images published to GHCR

The [Docker publishing workflow](../.github/workflows/docker-publish.yml) builds
the existing Dockerfile for `linux/amd64` and pushes to
`ghcr.io/ojixzzz/xiaozhi-server-nodejs`. It runs on pushes to `main`, tags matching
`v*`, and manual runs from the GitHub Actions tab.

Builds from `main` publish `latest`; tag builds publish the Git tag (for example,
`v1.0.0`). Every build also publishes a `sha-<short-commit>` tag. Manual runs
publish `latest` only when the selected branch is `main`.

Publishing uses the automatic `GITHUB_TOKEN` with `packages: write`; no additional
registry secret is required. The image name follows the repository owner/name,
so forks publish to their own GHCR namespace. Private packages require GHCR
authentication to pull.

## Default WebSocket deployment

```sh
# For a new checkout only. Merge settings manually if .env already exists.
test -e .env || cp .env.example .env
# Edit .env locally before starting: your provider key, unique ADMIN_PASSWORD
# of at least 12 characters, and device-reachable WebSocket URL.
docker compose config --quiet
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
docker compose ps
docker compose logs --tail=50 xiaozhi
```

Node 24 is used by the image; native execution requires Node >=24.0.0. The runtime
user is unprivileged `node`. Credentials, private certificates, `node_modules`,
device records, logs, sessions and memory databases are excluded from the build
context. Certificates must be supplied at runtime, never baked into the image.

The default published web address is `127.0.0.1:3000`. Use an existing properly
configured TLS reverse proxy, or explicitly set `WEB_BIND_ADDRESS` to a trusted
LAN interface for testing. `WEB_PORT` controls the host port; the application
remains on port 3000 inside the container. Devices need the reachable
`WEBSOCKET_URL_FOR_ALLOWED_DEVICE`, not container localhost. Do not expose a
plaintext dashboard or default credentials to the internet.

For HTTPS termination at a trusted proxy, set `COOKIE_SECURE=true` and configure
`TRUST_PROXY` with the verified proxy peer IP/CIDR (or `loopback` only when
appropriate). Trust is disabled by default; trust-all values and hop counts are
rejected. A host-based Docker proxy may appear as a bridge address, not loopback.
Without correct trust, secure session cookies may not be issued behind the proxy.
Do not broaden proxy trust to get around a login/configuration problem.

## Bundled MQTT deployment

Use `.env.mqtt.example` for a new trusted-LAN test. Supply your own keys and replace
all example IP addresses before startup; do not overwrite an existing `.env` or
switch existing devices without preserving the working configuration. The LAN
example explicitly opts into plaintext MQTT and HTTP. For production, use the
TLS instructions in [SETUP_ID.md](SETUP_ID.md#8-tls-dan-batas-penerapan-produksi).

```sh
docker compose --profile mqtt config --quiet
docker compose --profile mqtt up -d --build
docker compose --profile mqtt ps
docker compose --profile mqtt logs --tail=50 xiaozhi gateway
```

Compose starts the gateway after the relay passes its HTTP health check. MQTT
listeners default to TLS on port 8883; without user-supplied TLS material the
gateway will not start unless the trusted-LAN plaintext opt-in is explicitly set.

Port and mount behavior:

- `WEB_BIND_ADDRESS` defaults to `127.0.0.1`; `WEB_PORT` defaults to 3000
- `MQTT_BIND_ADDRESS` defaults to `127.0.0.1`; `MQTT_PORT` defaults to 8883 TCP
- `MQTT_UDP_PORT` defaults to 8884 UDP. The same port is published and advertised;
  changing only an external NAT mapping will break the voice path
- `MQTT_UDP_SOURCE_POLICY` defaults to `roaming`: UDP may use a different public
  IP from MQTT and change IP/port during a conversation. `pinned` locks the first
  UDP endpoint; `strict` additionally requires the MQTT source IP. Changes require
  recreating the gateway with an image that includes this setting. Compose passes
  it through the existing `.env` file; no extra port or firmware change is needed.
- Gateway HTTP port 3001 is not published. The relay calls `http://gateway:3001`
- The gateway reads the authenticated registry at
  `http://xiaozhi:3000/internal/mqtt/devices/` and connects upstream to
  `ws://xiaozhi:3000/xiaozhi/v1/`
- `./certs` is mounted read-only at `/run/mqtt-tls`. TLS paths are
  `MQTT_TLS_CERT_FILE=/run/mqtt-tls/fullchain.pem` and
  `MQTT_TLS_KEY_FILE=/run/mqtt-tls/privkey.pem`; see [certs/README.md](../certs/README.md)
- `./notification-audio` is mounted read-only at `/app/notification-audio` in the
  relay. It includes `sample-chime.ogg`. Installing an empty replacement directory
  hides that sample; the operator manages recordings on the host

Compose overrides internal URLs and bind hosts for container networking. Public
settings (`MQTT_ENDPOINT`, `MQTT_PUBLIC_HOST`, `NOTIFY_AUDIO_BASE_URL` and audio
origin allowlists) must still use addresses that the physical device can reach.
The two distinct operator-supplied MQTT keys must match across both services.

For TLS MQTT, the device-facing port must be 8883 for stock firmware, and the
certificate chain/hostname must be trusted by that firmware. TLS deployment,
reverse-proxy configuration and certificate trust were not verified on
physical hardware in the recorded verification run. With the optional `strict`
policy, TCP proxying that changes the device source IP while UDP arrives directly
is incompatible with peer-address matching. Default `roaming` allows this mismatch
and follows fresh UDP source mappings, including mid-session changes. This relaxes
the source-address restriction; it does not add UDP sender authentication.
The legacy firmware-compatible UDP AES-CTR format is not authenticated
encryption; MQTT TLS does not secure that separate audio transport. Restrict the
UDP path to trusted networks/devices and do not treat it as internet-safe merely
because the control listener uses TLS.

Enabling the profile does not switch any device automatically. Approve and test
one device using WebSocket first, then explicitly select MQTT in **Memory &
Notify** and reboot/fetch OTA. Test a normal two-way conversation before trying
an idle notification. See [notifications.md](notifications.md) for the APIs and
publication semantics.

## Health checks and configuration changes

`GET /health` on the relay checks HTTP process health. The gateway's private
`GET /health` checks gateway startup state. Neither proves provider availability,
firmware compatibility, device presence, UDP reachability, audio downloads or
playback. Authenticated `GET /api/mqtt/status` is a configuration report, not an
end-to-end connectivity probe.

After editing `.env`, apply it with `docker compose --profile mqtt up -d --build`
(or omit the profile for WebSocket-only use). A plain `docker compose restart`
does not recreate containers with newly changed environment values. Reboot/fetch
OTA when changing device transport or MQTT endpoint/credential settings.


The dashboard also hosts the reverse MCP WebSocket endpoint at
`/mcp_endpoint/mcp/` on the same web port. No extra MCP endpoint container is
required. If using a reverse proxy, forward WebSocket Upgrade and allow
`/api/notifications` for the agent inbox helper. Avoid logging the endpoint's
token query string. See [MCP pipe setup](remote-mcp.en.md).

## Persistent data and migration

The productivity update migrates inbox schema 1/2 to **3** in one transaction.
Stop the server and back up the complete data volume before deploying; restore
that backup when reverting to an older server. Existing inbox messages and
reminder schedules are retained. Docker includes Edge TTS and FFmpeg for direct
[Pomodoro announcements](screen-breaks.en.md); no local installation is
needed when using the image. The first generation needs internet access to
Microsoft's speech service. Cached audio is served through the existing
notification audio origin and gateway origin allowlist.


Voice sessions return to standby after 60 seconds without detected speech by
default. Device **Config → Standby otomatis setelah diam** overrides
`VOICE_IDLE_TIMEOUT_SECONDS` (0 disables; otherwise 15–3600 seconds).
`VOICE_ACTIVITY_THRESHOLD` sets the minimum microphone energy threshold (default
500, 50–10000). The standby detector raises the effective threshold above a
rolling background estimate to avoid treating steady noise as continuous speech.
This heuristic only affects standby; it does not filter audio sent to the AI.
Output/playback and pending tools pause the timer; pauses expire if
no further activity/completion arrives for two minutes, followed by the full
speech idle window. Apply env changes by recreating the Compose service; device
settings persist in `devices.json`. MQTT remains connected after a speech timeout.

A Gemini disconnect does not immediately end the device voice channel. Transient
failures get one reconnect attempt after one second; configuration/policy failures
are reported without an automatic retry. The speech idle setting still applies
(including `0`). While AI is unavailable it cannot answer. Inspect the relay log
`Provider session closed` for the model, `phase=setup` or `phase=ready`, WebSocket
close `code`, and `reason`. Connected/listening is announced only after Gemini
accepts session setup. A discovery timeout warning appears only if device MCP
discovery actually exceeds five seconds, not after successful discovery.
See the [session tracing guide](troubleshooting-logs.md) for log commands, event
fields, idle snapshots, provider close diagnostics, and `LOG_LEVEL=debug`.

The Compose named volume `xiaozhi-data`, mounted at `/app/data`, retains:

- `devices.json` and `mcp_devices.json`
- Dashboard sessions and application logs
- `memory.sqlite` and its adjacent SQLite `-wal`/`-shm` sidecars while active
- `notifications.sqlite` and its SQLite sidecars: text inbox, reminder schedules,
  skip-once records, delivery timelines and Pomodoro settings/sessions/history
- `announcement-audio/`: fixed Edge TTS announcements cached as mono Ogg Opus
- `remote-mcp-servers.json`: outgoing agent MCP URLs, settings and private Bearer
  credentials configured through **MCP Devices → Add external MCP**; see
  [two-way agent setup](remote-mcp.md)
- `agent-connections.json`: dashboard-created pairings and private per-device
  endpoint/inbox tokens used by the copy-to-agent setup; delete connections in the
  dashboard to revoke them

The notification inbox defaults to 30-day retention and 100 records per device.
Unread entries also expire; at capacity new messages are rejected rather than
evicting unexpired entries. Configure sender access only with deliberate
dashboard pairings or `NOTIFY_SENDERS_JSON` device allowlists and separate bearer
tokens. Ingress is disabled when both the environment sender list and dashboard
agent connection list are empty.
It preserves text when a device is offline/busy; there is no offline audio replay
queue. Unread messages request a fresh reminder chime every 60 seconds by default
(`NOTIFY_REMINDER_INTERVAL_MS`; `0` disables it), pausing during voice sessions.
Ordinary listing/getting or a beep does not mark it read. A greeting in Gemini
announces titles first; completed title responses acknowledge those messages.
Clearing conversation memory does not
clear this separate inbox. Check [inbox.md](inbox.md) for retention and deletion
semantics before handling sensitive notification content.

`docker compose down` preserves the volume. **`down -v` deletes it**; do not use
that flag on real data without a deliberate deletion decision and reviewed backup.
Mounting local prerecorded audio and TLS certificates does not put them in this
volume; back up/protect their host directories separately.

For a migration, preserve the old server configuration/OTA URL, stop the old
instance cleanly, and securely copy the existing device/MCP records and required
application data into the new volume, with ownership readable/writable by UID
1000. Do not print or paste device tokens. Do not replace existing records with a
blank registry just to make MQTT setup succeed. Establish a rollback plan before
changing a production device.

Use exactly one relay process per data directory. SQLite serializes writes, but
voice sessions, consent/context cache, audio-attempt deduplication and dashboard
state are process-local. Do not copy only the live main SQLite file for a backup;
stop cleanly first or use a SQLite-consistent backup procedure. Keep backups
private and include them in retention/deletion procedures. Restoring a backup may
restore information previously forgotten by the user.
Text-ingress idempotency is separate from process-local audio-attempt
deduplication: its key is persisted with the inbox record and scoped to the
device and authenticated sender for that record's retention period.

SIGTERM/SIGINT close voice connections, discard incomplete turns and drain
accepted completed memory writes. Compose gives shutdown 15 seconds; the relay's
shutdown budget is ten seconds. Stop cleanly using:

```sh
docker compose --profile mqtt stop
```

## Native execution without Docker

With Node 24 or newer and dependencies installed, the same two processes can run
without containers. Set a private `DATA_DIR`, device-reachable public addresses,
and the native internal URLs in `.env`:

```dotenv
DATA_DIR=./data
MQTT_GATEWAY_URL=http://127.0.0.1:3001
MQTT_REGISTRY_URL=http://127.0.0.1:3000/internal/mqtt/devices/
MQTT_UPSTREAM_URL=ws://127.0.0.1:3000/xiaozhi/v1/
MQTT_HTTP_BIND_HOST=127.0.0.1
```

Run `npm ci --ignore-scripts`, then `npm start` for the relay and `npm run
start:gateway` in a second terminal for MQTT. Both read `.env`; the same TLS or
explicit LAN-only insecure requirements apply. `WEB_BIND_ADDRESS` and
`MQTT_BIND_ADDRESS` are Compose host-publishing settings, not native listener
settings. Native listeners use `HOST`, `PORT`, `MQTT_BIND_HOST`,
`MQTT_UDP_BIND_HOST`, `MQTT_PORT` and `MQTT_UDP_PORT`. Native certificate paths must
point to real files on that host rather than Docker's `/run/mqtt-tls` paths.

## Tests without a live provider or device

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use temporary data directories, synthetic test credentials, local sockets
and fake provider responses. They exercise the relay HTTP/auth flow, SQLite
persistence, gateway protocol/UDP audio bridge, notification forwarding, local
signed audio and dashboard DOM behavior. They make no live paid Gemini request.
See [TEST_RESULTS.md](../TEST_RESULTS.md) for the historical checks and totals recorded on 7 October 2026;
that run predates the latest reminder, title-announcement and MCP dashboard changes.

During the historical verification run, Docker and Podman executables and a
Docker socket were unavailable in that implementation workspace. Actual image build/run, container health and
mounted-volume persistence were therefore not run here. Static Compose/image
checks and native local protocol tests do not substitute for those checks.

The opt-in real browser test is `npm run test:browser` (optionally set
`CHROMIUM_PATH`). Its browser launch was blocked by the environment's socket
permissions; no alternative launch was used to bypass that denial. Default test
runs skip it. DOM simulation is not a visual/browser verification.

## Checks to perform on your deployment

1. Build/start the selected services; confirm their container health
2. Approve one owned device and verify an ordinary WebSocket conversation
3. Enable memory, complete a harmless Gemini turn, and save a harmless explicit
   fact. Restart the relay and confirm the saved data remains
4. Clear the test memory using the dashboard's exact-device-ID confirmation;
   restart and verify it stays cleared
5. Select MQTT, reboot/fetch OTA and verify a complete two-way conversation
6. Let the device return idle, issue a fresh sample-chime link and send once;
   verify physical playback yourself. Check busy/offline behavior separately
7. Create a scoped dashboard agent pairing, or configure a manual sender token
   and explicit approved-device allowlist. Submit a
   harmless text notification through the documented HTTP/MCP endpoint, verify
   storage, restart the relay, then ask Gemini “notifnya apa?”. Check that list/get
   and beep do not mark it read. Say “halo” to announce titles, verify read status
   after the completed response, then ask for details. Check that aborting a title
   response leaves it unread and that reminders resume when the device returns idle.
   Repeat text submission while the device is offline and confirm later retrieval
8. Switch back to WebSocket, reboot/fetch OTA and confirm rollback works before
   expanding the rollout
9. Stop cleanly and check shutdown logs. Review secrets, bindings, HTTPS/TLS,
   backups and access restrictions before any production exposure
