# Internal XiaoZhi reminders

[Home](../README.en.md) · [Bahasa Indonesia](reminders.md)

Schedules run on the server without Hermes or an external MCP endpoint. Voice
tools require Gemini, an approved device and its dedicated token. The dashboard
can manage schedules without a voice session. Chimes use the existing MQTT setup.

Supported patterns: once after a delay, once at a date/time, daily, selected
weekdays, monthly dates, and anchored intervals of at least 60 seconds. Recurring
schedules support optional start/end local date-times. Missing monthly dates are
skipped; January 31 is followed by March 31. An interval first fires after its
interval, or at an explicitly supplied start time.

Open **Xiaozhi Devices → Pengingat** to create, edit, pause/resume or cancel a
schedule. Occurrence history provides **Tunda…** (snooze) and **Sudah selesai**
(complete). Changes apply immediately without disconnecting voice. Example voice
requests: “ingatkan minum 5 menit lagi”, “setiap Senin jam 7 malam”, “tunda 10
menit”, “sudah minum”. Ambiguous times or matching reminders require clarification.
Creation is confirmed in speech, without an extra inbox acknowledgment.

Each schedule snapshots a fixed UTC offset. Existing devices inherit
`DEVICE_TIMEZONE_OFFSET_MINUTES` (default 420, WIB). Dashboard examples are 420
WIB, 480 WITA, 540 WIT. Defaults affect new schedules only; existing schedules
retain their offset. These are fixed offsets, not DST-aware IANA zones.

Quiet hours are off initially, with a suggested 22:00–07:00 range. Once enabled,
they suppress **all inbox chimes**: external senders, internal reminders,
repeated unread chimes and manual retries. Storage and explicitly requested
spoken retrieval continue. Separate audio-only tests are unaffected. Afterwards,
the device's existing shared chime cadence resumes, without replaying every
message as a separate chime.

A greeting reads titles and marks their notifications read after completed audio
transmission. This stops chimes but does **not** mark tasks done. Completion
affects one occurrence; recurring schedules remain active. Snoozing stops that
occurrence's chime and later reopens the **same notification ID**, without
changing the recurring schedule or creating a second message. Snoozes allow up
to 30 days while content remains retained; expired content is never recreated.
Pause holds future occurrences and associated chimes; resume generates no paused
backlog. Cancel closes open occurrences and retains history.

The **Agenda kalender** panel shows a monthly calendar and paginated date-range
agenda. Click **Lewati kali ini** for one exact future/open occurrence, preserving
recurring timing and silencing an open occurrence. Voice can ask for today's,
tomorrow's or the week's agenda. Ambiguous matching occurrences require a choice.
Paused schedules are not projected. Future skips are limited to 1,000 per device;
history is retained until 30 days after the occurrence date.

**Jejak pengiriman** shows due, storage, chime blockers/publication, read, done,
snooze and skip events. Inbox detail also shows external notification delivery.
Older stored status is labeled legacy_snapshot; unavailable history is not
invented. Publication never implies confirmed speaker playback. Timelines keep
up to 100 recent delivery events per notification plus key storage/read events.
For direct spoken announcements without inbox messages, see
[screen breaks with Edge TTS](screen-breaks.en.md).

The scheduler checks at startup and every second. Offline devices retain inbox
messages. After server downtime, a missed one-off fires; a recurring schedule
emits only its latest missed occurrence and records the skipped count. Intervals
remain anchored to their original timing. Occurrence creation, inbox insertion
and schedule advance share one SQLite transaction. Chime publication does not
prove physical playback.

Limits: 100 active/paused schedules per device, title 120 and body 2000 UTF-16
units, occurrence history 30 days. A full inbox defers delivery without advancing
the schedule; marking read does not free capacity. Device deletion removes its
schedules/settings/history; unapproved devices are not processed.

Voice tools: `reminders_create/list/get/update/cancel/snooze/complete/settings`,
`reminders_agenda`, `reminders_skip`, `reminders_trace`, plus screen break tools.
They derive device scope from authentication, return untrusted data and use the
configured inbox tool budget. Tool list/get pages contain up to 5 records;
inspect `has_more`/`truncated`. Pause/resume uses update status `paused`/`active`.
Settings action `get/update` exposes current local time, default offset and quiet
hours. It does not authorize instructions inside reminder content.

Admin APIs under `/api/devices/:mac/`:

| Method / path | Behavior |
| --- | --- |
| GET / POST `reminders` | List/create |
| GET / PATCH / DELETE `reminders/:id` | Get/edit/cancel |
| GET `reminders/occurrences` | History, optional reminder_id filter |
| POST `reminders/occurrences/:id/snooze` | seconds and stable request_key |
| POST `reminders/occurrences/:id/complete` | confirm:true |
| GET `reminders/agenda` | from YYYY-MM-DD, days 1–42, limit 1–50, offset 0–100000 |
| GET `reminders/calendar` | Daily counts; from, days |
| POST `reminders/skip` | occurrence_id OR exact id + due_at from agenda |
| GET `reminders/occurrences/:id/trace` | Occurrence delivery timeline |
| GET `inbox/:id/trace` | Internal/external inbox delivery timeline |
| GET / PUT `reminder-settings` | timezone_offset_minutes, quiet_enabled, quiet_start/end |

Writes require the existing admin session and JSON dashboard header. Cancellation
requires confirm:true. List/history accept limit (1–50) and offset; schedule lists
also accept status. Updates may include revision for conflict detection. Creation
accepts title, optional text, schedule and stable request_key. See the
[Indonesian guide](reminders.md#referensi-api-dan-tools) for schedule fields.

**Deployment:** stop the server and back up its data volume before updating.
The existing inbox migrates transactionally from schema 1 or 2 to 3, preserving old
messages. Older server versions reject schema 3; rolling back requires restoring
the pre-migration backup. Do not copy just the SQLite main file while the server runs.
Lifecycle logs carry IDs/status without content or credentials. Regression tests
are prepared for Node 24 CI and use fake providers rather than live services.
