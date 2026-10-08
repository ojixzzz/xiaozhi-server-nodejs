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
| `mcp.discovery_started` / `mcp.discovery_finished` | Lama penemuan tools dan hasil `completed`, `timeout`, `error`, `cancelled`, atau `backend_skipped` |
| `mcp.rpc_request` / `mcp.rpc_response` / `mcp.rpc_timeout` | Cocokkan `rpc_id` untuk melihat request mana yang lambat/gagal; timeout tool lama berarti belum ada konfirmasi, bukan bukti tool berhasil |
| `provider.connect_requested` | Model, suara, nama/jumlah tools, dan status transkripsi yang dipakai; isi prompt tidak dicatat |
| `gemini.socket_open` | Jalur jaringan ke Gemini terbuka; sesi belum tentu diterima |
| `gemini.setup_accepted` / `provider.ready` | Gemini menerima konfigurasi dan perangkat dapat mulai mengirim audio |
| `gemini.setup_timeout` | Setup belum selesai setelah 20 detik; ini terpisah dari timeout diam perangkat |
| `audio.first_packet` / `audio.speech_detected` | Audio perangkat masuk / level suara terdeteksi; bukan bukti ucapan berhasil dipahami |
| `audio.output_started` / `audio.playback_drained` | Respons AI mulai diterima / antrean server selesai dikirim; bukan konfirmasi fisik speaker |
| `tool.requested` / `tool.response_submitted` | Cocokkan `call_id` untuk melihat nama tool, jalur pemanggilan, lama proses, dan hasil gagal; argumen/isi hasil tidak disalin |
| `provider.error` / `provider.closed` | Error lengkap atau alasan koneksi AI berakhir, beserta percobaan dan tahapnya |
| `provider.retry_scheduled` / `provider.retry_skipped` | Mengapa server menyambung ulang atau menghentikan retry otomatis |
| `idle.hold` / `idle.release` / `idle.hold_expired` | Timer menunggu AI/audio/tool, melanjutkan hitungan, atau melepas penantian yang macet |
| `session.status` | Ringkasan setiap 15 detik: keadaan timer, provider, antrean, dan jumlah paket audio |
| `idle.timeout` / `session.standby` | Waktu diam tercapai dan alasan perangkat diarahkan ke standby |
| `session.teardown` / `device.disconnected` | Cleanup dan kode penutupan perangkat; perubahan pengaturan/shutdown server punya alasan sendiri |

Pada `session.status`, lihat `timeout_ms`, `idle_ms`, `remaining_ms`, `paused`,
dan `holds`. `hold_remaining_ms` menunjukkan batas tunggu tiap pekerjaan.
Misalnya timeout 60 detik tampil sebagai `60000`. Jika `paused=true`,
timer masih menunggu pekerjaan dalam `holds`; `remaining_ms` bukan hitungan
aktif selama penantian itu. Nilai `remaining_ms=null` berarti timeout dimatikan.
`buffer_dropped` menunjukkan paket PCM lama yang dibuang karena batas buffer
saat AI belum siap. Ringkasan audio tidak menulis rekaman/base64, dan deteksi
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
`provider.closed` includes close code/reason and pending work. `session.status`
reports idle state and audio counters every 15 seconds. Lifecycle tracing is
enabled at `LOG_LEVEL=info`; `debug` adds control events and transcript character
counts without transcript text. The formatter preserves Error stacks/causes and
redacts known credentials and sensitive fields. These commands are instructions;
no local application, tests, build, or live provider was run to add this tracing.
