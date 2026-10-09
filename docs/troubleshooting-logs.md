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

Untuk pengingat ganda, cari `tool.requested` pada sesi saat membuat jadwal.
`source_tool` adalah nama asli tool agent, sedangkan `tool` dapat berupa alias
internal. Periksa apakah permintaan yang sama diteruskan melalui tool khusus
pengingat sekaligus tool agent umum. Bila hanya satu pemanggilan, lanjutkan
dengan log jadwal dan pengiriman di agent; lihat
[aturan satu pengingat](remote-mcp.md#satu-permintaan-pengingat-satu-notifikasi).

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
| `audio.input_summary` | Ringkasan celah audio dan statistik UDP tiap 5 detik selama ada aktivitas; menggantikan `audio.udp_stats` |
| `audio.input_gap` | Detail setiap celah, hanya pada `LOG_LEVEL=debug`; jumlah frame terlambat melewati batas tunggu dan frame yang diganti keheningan |
| `audio.udp_input_stalled` / `audio.udp_input_resumed` (gateway) | Belum ada audio diteruskan dalam 5 detik setelah `listen.start` / audio pertama akhirnya diteruskan |
| `audio.udp_unmatched` (gateway) | Ringkasan paket UDP dengan header tidak valid atau rute sesi tidak dikenal; mencakup seluruh gateway |
| `audio.udp_peer_bound` / `audio.udp_peer_changed` (gateway) | Alamat UDP pertama / perubahan tujuan balasan; perubahan diringkas maksimal satu log per 5 detik, total pada `peer_changes` |
| `audio.downlink_blocked` / `audio.downlink_recovered` | Antrean WebSocket keluar penuh lalu pulih; audio tidak terus ditambahkan ke socket yang macet |
| `audio.downlink_overflow` | Antrean suara mencapai batas; sesi ditutup dengan alasan `audio_backpressure` |
| `audio.first_packet` / `audio.activity_detected` | Audio perangkat masuk / energi audio melewati ambang adaptif; bukan bukti ucapan berhasil dipahami. Versi lama memakai nama `audio.speech_detected` |
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

## Tetap mendengarkan, tetapi audio masuk nol

Jika `provider.ready` sudah muncul, tetapi `input_packets=0` dan `pcm_frames=0`,
relay belum menerima audio mikrofon. Jika gateway juga melaporkan `received=0`,
belum ada paket masuk ke buffer pengurutan. Ini **belum membuktikan bahwa tidak
ada datagram mencapai gateway**: pemeriksaan header, sesi, dan alamat sumber
dilakukan sebelum counter `received` bertambah. Memperbesar buffer tidak
menyelesaikan jalur yang belum menerima paket.

Gateway menulis `audio.udp_input_stalled` satu kali jika belum ada audio yang
diteruskan selama 5 detik setelah `listen.start`. Log memuat `advertised_host`,
`advertised_port`, `mqtt_peer`, `udp_peer`, dan counter berikut. Pengamatan ini
berakhir setelah audio pertama diteruskan atau `listen.stop` diterima, agar
hening saat perangkat sedang memutar jawaban tidak dianggap gangguan baru.

| Field | Makna |
| --- | --- |
| `ingress_datagrams` | Datagram dengan ID rute sesi ini, dihitung sebelum validasi; ID ini belum membuktikan keaslian paket |
| `rejected_header` | Panjang, tipe, flags, atau panjang payload tidak sesuai format gateway |
| `rejected_state` | Sesi belum siap atau sudah tidak aktif |
| `rejected_source_ip` | IP sumber UDP berbeda dari IP koneksi MQTT pada mode `strict` |
| `rejected_endpoint` | Alamat/port UDP berubah pada mode `strict` atau `pinned` |
| `rejected_rate` | Laju melewati batas 200 datagram per detik per sesi |
| `rejected_sequence` | Nomor urutan nol, sebelum audio masuk buffer |
| `peer_changes` | Jumlah perubahan tujuan audio balasan pada mode `roaming` |

Counter juga tersedia di `audio.udp_session_closed` dan `audio.input_summary`.
Paket terlalu pendek untuk dibaca ID rutenya atau memakai rute yang tidak dikenal
masuk log `audio.udp_unmatched`, maksimal satu ringkasan per 5 detik jika ada
perubahan. Log ini berlingkup **seluruh gateway**, bukan bukti paket berasal dari
perangkat tertentu. Tidak ada audio, kunci AES, nonce, atau token yang dicatat.
Alamat jaringan dicatat untuk diagnosis; samarkan jika membagikan log publik.

Untuk perangkat yang mengakses IP VPS langsung:

1. Cocokkan `advertised_host` dengan IP/hostname VPS yang dapat dijangkau
   perangkat. Nilai `127.0.0.1`, nama service Docker, atau IP jaringan internal
   yang tidak terjangkau perangkat tidak cocok untuk alamat publik ini.
2. Cocokkan `advertised_port` (default **8884 UDP**) dengan port yang dipublikasikan
   Docker dan aturan firewall VPS/security group. MQTT TCP yang berhasil tidak
   membuktikan UDP sudah terbuka. Compose bawaan memakai `MQTT_BIND_ADDRESS`
   untuk kedua port; defaultnya `127.0.0.1`, sehingga binding aktual perlu dicek.
3. Saat pengguna berbicara, amati header paket di VPS (ganti port bila berbeda):

   ```sh
   sudo tcpdump -ni any -nn -q 'udp dst port 8884'
   ```

   Hentikan dengan Ctrl+C. Tidak ada paket saat berbicara mengarahkan pemeriksaan
   ke pengiriman perangkat, alamat tujuan, jaringan, atau firewall sebelum host.
   Paket terlihat pada VPS tetapi tidak pada gateway mengarahkan pemeriksaan ke
   firewall host dan pemetaan Docker. Satu paket dapat tampil pada beberapa
   interface; jangan menyamakan jumlah baris dengan jumlah audio.
4. Jika counter penolakan bertambah, gunakan alasan spesifiknya. Untuk penolakan
   karena IP TCP dan UDP berbeda, baca pengaturan berikut.

## IP MQTT dan UDP berbeda atau berubah

Jika `ingress_datagrams` terus naik tetapi seluruhnya masuk `rejected_source_ip`,
audio sudah sampai ke gateway dan ditolak pemeriksaan kesamaan IP. Contohnya,
koneksi MQTT terlihat dari `203.0.113.10` sedangkan UDP datang dari
`203.0.113.11`. Ini bisa terjadi pada jalur NAT atau jaringan dengan beberapa
alamat keluar; log tersebut sendiri tidak menentukan jenis jaringan ISP.
Menaikkan buffer atau membuka ulang port tidak mengatasi penolakan ini.

Gateway sekarang menggunakan **`roaming` sebagai bawaan**, sesuai kebutuhan
jaringan yang alamatnya berubah:

```dotenv
MQTT_UDP_SOURCE_POLICY=roaming
```

- IP MQTT dan UDP boleh berbeda.
- IP **dan port** UDP boleh berganti selama percakapan berlangsung.
- Balasan dikirim ke sumber paket dengan nomor urutan tertinggi yang diterima.
- Audio dari alamat lama yang datang terlambat tetap boleh mengisi celah buffer;
  paket itu tidak mengembalikan tujuan balasan ke alamat lama.
- Paket duplikat, nomor urutan nol, format salah, atau sesi tidak aktif tetap
  ditangani seperti sebelumnya. Sesi baru mendapatkan kunci dan rute baru.

`pinned` tersedia untuk mengunci alamat/port UDP pertama selama satu sesi.
`strict` menambahkan syarat IP UDP sama dengan MQTT, seperti perilaku lama.
Pilihan selain `roaming`, `pinned`, atau `strict` membuat gateway menolak startup.
Mode roaming melonggarkan pembatasan alamat sumber: protokol UDP lama tidak
memiliki authentication tag, sehingga ID rute dan dekripsi AES bukan bukti
identitas pengirim.

Gunakan image gateway yang memuat perubahan ini. Jika variabel belum ada,
bawaan baru langsung berlaku. Jika `.env` sudah menetapkan `strict` atau `pinned`,
ubah menjadi `roaming`, lalu buat ulang container gateway sesuai metode
deployment Anda. Startup harus menampilkan `UDP source policy roaming`.
Perubahan tidak perlu flashing firmware. Setelah pembaruan, buka percakapan
baru dan periksa `audio.udp_peer_bound`, `input_packets`, dan `pcm_frames`.
Perubahan alamat berikutnya dihitung pada `peer_changes`.

## Koneksi audio MQTT/UDP tidak stabil

Gateway menunggu paket yang tidak urut dengan batas adaptif **120 → 240 → 360 ms**.
Batas naik saat terjadi celah atau paket pengisi celah hampir terlambat, maksimal
satu kenaikan per detik. Setelah aliran stabil selama 10 detik dan setidaknya
32 paket berurutan diterima, batas turun satu langkah. Paket yang sudah urut
langsung diteruskan. Pengaturan ini otomatis, tanpa mengubah dashboard.

Saat perangkat mengirim `listen.stop`, gateway menunggu audio terakhir sesuai
batas tersebut, maksimal 360 ms sejak permintaan stop pertama. Setelah itu,
antrean diteruskan sebelum akhir ucapan dikirim ke relay. `listen.start` baru
membatalkan stop yang masih tertunda; penutupan sesi membersihkan kedua timer.

Pada level log biasa, celah dirangkum dalam `audio.input_summary` tiap 5 detik,
bukan satu peringatan untuk setiap paket. Ringkasan terakhir juga ditulis saat
sesi berakhir jika masih ada data yang belum dilaporkan. Jendela tanpa aktivitas
tidak menghasilkan ringkasan. Gunakan field berikut untuk membaca kondisinya:

| Field | Cara membaca |
| --- | --- |
| `missing_frames` / `missing_audio_ms` | Jumlah frame yang melewati batas tunggu dan durasi audio terkait dalam jendela ringkasan |
| `concealed_frames` / `concealed_audio_ms` | Bagian celah yang diganti keheningan; maksimal 5 frame per celah agar antrean tidak membengkak |
| `udp.wait_ms` | Batas tunggu saat statistik gateway diambil: 120, 240, atau 360 ms |
| `udp.missing` | Total frame yang melewati batas tunggu selama sesi, termasuk yang kemudian datang terlambat |
| `udp.late` | Paket unik yang akhirnya datang setelah celahnya sudah dilewati; tidak diputar ulang |
| `udp.unrecovered` | `missing - late`: frame yang belum terlihat kembali dalam riwayat pelacakan, bukan bukti semuanya hilang permanen |
| `udp.reordered` / `udp.recovered` | Paket datang tidak sesuai urutan / paket pengisi celah yang berhasil diterima sebelum celah dilewati |
| `udp.duplicates` | Paket yang sudah pernah diterima dan masih dikenali oleh riwayat pelacakan |
| `udp.after_stop` | Paket datang setelah akhir ucapan selesai diproses; terpisah dari `late` |
| `udp_delta` / `udp_age_ms` | Perubahan sejak statistik sebelumnya dilaporkan / umur statistik terakhir dari gateway |

Field di dalam `udp` bersifat kumulatif selama sesi, sedangkan field celah di
luarnya dihitung per jendela. Statistik gateway dikirim tiap 5 detik, sehingga
waktu pembaruannya tidak selalu persis sama dengan ringkasan relay. Riwayat
dibatasi 512 paket yang sudah diterima dan 128 rentang celah: paket lama yang
sudah tidak dapat diklasifikasikan masuk `udp.stale`, dan celah yang keluar dari
pelacakan dihitung pada `udp.untracked_missing`. `udp.max_reorder_wait_ms`+mencatat waktu tunggu terlama untuk paket pengisi celah yang berhasil diterima.

Contoh: `udp.missing=10`, `udp.late=8`, `udp.unrecovered=2` berarti delapan dari
sepuluh frame ternyata datang terlambat. Audio delapan frame itu tetap sudah
terlewat; buffer adaptif membantu mengurangi kejadian berikutnya. Jika celah
terus tinggi pada batas 360 ms, periksa Wi-Fi perangkat, jalur UDP, dan beban
gateway. Buffer tidak dapat mengembalikan data suara yang tidak sampai.

Untuk memakai perilaku ini, perbarui **relay XiaoZhi dan gateway** ke versi yang
sama. Gateway lama masih memakai batas tetap dan statistik yang lebih terbatas.

## Saat diam tetapi timer standby terus direset

Pada versi lama, noise di atas ambang tetap selama 120 ms dapat memicu
`audio.speech_detected`. Nama log itu tidak membuktikan pengguna berbicara.
Versi baru memakai `audio.activity_detected` dan ambang yang menyesuaikan noise
latar. Lihat `audio_activity` pada log aktivitas atau `session.status`:

- `rms`: level audio terakhir, setelah bias DC mikrofon dihilangkan.
- `noise_floor`: perkiraan level latar dari bagian 20% terbawah dalam dua detik audio.
- `threshold`: ambang efektif, nilai terbesar antara minimum konfigurasi dan 2,5 kali level latar.
- `calibrated`: minimal 0,5 detik audio sudah terkumpul untuk memperkirakan noise.

Noise stabil seharusnya berada di bawah `threshold` setelah kalibrasi. Noise
berubah-ubah, TV, atau suara orang lain masih bisa memicu aktivitas; detektor ini
bukan pengenal ucapan. `speech_frames` dipertahankan untuk kompatibilitas dan
menghitung frame yang lolos detektor energi, bukan kata yang dikenali. Penyesuaian
ini tidak membuang atau mengubah audio yang dikirim ke Gemini. Jika timer tetap
direset, periksa juga transkripsi AI serta `holds` untuk respons, playback, dan tool.

## Saat perangkat terlalu cepat standby

1. Pastikan `session.configured.idle_seconds` sesuai pengaturan, misalnya `60`.
2. Jika ada `provider.closed` sebelum `provider.ready`, baca `code` dan `reason`:
   kemungkinan kegagalan ada pada setup AI, bukan penghitung diam.
3. Jika ada `idle.timeout`, cocokkan `idle_ms` dan `timeout_ms`. Lihat apakah
   `audio.activity_detected` muncul setelah pengguna bicara.
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
When relay `input_packets` and gateway `received` both stay zero, no audio has
reached the reorder buffer; packets may still have been rejected before it.
`ingress_datagrams` and the `rejected_*` counters expose those early checks.
The gateway logs `audio.udp_input_stalled` once after five seconds without the
first forwarded packet following `listen.start`, with advertised UDP destination
and peer addresses. A subsequent first packet logs `audio.udp_input_resumed`.
The watch ends after that packet or `listen.stop`; it does not treat later DTX
or playback silence as a failure. `audio.udp_unmatched` aggregates malformed or
unknown-route traffic gateway-wide every five seconds when counters change.
These diagnostics report the selected peer policy and do not prove playback.
The default UDP source policy is now `roaming`: MQTT and UDP IPs can differ and
UDP IP/port changes are allowed mid-session. Downlink follows the highest accepted
sequence's source; delayed older packets can fill reorder holes without changing
that destination. `MQTT_UDP_SOURCE_POLICY=pinned` locks the first endpoint;
`strict` also enforces MQTT/UDP IP equality. Roaming removes that source-address
restriction; legacy AES-CTR UDP still has no sender authentication. Startup shows
the selected policy; `audio.udp_peer_bound`, `audio.udp_peer_changed` and
`peer_changes` expose actual destination changes. Recreate the gateway on the
updated image; no firmware modification is required for this policy.
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
MQTT/UDP reordering now uses an adaptive 120–360 ms deadline; contiguous audio
is forwarded immediately. Each ten stable seconds with at least 32 contiguous
arrivals lowers the deadline one step. Pending `listen.stop` follows that
deadline, capped at 360 ms from the first stop, and drains audio before ending
the stream. Update both relay and gateway for this behavior.
`audio.input_summary` aggregates gaps every 5 seconds; individual
`audio.input_gap` events require `LOG_LEVEL=debug`. `udp.missing` counts deadline
misses, `udp.late` counts unique later arrivals, and `udp.unrecovered` is their
difference, subject to bounded history. These are not proof of permanent packet
loss. `udp_delta` contains changes since the previous reported snapshot and
`udp_age_ms` gives its age. The relay inserts at most five silent frames per gap;
missing-frame counters still report the full gap. All summary timers stop at
teardown, with one final partial summary if needed.
`provider.closed` includes close code/reason and pending work. `session.status`
reports idle state and audio counters every 15 seconds. Lifecycle tracing is
enabled at `LOG_LEVEL=info`; `debug` adds control events and transcript character
counts without transcript text. The formatter preserves Error stacks/causes and
redacts known credentials and sensitive fields. These commands are instructions;
no local application, tests, build, or live provider was run to add this tracing.
