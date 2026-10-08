# Two-way MCP endpoint example

[Indonesian](README.md) · **English** · [Full guide](../../docs/remote-mcp.en.md)

Source repository: [ojixzzz/xiaozhi-server-nodejs](https://github.com/ojixzzz/xiaozhi-server-nodejs).
These example files are in its `examples/mcp-endpoint` folder.

Use Python **3.11+**. In this folder:

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Open the dashboard → **MCP Devices → Hubungkan agent · MCP dua arah** → choose a
Gemini device → **Buat endpoint → Salin MCP_ENDPOINT**. Paste its complete URL:

```sh
export MCP_ENDPOINT='FULL_PRIVATE_URL_FROM_DASHBOARD'
python mcp_pipe.py agent.py
```

Windows PowerShell: `$env:MCP_ENDPOINT='FULL_URL'`; activate the virtual environment
with `.venv\Scripts\Activate.ps1`.

| File | Purpose |
| --- | --- |
| [mcp_pipe.py](mcp_pipe.py) | Forward local stdio JSON-RPC over WebSocket |
| [agent.py](agent.py) | Example `agent_echo` and `agent_notify`; replace with real agent tools |
| [calculator.py](calculator.py) | Two-number calculator without eval or startup notifications |
| [xiaozhi_notify.py](xiaozhi_notify.py) | Send inbox messages with the same MCP_ENDPOINT |
| [mcp_config.json](mcp_config.json) | Launch multiple stdio servers instead of a single script |

Calculator only: `python mcp_pipe.py calculator.py`. The user's original calculator
pipe can also connect directly. Node.js: `python mcp_pipe.py -- node /path/to/server.js`.
With no arguments, the pipe reads `mcp_config.json` or `MCP_CONFIG`. Commands use
the terminal's current working directory; use absolute paths when needed.

XiaoZhi → agent: wait for tools, reopen a voice conversation, and request
`agent_echo`. This is an echo demonstration, not a configured Hermes instance.
Agent → XiaoZhi: import the helper from a custom tool/background job:

```python
from xiaozhi_notify import notify_send

receipt = notify_send("Report ready", "Your result is available.", "job-123-complete")
```

Or explicitly send one message from another terminal with the same environment:

```sh
python xiaozhi_notify.py --title 'Report ready' --text 'Your result is available.' --idempotency-key 'job-123-complete'
```

The helper derives the HTTP(S) URL and token from MCP_ENDPOINT; no separate device
or credential configuration is needed. The CLI loads `.env`; imported functions
read process environment. `stored: true` confirms storage, not playback. Use one
stable unique key per message; uncertain sends require checking inbox and retaining
the same key/content on retry. For async tools use
`await asyncio.to_thread(notify_send, title, text, key)`.

MCP server stdout is JSON-RPC only; send logs to stderr. The pipe does not print
the private URL or replay calls on reconnect. A disconnected pipe restarts the
local server process; long jobs need separate durable storage/queues to survive.
Ctrl+C stops the pipe. Restart it after changing tools.

MCP_ENDPOINT is a device-scoped secret. Do not commit env files, logs or tokens.
Examples send nothing on startup and have not been run/tested in this change.
