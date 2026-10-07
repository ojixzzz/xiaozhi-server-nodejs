# Hermes / MCP notification ingress

This is a sender-only integration. An authorized Hermes job (or another configured client) submits text, the server commits it to the device's SQLite inbox, and then attempts one short chime. Gemini can read the stored message later when the device user asks. Notification text is data, never a command for an agent.

No external Hermes service is configured or contacted by this repository. The examples below describe the server contract; use the actual HTTP or remote MCP configuration supported by your Hermes installation. Never put a token in a prompt or message body.

## Operator configuration

Ingress is off unless at least one sender is configured:

```dotenv
NOTIFY_SENDERS_JSON=[{"name":"hermes","token_env":"HERMES_NOTIFY_TOKEN","device_ids":["aa:bb:cc:dd:ee:ff"]}]
NOTIFY_INGRESS_RATE_PER_MINUTE=60
NOTIFY_INGRESS_MAX_PENDING=4
NOTIFY_INGRESS_BEEP_TIMEOUT_MS=15000
NOTIFY_INGRESS_ORIGINS=
```

Separately supply `HERMES_NOTIFY_TOKEN` through your existing secret manager or protected environment file. It must be an operator-provided, unique bearer-compatible secret, 32–512 characters long. Placeholder values are rejected. The application never generates or saves sender credentials. Do not reuse an MQTT signature key, gateway key, session secret, admin password, device authentication token, Gemini/DashScope API key, or another sender's token. Reserved environment variable names and matching values are rejected. `token_env` is the environment variable's name, not the token itself.

Each sender must have a unique name and 1–64 exact device IDs. Up to 32 senders are supported. There are no wildcard destinations and no device-ID case normalization. A device must also currently be approved and have a dedicated device identity in the application. Approval is rechecked on every send, including retries. `sender` is always taken from the authenticated configuration; caller-supplied `sender` and `source` fields are rejected.

`NOTIFY_SENDERS_JSON=[]` disables ingress. Invalid configuration fails closed for these endpoints without taking down the voice server. Restart after changing credentials or scopes. Revoking a sender stops future requests, but does not erase previously stored inbox messages.

Expose ingress only over HTTPS or a trusted local test connection. Keep the actual application listener private behind your authenticated TLS reverse proxy; local-only deployments should bind to loopback. Do not forward or log Authorization headers. Headless clients normally omit Origin. A supplied Origin is rejected unless it exactly matches an entry in the comma-separated `NOTIFY_INGRESS_ORIGINS` list. This does not enable CORS; no browser-origin access is granted implicitly. The dashboard administrator's password or session cookie does not authorize these endpoints.

The app mounts ingress before its normal JSON/session middleware. Chimes also require the documented notification audio and MQTT configuration in [the setup guide](SETUP_ID.md). Missing chime configuration does not prevent a valid message from being stored.

## HTTP sender

POST `/api/notifications` with these headers:

```http
Authorization: Bearer <operator-supplied sender token>
Content-Type: application/json
```

Body:

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "title": "Pengingat",
  "text": "Besok rapat jam 10 pagi.",
  "idempotency_key": "calendar-event-123-reminder-1"
}
```

For a plain HTTP fallback, save that body as `notification.json`, set `SERVER_ORIGIN` to your trusted HTTPS server origin, and supply the token environment variable above. This sends the credential to curl through standard input rather than embedding it in the URL or command arguments:

```bash
printf 'Authorization: Bearer %s\n' "$HERMES_NOTIFY_TOKEN" | \
  curl --fail-with-body --silent --show-error \
    --header @- --header 'Content-Type: application/json' \
    --data-binary @notification.json "$SERVER_ORIGIN/api/notifications"
```

Do not enable shell tracing or verbose request logging when handling credentials. This fallback does not require an MCP client.

- `device_id`: an exact configured and currently approved device ID
- `title`: optional, defaults to an empty string; at most 120 characters, with no control characters
- `text`: required nonblank text, at most 2,000 characters; line breaks and tabs are allowed
- `idempotency_key`: required, 1–128 characters from letters, numbers, `.`, `_`, `:`, `@`, `/`, `-`
- No other body fields are accepted; the entire JSON request is limited to 16 KiB

Length checks use JavaScript string length, so an emoji may count as two characters. Keep the same idempotency key and identical title/text when retrying one event. Scope is device + authenticated sender + key. A changed payload with the same key returns a conflict. Dedupe is durable across restart for the inbox retention period; the default retention is 30 days. Do not use a fresh key merely to make a chime retry.

A new stored message returns HTTP 201; an identical retry returns HTTP 200:

```json
{
  "stored": true,
  "notification_id": "a-notification-uuid",
  "device_id": "aa:bb:cc:dd:ee:ff",
  "duplicate": false,
  "beep": { "status": "published", "playback": "unknown" },
  "beep_status_persisted": true
}
```

The response deliberately does not echo message text. `stored:true` confirms inbox acceptance independently of the chime. `published` confirms only the gateway write. `not_published` means the chime was not sent or the gateway explicitly reported no publication; `unknown` means the publication outcome could not be established. Playback is always unknown because firmware playback acknowledgements are not available.

The chime uses the configured local audio asset. Notification text is never sent as MQTT subtitles or automatic TTS. Offline devices, busy voice sessions, unavailable audio, or transport failures do not remove the unread message. There is no offline beep queue or automatic replay. A duplicate never starts a second chime. Before the side effect, the inbox records an unknown in-progress status so a process crash cannot leave a false completed-publication claim. If the final status cannot be saved, `beep_status_persisted:false` flags that explicitly while preserving `stored:true`.

Authentication fails with 401; unapproved/out-of-scope device or disallowed Origin with 403; unsupported MIME with 415; input errors with 400; idempotency conflicts with 409; rate/capacity limits with 429; unavailable storage/configuration with 503. Error bodies contain a short code and message. A storage outcome that cannot be confirmed returns `stored:null`; retry only with the same key. Known validation/rejection errors return `stored:false`.

Limits apply separately to each sender: 60 send attempts/minute and 4 pending operations by default. Idempotent requests also consume request limits. Inbox capacity and retention add their own independent limits. Limit tuning is bounded to 1–600/minute, 1–32 pending operations, and a 1–30 second chime-result timeout. A timed-out chime reports unknown and is not retried. Its active-operation slot remains occupied until the underlying callback actually settles, even across rate-window resets, so a hung adapter cannot create unlimited orphaned operations.

## Actual MCP endpoint

POST `/mcp/notifications` implements the JSON-response variant of MCP Streamable HTTP. It supports protocol versions `2025-11-25` and `2025-06-18`; it is not an ad-hoc JSON payload branded as MCP. These are deliberately pinned versions, not a claim of support for every future revision.

Every request requires the sender Authorization header. All POSTs require `Content-Type: application/json` and an Accept header containing both `application/json` and `text/event-stream`, even though this server chooses a JSON response. Every message is one JSON-RPC 2.0 request or notification. Batch arrays are rejected.

1. Initialize without requiring a protocol header:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"hermes-notifications","version":"1.0"}}}
```

The response declares `capabilities.tools` and returns a supported `protocolVersion`. An unsupported version in the initialize body negotiates the latest supported version; the client must stop if it cannot support that response. An invalid/unsupported version supplied as an HTTP header is rejected with HTTP 400.

2. Send `MCP-Protocol-Version: 2025-11-25` (or the other negotiated version) on every subsequent request. Signal readiness:

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

This notification returns HTTP 202 with no response body. Since this server retains no protocol sessions, a missing subsequent version header cannot be recovered from session state. The old implicit `2025-03-26` fallback is not supported, so it returns HTTP 400. No `Mcp-Session-Id` is issued or required.

3. Discover the only exposed tool:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

4. Call it:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"notify_send","arguments":{"device_id":"aa:bb:cc:dd:ee:ff","title":"Pengingat","text":"Besok rapat jam 10 pagi.","idempotency_key":"calendar-event-123-reminder-1"}}}
```

`notify_send` uses exactly the HTTP payload and permissions above. Successful tool results contain `isError:false`, a JSON receipt in `structuredContent`, and the same serialized receipt in a text `content` item. The discovery response includes input/output schemas. Validation, scope, capacity and storage errors are tool results with `isError:true`; protocol errors use JSON-RPC `error`. An unknown tool or method cannot execute another operation. A tools/call message without a request ID is never executed.

There are no sender read/delete tools, agent execution tools, remote resource fetchers, sampling, tasks, or automatic text-to-speech. `ping` is supported. GET and DELETE return HTTP 405 because there is no SSE stream or session state to terminate. Cancellation notifications are accepted but do not undo a notification already stored or cancel an in-flight chime.

Protocol references: [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [initialization and version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), and [tools and structured results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Verification boundaries

`node --test test/notification-ingress.test.js` exercises local HTTP/MCP behavior with ephemeral test credentials. The server exposes interoperable MCP framing, but this does not prove your Hermes version's client configuration or a deployed endpoint's TLS/routing. Deployment, real credentials, Hermes connectivity, and physical-device chime playback still need operator verification. See [notifications](notifications.md) for device and transport constraints.
