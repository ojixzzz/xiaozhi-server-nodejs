# Pomodoro with Edge TTS

[Home](../README.en.md) · [Bahasa Indonesia](screen-breaks.md) · [Reminders and calendar](reminders.en.md)

Open **Xiaozhi Devices → Pengingat → Pomodoro**. Configure focus, short rest,
long rest, completed focus sessions before a long rest, active hours/days and
announcement language. Save, then press **Mulai Pomodoro**.

Defaults: **25 minutes focus → 5 minutes rest**, with **20 minutes long rest
after 4 completed focus sessions**. Phases advance automatically; the block count
resets after long rest. Total completed focus sessions remain visible until a new
block starts. Starting at 09:00 gives rest at 09:25–09:30, next focus at
09:30–09:55, and the first long rest at 10:55–11:15.

Focus allows 5–240 minutes, short rest 1–30, long rest 1–60, and 1–12 completed
focus sessions per block. Defaults use Monday–Friday 08:00–17:00, Indonesian,
automatic start off. Times follow the device timezone; overnight windows belong
to their start day.

Every automatic transition plays one direct **Edge TTS** announcement. This
creates **no inbox message**, has no read status and never repeats that event.
The timer counts elapsed phases; an announcement cannot verify actual rest.
Greetings leave the timer unchanged. Manual commands receive conversational
confirmation without an extra announcement.

| Command / dashboard control | Behavior |
| --- | --- |
| start / Mulai Pomodoro | New block; an already-running focus keeps its timer |
| pause / Jeda timer | Freeze remaining focus or rest time |
| resume / Lanjutkan | Continue the paused phase; if resting without pause, return to focus early |
| rest / Mulai istirahat | Rest early, optionally 1–60 minutes; no completed focus credit |
| snooze / Tunda akhir fokus | End focus N minutes from now (default 5); focus only |
| skip / Lewati fase | Move to the next phase; skipped focus receives no completion credit |
| stop / Hentikan | Stop the session |

Saving settings resets the current phase duration, including paused remaining
time. Changing block size resets block progress. Automatic start runs once per
active window, from the first server check. Stopping blocks another automatic
start in that window. Sessions, including paused ones, stop outside active hours.

State, counters and paused remaining time survive restart. After a long outage
within the same active window, only one phase advances and the next phase receives
its full duration from processing time. Missed cycles are not fabricated. During
conversations, announcements wait up to **2 minutes** from due time. Offline,
quiet-hours, expired and TTS-failed announcements are skipped without replay;
the timer continues independently.

Previous interval timers upgrade once: their sessions stop and pending speech is
cancelled. Start Pomodoro again. The old default pair 30/2 becomes 25/5; other
configured duration pairs are preserved. Long rest defaults to 20 after 4 focus
sessions. This upgrade uses existing schema-3 tables with no schema version bump.

Voice uses Gemini, an approved device and dedicated token. Open a new conversation
after updating the server to load `screen_breaks_settings` and
`screen_breaks_session`. Tool names and `/screen-breaks` API paths are retained
for compatibility. Session actions: start/stop/rest/pause/resume/snooze/skip.
Neither tool accepts a device ID. External agents must not schedule a duplicate
Pomodoro timer or send inbox messages for these announcements.

Use the **bundled MQTT gateway**, compatible notification-playback firmware, and
the existing notification settings: `NOTIFY_ENABLED`, `NOTIFY_AUDIO_BASE_URL`,
`NOTIFY_ALLOWED_AUDIO_ORIGINS`, and `MQTT_AUDIO_ALLOWED_ORIGINS`. The audio origin
must be device reachable. See [MQTT setup](notifications.md) for secrets and HTTP
opt-in. WebSocket transport and custom notification adapters are unsupported here.

Docker includes **edge-tts 7.2.8**, Python and FFmpeg. Edge TTS creates MP3;
FFmpeg converts it to mono Ogg Opus. No Gemini TTS key is required. First-time
generation needs access to Microsoft's online speech service; fixed phrases are
cached in `DATA_DIR/announcement-audio` for subsequent delivery. Indonesian uses
`id-ID-GadisNeural`; English uses `en-US-JennyNeural`. See the
[Edge TTS project](https://github.com/rany2/edge-tts). Outside Docker, install the
executables separately and set `EDGE_TTS_COMMAND` and `FFMPEG_COMMAND` to their
paths if needed. These variables are executable paths, not shell commands.

Publication is claimed persistently before sending. If the server restarts or
loses a response after that claim, the event remains **unknown** and is never
retried. This avoids duplicate speech but can omit an announcement after a crash.
Gateway publication does not prove audible playback; the firmware supplies no
playback acknowledgment. History retains 30 days of published/skipped/unknown
events, including reasons such as offline, quiet hours, expired or TTS unavailable.

Admin APIs under `/api/devices/:mac/` use existing dashboard authentication and
JSON write protection:

| Method / path | Behavior |
| --- | --- |
| GET / PUT `screen-breaks` | Read/update interval_minutes (focus), rest_minutes (short), long_rest_minutes, cycles_before_long_rest, active_start/end, weekdays, auto_start, language |
| POST `screen-breaks/command` | action, optional minutes for rest/snooze, stable request_key |
| GET `screen-breaks/history` | limit 1–50, offset 0–1000 |

Keep the same key and payload for uncertain retries. Receipts retain up to the
last 128 commands within 30 days. Back up the stopped server's data volume before
deploying the schema-3 migration; see [deployment details](reminders.en.md).
