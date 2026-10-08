# Two-way external agent integration

[Bahasa Indonesia](remote-mcp.md) · **English** · [Documentation index](README.md)

Use this guide after your relay and Gemini voice conversation work. For the
short dashboard flow, follow the first setup section; protocol/API details are
for developers. New MCP dashboard changes have not been locally tested in this
iteration; a connected status is not verification of the agent’s task logic.

The relay supports two independent MCP connections:

| Direction | MCP client | MCP server | Purpose |
| --- | --- | --- | --- |
| Agent → XiaoZhi | Hermes/custom agent | Relay `/mcp/notifications` | Call `notify_send` to store text and request a chime |
| XiaoZhi → agent | Relay, acting for the device's Gemini session | Your agent's remote MCP endpoint | Discover and call the agent's tools |

These use separate credentials. The external agent must provide a real MCP
server for its tools; being able to call other MCP servers does not automatically
make an agent an MCP server. Incoming notifications do not require an active
voice session. Outgoing tool calls happen during an authenticated Gemini session.

## Simple dashboard setup: copy to your agent

1. Deploy the new relay image and open **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Choose an approved Gemini device with its own device token. The agent name is
   prefilled; change it if desired. The public relay URL is filled from the
   dashboard address. Under **Alamat dashboard yang bisa diakses agent**, change
   it only if your agent needs a different reachable domain/IP.
3. Click **Buat konfigurasi**, then **Salin untuk agent**. Paste the complete text
   into Hermes/custom agent. **Salin JSON MCP saja** is available for an MCP
   configuration editor; it contains a standard `mcpServers` entry with URL and
   Authorization header. Some clients require their own configuration format.
4. The agent can immediately call `notify_send` to store an inbox message for the
   selected device. No `.env` changes or restart are needed for this sender.
5. For the return direction, the setup text tells the agent to provide its own
   reachable MCP server, then call `agent_register` with its URL, transport and
   optional separate Bearer token. The relay discovers its tools and automatically
   selects this connection for the paired device. Reopen the voice conversation.
   The dashboard shows **Terhubung dua arah** once the server is connected and
   tools are enabled for the device.

An agent that only supports MCP clients still needs an MCP server/adapter for
the return direction. Pasting instructions cannot create an endpoint in an
application that lacks that capability. The dashboard keeps this state visible
as **Inbox siap · menunggu agent mendaftarkan server MCP**.

`agent_register` is exposed only to dashboard-created credentials. Existing
environment-configured notification senders retain only `notify_send`. The tool
accepts `{url, transport?, token?}`, never a device ID or a connection ID; the
relay obtains both from the saved pairing. Its endpoint URL follows the same
HTTPS/loopback and `MCP_ALLOW_HTTP` rules as manual configuration. It can update
only its own outgoing connection. Do not reuse the relay notification token as
the agent-server token. An offline registration returns `registered:true` with
`connected:false`; discovery retries every 30 seconds. It does not prove the
agent's business logic works and does not send a test notification.

Pairings and their randomly generated per-device sender tokens persist in
`DATA_DIR/agent-connections.json` with mode `0600`, inside the existing data
volume. The normal list/poll API never returns tokens. Explicit authenticated
creation/export operations provide them for copying; the dashboard clears the
visible export on close/logout. **Hapus koneksi** revokes that token, removes the
outgoing server and deselects its tools. Existing stored inbox messages remain.
Deleting only the outgoing server in the advanced section leaves the inbox
token active so the agent can register a replacement endpoint later.

`NOTIFY_SENDERS_JSON=[]` disables environment-defined senders only. To revoke
dashboard-created credentials, delete their connections in the dashboard.
Existing malformed ingress environment settings still fail closed; correct
those settings before using a pairing.

## Manual outgoing connection (advanced)

1. Open **MCP Devices → Konfigurasi MCP manual / lanjutan → Add external MCP**.
2. Enter a name, your agent's server URL, transport and optional Bearer token.
   Streamable HTTP is the default; select SSE for an older HTTP+SSE server.
3. Click **Save & connect**. Inspect connection status and **View Tools**.
   Saving retains the configuration even if the agent is unavailable; the relay
   checks disconnected enabled servers again every 30 seconds. **Reconnect** or
   **Refresh tools** triggers discovery explicitly.
4. Open **Configure Xiaozhi Device → Expose Tools from MCP Devices**, select the
   new connection and save. Reopen the voice conversation to load its tools.

Tools are available only to approved devices with a dedicated device token using
Gemini, and only for connections enabled in that device's configuration. Saving,
refreshing or deleting an outgoing connection closes affected voice sessions so
their tool definitions can be reloaded. Disabling/deleting a connection also
prevents subsequent calls from old sessions.

HTTPS and loopback HTTP are accepted by default. To use an agent on a trusted
LAN/container network, explicitly set `MCP_ALLOW_HTTP=true` and recreate the relay
before entering its HTTP URL. With Docker, `localhost` means the relay container
unless using host networking; use a reachable service name/address for a separate
agent container. URLs must not contain query parameters, credentials or fragments.
Provide authentication through the dedicated Bearer token field.

Credentials are stored in `DATA_DIR/remote-mcp-servers.json`, with mode `0600`,
inside the existing data volume. The file is excluded from Git and Docker build
contexts. Dashboard APIs return only `tokenConfigured`, never the saved token.
Leaving the token blank on edit preserves it; **Remove saved token** clears it.
Backups of the data volume include these credentials. This file is private, not
encrypted. A malformed saved configuration disables this optional integration
without replacing the file or interrupting voice/notification services.

This connection supports remote tool calls; it does not spawn local `stdio`
commands or implement an OAuth login, sampling, resource browsing or elicitation.

## Configure notifications back from the agent

This environment-based setup is needed only for the manual connection flow.
The simple dashboard setup above creates and saves its sender automatically.

Follow [notification sender setup](hermes-mcp.md). In the relay environment, use
the exact approved device IDs and a separate sender credential:

```dotenv
NOTIFY_SENDERS_JSON=[{"name":"my-agent","token_env":"AGENT_NOTIFY_TOKEN","device_ids":["aa:bb:cc:dd:ee:ff"]}]
# Supply a real unique token, at least 32 characters, through the protected env.
# AGENT_NOTIFY_TOKEN=<agent-to-relay credential>
```

Configure your external agent as an MCP client of
`https://relay.example.com/mcp/notifications` with
`Authorization: Bearer <agent-to-relay credential>`. It initializes MCP and calls
`notify_send` with `device_id`, optional `title`, `text` and `idempotency_key`.
The existing direct HTTP fallback is `POST /api/notifications` with the same
credential and message fields.

## Contract for a custom agent MCP server

Use the official MCP SDK to expose standard `initialize`, `tools/list` and
`tools/call` operations over Streamable HTTP. The relay uses
`@modelcontextprotocol/sdk`, negotiates the protocol version, and supports JSON
responses, SSE responses and session IDs through that SDK. See the
[official client documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md)
and [server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md).

Useful application tools include:

| Example tool | Arguments | Suggested result |
| --- | --- | --- |
| `agent_submit_task` | `instruction` | `{ "accepted": true, "job_id": "job-123" }` |
| `agent_task_status` | `job_id` | Task state and bounded human-readable progress |
| `agent_reply` | `notification_id`, `message` | Acceptance of the user's response |

These are example business tools for your agent to implement; the relay does
not fabricate them or execute work on its own. Each tool must supply an object
`inputSchema`. A connection accepts up to 64 unique tools, each with an input
schema of at most 8,000 serialized characters. Use Gemini-compatible JSON schemas.

The relay adds server-controlled caller context to every outgoing `tools/call`:

```json
{
  "name": "agent_submit_task",
  "arguments": { "instruction": "Siapkan ringkasan laporan" },
  "_meta": {
    "xiaozhi/device_id": "aa:bb:cc:dd:ee:ff",
    "xiaozhi/session_id": "the-current-voice-session-uuid"
  }
}
```

The agent should use `_meta["xiaozhi/device_id"]` as the originating device,
checking it against its own authorization scope. The model does not set this
metadata. For a reply, save the notification UUID from `notify_send`'s receipt
so `agent_reply` can correlate the user's response with your original event.

For long-running work, return an accepted job ID within 30 seconds, finish work
in the agent's own queue, then call the relay's `notify_send`:

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "title": "Ringkasan laporan selesai",
  "text": "Hasil ringkasan untuk job-123 sudah tersedia.",
  "idempotency_key": "job-123-complete"
}
```

Repeated submissions of that event must reuse the same idempotency key and
identical content. This callback is independent of the original voice session,
so it works after the user has stopped talking. The ordinary inbox reminder and
title-first/read behavior apply to the completion notification.

Remote tool names are scoped internally to avoid collisions with other servers
or built-in tools. The original name is sent to the external agent. Tool results
are bounded to 6,000 serialized characters and kept as untrusted data. Remote
`isError`/structured results are preserved; exceptions/timeouts do not become
success. At most four concurrent tool calls per connection are dispatched.
Calls are not automatically replayed after an error, timeout or disconnect;
the external agent may still be running an action whose result was lost.

## Dashboard API

Admin routes require login and a configured strong admin password. Mutations
require JSON and `X-Requested-With: XiaozhiDashboard`:

- `GET /api/remote_mcp_servers`: sanitized settings, connection state and tools
- `POST /api/remote_mcp_servers`: `{id?,name,url,transport,token?,enabled?}`;
  `token:null` clears a saved token, an empty string preserves it on edit
- `POST /api/remote_mcp_servers/:id/connect`: reconnect and discover tools
- `DELETE /api/remote_mcp_servers/:id`: remove connection and device selections

Simple pairing routes use the same strong admin session, JSON/custom-header
mutation checks and `Cache-Control: no-store`:

- `GET /api/agent_connections`: settings/status without credentials
- `POST /api/agent_connections`: `{name,device_id,public_url}`; create a scoped
  sender and return instructions plus `mcp_config`
- `POST /api/agent_connections/:id/export`: copy the existing instructions/config
- `DELETE /api/agent_connections/:id`: revoke sender and remove its outgoing tools

Saved remote servers also appear in `GET /api/mcp_devices` so the existing
per-device tool selection works for both incoming WebSocket providers and
outgoing remote servers. No live Hermes/custom-agent endpoint is bundled or
configured automatically. Added automated coverage is not a verification of an
actual external agent, Gemini tool selection or physical-device behavior.
