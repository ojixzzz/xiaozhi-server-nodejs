# Panduan pengguna dashboard

[Beranda](../README.md) · [Semua dokumentasi](README.md) · [English overview](../README.en.md)

Panduan ini untuk server yang **sudah terpasang**. Jika belum, ikuti
[panduan instalasi](SETUP_ID.md). Anda tidak perlu memahami API atau mengedit
source untuk memakai fitur dashboard berikut.

## Sebelum mulai

Siapkan alamat dashboard dan password admin dari pengelola server. Buka alamat
tersebut di browser, misalnya Chrome atau Firefox. Login memakai
password tersebut. Jika perangkat belum tampil atau berstatus **Pending**
(menunggu persetujuan), minta administrator menyetujui perangkat yang benar.

Gunakan perangkat dengan percakapan **Gemini** yang sudah berjalan untuk fitur
memori, pembacaan inbox, dan MCP dua arah. Fitur tersebut membutuhkan token
khusus perangkat. Jika dashboard menolak karena token, administrator perlu
memeriksa konfigurasi perangkat; token agent bukan penggantinya.

## Mengenal menu

| Menu / tombol | Untuk apa |
| --- | --- |
| **Xiaozhi Devices** | Daftar perangkat XiaoZhi |
| **Config** | Mengubah AI, suara, instruksi, dan tools untuk perangkat |
| **Memory & Notify** | Memori, transport perangkat, serta inbox dan uji notifikasi |
| **MCP Devices** | Menghubungkan agent dan melihat tools yang tersedia |
| **Hubungkan agent · MCP dua arah** | Membuat konfigurasi agent yang siap disalin |

Menu mengikuti teks dashboard yang tersedia. Mengubah pengaturan tertentu akan
menutup percakapan aktif agar pengaturan baru dimuat. Buka percakapan lagi
setelah selesai menyimpan.

## Membuat dan mengelola pengingat

Untuk membuat pengingat melalui suara atau dashboard, lihat
[Pengingat internal](reminders.md). Tidak perlu agent eksternal. Jadwal harian,
hari tertentu, tanggal, bulanan, dan interval dapat ditunda atau ditandai selesai.
Jam tenang pada panel Pengingat berlaku untuk semua beep inbox.

## Otomatis kembali standby setelah diam

Setelah pengguna diam, perangkat otomatis meninggalkan sesi **Mendengarkan**
dan kembali standby. Defaultnya **60 detik**. Server menunggu jawaban AI selesai
diputar dan tools selesai sebelum memulai hitungan diam lagi. Paket audio yang
berisi keheningan tidak membuat sesi terus aktif.

1. Buka **Xiaozhi Devices → Config** pada perangkat pilihan.
2. Isi **Standby otomatis setelah diam (detik)**, misalnya `30`, `60`, atau `120`.
3. Klik **Save**. Perubahan waktu menutup sesi lama; bangunkan perangkat untuk
   memulai percakapan baru.

Kosong mengikuti standar server. Nilai `0` mematikan timeout ini; nilai lain
harus 15–3600 detik. Ini mengakhiri **sesi suara**, bukan mematikan perangkat.
Pada MQTT, koneksi tetap online sehingga beep notifikasi dapat diterima setelah
sesi suara berakhir. Pada WebSocket langsung, sesi ditutup dan perangkat dapat
membuka percakapan baru melalui mekanisme firmware-nya.

Deteksi aktivitas menyesuaikan ambang volume dengan perkiraan noise latar dari
dua detik audio terakhir, mulai setelah 0,5 detik audio terkumpul. Noise yang
stabil tidak terus dianggap pengguna berbicara. Audio tetap dikirim utuh ke AI;
penyesuaian ini hanya untuk timer standby. Ini masih perkiraan berdasarkan volume:
suara orang lain, TV, atau noise yang berubah-ubah dapat memperpanjang sesi,
sedangkan suara pelan dekat level noise dapat terlewat. Transkripsi dari AI
juga mereset timer. Administrator dapat menyesuaikan batas minimum
`VOICE_ACTIVITY_THRESHOLD` bila diperlukan.
Jika AI/tools berhenti mengirim aktivitas tanpa menyelesaikan respons, jeda
pelindung berakhir setelah dua menit, lalu hitungan diam dimulai kembali. Batas
jaringan gateway tetap terpisah dari timeout suara ini.

Jika koneksi Gemini terputus sementara, server mencoba ulang maksimal **lima
kali**, dengan jeda **1, 2, 4, 8, dan 15 detik**. Hitungan diam dijeda selama
setup/pemulihan. Jatah retry kembali penuh setelah koneksi berhasil bertahan
30 detik. Jika seluruh percobaan gagal atau konfigurasi/izin ditolak, sesi suara
diakhiri dengan alasan `provider_unavailable`, termasuk saat timeout diam `0`.
Ini mencegah perangkat terus terlihat Mendengarkan padahal AI tidak tersedia.
Koneksi MQTT untuk notifikasi tetap dipertahankan. Periksa `phase`, `code`, dan
`reason` pada log `Provider session closed`; buka percakapan baru setelah masalah
teratasi. `phase=setup` berarti sesi belum diterima Gemini.

Agent MCP yang tersambung, terputus, atau mencoba sambung ulang otomatis tidak
mengembalikan perangkat ke standby. Percakapan tetap berjalan; buka percakapan
baru untuk memuat tools agent yang baru. Perubahan dashboard yang memang perlu
menutup sesi, misalnya mengubah timeout atau menghapus memori/koneksi, dicatat
dengan alasan spesifik pada log `session.close_requested`.

## Internet buruk atau perangkat dimatikan

Ada dua sambungan yang dapat bermasalah: perangkat ke server, dan server ke AI.
Pilih **Gemini 3.8 Live** pada konfigurasi model perangkat untuk menggunakan
`gemini-3.8-live`. Pilihan model perangkat lama tidak diubah otomatis.
Saat reconnect, server mencoba melanjutkan konteks melalui checkpoint Gemini
jika masih valid dan tools/pengaturan sesuai. Jika checkpoint ditolak, server
mencoba sesi baru. Tool yang status eksekusinya belum jelas tidak diputar ulang
otomatis melalui checkpoint.

Audio mikrofon dikirim dalam potongan **20 ms**, termasuk setelah reconnect.
Buffer menyimpan maksimal **3 detik audio yang belum dikirim**; audio lebih lama
dibuang agar ucapan tidak tertunda terus. Saat perangkat selesai bicara, server
mengirim tanda akhir audio ke Gemini. Jika stream berhenti tanpa tanda tersebut,
server mengakhiri stream setelah jeda **1,2 detik**. Ini tidak menutup koneksi AI.

Pada MQTT/UDP, paket yang tertukar urutannya ditunggu maksimal **120 ms** dengan
antrean terbatas. Sebelum meneruskan `listen.stop`, gateway menunggu jendela yang
sama agar paket akhir ucapan sempat masuk. Celah kecil pada audio diisi
keheningan singkat; kata yang paketnya benar-benar hilang tidak dapat dipulihkan.
Suara jawaban memakai buffer awal hingga **180 ms** untuk meredam keterlambatan
pendek. Jika pengiriman benar-benar macet atau antrean melampaui batas, sesi
diakhiri dengan `audio_backpressure` agar perangkat dapat membuka sesi baru.

Untuk WebSocket suara, server mengirim **ping setiap 5 detik**. Jika tidak ada
balasan **pong selama 30 detik**, server mengakhiri sesi, menutup koneksi AI,
dan membersihkan timer serta antrean audio. Jeda ini memberi kesempatan koneksi
yang sempat tersendat untuk pulih. Pemeriksaan jaringan tetap berjalan saat
timeout standby disetel `0`; pong tidak dihitung sebagai pengguna berbicara.
Saat perangkat dimatikan mendadak, deteksi bisa memerlukan jeda ini karena
perangkat tidak sempat mengirim pesan penutupan.

Pada MQTT, gateway memeriksa keepalive MQTT dan batas sesi audionya sendiri.
Heartbeat WebSocket memeriksa sambungan gateway ke server; perangkat yang
terputus dari gateway ditangani gateway. Batas sesi audio tanpa aktivitas
di gateway secara bawaan dua menit, terpisah dari timeout standby.

Log `session.status` muncul setiap 15 detik selama server masih menganggap sesi
terbuka. `idle_ms` yang bertambah saat `timeout_ms=0` adalah catatan waktu diam,
bukan countdown standby. `provider_ready=true` menunjukkan sesi AI siap,
bukan bukti perangkat masih menyala. Setelah koneksi putus terdeteksi, cari
`session.teardown` dan `device.disconnected`; log status sesi itu berhenti.

## Membaca notifikasi dari perangkat

Misalnya agent mengirim judul “Laporan sudah selesai” dan isi ringkasan laporan.

1. Saat perangkat online dan idle, Anda dapat mendengar beep.
2. Bangunkan perangkat seperti biasanya dan katakan **“halo”**, **“apa”**, atau
   **“ada apa”**.
3. XiaoZhi membacakan judul lebih dulu dan menawarkan detail.
4. Katakan **“bacakan isi pesan itu”** untuk mendengar isi lengkapnya.
5. Jika agent menyediakan tool balasan, Anda dapat meminta **“balas pesan itu…”**.
   Koneksi dua arah harus aktif dan tool balasan harus tersedia di agent.

Server menandai pesan **read** setelah judulnya terucap pada respons audio yang
selesai. Jika respons dibatalkan atau judul belum terucap, pesan tetap **unread**.
Ini berdasarkan respons yang dikirim server, bukan bukti Anda benar-benar
mendengar suara. Isi lengkap tetap bisa diminta setelah pesan read.

Bila ada beberapa pesan, beberapa judul bisa dibacakan dalam satu respons.
Pesan yang belum disebut tetap unread. Minta judul berikutnya jika masih ada.

## Membaca inbox dari dashboard

1. Pada perangkat pilihan, buka **Memory & Notify → Notification inbox**.
2. Pilih **Unread only** untuk pesan belum dibaca, atau **All messages** untuk semuanya.
3. Buka pesan untuk melihat judul, isi, dan statusnya.
4. Klik **Mark read** jika ingin menandainya sudah dibaca.

**Membuka pesan di dashboard saja tidak menandainya read.** Menandai read
menghentikan pengingat untuk pesan itu, tetapi tidak menghapusnya. Pengingat
perangkat masih bisa berbunyi jika ada pesan unread lain.

Jika tidak ada pesan setelah ditandai read, ganti filter ke **All messages**.
Gunakan **Previous page / Next page** jika pesan ada di halaman lain.

## Mengatur dan mencoba pengingat

Bawaan server mencoba beep setiap **60 detik** selama masih ada pesan unread.
Saat perangkat sedang bercakap-cakap, pengingat ditunda. Pesan read atau pesan
yang kedaluwarsa tidak memicu pengingat.

Interval merupakan pengaturan server: `NOTIFY_REMINDER_INTERVAL_MS=60000` berarti
60 detik; `0` mematikan pengingat. Minta administrator mengubahnya bila perlu.
Satu perangkat tidak mendapat satu beep per pesan pada setiap interval.

Untuk mencoba tanpa agent:

1. Buka **Memory & Notify → Test message & beep**.
2. Isi judul singkat dan pesan percobaan yang tidak sensitif.
3. Klik **Save message & beep** sekali.
4. Periksa bahwa pesan tersimpan di inbox. Jika perangkat MQTT online dan idle,
   dengarkan beep, lalu ucapkan “halo” untuk mendengar judul.

Tombol **Retry beep only** mencoba beep untuk pesan yang sudah disimpan; tombol
ini tidak membuat pesan baru dan tidak menandainya read. Hasil yang tidak pasti
bisa berarti beep sebelumnya sudah berbunyi, sehingga retry dapat mengulangnya.

Uji **Send notification** pada bagian audio hanya mengirim rekaman suara; uji itu
berbeda dari **Save message & beep** dan tidak membuat pesan teks di inbox.

## Menghubungkan agent eksternal

1. Buka **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Pilih perangkat Gemini. Nama agent sudah terisi; ubah jika diinginkan.
3. Klik **Buat endpoint**, lalu **Salin untuk agent**.
4. Tempel teks tersebut ke agent eksternal yang Anda percaya.
5. Tunggu status **Terhubung dua arah**, lalu buka ulang percakapan perangkat.

Konfigurasi berisi token inbox khusus perangkat. Agent dapat mengirim pesan
melalui koneksi tersebut. Untuk arah sebaliknya, agent perlu menyediakan server
MCP lokal stdio dan menjalankannya lewat `mcp_pipe.py` dengan `MCP_ENDPOINT` yang
disalin. Agent tidak perlu membuka server HTTP publik. Jika aplikasi hanya punya
MCP client, koneksi balik belum tersedia sampai ada server/adaptor.

Alamat dashboard otomatis dipakai dalam konfigurasi. Jika alamatnya `localhost`
sedangkan agent berada di mesin lain, buka **Alamat dashboard yang bisa diakses
agent** dan isi domain/IP server yang dapat dijangkau agent **sebelum** membuat
konfigurasi. `localhost` pada agent menunjuk mesin agent sendiri.

Ada dua pilihan salin:

- **Salin untuk agent:** teks petunjuk lengkap, termasuk konfigurasi dan cara koneksi balik.
- **Salin MCP_ENDPOINT:** URL WebSocket untuk environment pada mesin agent.

Jika clipboard tidak tersedia, dashboard memilih teks untuk Anda. Tekan **Ctrl+C**
atau **Cmd+C**, lalu tempel ke agent. Detail dan arti status ada di
[panduan koneksi agent](remote-mcp.md).

**Hapus koneksi** mencabut token agent dan melepas tools-nya. Pesan yang sudah
tersimpan tetap ada sampai kedaluwarsa. Menutup teks konfigurasi hanya
menyembunyikannya; itu tidak memutus koneksi.

## Memori percakapan: opsional

Memori membantu Gemini mengingat percakapan perangkat dan catatan yang Anda
masukkan. Awalnya nonaktif. Inbox tetap berfungsi tanpa memori.

1. Pastikan semua orang yang memakai perangkat setuju percakapan disimpan.
2. Buka **Memory & Notify** dan centang **Enable shared memory for this device**.
3. Bila perlu, masukkan catatan sederhana, satu catatan per baris.
4. Klik **Save memory**, lalu buka ulang percakapan.

Hanya percakapan Gemini yang selesai dengan teks kedua sisi yang disimpan;
percakapan terputus tidak disimpan sebagai giliran lengkap. Server tidak
mengenali pemilik suara. Semua orang yang memakai perangkat berbagi memori dan inbox.

Menyimpan pengaturan dengan memori nonaktif menghapus catatan dan percakapan
memori yang tersimpan. Gunakan **Forget memory** di dashboard jika ingin
melupakan data; ikuti konfirmasi ID perangkat yang diminta. Tindakan ini tidak
menghapus inbox atau salinan cadangan lama. [Detail memori](memory.md).

## Berapa lama pesan disimpan?

Inbox menyimpan maksimal **100 pesan per perangkat**, termasuk yang read,
dengan retensi bawaan **30 hari** sejak pesan diterima server. Pesan unread juga
kedaluwarsa. Bila penuh, pesan baru ditolak; pesan lama yang belum kedaluwarsa
tidak otomatis digusur.

Menandai read tidak mengosongkan tempat. Jika kapasitas perlu diubah, minta
administrator memeriksa pengaturan server. Dashboard tidak menyediakan
penghapusan satu pesan inbox. Hindari memasukkan password atau informasi sangat
pribadi, terutama pada perangkat yang dipakai bersama.

## Jika ada masalah

| Yang Anda lihat | Penjelasan / langkah awal |
| --- | --- |
| Notifikasi tersimpan, tidak ada beep | Teks dan beep terpisah. Periksa perangkat online/idle, transport MQTT, dan pengaturan audio |
| `published`, tetapi belum terdengar | Server meneruskan permintaan; periksa speaker, firmware, dan akses perangkat ke URL audio |
| `not_published` | Permintaan beep tidak berhasil diteruskan; teks yang sudah tersimpan tetap tersedia |
| `unknown` | Hasil pengiriman tidak dapat dipastikan; lihat inbox sebelum membuat pesan baru |
| Beep terus berulang | Masih ada unread. Dengarkan respons judul sampai selesai atau gunakan **Mark read** |
| Pesan hilang dari filter unread | Ganti ke **All messages**; pesan mungkin sudah read |
| “Inbox siap · menunggu koneksi MCP pipe” | Isi MCP_ENDPOINT lalu jalankan pipe pada mesin agent |
| Server agent offline | Periksa MCP_ENDPOINT, proses pipe dan jaringan; lihat [panduan agent](remote-mcp.md) |
| Tools tersedia, tetapi belum digunakan | Pastikan tools dipilih untuk perangkat dan buka ulang percakapan Gemini |
| Perangkat tidur/mati | Aktifkan kembali perangkat; MQTT tidak membangunkan perangkat yang mati/deep sleep |
| Inbox penuh | Read tidak menghapus pesan. Tunggu retensi atau minta administrator meninjau kapasitas |

Bila butuh bantuan, kirim gejala dan pesan error yang sudah disunting agar tidak
berisi rahasia. Sertakan jenis perangkat dan langkah yang sedang dilakukan.
Gunakan [panduan menelusuri log](troubleshooting-logs.md) untuk mengambil semua
kejadian dari satu ID sesi, termasuk error Gemini dan alasan standby.
Jangan mengirim seluruh `.env`, token, API key, isi inbox pribadi, atau URL audio
bertanda tangan. Bantuan pemasangan jaringan ada di
[panduan instalasi](SETUP_ID.md#10-jika-belum-berhasil).

## Agenda, jejak, dan istirahat layar

Buka **Xiaozhi Devices → Pengingat** untuk melihat kalender dan melewati satu
kejadian tanpa mengubah jadwal rutin. Pilih **Jejak pengiriman** untuk mengetahui
apa yang terjadi pada pengingat; detail inbox juga memiliki jejak pesan agent.

Panel **Istirahat layar** mengatur interval kerja, durasi jeda, jam/hari aktif dan
bahasa. Klik **Mulai kerja**, atau minta melalui suara. Pengumuman Edge TTS
langsung tidak masuk inbox dan tidak diulang. Default 30 menit kerja / 2 menit
istirahat; mulai otomatis nonaktif. Lihat [panduan lengkap](screen-breaks.md).
