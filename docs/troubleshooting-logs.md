# Menelusuri masalah melalui log

[Dokumentasi](README.md) · [Panduan pengguna](panduan-pengguna.md)

Log mencatat perjalanan satu percakapan: perangkat masuk, diperiksa aksesnya,
tools ditemukan, koneksi AI dibuka, audio diterima/diputar, lalu sesi berakhir.
Setiap percakapan mempunyai **ID sesi** sendiri. Sambung ulang AI dalam
percakapan yang sama tetap memakai ID itu, dengan nomor `attempt` berikutnya.

## Mengambil log

Untuk Compose bawaan, buka Terminal di folder proyek:

```sh
docker compose logs --since=10m --timestamps xiaozhi
```

Jika menggunakan berkas tambahan GHCR, sertakan berkas yang sama dengan saat
menjalankan server:

```sh
docker compose -f compose.yaml -f compose.ghcr.yaml logs --since=10m --timestamps xiaozhi
```

Untuk mengikuti kejadian baru saat perangkat dibangunkan:

```sh
docker compose logs -f --tail=200 xiaozhi
```

Nama layanan adalah `xiaozhi`, bukan nama container seperti `xiaozhi-1`.
Sesuaikan nama jika konfigurasi Compose Anda berbeda. Jika menjalankan Node
langsung, log muncul di Terminal dan disimpan dalam
`DATA_DIR/connection-YYYY-MM-DD.log`. Dalam container bawaan, lokasinya
`/app/data/connection-YYYY-MM-DD.log`; berkas dirotasi hingga 20 MB dan
dipertahankan 14 hari.

## Menelusuri satu percakapan

Cari baris `device.connection_requested`, lalu salin `session_id` pada percakapan
yang bermasalah. Gunakan ID lengkap untuk menyaring log, misalnya:

```sh
docker compose logs --since=10m xiaozhi | grep -F '73e584ac-6c58-45a2-87b0-102f929de8f8'
```

ID di atas hanya contoh dari log; ganti dengan ID kejadian terbaru. Sertakan
baris dari awal koneksi sampai `device.disconnected` agar penyebab dan akibat
terlihat bersama.

Baris baru mempunyai penanda `trace` dan data JSON. Contoh ilustrasi:

```text
[2026-10-09T00:00:00.104Z] WARN: [contoh-sesi] trace {"attempt":1,"event":"provider.closed","phase":"setup","code":1008,"reason":"Invalid configuration","seq":9,"session_id":"contoh-sesi","device_id":"contoh-perangkat","elapsed_ms":104}
```

| Kolom | Cara membacanya |
| --- | --- |
| `session_id`, `device_id` | Percakapan dan perangkat yang mengalami kejadian |
| `seq` | Urutan kejadian trace dalam sesi, mulai dari 1; filter `debug` dapat membuat nomor terlihat melompat |
| `elapsed_ms` | Waktu sejak koneksi perangkat, dalam milidetik; `1000` berarti satu detik |
| `attempt` | Percobaan koneksi AI; `0` berarti AI belum mulai disiapkan |
| `event` | Tahap yang terjadi; lihat tabel berikut |
| `phase` | `setup`: sesi AI belum siap; `ready`: AI sudah menerima konfigurasi |
| `code`, `reason`, `was_clean` | Kode, alasan, dan status penutupan koneksi dari provider/perangkat |
| `error` | Nama, pesan, stack trace, kode, dan penyebab error bila tersedia |

## Kejadian yang penting

| Kejadian | Makna |
| --- | --- |
| `session.configured` | Backend, timeout efektif, asal timeout perangkat/server, dan ambang deteksi suara |
| `device.heartbeat_started` / `device.heartbeat_timeout` | Ping WebSocket tiap 5 detik; 30 detik tanpa pong mengakhiri koneksi dan membersihkan sesi, termasuk saat timeout standby dimatikan |
| `device.heartbeat_error` | Ping gagal ditulis; sesi dibersihkan dengan alasan `device_heartbeat_send_failed` |
| `mcp.discovery_started` / `mcp.discovery_finished` | Lama penemuan tools dan hasil `completed`, `timeout`, `error`, `cancelled`, atau `backend_skipped` |
| `mcp.rpc_request` / `mcp.rpc_response` / `mcp.rpc_timeout` | Cocokkan `rpc_id` untuk melihat request mana yang lambat/gagal; timeout tool lama berarti belum ada konfirmasi, bukan bukti tool berhasil |
| `mcp.tools_available` / `mcp.endpoint_disconnected` | Discovery dan perubahan sambungan agent; `tools_apply_next_session` mempertahankan percakapan aktif dan memuat tools baru pada sesi berikutnya |
| `provider.connect_requested` | Model, suara, nama/jumlah tools, dan status transkripsi yang dipakai; isi prompt tidak dicatat |
| `gemini.tool_schema_prepared` | Nama dan indeks tools serta format schema yang dikirim; indeks mulai dari `0` dan cocok dengan `function_declarations[n]` pada error Gemini |
| `gemini.socket_open` | Jalur jaringan ke Gemini terbuka; sesi belum tentu diterima |
| `gemini.setup_accepted` / `provider.ready` | Gemini menerima konfigurasi dan perangkat dapat mulai mengirim audio |
| `gemini.setup_timeout` | Setup belum selesai setelah 20 detik; ini terpisah dari timeout diam perangkat |
| `gemini.audio_stream_ended` / `audio.input_ended` | Akhir audio telah dikirim setelah antrean mikrofon selesai, melalui `listen.stop` atau jeda stream 1,2 detik |
| `gemini.resumption_updated` / `gemini.go_away` | Checkpoint pemulihan tersedia atau Gemini meminta pergantian koneksi; token checkpoint tidak dicatat |
| `provider.resumption_rejected` | Checkpoint ditolak saat setup; percobaan berikutnya memakai sesi baru |
| `audio.udp_stats` / `audio.input_gap` | Paket UDP diterima, diurutkan, terlambat/duplikat, hilang, atau celah audio yang diisi keheningan |
| `audio.downlink_blocked` / `audio.downlink_recovered` | Antrean WebSocket keluar penuh lalu pulih; audio tidak terus ditambahkan ke socket yang macet |
| `audio.downlink_overflow` | Antrean suara mencapai batas; sesi ditutup dengan alasan `audio_backpressure` |
| `audio.first_packet` / `audio.speech_detected` | Audio perangkat masuk / level suara terdeteksi; bukan bukti ucapan berhasil dipahami |
| `audio.output_started` / `audio.playback_drained` | Respons AI mulai diterima / antrean server selesai dikirim; bukan konfirmasi fisik speaker |
| `tool.requested` / `tool.response_submitted` | Cocokkan `call_id` untuk melihat nama tool, jalur pemanggilan, lama proses, dan hasil gagal; argumen/isi hasil tidak disalin |
| `provider.error` / `provider.closed` | Error lengkap atau alasan koneksi AI berakhir, beserta percobaan dan tahapnya |
| `provider.retry_scheduled` / `provider.retry_skipped` | Mengapa server menyambung ulang atau menghentikan retry otomatis |
| `idle.hold` / `idle.release` / `idle.hold_expired` | Timer menunggu AI/audio/tool, melanjutkan hitungan, atau melepas penantian yang macet |
| `session.status` | Ringkasan setiap 15 detik: keadaan timer, provider, antrean, dan jumlah paket audio |
| `idle.timeout` / `session.standby` | Waktu diam tercapai dan alasan perangkat diarahkan ke standby |
| `session.close_requested` | Penutupan yang diminta pengaturan/revokasi, dengan alasan spesifik, sumber, dan konteks request dashboard |
| `session.teardown` / `device.disconnected` | Cleanup dan kode penutupan perangkat; perubahan pengaturan/shutdown server punya alasan sendiri |

Pada `session.status`, lihat `timeout_ms`, `idle_ms`, `remaining_ms`, `paused`,
dan `holds`. `hold_remaining_ms` menunjukkan batas tunggu tiap pekerjaan.
Misalnya timeout 60 detik tampil sebagai `60000`. Jika `paused=true`,
timer masih menunggu pekerjaan dalam `holds`; `remaining_ms` bukan hitungan
aktif selama penantian itu. Nilai `remaining_ms=null` berarti timeout dimatikan.
`heartbeat.last_pong_age_ms` menunjukkan waktu sejak pong terakhir (atau sejak
heartbeat dimulai jika belum ada pong). `heartbeat.pong_received` membedakan
dua keadaan itu. Pong memeriksa jaringan dan tidak mereset hitungan diam.
`buffer_dropped` menunjukkan paket PCM lama yang dibuang karena batas buffer
saat AI belum siap: maksimal 150 frame PCM 20 ms, dengan umur maksimal 3 detik.
`playback_underruns` menunjukkan antrean suara sempat kosong sebelum respons
selesai; `socket_buffered_bytes` menunjukkan data yang menunggu dikirim ke peer
WebSocket. Pada MQTT, peer tersebut adalah gateway, bukan speaker perangkat.
Ringkasan audio tidak menulis rekaman/base64, dan deteksi
suara dibatasi satu log per 10 detik agar tidak menumpuk setiap paket.

## Saat perangkat terlalu cepat standby

1. Pastikan `session.configured.idle_seconds` sesuai pengaturan, misalnya `60`.
2. Jika ada `provider.closed` sebelum `provider.ready`, baca `code` dan `reason`:
   kemungkinan kegagalan ada pada setup AI, bukan penghitung diam.
3. Jika ada `idle.timeout`, cocokkan `idle_ms` dan `timeout_ms`. Lihat apakah
   `audio.speech_detected` muncul setelah pengguna bicara.
4. Jika `device.disconnected` muncul tanpa `session.standby`, periksa kode
   penutupan perangkat, jaringan/gateway, atau perubahan pengaturan. Untuk MQTT,
   sertakan juga `docker compose logs --since=10m gateway`.

Jika ada `session.close_requested`, lihat `source`, `operation`, `request_id`,
`method`, dan `route`. Misalnya `voice_idle_setting_changed` menyertakan waktu
lama/baru; `memory_cleared` berarti hapus memori; `transport_changed` berarti
simpan transport; `agent_connection_revoked` berarti akses agent dicabut.
`source=dashboard_api` menunjukkan request dashboard yang menyebabkan penutupan.
Perubahan koneksi agent otomatis memakai `source=mcp_lifecycle` dan mempertahankan
percakapan, kecuali pencabutan akses yang memang harus mengakhiri sesi. Pada versi
sebelumnya semua jalur ini memakai alasan umum `device_settings_changed`, sehingga
log lama saja tidak dapat membedakan pemicunya.

## Log masih muncul setelah perangkat dimatikan

Jika `session.status` masih muncul, server belum mendeteksi sambungan putus.
Saat daya dicabut, perangkat mungkin tidak sempat menutup WebSocket. Pada versi
terbaru, `device.heartbeat_timeout` muncul setelah sekitar 30–35 detik tanpa pong,
diikuti cleanup dengan `server_reason=device_heartbeat_timeout`. Timer status,
timer diam, retry AI, dan antrean audio ikut dihentikan; koneksi AI ditutup.
Koneksi yang ditutup normal dibersihkan langsung melalui event `close`.

Nilai `timeout_ms=0`, `remaining_ms=null`, dan `stopped=false` berarti tracker
diam masih melekat pada sesi terbuka, tetapi timer standby tidak dijadwalkan.
`provider_ready=true` hanya menjelaskan sisi AI. Paket audio berjumlah `0`
juga dapat terjadi ketika pengguna belum berbicara; gunakan heartbeat atau
event penutupan untuk menilai koneksi. Jika menggunakan gateway MQTT, pong
menunjukkan gateway masih terhubung ke relay; gateway memeriksa sambungan
MQTT perangkat secara terpisah.

## Gemini menolak schema tool MCP

Jika log menunjukkan `code=1007`, `setup_accepted=false`, dan pesan seperti
`Unknown name "uniqueItems"` pada `function_declarations[7].parameters`,
Gemini menolak konfigurasi tool sebelum percakapan dimulai. Ini terpisah dari
timeout diam. Indeks `[7]` berarti tool kedelapan; cocokkan dengan urutan
`tool_names` di `provider.connect_requested`, atau `index` di
`gemini.tool_schema_prepared` pada versi terbaru.

Contoh dari tool Hermes: `hermes_reminder_create` menggunakan `uniqueItems`
untuk daftar yang tidak boleh berisi nilai berulang. Server kini mengirim schema
tool lewat `parametersJsonSchema`, sesuai
[adapter MCP SDK Google](https://github.com/googleapis/js-genai/blob/v1.45.0/src/_transformers.ts#L685-L707).
Schema asli tetap dipertahankan. Perubahan berlaku untuk tools agent, MCP
perangkat, dan tools bawaan sebelum dikirim ke Gemini.

Jika masih memakai image lama, perbarui image dan buat ulang container melalui
cara deployment biasa Anda, lalu buka percakapan baru. Cari
`gemini.tool_schema_prepared` dengan `schema_format=parametersJsonSchema`,
kemudian `gemini.setup_accepted` dan `provider.ready`. Format schema yang benar
belum menjamin setup berhasil jika ada penolakan lain; baca `reason` terbaru.

## Detail tambahan

Log lifecycle di atas aktif pada standar `LOG_LEVEL=info`. Untuk melihat pesan
kontrol tambahan dan jumlah karakter transkripsi, ubah `.env` menjadi:

```dotenv
LOG_LEVEL=debug
```

Terapkan dengan perintah `up -d` yang biasa Anda gunakan agar env container
diperbarui. `restart` saja tidak memuat perubahan `.env`. Kembalikan ke `info`
setelah selesai. Isi ucapan, prompt, notifikasi, argumen tool, dan hasil tool
tidak disalin oleh log trace; credential yang dikenal, Bearer token,
token query URL, dan field rahasia disamarkan. Tetap periksa log sebelum
mengirimnya karena log berisi ID perangkat, alamat jaringan, dan pesan dari
layanan luar. Jangan kirim `.env` atau teks konfigurasi agent yang berisi token.

## English quick reference

Filter relay logs by `session_id`; include the whole session from connection to
disconnect. `seq` orders events, `elapsed_ms` measures time since the device
connection, and `attempt` distinguishes AI reconnects. `gemini.socket_open` is
transport readiness; `provider.ready` means session setup was accepted.
An `Unknown name "uniqueItems"` setup rejection means a tool's JSON Schema was
sent through Gemini's restricted `parameters` field. The server now uses
`parametersJsonSchema`, preserving the original tool constraints. Update the
deployed image and start a new conversation; `gemini.tool_schema_prepared`
lists tool names, zero-based indexes, and schema formats without schema contents.
Voice WebSockets now ping every 5 seconds and clean up after 30 seconds without
a pong, independent of speech standby (`0` disables only speech standby).
`heartbeat.last_pong_age_ms` measures network liveness; MQTT device liveness is
checked separately by the gateway. Once teardown completes, session status
logging, provider connections and per-session timers stop.
`provider.closed` includes close code/reason and pending work. `session.status`
reports idle state and audio counters every 15 seconds. Lifecycle tracing is
enabled at `LOG_LEVEL=info`; `debug` adds control events and transcript character
counts without transcript text. The formatter preserves Error stacks/causes and
redacts known credentials and sensitive fields. These commands are instructions;
no local application, tests, build, or live provider was run to add this tracing.
