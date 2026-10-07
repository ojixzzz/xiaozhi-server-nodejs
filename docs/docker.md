# Docker, native startup and local verification

For the full device-by-device workflow, use
[the Indonesian setup guide](SETUP_ID.md). The repository has two Compose services:
`xiaozhi` (relay/dashboard/memory/audio hosting) and the opt-in `gateway`
(MQTT/UDP-to-WebSocket bridge/private forwarding API). Redis and a separate MQTT
broker are not needed.

The main notification workflow stores text from an authorized HTTP/MCP sender,
attempts a short fixed beep, and lets the user ask Gemini for the saved content
later. The persistent inbox is independent of whether that beep plays. See
[inbox behavior](inbox.md) and [Hermes/agent sender setup](hermes-mcp.md).

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
reverse-proxy configuration and certificate trust have not been verified on
physical hardware here. TCP proxying that changes the device source IP while UDP
arrives directly is incompatible with this bridge's peer-address matching.
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

## Persistent data and migration

The Compose named volume `xiaozhi-data`, mounted at `/app/data`, retains:

- `devices.json` and `mcp_devices.json`
- Dashboard sessions and application logs
- `memory.sqlite` and its adjacent SQLite `-wal`/`-shm` sidecars while active
- `notifications.sqlite` and its SQLite sidecars: sender-submitted text, unread/
  read state and inbox records, separate from optional conversation memory

The notification inbox defaults to 30-day retention and 100 records per device.
Unread entries also expire; at capacity new messages are rejected rather than
evicting unexpired entries. Configure sender access only with deliberate
`NOTIFY_SENDERS_JSON` device allowlists and separate operator-supplied bearer
tokens. An empty sender list disables external ingress.
It preserves text when a device is offline/busy; there is no offline audio replay
queue. Listing/getting a notification or playing a beep does not mark it read.
Mark-read is a separate operation, and clearing conversation memory does not
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
See [TEST_RESULTS.md](../TEST_RESULTS.md) for exact checks and current totals.

Docker and Podman executables and a Docker socket were unavailable in the
implementation workspace. Actual image build/run, container health and
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
7. Configure a sender token and explicit approved-device allowlist. Submit a
   harmless text notification through the documented HTTP/MCP endpoint, verify
   storage, restart the relay, then ask Gemini “notifnya apa?”. Check that list/get
   and beep do not mark it read; explicitly mark it read in a separate action.
   Repeat text submission while the device is offline and confirm later retrieval
8. Switch back to WebSocket, reboot/fetch OTA and confirm rollback works before
   expanding the rollout
9. Stop cleanly and check shutdown logs. Review secrets, bindings, HTTPS/TLS,
   backups and access restrictions before any production exposure
