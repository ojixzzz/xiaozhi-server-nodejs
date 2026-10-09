# Dokumentasi XiaoZhi

[Bahasa Indonesia](../README.md) · [English overview](../README.en.md)

Mulai dengan panduan sesuai kebutuhan Anda. Nama tombol dalam panduan mengikuti
teks yang muncul di dashboard; beberapa tombol masih berbahasa Inggris.
Dokumentasi Bahasa Indonesia tidak berarti semua menu atau respons AI otomatis
berubah bahasa. Bahasa percakapan mengikuti pengaturan dan permintaan Anda.

## Untuk pengguna dan administrator

| Panduan | Isi | Bahasa |
| --- | --- | --- |
| [Panduan pengguna](panduan-pengguna.md) | Dashboard, memori, notifikasi, balasan, dan masalah umum | Indonesia |
| [Pengingat internal](reminders.md) / [English](reminders.en.md) | Jadwal, tunda/selesai, jam tenang, dan dashboard | Indonesia / English |
| [Hubungkan agent](remote-mcp.md) / [English](remote-mcp.en.md) | Konfigurasi siap salin dan MCP dua arah | Indonesia / Inggris |
| [Pasang server](SETUP_ID.md) | Instalasi bertahap, pengaturan perangkat, dan kembali ke konfigurasi lama | Indonesia |
| [Docker dan penyimpanan](docker.md) | Menjalankan, memakai image GHCR, memperbarui, dan mencadangkan server | Ringkasan Indonesia, referensi Inggris |
| [Menelusuri log](troubleshooting-logs.md) | Mengambil log, menyaring ID sesi, dan mencari penyebab putus/standby | Indonesia / ringkasan Inggris |
| [Rekaman beep](../notification-audio/README.md) | Mengganti rekaman dan format audio yang diterima | Ringkasan Indonesia, referensi Inggris |

Jika server sudah bekerja, mulai dari **Panduan pengguna**. Tidak perlu
mengulang instalasi hanya untuk membuat koneksi agent di dashboard.

## Untuk pengembang atau pemeriksaan teknis

| Referensi | Isi |
| --- | --- |
| [Memori](memory.md) | Apa yang disimpan, privasi, batas, dan API memori |
| [Inbox](inbox.md) | Penyimpanan, read/unread, retensi, dan API inbox |
| [Contoh pipe dan agent](../examples/mcp-endpoint/README.md) | MCP_ENDPOINT, calculator lokal, dan helper inbox |
| [HTTP/MCP untuk pengirim](hermes-mcp.md) | Pengirim manual, format pesan, dan protokol MCP |
| [MQTT dan audio](notifications.md) | Gateway, provisioning, API audio, dan arti hasil pengiriman |
| [Gateway](../gateway/README.md) | Pengaturan jaringan dan protokol gateway |
| [Sertifikat MQTT](../certs/README.md) | Menyediakan sertifikat dan kunci TLS |
| [Kompatibilitas firmware](firmware-compatibility.md) | Bukti source dan keterbatasan perangkat/firmware |
| [Laporan tes historis](../TEST_RESULTS.md) | Pemeriksaan pada 7 Oktober 2026; bukan jaminan versi terbaru |

Referensi teknis di tabel ini terutama berbahasa Inggris. Alur pemakaian dan
penjelasan fiturnya tersedia di panduan Indonesia di atas.

## Istilah yang sering muncul

| Istilah | Arti sederhana |
| --- | --- |
| Server / relay | Program yang menghubungkan perangkat XiaoZhi, AI, dan agent |
| Dashboard | Halaman web untuk mengubah pengaturan dan melihat data |
| Agent | Aplikasi AI yang dapat mengerjakan tugas, misalnya agent custom atau Hermes |
| Tool | Kemampuan yang bisa dipanggil AI, misalnya membuat laporan atau mengirim balasan |
| MCP | Cara standar agar aplikasi AI dapat menggunakan tools aplikasi lain |
| MCP client | Aplikasi yang memanggil tools; misalnya agent saat mengirim inbox |
| MCP server | Aplikasi yang menyediakan tools; dibutuhkan agent untuk koneksi balik |
| Endpoint / URL | Alamat layanan yang dihubungi, misalnya URL WebSocket MCP_ENDPOINT dari dashboard |
| Token / secret | Kunci akses rahasia; berbeda dari nama perangkat atau URL |
| API key | Kunci akses akun provider AI, bukan token untuk agent atau perangkat |
| Inbox | Kotak masuk pesan teks yang disimpan oleh server |
| Unread / read | Belum dibaca / sudah ditandai dibaca; bukan status penghapusan |
| MQTT | Sambungan yang memungkinkan server mengirim tanda beep ke perangkat idle |
| WebSocket | Sambungan untuk percakapan suara dan pipe MCP agent |
| Approved / pending | Perangkat sudah disetujui / masih menunggu persetujuan administrator |
| Idle / offline | Terhubung tetapi tidak berbicara / sedang tidak terhubung |
| Retensi | Lama data disimpan sebelum kedaluwarsa |
| Volume Docker | Penyimpanan data yang tetap ada saat container diganti |
| Firmware / OTA | Program di perangkat / pengambilan pembaruan atau konfigurasi melalui jaringan |

**“Online” dan “configured” berbeda.** Configured berarti pengaturan server
lengkap. Online berarti perangkat atau server lain benar-benar tersambung.
Keduanya belum membuktikan suara terdengar di speaker.

- [Pomodoro dengan Edge TTS](screen-breaks.md) · [English](screen-breaks.en.md).
