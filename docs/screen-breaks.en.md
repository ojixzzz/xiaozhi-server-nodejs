# Screen breaks with Edge TTS

[Home](../README.en.md) · [Bahasa Indonesia](screen-breaks.md) · [Reminders and calendar](reminders.en.md)

Open **Xiaozhi Devices → Pengingat → Istirahat layar**. Save your work interval,
rest duration, active hours/days and announcement language, then press **Mulai kerja**.
Defaults: **30 minutes of work**, **2 minutes of rest**, **Monday–Friday 08:00–17:00**,
Indonesian, automatic start **off**. Intervals allow 5–240 minutes; rests 1–30 minutes.
Times use the device timezone. Overnight active windows belong to their start day.

The device plays an Edge TTS announcement directly while idle. This creates
**no inbox message**, has no read status, and never repeats the same occurrence.
Only explicit “start rest” begins a rest; hearing an announcement or greeting the
device does not count. Ignoring a 09:30 announcement leaves the next one at 10:00.
Starting a two-minute rest at 09:30 announces its end at 09:32; the next work
interval ends at 10:02. After a long server outage, work resumes from processing
time instead of replaying missed rest announcements.

Controls: start work, start rest, return to work, snooze, skip once and finish work.
Settings changes restart the active work interval from now. Automatic start runs
once per active window, from the server's first check in that window. Finishing
work blocks another automatic start in the same window. Sessions stop outside
active hours. During active conversations, announcements wait up to **2 minutes**
from their due time. Offline, quiet-hours, expired and TTS-failed announcements are
skipped; nothing is queued for replay on reconnect.

Voice uses Gemini, an approved device and dedicated token. Start a new
conversation after server update to load `screen_breaks_settings` and
`screen_breaks_session`. The latter supports start/stop/rest/resume/snooze/skip.
Neither tool accepts a device ID. External agents must not create a duplicate
reminder or inbox message for a screen break.

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
| GET / PUT `screen-breaks` | Read/update interval_minutes, rest_minutes, active_start/end, weekdays, auto_start, language |
| POST `screen-breaks/command` | action, optional minutes for rest/snooze, stable request_key |
| GET `screen-breaks/history` | limit 1–50, offset 0–1000 |

Keep the same key and payload for uncertain retries. Receipts retain up to the
last 128 commands within 30 days. Back up the stopped server's data volume before
deploying the schema-3 migration; see [deployment details](reminders.en.md).
