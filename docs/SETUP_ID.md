# Memasang server XiaoZhi: panduan bertahap

[Beranda](../README.md) · [Panduan pengguna](panduan-pengguna.md) · [Semua dokumentasi](README.md)

Panduan ini untuk **memasang atau menyiapkan server**, mulai dari satu perangkat.
Jika server dan percakapan sudah berjalan, langsung gunakan [panduan pengguna](panduan-pengguna.md)
atau [hubungkan agent](remote-mcp.md); tidak perlu mengulang instalasi.

Hasil yang dituju: perangkat dapat bercakap-cakap dengan Gemini, menerima beep
notifikasi melalui MQTT, dan membaca judul inbox saat Anda menyapa. Isi lengkap
baru dibacakan ketika Anda meminta detail. Memori percakapan bersifat opsional.

## Urutan yang diikuti

1. Siapkan kebutuhan dan simpan konfigurasi lama.
2. Isi pengaturan server untuk jaringan lokal tepercaya.
3. Jalankan server dan gateway.
4. Pastikan satu perangkat dapat bercakap-cakap lewat WebSocket.
5. Aktifkan memori jika diperlukan dan pengguna perangkat setuju.
6. Pindahkan perangkat uji ke MQTT untuk beep, lalu uji percakapan lagi.
7. Coba inbox dari dashboard, kemudian hubungkan agent jika diperlukan.
8. Untuk penggunaan di luar jaringan lokal, pelajari pengaturan TLS dan jaringan.

**Perintah pada blok `sh` dijalankan di Terminal pada komputer/server**, dari
folder proyek yang berisi `compose.yaml`. Blok `dotenv` merupakan isi pengaturan
untuk berkas `.env`, bukan perintah Terminal. Ganti IP dan nilai contoh sebelum
menjalankan layanan. [Penjelasan istilah](README.md#istilah-yang-sering-muncul).

Paket mencakup gateway dan beep contoh; tidak perlu Redis atau broker MQTT
terpisah. Panduan LAN di bawah memakai HTTP/MQTT tanpa TLS untuk jaringan privat
tepercaya, bukan konfigurasi internet. [Laporan tes](../TEST_RESULTS.md) mencatat
pemeriksaan historis pada 7 Oktober 2026, bukan pengujian ulang seluruh source
terbaru atau bukti firmware terpasang pada perangkat Anda. Bukti protokol dan
batas perangkat ada di [referensi firmware](firmware-compatibility.md).

## 1. Siapkan kebutuhan dan jalur kembali

Unduh atau clone source repo, lalu buka folder proyeknya. Jika memakai ZIP,
ekstrak dahulu; pastikan Anda melihat `compose.yaml` dan `.env.mqtt.example`.
Semua perintah pada panduan ini dijalankan dari folder tersebut.

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

Di folder proyek yang berisi `compose.yaml`:

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
VOICE_IDLE_TIMEOUT_SECONDS=60
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

### Standby otomatis ketika pengguna diam

Defaultnya 60 detik tanpa suara terdeteksi. Ubah per perangkat di **Xiaozhi
Devices → Config → Standby otomatis setelah diam (detik)**, lalu **Save**.
Kosong mengikuti `.env`; `0` menonaktifkan; nilai lain harus 15–3600 detik.
Standar server dapat diatur lewat `VOICE_IDLE_TIMEOUT_SECONDS=60`.

Timer berhenti sementara saat AI mengirim jawaban, playback belum selesai, atau
tools masih bekerja. Sesudah selesai, hitungan dimulai lagi. Audio hening tetap
boleh dikirim perangkat tanpa memperpanjang sesi. Sesi suara berakhir dengan
`goodbye`; koneksi MQTT tetap online untuk beep. Ini tidak mengubah timer deep
sleep/baterai firmware.

Deteksi sederhana memakai RMS audio, default threshold 500. Untuk mikrofon pelan
coba nilai lebih rendah; jika suara latar mempertahankan sesi, nilai lebih tinggi.
`VOICE_ACTIVITY_THRESHOLD` menerima 50–10000. Perubahan env perlu diterapkan ulang
ke server/container; pengaturan perangkat tersimpan pada volume data.

## 7. Coba inbox, lalu hubungkan agent

### Coba dari dashboard dahulu

Anda dapat mencoba tanpa Hermes atau token pengirim eksternal.
`NOTIFY_SENDERS_JSON=[]` boleh dibiarkan untuk langkah ini.

1. Login dashboard, lalu buka **Memory & Notify** pada perangkat approved.
2. Di **Test message & beep**, isi judul “Laporan uji selesai” dan pesan yang
   tidak sensitif, lalu klik **Save message & beep** sekali.
3. Periksa inbox. Pesan tersimpan lebih dulu; penyimpanan dan beep memiliki hasil
   berbeda. Pesan tetap tersimpan saat perangkat offline atau beep gagal.
4. Saat perangkat MQTT online dan idle, dengarkan beep. Bawaan paket adalah nada
   uji `sample-chime.ogg`, bukan ucapan isi pesan.
5. Bangunkan perangkat, katakan “halo” atau “ada apa”, dan dengarkan respons judul
   sampai selesai. Judul yang terucap ditandai read; minta isi lengkap bila diperlukan.
6. Buka ulang inbox dashboard. Gunakan **All messages** untuk melihat pesan read.
   Membuka pesan di dashboard saja tidak menandainya read; gunakan **Mark read**.

Jika masih ada unread, pengingat dicoba tiap 60 detik; percakapan aktif menundanya.
`NOTIFY_REMINDER_INTERVAL_MS=60000` mengatur interval dalam milidetik; `0`
mematikannya. Setelah mengubah `.env`, terapkan ulang container sebagaimana langkah 3.

Inbox dan memori terpisah. Memori boleh tetap nonaktif. Bawaan inbox adalah 100
pesan per perangkat, termasuk yang read, dengan retensi 30 hari sejak diterima.
Unread juga kedaluwarsa. Inbox penuh menolak pesan baru; read tidak menghapusnya.
[Detail inbox](inbox.md) dan [panduan pemakaian](panduan-pengguna.md).

### Hubungkan agent melalui konfigurasi siap salin

1. Buka **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Pilih perangkat Gemini. Isi nama agent bila ingin mengganti nama bawaan.
3. Periksa alamat dashboard yang bisa diakses agent. Ubah jika agent berada di
   mesin lain tetapi URL dashboard memakai `localhost`.
4. Klik **Buat endpoint → Salin untuk agent**.
5. Tempel teks ke agent yang ingin Anda hubungkan. Token inbox dibuat otomatis;
   tidak perlu mengedit `.env` untuk pengirim ini.
6. Agent menjalankan server MCP lokal stdio: isi `MCP_ENDPOINT`, lalu jalankan
   `python mcp_pipe.py agent.py` seperti calculator. Tools otomatis dipilih untuk
   perangkat tersebut; server HTTP publik pada agent tidak diperlukan.
7. Setelah **Terhubung dua arah** muncul, buka ulang percakapan dan coba
   permintaan sesuai tools yang tersedia pada agent.

Jika agent hanya mendukung MCP client, inbox dapat digunakan tetapi koneksi
balik masih memerlukan server/adaptor agent. [Panduan agent](remote-mcp.md)
menjelaskan pipe, helper inbox dengan endpoint yang sama, dan pengaturan manual.

### Pilihan lanjutan: pengirim HTTP/MCP manual

Lewati bagian ini jika memakai konfigurasi siap salin dari dashboard.
Untuk aplikasi yang ingin mengirim pesan dengan kredensial dari `.env`, atur:

```dotenv
NOTIFY_SENDERS_JSON=[{"name":"hermes","token_env":"HERMES_NOTIFY_TOKEN","device_ids":["aa:bb:cc:dd:ee:ff"]}]
HERMES_NOTIFY_TOKEN=
```

Ganti MAC dengan ID persis di dashboard. Isi token dengan secret berbeda dari
password admin, token perangkat, API key, dan kedua key gateway; minimal 32
karakter. Terapkan perubahan dengan:

```sh
docker compose --profile mqtt up -d --build
```

Pengirim memakai `POST /api/notifications` atau MCP `/mcp/notifications`, dengan
Bearer token pengirim. [Format pesan dan contoh HTTP/MCP](hermes-mcp.md).
Pengaturan itu mengizinkan penerimaan; aplikasi agent masih perlu dipasang
koneksinya. `NOTIFY_SENDERS_JSON=[]` hanya mematikan pengirim dari env. Hapus
pairing dashboard untuk mencabut token pengirim yang dibuat di sana.

### Jika ingin mencoba rekaman audio saja

**Memory & Notify → Audio-only test (no inbox message)** menyediakan pengiriman
rekaman tanpa membuat pesan inbox. Pilih rekaman, klik **Use local audio**,
lalu **Send notification**. URL saja tidak mengirim beep. Bila ingin menguji
teks dan beep sekaligus, gunakan **Save message & beep** di atas.

**Retry beep only** pada detail inbox mengulangi beep untuk pesan yang sama,
tanpa pesan baru atau perubahan read. Jika hasil sebelumnya tidak pasti,
percobaan ulang bisa membuat bunyi ganda. [Format rekaman](../notification-audio/README.md).

Perangkat perlu tetap online. Pada source Spotpear 1.28 Box yang diaudit, hemat
daya baterai dapat membuat board tidur/mati setelah sekitar 290 detik idle;
keadaan perangkat Anda perlu diperiksa sendiri. MQTT tidak membangunkan perangkat
mati/deep sleep. Teks tetap tersimpan dan bisa ditanyakan setelah tersambung lagi.

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
menolak pesan baru dari semua agen, hapus semua koneksi agent di dashboard dan
set `NOTIFY_SENDERS_JSON=[]`, lalu terapkan ulang konfigurasi; pesan yang sudah
tersimpan tetap mengikuti retensinya.
Jangan menghapus volume untuk rollback. `docker compose down` mempertahankan
volume; **jangan menambahkan `-v`** pada data sungguhan tanpa keputusan penghapusan
serta cadangan yang sudah diperiksa.

## 10. Jika belum berhasil

Untuk masalah pemakaian dashboard atau status agent, lihat juga
[panduan pengguna](panduan-pengguna.md#jika-ada-masalah) dan
[panduan agent](remote-mcp.md#jika-koneksi-belum-berhasil).

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
