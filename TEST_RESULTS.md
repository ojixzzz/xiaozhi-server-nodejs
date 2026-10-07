# Local verification report

Date: 2026-10-07. Runtime: Node 24.19.0, built-in SQLite 3.53.3.
Original relay base: `31ff6cff2e11d34e44332394bea99b3c915234c1`.
Gateway protocol reference: `78/xiaozhi-mqtt-gateway` commit
`c5e3235df8db8f06d1710074ec10e870159e0844`; MIT attribution is in gateway/.
Firmware source pin: `0d576d3d4c049c6f55eaf879725dc23e516511b4`.
The delivery summary records the exact final local commit tested.

## Passed

- Dependency installation: npm ci --ignore-scripts; no additional runtime npm
  dependency was required for MQTT, UDP, SQLite, signed assets or MCP ingress
- npm run check: application, providers and all added runtime modules
- git diff --check
- npm test: 191 total, 190 passed, zero failed, one explicitly skipped browser test
- Existing Opus encode/decode roundtrip and fake-Gemini lifecycle tests
- SQLite conversation memory: opt-in, hashed device scoping, restart persistence,
  transactional rollback, bounded records/cache, retention, stale epoch rejection,
  corruption/schema guards, redaction and complete-wrapper Unicode context caps
- Actual loopback Node relay + bundled gateway + independent MQTT wire mock:
  OTA/HMAC authentication, per-device upstream token, stock-style hello/MCP,
  encrypted UDP microphone frames -> raw Opus WebSocket -> decoded fake-provider
  PCM, and reverse PCM -> Opus -> encrypted UDP with independent verification
- Control lifecycle: abort, goodbye preserving idle MQTT, reconnect with fresh
  session keys, timeout/keepalive expiry, invalid auth, approval/transport revocation,
  default WebSocket OTA and successful WebSocket restoration after rollback
- Actual signed audio HTTP download: auth list/issue, URL-only response matching
  the mono Opus sample bytes, expiry/tamper rejection, no-store response; ffprobe
  verifies the bundled one-second two-beep file has mono Opus and 20 ms packets
- Notification publication: exact timed-subtitle protocol, mapping, payload/origin
  limits, dedupe, offline rejection with no replay, honest unknown outcome on failure
- Durable inbox: separate notifications.sqlite, unread/read persistence, device
  isolation, sender-scoped idempotency across restart, transactional capacity,
  retention, explicit mark-read, clear, queue limits and bounded serialized tool output
- External HTTP and real stateless MCP Streamable HTTP contract: bearer and
  device allowlist, Origin handling, initialize/tools/list/tools/call, versions,
  input errors, storage-before-side-effect, sender-derived identity, rate limits,
  unresolved callback bounds, post-storage revocation and reserved-secret rejection
- Full requested workflow: authenticated REST/MCP sender -> SQLite commit ->
  MQTT payload containing only signed chime URL -> later new Gemini connection's
  list/get tools -> explicit read acknowledgement. Tests cover restart, dedupe,
  offline/busy unread retention, no notification text/subtitles in the beep,
  cross-device isolation, shared-token exclusion and <=4000-character tool result
- Immediate revocation during slow WebSocket close: late provider audio/transcript/
  completion/tool events cannot restore cleared memory or mutate settings
- Complete dashboard flow without any external sender configuration: admin session
  and CSRF-protected Save message & beep -> SQLite-before-MQTT -> signed chime-only
  payload -> paginated inbox/detail -> later scoped Gemini retrieval -> explicit
  mark-read. Same compose ID survives restart without another message/beep
- Shared admin/external publishing pipeline; explicit beep-only retries preserve
  message ID/count/read state, deduplicate the same attempt, remain bounded on
  timeout, and recover with the same ID after pre-effect rate/busy rejection
- Dashboard DOM checks for All/Unread filters, per-page/global-unread counts,
  details, explicit read and beep-only confirmation, offline storage visibility,
  immutable retry bodies, cancellation/stale responses, nested errors, and safe
  display of admin-password setup errors
- Known shipped admin-password placeholders are rejected by the real login route
- UI DOM simulation: explicit transport selection/confirmation, setup readiness,
  local audio selection without automatic send, memory opt-in/clear, limits,
  errors, stale responses, duplicate-click protection and stable retry IDs
- Static Docker/config checks: unprivileged image, persistent volume, private
  gateway HTTP port, loopback defaults, secret/SQLite exclusions, TLS/plaintext
  configuration guards and narrowly scoped reverse-proxy trust

## Additional independent firmware-source verification

The pinned firmware MQTT/OTA/application files byte-match the implementation's
reference snapshots. Audit found and corrected OTA timezone units: the field is
minutes, not seconds. Focused unit plus actual pending/approved/MQTT OTA tests
verify configurable minute bounds and unshifted UTC millisecond timestamps.

Separately from npm, the unchanged pinned firmware OggDemuxer was compiled with
only logging stubbed. The bundled sample parsed at 1/31/1024/4096-byte chunks:
51 packets, all 20 ms, 16000 Hz metadata, Finish=true, no parser error. The optional
reproduction script is scripts/firmware-audit/check-sample.sh; this result is not
counted as npm coverage or ESP32/Opus-decoder/speaker execution. No firmware was
modified. See docs/firmware-compatibility.md for the source matrix and the specific
Spotpear charging/battery idle-shutdown caveat.

## What these tests do not establish

- Docker image build/run was attempted but blocked: docker: command not found
  (exit 127). No Docker/Podman executable or Docker socket is available. No daemon
  was installed. Compose networking, mounted volume behavior and container TLS
  certificate access are not proven by native-process or static-config tests
- Chromium launch was attempted earlier and blocked by process socket permissions.
  The browser/visual test stays opt-in via npm run test:browser; DOM simulation
  is not a real browser or visual-layout pass
- No external Hermes instance or real Gemini API was contacted. Gemini is a local
  scripted provider in integration tests; these do not prove natural-language
  recognition of “notifnya apa?” by a live model
- No physical ESP32 firmware was executed, flashed or changed, and audible
  playback was not observed. Installed firmware must support the notify feature
- Public TLS deployment and internet routing have not been tested. Stock UDP
  framing is unauthenticated AES-CTR with inherited nonce/confidentiality limits;
  MQTT TLS does not repair that separate transport. Use a trusted private audio
  network; the default LAN example is not an internet-hardened deployment

## Implemented boundary

The package now contains an actual native MQTT/UDP-to-raw-Opus-WebSocket gateway,
private authenticated HTTP forward route and matching built-in relay client.
It no longer requires the previous custom-adapter stub or undocumented Redis RPC.
Publication still does not prove receipt, playback or that anyone heard a beep.
There is no automatic TTS, scheduler, offline beep queue or arbitrary agent
execution from notification text.

No production server was changed, no firmware was flashed, and no remote push,
PR, deployment, persistent production credential generation or external-agent
connection was performed. Operator-provided configuration/secrets and a one-device
acceptance test remain required. See docs/SETUP_ID.md for the Indonesian guide.
