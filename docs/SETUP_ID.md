# Panduan siap dijalankan: memori Gemini dan inbox notifikasi Xiaozhi

Alur utamanya: **Hermes/agen yang diizinkan mengirim teks → teks disimpan →
Xiaozhi berbunyi beep bila memungkinkan → Anda bertanya “notifnya apa?” → Gemini
mengambil isi notifikasi yang tersimpan.** Isi pesan tidak langsung dibacakan
secara otomatis.

Paket ini berisi relay, dashboard, memori percakapan SQLite, inbox notifikasi
SQLite terpisah, gateway MQTT/UDP, dan audio beep uji. Anda tidak perlu memasang
Redis, broker MQTT tambahan, atau menulis adapter gateway sendiri.

**Mulai dari satu perangkat uji.** Docker, panggilan Gemini langsung, firmware
perangkat Anda, serta pemutaran pada ESP32 belum diuji di lingkungan pengerjaan
ini. Sambungan ke Hermes sungguhan juga belum dikonfigurasi atau diuji. Tes
protokol lokal menggunakan provider palsu. Ikuti pemeriksaan di bawah
sebelum memindahkan perangkat utama; hasil tes terbaru ada di
[TEST_RESULTS.md](../TEST_RESULTS.md).

Audit source memakai firmware commit `0d576d3d4c049c6f55eaf879725dc23e516511b4`;
ini bukan bukti versi yang sedang terpasang pada perangkat Anda. Lihat
[matriks kompatibilitas](firmware-compatibility.md) untuk bukti protokol, parser
audio asli firmware, koreksi satuan waktu OTA, dan batas pengujiannya.

## 1. Siapkan kebutuhan dan jalur kembali

- Komputer/server dengan Docker Engine dan Docker Compose yang sudah terpasang
- Satu perangkat Xiaozhi milik Anda dengan firmware yang mendukung MQTT/UDP dan
  pesan `notify`. Versi firmware Anda belum diketahui; periksa dukungannya di
  [dokumentasi resmi](https://github.com/78/xiaozhi-esp32/blob/main/docs/notify.md).
  Panduan ini tidak melakukan flashing firmware
- Koneksi internet server dan API key Gemini milik Anda untuk percakapan langsung;
  biaya penggunaan provider tetap mengikuti akun Anda
- IP LAN server yang tetap, misalnya `192.168.1.50`, dan perangkat pada jaringan
  privat tepercaya yang bisa menjangkau server
- Password admin unik minimal 12 karakter, serta dua secret berbeda dengan
  entropi tinggi, masing-masing minimal 32 karakter untuk `MQTT_SIGNATURE_KEY` dan
  `MQTT_GATEWAY_KEY`. Sediakan sendiri melalui pengelola secret/password Anda.
  Jangan kirim nilainya ke chat atau commit ke Git

Sebelum mengubah perangkat, simpan URL OTA lama, alamat WebSocket lama, konfigurasi
server yang masih bekerja, dan cadangan data privat. Untuk database SQLite, pakai
cadangan yang konsisten atau hentikan layanan secara bersih lebih dulu; jangan
hanya menyalin `memory.sqlite` ketika masih aktif. Jangan menjalankan dua relay
pada direktori data yang sama. Bila ini migrasi server lama, baca bagian
[persistensi dan migrasi](docker.md#persistent-data-and-migration) terlebih dahulu.

## 2. Isi konfigurasi uji LAN

Contoh berikut sengaja memakai HTTP dan MQTT tanpa TLS untuk uji terbatas di LAN
tepercaya. **Jangan buka port ini ke internet, jaringan umum, atau Wi-Fi tamu.**
HTTP/MQTT tanpa TLS dapat membocorkan password, kredensial, tautan audio dan isi
komunikasi kepada pengamat jaringan. Untuk penggunaan di luar LAN tepercaya,
langsung ikuti bagian [TLS](#8-tls-dan-batas-penerapan-produksi).

Di root checkout ini:

```sh
# Hanya untuk instalasi baru; tidak menimpa .env yang sudah ada.
test -e .env || cp .env.mqtt.example .env
```

Jika `.env` sudah ada, gabungkan pengaturan MQTT/audio dari template secara
manual. Pertahankan key Gemini, token perangkat, dan pengaturan server lama yang
masih diperlukan. Edit `.env` secara lokal:

1. Ganti semua `192.168.1.50` dengan IP LAN server Anda
2. Isi `GEMINI_API_KEY`, `ADMIN_PASSWORD`, dan `CLIENT_AUTH_TOKEN` milik Anda.
   `CLIENT_AUTH_TOKEN` adalah fallback lama; memori dan MQTT memerlukan token
   khusus per perangkat, bukan token bersama tersebut
3. Isi **dua secret berbeda** pada `MQTT_SIGNATURE_KEY` dan `MQTT_GATEWAY_KEY`.
   Nilai contoh `REPLACE_ME...` sengaja ditolak
4. Pastikan blok berikut sesuai; jangan menambahkan `mqtt://` pada endpoint

```dotenv
LLM_BACKEND=gemini
WEB_BIND_ADDRESS=192.168.1.50
WEB_PORT=3000
WEBSOCKET_URL_FOR_ALLOWED_DEVICE=ws://192.168.1.50:3000/xiaozhi/v1/
COOKIE_SECURE=false
DEVICE_TIMEZONE_OFFSET_MINUTES=420

MQTT_ENABLED=true
MQTT_BIND_ADDRESS=192.168.1.50
MQTT_ENDPOINT=192.168.1.50:1883
MQTT_PUBLIC_HOST=192.168.1.50
MQTT_PORT=1883
MQTT_UDP_PORT=8884
MQTT_ALLOW_INSECURE=true
MQTT_TLS_CERT_FILE=
MQTT_TLS_KEY_FILE=

NOTIFY_ENABLED=true
NOTIFY_ALLOW_HTTP=true
NOTIFY_AUDIO_BASE_URL=http://192.168.1.50:3000
NOTIFY_ALLOWED_AUDIO_ORIGINS=http://192.168.1.50:3000
MQTT_AUDIO_ALLOWED_ORIGINS=http://192.168.1.50:3000
NOTIFY_TIMEOUT_MS=5000
NOTIFY_BEEP_ASSET=sample-chime.ogg

MEMORY_CONTEXT_MAX_CHARS=6000
MEMORY_MAX_TURNS=8
MEMORY_TURN_MAX_CHARS=1200
```

`DEVICE_TIMEZONE_OFFSET_MINUTES` memakai **menit**, bukan detik. Default paket
adalah `420` (WIB/UTC+7), bukan hasil deteksi lokasi Anda. Ganti sesuai kebutuhan,
misalnya `0` untuk UTC atau `480` untuk UTC+8; rentang valid -720 sampai 840.
Timestamp OTA tetap UTC dalam milidetik. Offset ini statis, bukan pengaturan
zona IANA/DST otomatis.

`NOTIFY_AUDIO_BASE_URL` harus berupa origin saja: skema, host, dan port; tanpa
path atau trailing parameter. Ketiga origin audio harus sama untuk contoh ini.
Alamat `localhost`, `127.0.0.1`, `xiaozhi`, dan `gateway` bukan alamat yang bisa
dipakai ESP32 untuk menghubungi server.

Compose otomatis memakai alamat internal berikut. Nilai loopback dalam template
berfungsi untuk proses Node native dan ditimpa oleh Compose:

- Relay → gateway: `http://gateway:3001`
- Gateway → registry: `http://xiaozhi:3000/internal/mqtt/devices/`
- Gateway → percakapan: `ws://xiaozhi:3000/xiaozhi/v1/`

Biarkan `NOTIFY_ADAPTER_MODULE` dan `NOTIFY_CLIENT_IDS_JSON` tidak diisi untuk
jalur bawaan ini. Tidak perlu mengarang client ID MQTT atau menambahkan Redis.

## 3. Jalankan dua layanan

```sh
docker compose --profile mqtt config --quiet
docker compose --profile mqtt up -d --build
docker compose --profile mqtt ps
curl --fail http://192.168.1.50:3000/health
docker compose --profile mqtt logs --tail=50 xiaozhi gateway
```

Ganti IP pada perintah `curl` juga. `config --quiet` memeriksa Compose tanpa
mencetak konfigurasi lengkap yang dapat memuat secret. Pastikan layanan `xiaozhi`
dan `gateway` berjalan dan pemeriksaan health menjadi `healthy`. Health hanya
memeriksa proses/listener; ini belum membuktikan koneksi Gemini atau perangkat.

Layanan web tersedia pada TCP 3000, MQTT LAN pada TCP 1883, dan audio percakapan
pada UDP 8884. Jika ada firewall yang sudah Anda kelola, pastikan aturan yang
sesuai mengizinkan perangkat uji ke port tersebut. Jangan meneruskan port 3001
ke jaringan publik; API gateway hanya untuk koneksi antar-container.

## 4. Pastikan percakapan WebSocket biasa bekerja dahulu

1. Buka `http://192.168.1.50:3000` dari komputer Anda dan login dengan password
   admin yang tadi Anda isi
2. Untuk perangkat baru/server baru, arahkan URL OTA melalui mekanisme konfigurasi
   firmware/perangkat Anda ke `http://192.168.1.50:3000/xiaozhi/ota/`. Catat URL
   sebelumnya. Letak pengaturan berbeda menurut board dan firmware; jangan
   mem-flash firmware hanya untuk menebak langkah ini
3. Nyalakan/reboot satu perangkat uji agar muncul di daftar. Cocokkan alamat
   perangkat yang benar, lalu klik **Approve**
4. Biarkan **Connection transport** tetap **WebSocket (default)**. Reboot/fetch OTA
   lagi setelah persetujuan bila diperlukan, lalu uji satu percakapan Gemini
5. Jika model/voice bawaan sudah tidak tersedia pada akun Anda, pilih model/voice
   yang tersedia melalui konfigurasi provider sebelum melanjutkan

Jangan lanjut ke MQTT jika percakapan biasa belum berhasil. Saat perangkat
terdaftar melalui OTA, relay menyimpan token per perangkat. Perangkat lama yang
menggunakan token bersama mungkin membutuhkan provisioning yang benar; jangan
menghapus record atau mengganti token perangkat utama sembarangan.

## 5. Aktifkan memori bila semua pengguna perangkat setuju

1. Buka **Memory & Notify** pada perangkat yang sudah approved
2. Centang **Enable shared memory for this device**
3. Bila perlu tambahkan fakta uji yang tidak sensitif, satu per baris, lalu klik
   **Save memory**
4. Akhiri sesi dan mulai koneksi Gemini baru. Lakukan percakapan pendek sampai
   jawaban selesai, lalu klik **Refresh memory** untuk melihat giliran tersimpan
5. Mulai koneksi baru lagi untuk memeriksa penggunaan konteks yang disimpan

Memori ini milik **perangkat**, sehingga dipakai bersama semua orang yang
menggunakannya. Ini bukan pengenalan identitas pembicara. Memori menyimpan teks
percakapan Gemini yang selesai, bukan audio; teks tersimpan dikirim sebagai
konteks ke Gemini pada koneksi berikutnya. Jangan mendiktekan secret.

Batas default adalah 6.000 karakter untuk seluruh bagian memori yang disisipkan,
8 giliran lengkap, dan 1.200 karakter per sisi giliran. Ini bukan batas token
persis dan bukan batas total konteks sesi Gemini. Retensi teks 30 hari. Memori
dapat dipakai melalui WebSocket maupun MQTT. Rincian privasi dan penghapusan ada
di [docs/memory.md](memory.md).

Untuk menghapus, ketik alamat perangkat persis di **Forget memory** dan konfirmasi.
Ini menutup sesi aktif; pengaturan enabled tetap sama. Untuk menghentikan
penyimpanan sekaligus menghapus isinya, matikan centang lalu **Save memory**.

## 6. Pindahkan satu perangkat ke MQTT dan uji percakapan

1. Di **Memory & Notify**, klik **Refresh connection setup**. Status harus
   menyatakan konfigurasi gateway tersedia. Ini hanya pemeriksaan konfigurasi,
   bukan bukti perangkat sedang online
2. Pilih **MQTT gateway** pada **Connection transport**, klik **Save transport**,
   lalu konfirmasi perangkat yang dipilih
3. Reboot perangkat atau minta perangkat mengambil OTA lagi. Pengaturan dashboard
   tidak melakukan reboot sendiri. Relay mengirim client ID dan kredensial MQTT
   bertanda tangan untuk perangkat yang disetujui
4. Setelah perangkat tersambung, bangunkan dan lakukan percakapan dua arah lagi.
   Anda harus mendengar jawaban sebelum menguji notifikasi idle

Jika penyimpanan transport ditolak karena UUID/token, kembalilah ke koneksi
WebSocket yang bekerja dan sambungkan perangkat melalui provisioning aslinya.
Jangan mengisi UUID atau client ID secara acak. Bila perangkat utama terganggu,
pakai [rollback](#9-rollback-ke-websocket) sebelum melanjutkan diagnosis.

## 7. Uji inbox dari web dahulu; Hermes opsional

Anda dapat menguji alur lengkap **tanpa Hermes dan tanpa token pengirim eksternal**.
Biarkan `NOTIFY_SENDERS_JSON=[]` untuk tahap ini:

1. Login dashboard, pilih perangkat approved, lalu buka **Memory & Notify**
2. Di **Test message & beep**, isi judul opsional dan pesan uji seperti
   “Tes dari dashboard: laporan sudah selesai”
3. Klik **Save message & beep** satu kali. Periksa **penyimpanan pesan** dan
   **hasil beep** secara terpisah. Pesan disimpan lebih dulu, meskipun beep gagal
4. Di **Notification inbox**, gunakan **All messages** atau **Unread only**,
   **Previous page / Next page**, lalu buka pesan untuk membaca detail dan statusnya
5. Selama unread, beep dicoba lagi tiap 60 detik; percakapan aktif menundanya.
   Bangunkan perangkat lalu katakan “halo”, “apa”, “ada apa”, atau “notifnya apa?”.
   Gemini menyebutkan judul dulu dan menawarkan detail. Judul yang disebutkan dalam
   respons audio selesai ditandai read. Minta detail untuk mendengar isi pesan.
   Membuka koneksi atau pesan di dashboard dan mendengar beep saja tidak menandai read.
6. Bila beep terlewat, buka pesan yang sama dan klik **Retry beep only** lalu
   konfirmasi. Ini tidak membuat pesan inbox baru dan tidak mengubah read/unread.
   Jika percobaan sebelumnya berstatus unknown, bunyi ganda tetap mungkin terjadi
7. Bila respons penyimpanan terputus, ulangi permintaan yang sama; dashboard
   mempertahankan request ID. Gunakan **Start a new message** hanya untuk pesan baru

Penyimpanan pesan tetap dapat diuji saat MQTT mati/perangkat offline; beep
memerlukan gateway aktif, perangkat MQTT tersambung dan idle, serta firmware
notify. Panel **Audio-only test (no inbox message)** berbeda: tombol audio lama
hanya menguji rekaman dan tidak membuat teks untuk ditanyakan kemudian.

Pengaturan sender/secret dan batas numerik tetap di konfigurasi server. Dashboard
menampilkan batas dan status, tetapi tidak membuat/mengungkap secret. Tidak ada
penghapusan pesan satu per satu di panel ini; retensi inbox tetap berlaku.

### Pengirim eksternal opsional: HTTP atau MCP

Setelah tes web berhasil, Hermes, aplikasi lain, atau skrip yang Anda izinkan
boleh mengirim melalui HTTP/MCP berikut. Tidak ada ketergantungan wajib pada Hermes.

### A. Izinkan satu pengirim untuk perangkat uji

Setelah alamat perangkat approved diketahui, tambahkan konfigurasi berikut ke
`.env`. Ganti MAC contoh dengan alamat persis di dashboard:

```dotenv
NOTIFY_SENDERS_JSON=[{"name":"hermes","token_env":"HERMES_NOTIFY_TOKEN","device_ids":["aa:bb:cc:dd:ee:ff"]}]
HERMES_NOTIFY_TOKEN=
NOTIFY_BEEP_ASSET=sample-chime.ogg
```

Isi `HERMES_NOTIFY_TOKEN` dengan secret kuat milik operator, minimal 32 karakter,
yang berbeda dari password admin dan kedua key gateway. Jangan memakai token
perangkat atau Gemini API key sebagai token pengirim. Token pengirim hanya
mengizinkan pengiriman ke alamat perangkat dalam allowlist-nya; jangan memberikan
key gateway kepada Hermes.

Terapkan perubahan:

```sh
docker compose --profile mqtt up -d --build
```

Konfigurasi ini menyiapkan penerimaan pada relay, **belum menyambungkan aplikasi
Hermes Anda**. Ikuti [docs/hermes-mcp.md](hermes-mcp.md) untuk payload HTTP, autentikasi,
endpoint MCP dan contoh permintaan yang cocok dengan implementasi. Tujuannya:

- HTTP: `POST /api/notifications`
- Stateless MCP: `POST /mcp/notifications`

Keduanya memakai token pengirim yang Anda izinkan, bukan sesi admin dashboard.
MCP menyediakan tool `notify_send`; payload pengirim menggunakan `device_id`,
`text`, `idempotency_key`, dan `title` opsional. Batasnya 2.000 karakter teks dan
120 karakter judul. Gunakan key idempotensi yang sama saat mengulang pesan yang
hasil HTTP-nya belum pasti; jangan mengganti key hanya untuk melewati deduplikasi.
Daftar pengirim kosong (`NOTIFY_SENDERS_JSON=[]`) menonaktifkan ingress eksternal.
Gunakan alamat server yang dapat dijangkau agen. Untuk pengirim di luar LAN
tepercaya, gunakan HTTPS yang valid. Detail cara mendaftarkan tool/server MCP
pada aplikasi agen bergantung pada klien dan versinya; jangan menganggap contoh
relay otomatis mengubah konfigurasi Hermes eksternal.

**Khusus Spotpear 1.28 Box pada source yang diaudit:** mode baterai dapat
menidurkan/mematikan board setelah sekitar 290 detik idle bila timer hemat daya
aktif. Saat charging, source menonaktifkan timer tersebut. Untuk uji notifikasi
standby yang lama, pastikan perangkat ditenagai/charging dan benar-benar tetap
online. MQTT tidak dapat membangunkan perangkat mati/deep sleep. Paket ini tidak
mengubah kebijakan daya atau melakukan flashing; pesan teks tetap tersimpan jika
beep gagal, lalu bisa ditanyakan setelah perangkat aktif lagi.

### B. Uji alur lengkap dengan pesan tidak sensitif

1. Pastikan satu perangkat MQTT tersambung dan idle
2. Kirim teks uji, misalnya “Tes inbox: laporan uji sudah selesai”, melalui salah
   satu antarmuka pengirim sesuai contoh di [hermes-mcp.md](hermes-mcp.md)
3. Periksa hasil penyimpanan teks secara terpisah dari hasil pengiriman beep
4. Dengarkan perangkat: `sample-chime.ogg` hanya nada uji satu detik, bukan ucapan.
   Ini tanda bahwa ada notifikasi; isi teks tidak disuarakan otomatis
5. Bangunkan perangkat dan katakan “halo”, “apa”, “ada apa”, atau “notifnya apa?”.
   Gemini mengambil judul notifikasi untuk perangkat itu lalu menawarkan detail.
   Isi pesan baru diambil bila Anda meminta detail
6. Beep, list biasa, atau get tetap tidak mengubah read. Judul yang terucap pada
   respons audio selesai ditandai read dan pengingatnya berhenti. Jika respons
   dibatalkan, judul belum terucap atau masih ada judul lain, pesan tersebut tetap unread
7. Untuk memeriksa persistensi, restart relay lalu tanyakan lagi. Uji juga mengirim
   teks ketika perangkat offline, lalu sambungkan kembali dan minta isinya

Tool Gemini bernama `notifications_announce`, `notifications_list`, `notifications_get`, dan
`notifications_mark_read`. Tool terikat ke perangkat yang terautentikasi; agen
tidak memilih device ID lain melalui argumennya. Ini memerlukan backend Gemini
dan token khusus per perangkat. Daftar default hanya menampilkan pesan unread;
untuk mengecek pesan yang sudah read, mintalah secara jelas agar pesan read juga
ditampilkan. Pengambilan inbox tetap tersedia melalui percakapan WebSocket;
MQTT dibutuhkan untuk beep idle, bukan untuk menyimpan teks atau menanyakannya.

Pengingat defaultnya `NOTIFY_REMINDER_INTERVAL_MS=60000` (milidetik). Ubah interval
di `.env` lalu recreate service relay; `0` mematikan pengingat. Satu perangkat
mendapat paling banyak satu beep per interval, meskipun memiliki beberapa pesan
unread. Pengingat pulih dari SQLite setelah restart, berhenti setelah semua pesan
read atau kedaluwarsa, dan ditunda selama percakapan aktif. Hasil published/unknown
tidak membuktikan audio terdengar; pengingat berikutnya bisa mengulang beep yang
sebelumnya sebenarnya sudah berbunyi.

Inbox berada di `DATA_DIR/notifications.sqlite`, terpisah dari `memory.sqlite`.
Defaultnya menyimpan paling banyak 100 record per perangkat dengan retensi 30
hari sejak diterima server, termasuk pesan unread. Ketika penuh, pesan baru
ditolak tanpa disimpan atau dibunyikan; record yang belum kedaluwarsa tidak
diam-diam digusur, termasuk yang sudah read. Mematikan memori percakapan tidak
otomatis mematikan inbox. Perangkat yang
sibuk/offline dapat melewatkan beep tetapi teks tetap tersimpan sesuai batas
retensi. Tidak ada antrean untuk memutar ulang beep otomatis saat perangkat online.
Menandai read tidak sama dengan menghapus record; menghapus memori percakapan
juga tidak menghapus inbox. Lihat [docs/inbox.md](inbox.md) untuk batas, status,
retensi dan batas dukungan penghapusan.

Notifikasi juga milik perangkat dan dapat diakses orang yang memakai perangkat
itu; ini bukan kotak masuk pribadi yang mengenali suara pemilik. Isi notifikasi
akan masuk ke Gemini ketika diambil untuk menjawab. Perlakukan teks kiriman
agen sebagai informasi, bukan perintah tepercaya untuk melakukan aksi lain.
Jika memori percakapan aktif, giliran Gemini yang membahas isi inbox juga dapat
tersimpan sebagai percakapan sesuai batas memori; kedua database tetap terpisah.

### C. Bila perlu, uji jalur audio secara terpisah

Panel **Memory & Notify** tetap menyediakan uji audio manual:

1. Pilih **sample-chime.ogg** di **Local prerecorded audio**
2. Klik **Use local audio** untuk membuat tautan lima menit; ini belum mengirim
3. Klik **Send notification** sekali saat perangkat idle, lalu dengarkan langsung

Pengiriman audio manual ini menguji jalur beep, bukan membuat pesan teks inbox.
Subtitle pada panel hanya teks layar dan tidak menghasilkan ucapan. Untuk audio
manual berupa ucapan, pasang rekaman mono Ogg Opus yang berisi kata-kata tersebut;
lihat [panduan audio](../notification-audio/README.md). Alur teks-inbox tidak perlu
rekaman ucapan atau layanan TTS. Paket ini belum memiliki penjadwal pengingat.

Arti hasil audio:

- `published`: gateway melaporkan penulisan pesan ke koneksi MQTT; belum membuktikan
  pemutaran atau bahwa seseorang mendengarnya
- `not_published`: tidak diteruskan menurut hasil gateway/deadline lokal
- `unknown`: hasil tidak pasti, misalnya timeout. Jangan mengirim berulang kali
  dengan request baru karena bunyi dapat terduplikasi

Status audio tidak menandai teks sudah dibaca dan tidak mengubah hasil penyimpanan
inbox. Tautan kedaluwarsa harus dibuat ulang untuk uji manual; siapa pun yang
memiliki tautan dapat mengunduh rekaman selama masih berlaku. Jangan membagikan
atau mencatat query string-nya ke log publik.

## 8. TLS dan batas penerapan produksi

**Jika server berada di VPS:** jangan menganggap paket ini aman untuk UDP publik hanya karena MQTT memakai TLS. Jalur audio firmware stock memiliki batas integritas dan kerahasiaan. Gunakan jalur jaringan privat tepercaya yang sudah Anda kelola dan uji, bukan membuka UDP ke semua internet. Menyiapkan tunnel/VPN atau mengubah jaringan tidak dilakukan oleh paket ini. Bila jalur privat belum tersedia, pertahankan WebSocket yang sudah bekerja; inbox teks tetap bisa dipakai, tetapi beep standby MQTT belum dapat dijanjikan.

Lakukan ini setelah uji satu perangkat berhasil dan Anda memiliki domain,
sertifikat valid, serta konfigurasi jaringan yang sesuai. Dukungan CA/hostname
harus cocok dengan firmware. Jangan menonaktifkan validasi sertifikat atau
mengandalkan sertifikat self-signed yang tidak dipercaya perangkat.

1. Letakkan sertifikat rantai lengkap milik Anda pada `certs/fullchain.pem` dan
   private key pada `certs/privkey.pem`. Compose memasangnya read-only di
   `/run/mqtt-tls/`. Pastikan user container UID 1000 dapat membacanya melalui
   akses minimum yang sesuai; jangan membuat private key dapat dibaca semua orang
2. Gunakan port publik MQTT **8883**. Firmware stock memilih TLS berdasarkan
   port ini; mengganti ke port luar lain dapat membuat perangkat memakai plaintext
3. Ubah pengaturan MQTT berikut dengan hostname sertifikat Anda

```dotenv
MQTT_ENDPOINT=mqtt.example.com:8883
MQTT_PUBLIC_HOST=mqtt.example.com
MQTT_PORT=8883
MQTT_UDP_PORT=8884
MQTT_ALLOW_INSECURE=false
MQTT_TLS_CERT_FILE=/run/mqtt-tls/fullchain.pem
MQTT_TLS_KEY_FILE=/run/mqtt-tls/privkey.pem
```

4. Set `MQTT_BIND_ADDRESS` ke alamat interface server yang benar. Publikasikan
   TCP 8883 dan UDP 8884 melalui konfigurasi jaringan Anda. Pertahankan nomor port
   UDP yang sama dari perangkat sampai gateway. Proxy TCP yang mengubah alamat
   sumber sementara UDP datang langsung tidak cocok dengan pencocokan alamat
   peer pada bridge ini; gunakan jalur yang mempertahankan alamat sumber konsisten.
   Batasi jalur UDP ke jaringan/perangkat tepercaya; TLS MQTT tidak mengamankannya
5. Sediakan HTTPS untuk relay/audio melalui reverse proxy tepercaya. Misalnya:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=3000
WEBSOCKET_URL_FOR_ALLOWED_DEVICE=wss://relay.example.com/xiaozhi/v1/
NOTIFY_AUDIO_BASE_URL=https://relay.example.com
NOTIFY_ALLOWED_AUDIO_ORIGINS=https://relay.example.com
MQTT_AUDIO_ALLOWED_ORIGINS=https://relay.example.com
NOTIFY_ALLOW_HTTP=false
COOKIE_SECURE=true
```

   Pastikan proxy meneruskan upgrade WebSocket, OTA dan unduhan audio tanpa
   redirect. Blok akses publik ke `/internal/mqtt/` dan batasi akses dashboard.
   Set `TRUST_PROXY` ke IP/CIDR peer proxy yang benar-benar dipercaya setelah
   memeriksa alamat sumber yang dilihat container. Misalnya `loopback` hanya
   cocok bila koneksi proxy memang datang dari loopback; proxy pada host Docker
   dapat terlihat sebagai IP bridge. Jangan menyalin subnet contoh tanpa verifikasi.
   Nilai bawaan tidak mempercayai proxy; `true`, jumlah hop, dan jaringan yang
   mempercayai semua alamat ditolak. Tanpa trust proxy yang benar, login dengan
   `COOKIE_SECURE=true` di belakang terminasi HTTPS dapat gagal menyimpan cookie.
   Konfigurasi proxy dan sertifikat web tidak disediakan otomatis oleh Compose
6. Arahkan OTA perangkat ke `https://relay.example.com/xiaozhi/ota/`, dengan
   hostname yang benar-benar Anda kelola. Terapkan perubahan environment dengan
   `docker compose --profile mqtt up -d --build`, lalu reboot/fetch OTA perangkat
7. Ulangi pemeriksaan percakapan biasa, percakapan MQTT, unduhan audio dan bunyi
   idle pada satu perangkat sebelum memindahkan yang lain

Jangan memakai hostname contoh secara literal. TLS MQTT tidak sekaligus
mengaktifkan HTTPS pada port web. Pada gateway ini audio percakapan memakai
format UDP terenkripsi Xiaozhi; jangan menganggapnya sebagai TLS untuk semua
jalur komunikasi.
Format UDP AES-CTR yang mengikuti protokol firmware tidak menyediakan autentikasi
integritas paket setara TLS; kerahasiaannya juga bergantung pada perilaku nonce
firmware. Gunakan jaringan tepercaya dan pembatasan akses, bukan asumsi bahwa
port UDP yang terbuka ke internet menjadi aman karena MQTT memakai TLS.

## 9. Rollback ke WebSocket

1. Buka perangkat di **Memory & Notify**
2. Pilih **WebSocket (default)** lalu **Save transport**
3. Reboot/fetch OTA perangkat dan uji kembali percakapan biasa
4. Jika sebelumnya mengganti host server/URL OTA, pulihkan URL/config lama yang
   Anda simpan sesuai kebutuhan
5. Setelah semua perangkat yang perlu dikembalikan bekerja, Anda dapat mematikan
   jalur MQTT/beep dengan `MQTT_ENABLED=false` dan `NOTIFY_ENABLED=false`, lalu
   menerapkan ulang konfigurasi relay. Hentikan gateway bila tidak lagi dipakai

Mengubah `MQTT_ENABLED` saja tidak otomatis mengubah pilihan transport perangkat.
Rollback ini tidak menghapus inbox atau menonaktifkan pengiriman teks. Jika ingin
menolak pesan baru dari semua agen, set `NOTIFY_SENDERS_JSON=[]` dan terapkan
ulang konfigurasi; pesan yang sudah tersimpan tetap mengikuti retensinya.
Jangan menghapus volume untuk rollback. `docker compose down` mempertahankan
volume; **jangan menambahkan `-v`** pada data sungguhan tanpa keputusan penghapusan
serta cadangan yang sudah diperiksa.

## 10. Jika belum berhasil

- **Dashboard tidak terbuka:** periksa IP, `WEB_BIND_ADDRESS`, port host, status
  container, serta jalur jaringan dari komputer Anda
- **MQTT tidak configured:** periksa dua secret berbeda, placeholder, endpoint
  tanpa skema, sertifikat/TLS atau opt-in LAN. Baca alasan di panel setup
- **Perangkat tidak berpindah:** transport disimpan per perangkat; reboot/fetch
  OTA dan periksa bahwa URL OTA menuju relay yang benar
- **Percakapan MQTT gagal tetapi kontrol tersambung:** periksa UDP 8884, alamat
  `MQTT_PUBLIC_HOST`, port yang dipetakan, token khusus perangkat dan kesamaan
  alamat sumber TCP/UDP. Status konfigurasi tidak menguji jalur audio
- **Audio lokal tidak tersedia:** periksa mount `notification-audio/`, key gateway,
  origin audio dan izin baca. Mount direktori kosong menyembunyikan sample bawaan
- **Pengirim ditolak:** periksa token khusus pengirim, nama environment token,
  allowlist alamat perangkat yang tepat, dan status approval. Jangan memperluas
  allowlist atau membagikan key admin/gateway untuk menghindari error
- **Teks tersimpan tetapi tidak ada beep:** penyimpanan dan bunyi terpisah. Periksa
  perangkat idle/online, MQTT, asset beep dan origin audio; tanyakan isi notifikasi
  melalui Gemini meskipun beep terlewat
- **Published tetapi tidak berbunyi:** pastikan firmware mendukung notify,
  perangkat idle, tautan belum kedaluwarsa, origin/sertifikat dapat dijangkau
  perangkat, serta format rekaman valid. Subtitle tidak menghasilkan ucapan
- **Memori kosong:** pastikan enabled dan tersimpan, pakai Gemini, mulai koneksi
  baru, dan tunggu giliran lengkap dengan teks kedua sisi. Giliran terputus tidak
  disimpan

Saat meminta bantuan, bagikan pesan error/status yang sudah disunting, versi
firmware, jenis board dan topologi jaringan. Jangan bagikan `.env`, token, key,
URL audio bertanda tangan, token pengirim, isi inbox atau isi memori privat.
