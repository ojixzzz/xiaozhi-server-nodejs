# XiaoZhi Server Node.js

[Bahasa Indonesia](README.md) · **English**

Source repository: [ojixzzz/xiaozhi-server-nodejs](https://github.com/ojixzzz/xiaozhi-server-nodejs).

A server that connects XiaoZhi devices to voice AI, stores notifications, and
communicates with external agents such as Hermes. Manage devices through a web
dashboard.

Example: ask an agent to prepare a report through XiaoZhi. When it finishes, the
agent sends a notification. Your device can play a chime. Say “halo” or “ada apa”
to hear the **title first**, then ask for details or reply through the agent's tools.

## Choose your starting point

| What you want to do | Guide |
| --- | --- |
| Use an existing server's dashboard | [User guide — Indonesian](docs/panduan-pengguna.md) |
| Connect an external agent | [Two-way MCP — English](docs/remote-mcp.en.md) |
| Install a new server | [Step-by-step setup — Indonesian](docs/SETUP_ID.md) |
| Manage Docker, updates, and backups | [Docker reference — English with Indonesian introduction](docs/docker.md) |
| Find APIs and feature details | [Documentation index and glossary](docs/README.md) |

Use **Gemini** for conversation memory, spoken inbox retrieval, and outgoing
remote-agent tools. Qwen and local LFM conversation adapters are also included;
their feature support differs. Model availability depends on your provider account.

## Features

- Voice conversations through XiaoZhi devices.
- A dashboard for device approval, AI settings, memory, and inbox management.
- Internal scheduled reminders: daily, weekdays, monthly dates, intervals and
  one-offs, with voice snooze/completion and all-inbox quiet hours. See the
  [reminder guide](docs/reminders.en.md), including skip-once, calendar agenda
  and delivery timelines.
- Pomodoro with direct Edge TTS: focus 25 minutes, short rest 5, long rest 20
  after 4 completed focus sessions. Configure durations and active hours, without inbox messages or repeated announcements. See the
  [Pomodoro guide](docs/screen-breaks.en.md).
- Optional memory of completed Gemini turns and administrator-entered notes.
  It starts disabled and is shared by everyone using that device.
- A persistent text inbox that retains messages even while the device is offline.
- Unread reminder chimes, attempted every 60 seconds and paused during conversations.
- Two-way MCP: the agent sends inbox messages; XiaoZhi calls the agent's task or
  reply tools during a voice conversation.

The package includes its MQTT gateway and a sample chime. The bundled path does
not require Redis or a separate MQTT broker.

## Connect an agent from the dashboard

Start with an approved device and a working Gemini conversation.

1. Open **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Select a device and click **Buat endpoint** (Create endpoint).
3. Click **Salin untuk agent** (Copy for agent) and paste the text into your agent.
4. Once **Terhubung dua arah** (Connected both ways) appears, reopen the voice conversation.

The dashboard generates a device-scoped inbox token without editing `.env`.
Give this private configuration only to the agent you intend to connect.
The agent exposes a **local stdio MCP server** through a WebSocket pipe, following
the `mcp-calculator` example:

```sh
export MCP_ENDPOINT='FULL_PRIVATE_URL_FROM_DASHBOARD'
python mcp_pipe.py agent.py
```

No public agent HTTP server is required. `xiaozhi_notify.py` sends inbox messages
using that same endpoint, with no extra device/credential configuration.
[Bundled examples](examples/mcp-endpoint/README.en.md) and
[the agent guide](docs/remote-mcp.en.md) explain both directions.

## Notification behavior

Voice sessions return to **standby after 60 seconds without detected speech**.
Configure it under **Xiaozhi Devices → Config → Standby otomatis setelah diam**.
The timer pauses for AI output/playback and pending tools; silent packets do not
reset it. The MQTT connection remains online for notifications.

1. The agent sends a title and body; the server stores them in the inbox.
2. An online, idle device can play a chime through MQTT.
3. The relay attempts another reminder every 60 seconds while messages remain unread.
4. On a greeting such as “halo”, “apa”, or “ada apa”, Gemini announces titles first.
5. Titles present in a completed audio response are marked read by the server.
   Ask for the message body when you want the details.

Opening an inbox message in the dashboard does not mark it read. Use **Mark read**
for that. Read messages remain stored. Reminders stop when all messages are read
or expired. A failed chime does not remove the text.

`published` confirms forwarding, not audible playback. A powered-off or deeply
sleeping device cannot receive a chime. The server's read acknowledgment is not
proof that a person physically heard the audio.

## Installation and images

Use Docker with Compose, or Node.js **24+** for native execution. Supply your own
AI API key and server credentials; provider charges follow your account.
Follow [the setup guide](docs/SETUP_ID.md) to configure one device before expanding.
Keep an existing `.env`, working device settings, and persistent data.

GitHub Actions publishes **AMD64-only** images to
`ghcr.io/ojixzzz/xiaozhi-server-nodejs`. `latest` follows successful builds from
`main`; `sha-…` identifies a commit build. The bundled Compose file builds source
locally. [Docker instructions](docs/docker.md) explain deployment and image usage.

## Data and privacy

| Item | Default behavior |
| --- | --- |
| Conversation memory | Disabled until enabled per device |
| Inbox capacity | 100 messages per device, including read messages |
| Inbox retention | 30 days from receipt, including unread messages |
| Reminders | 60 seconds; `NOTIFY_REMINDER_INTERVAL_MS=0` disables them |
| Docker persistence | `xiaozhi-data` volume at `/app/data` |

Memory and inbox are separate: clearing memory does not clear notifications.
A full inbox rejects new messages; marking read does not free a slot. Anyone
using a shared device may access its memory and inbox. Retrieved content is sent
to the configured AI provider.

Preserve the existing Compose project name and volume when updating.
`docker compose down -v` deletes the data volume. See
[backup and migration details](docs/docker.md#persistent-data-and-migration).

## Troubleshooting and development

If text is saved but no chime plays, check device connectivity, MQTT selection,
and the reachable audio URL. If the dashboard is waiting for a pipe connection,
set MCP_ENDPOINT and start the local pipe. Reopen the conversation
after tools are connected. More help: [user guide](docs/panduan-pengguna.md#jika-ada-masalah).

Run `npm run check` and `npm test` for source verification when appropriate.
[TEST_RESULTS.md](TEST_RESULTS.md) records a historical run from 7 October 2026;
it does not certify the latest reminder, title announcement, or MCP dashboard
changes. Those additions have not been locally tested in this iteration.
Deployment, live agents, providers, and physical playback require verification
in your actual environment.

## Attribution

The gateway derives from the MIT-licensed
[78/xiaozhi-mqtt-gateway](https://github.com/78/xiaozhi-mqtt-gateway/tree/c5e3235df8db8f06d1710074ec10e870159e0844).
Its license is retained in [gateway/LICENSE.upstream](gateway/LICENSE.upstream).
Devices use the [XiaoZhi ESP32](https://github.com/78/xiaozhi-esp32) protocol.
