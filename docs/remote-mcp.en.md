# Two-way MCP agents

[Indonesian](remote-mcp.md) · **English** · [Documentation index](README.md)

Source repository: [ojixzzz/xiaozhi-server-nodejs](https://github.com/ojixzzz/xiaozhi-server-nodejs).
The dashboard's **Salin untuk agent** instructions include the repository,
Indonesian MCP guide, and example folder links so the agent can find integration files.

Copy **MCP_ENDPOINT** from the dashboard and run a local stdio MCP server through
`mcp_pipe.py`. This follows the `xiaozhi-esp32-server` / `mcp-calculator` pattern:
the agent connects outward to the relay over WebSocket. No public agent HTTP
server or `agent_register` call is required for this flow.

| Direction | Behavior |
| --- | --- |
| XiaoZhi → agent | Gemini calls the agent's local tools for tasks or replies |
| Agent → XiaoZhi | The agent sends titles and bodies to the persistent inbox, including delayed job results |

## Dashboard setup

Start with an approved device, its own token, and a working Gemini conversation.

1. Open **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Select the device; optionally rename the agent.
3. Check **Alamat dashboard yang bisa diakses agent**: use a relay address reachable
   from the agent. Another computer's `localhost` is not the relay.
4. Click **Buat endpoint**, then **Salin MCP_ENDPOINT**. **Salin untuk agent** copies
   complete setup instructions instead.
5. Set the copied environment variable on the agent machine:

```sh
export MCP_ENDPOINT='wss://relay.example.com/mcp_endpoint/mcp/?token=TOKEN_FROM_DASHBOARD'
python mcp_pipe.py calculator.py
```

The URL above is a placeholder. Use the complete private URL from the dashboard.
The original calculator pipe can connect without changing its JSON-RPC framing.
Dashboard HTTPS produces WSS, while HTTP produces WS; use TLS over the internet.
The URL contains a secret scoped to one device. Keep it out of repositories,
public screenshots, and logs. Creating a pairing needs no relay restart or env edit.

## Bundled examples

See [examples/mcp-endpoint](../examples/mcp-endpoint/README.en.md) for a Python 3.11+
pipe, calculator and two-way example agent:

```sh
cd examples/mcp-endpoint
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export MCP_ENDPOINT='FULL_URL_FROM_DASHBOARD'
python mcp_pipe.py agent.py
```

`agent.py` exposes `agent_echo` and `agent_notify`. Replace the demonstration tools
with your real Hermes/agent integration. No live Hermes service or job queue is
configured by this repository.

A local MCP server provides line-delimited JSON-RPC over stdio. To launch another
runtime, use `python mcp_pipe.py -- node /path/to/server.js`. With no arguments,
the bundled pipe reads `mcp_config.json` or the file at `MCP_CONFIG`; every enabled
stdio server receives its own WebSocket connection to the same endpoint. Identical
tool names are isolated. HTTP/SSE requires an adapter or the advanced flow below.

Once discovery finishes, tools are automatically selected for the paired device.
Wait for **Terhubung dua arah · … tools** and reopen the voice conversation.
Background pipe discovery, disconnects and reconnects keep the active voice
conversation open. New tools load on the next conversation; captured tools from a
disconnected peer cannot be replayed against its replacement. Reopen the voice
conversation to use reconnected tools. Restart the pipe after changing tools to
rediscover them. Explicit revocation/deletion and advanced HTTP settings changes
still invalidate affected voice sessions.

## Send inbox messages with the same endpoint

The original calculator only calculates; starting it does not send notifications.
For agent-initiated messages, use the bundled helper:

```python
from xiaozhi_notify import notify_send

receipt = notify_send(
    title="Report ready",
    text="Your report summary is available.",
    idempotency_key="job-123-complete",
)
```

The helper reads the same **MCP_ENDPOINT**, extracts its token, and posts to
HTTP(S) `/api/notifications` on that relay. The device comes from the pairing:
no second URL, credential or device setting is needed. It can deliver a delayed
result after a conversation ends and while the tools WebSocket is disconnected.
In async tools, run the synchronous helper through `asyncio.to_thread`.

For one explicitly requested terminal message:

```sh
python xiaozhi_notify.py --title 'Report ready' --text 'Your result is available.' --idempotency-key 'job-123-complete'
```

`stored: true` confirms persistence, not audible playback. Keep `notification_id`
for replies. Use a stable unique key per message; if delivery is uncertain, check
the inbox before retrying with the **same key and content**. No automatic send
retry occurs. The inbox retains its reminder/read behavior: one-minute reminder
attempts, paused during conversations, and titles spoken first on “halo”, “apa”,
or “ada apa”. See [notification behavior](../README.en.md#notification-behavior).

## Status and troubleshooting

### One reminder request, one notification

“Remind me to drink in 5 minutes” is one schedule: **Drink** is the subject and
**5 minutes** is the delay. Return schedule creation confirmation as a tool
result for XiaoZhi to speak. Send one inbox message when it is due, without an
extra creation notification unless the user requests one.

Prefer a dedicated tool such as `hermes_reminder_create` when available. Do not
also delegate the same reminder to `ask_hermes` or create another timer. The
external agent owns scheduling; the relay stores messages when they arrive.

Persist the schedule ID and due occurrence ID. All workers and retries for the
same occurrence must use a stable `idempotency_key`, such as
`reminder-JOB_ID-OCCURRENCE_ID`, and identical title/body. A later occurrence of a
recurring reminder gets a new occurrence ID. Do not generate a new UUID on each
retry or send a new inbox message every minute: the relay already repeats the
chime until read.

If two titles arrive at the due time, inspect schedules in the agent and the
creation session's `tool.requested` events. `source_tool` identifies the original
tool name. Check for two creation paths, two schedules, or a delivery worker
using different keys. Different keys represent separate messages. After updating
the server, copy **Salin untuk agent** to the existing agent again and open a
new voice conversation to apply the instructions. Existing duplicate schedules
in the agent are not removed by this update.

### Connection status

| Dashboard status / symptom | Next step |
| --- | --- |
| **Inbox siap · menunggu koneksi MCP pipe** | Set MCP_ENDPOINT and start the pipe |
| **Menghubungkan MCP · membaca daftar tools…** | Wait for handshake; check MCP server stderr |
| **MCP terhubung · belum menyediakan tools** | Add tools and restart the pipe |
| **MCP terhubung · aktifkan tools di konfigurasi perangkat** | Check Gemini, dedicated token and Config selection |
| **Terhubung dua arah · … tools** | Reopen the conversation and use a provided tool |
| **Inbox siap · MCP belum terhubung** | Check endpoint, agent process, network and status error |
| Unauthorized connection | Check approval, dedicated token, Gemini and whether pairing was revoked |
| Domain WebSocket fails | Forward WebSocket Upgrade through the reverse proxy |

The bundled pipe reconnects with a 1–60 second backoff. It never replays pending
calls; the agent might have executed them already. Agent and device can be on
different networks as long as the agent can reach the relay. Container localhost
points to that container, not another machine.

**Hapus koneksi** revokes both endpoint and inbox access, closes every paired
pipe, and removes tools. Existing inbox messages remain until retention expires.
**Tutup** only hides credentials; **Konfigurasi untuk agent** reexports the same
URL/token. Connected status proves discovery, not success of every business task.

## WebSocket developer contract

Endpoint: `/mcp_endpoint/mcp/?token=PAIRING_TOKEN`. A Bearer header is also accepted
by custom bridges; if both are supplied they must agree. This is a custom
WebSocket transport compatible with the calculator pipe, separate from MCP
Streamable HTTP.

The relay uses the MCP SDK client for `initialize`, `notifications/initialized`,
paginated `tools/list`, and `tools/call`. Each text frame carries one JSON-RPC
object. Limits: 256 KiB/frame, 10-second initialization, 16 providers and 64 tools
per pairing, 64 providers globally, 8,000 JSON characters per tool input schema.

Tool aliases avoid collisions; original names are dispatched to the agent.
Authenticated caller context accompanies calls:

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "tools/call",
  "params": {
    "name": "agent_submit_task",
    "arguments": { "instruction": "Prepare a report" },
    "_meta": {
      "xiaozhi/device_id": "aa:bb:cc:dd:ee:ff",
      "xiaozhi/session_id": "VOICE_SESSION_ID"
    }
  }
}
```

`agent_submit_task`, `agent_task_status` and `agent_reply` are suggested business
tools the agent must implement. Check caller scope on the agent. For long jobs,
return an accepted status and job ID within 30 seconds, continue in the agent's
queue, and later send an inbox receipt. Four calls per provider may be in flight;
results are bounded to 6,000 JSON characters and treated as untrusted data. Timeout
or disconnection means execution outcome is unknown; no automatic action retry.

A custom bridge can send a notification on the same WebSocket:

```json
{
  "jsonrpc": "2.0",
  "id": "notify-job-123",
  "method": "xiaozhi/notify",
  "params": {
    "title": "Report ready",
    "text": "Your result is available.",
    "idempotency_key": "job-123-complete"
  }
}
```

Alternatively use `tools/call`, `params.name: "notify_send"`, with arguments in
`params.arguments`. This is a **relay extension for server-to-client delivery**;
ordinary stdio MCP SDKs do not implement it automatically. Do not write these
requests into FastMCP stdout without a bridge that can demultiplex replies. For
ordinary stdio servers, use the HTTP helper instead.

The response echoes the ID and includes `result.content`, `structuredContent`
(the receipt) and `isError`. Inbox requests must have IDs: fire-and-forget requests
are not stored. The token determines device scope; other device IDs are rejected.
Revoked tokens cannot submit new messages. Inbox keys handle message duplication.

## Advanced HTTP/SSE and existing integrations

Existing integrations remain available under **MCP Devices → Konfigurasi MCP
manual / lanjutan → Add external MCP**. Supply a relay-reachable Streamable HTTP
or SSE agent URL and a separate agent-server token, then select that connection
in **Xiaozhi Devices → Config → Expose Tools from MCP Devices**. Reopen the voice
conversation. **Reconnect / Refresh tools** reloads HTTP tools.

HTTPS and loopback HTTP are accepted; trusted LAN/container HTTP needs
`MCP_ALLOW_HTTP=true`. HTTP server URLs cannot include credentials, queries or
fragments. A blank edit token preserves the secret; **Remove saved token** removes
it. This advanced flow connects outgoing tools only. Inbox uses dashboard pairing
or [manual sender configuration](hermes-mcp.md).

Admin exports still include the old `mcp_config` targeting `/mcp/notifications`.
Its paired token retains the `agent_register` tool with `{url,transport?,token?}`
for automatically selecting an HTTP return server. Agent-server credentials must
be separate from the pairing token. The pipe flow needs no registration. Removing
an advanced HTTP server does not revoke the pairing token; delete the pairing to
revoke all access.

## Persistence, proxy and admin API

`DATA_DIR/agent-connections.json` stores paired endpoint/inbox credentials;
`remote-mcp-servers.json` stores advanced HTTP settings. Files are mode `0600` on
POSIX and private, not encrypted. Backups contain credentials. Existing pairings
can reexport the new WebSocket URL with their existing token; inbox and volume
migration is unnecessary. Polling APIs contain no token, and the dashboard clears
setup text on close/logout.

The endpoint shares the dashboard port; no additional endpoint service is needed.
Proxy `/mcp_endpoint/mcp/` with WebSocket Upgrade and allow `/api/notifications`
for the helper. Keep token query strings out of proxy access logs.

| Admin API | Purpose |
| --- | --- |
| `GET /api/agent_connections` | Credential-free status and tool/provider counts |
| `POST /api/agent_connections` | `{name,device_id,public_url}` → pairing, `mcp_endpoint`, `environment`, instructions and legacy HTTP config |
| `POST /api/agent_connections/:id/export` | Reexport existing credentials |
| `DELETE /api/agent_connections/:id` | Revoke endpoint/inbox and remove tools |
| `GET /api/remote_mcp_servers` | Advanced HTTP servers without secrets |
| `POST /api/remote_mcp_servers` | `{id?,name,url,transport,token?,enabled?}` |
| `POST /api/remote_mcp_servers/:id/connect` | HTTP reconnect and discovery |
| `DELETE /api/remote_mcp_servers/:id` | Remove HTTP server and selections |

Admin APIs require a strong-password session; mutations require JSON and
`X-Requested-With: XiaozhiDashboard`. Admin responses use `Cache-Control: no-store`.
Resources, OAuth, sampling and elicitation are not supplied. Transport/scope tests
are included but this change has not been locally tested/built or verified with
live agents and physical devices.
