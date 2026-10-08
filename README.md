# XiaoZhi Server Node.js

**Bahasa Indonesia** · [English](README.en.md)

Server untuk menghubungkan perangkat XiaoZhi dengan AI suara, menyimpan notifikasi,
dan berkomunikasi dengan agent seperti Hermes. Pengaturan perangkat dilakukan
melalui dashboard web.

Contoh penggunaan: Anda meminta agent menyiapkan laporan melalui XiaoZhi.
Setelah selesai, agent mengirim notifikasi. Perangkat berbunyi, lalu saat Anda
menyapa “halo” atau “ada apa?”, XiaoZhi membacakan **judulnya terlebih dahulu**.
Anda bisa meminta isi lengkapnya atau membalas melalui tools yang disediakan agent.

## Mulai dari sini

| Kondisi Anda | Panduan yang dibaca |
| --- | --- |
| Server sudah berjalan; ingin memakai dashboard | [Panduan pengguna](docs/panduan-pengguna.md) |
| Ingin menghubungkan Hermes / agent custom | [Hubungkan agent dua arah](docs/remote-mcp.md) |
| Belum memasang server | [Instalasi bertahap Bahasa Indonesia](docs/SETUP_ID.md) |
| Mengelola Docker, pembaruan, atau cadangan | [Panduan Docker](docs/docker.md) |
| Mencari API, istilah, atau detail fitur | [Daftar dokumentasi](docs/README.md) |

Untuk fitur memori, pembacaan inbox, dan koneksi agent dua arah, gunakan **Gemini**.
Adapter Qwen dan LFM lokal juga tersedia untuk percakapan; dukungan fiturnya
berbeda. Memiliki adapter tidak menjamin model tersedia pada akun provider Anda.

## Fitur utama

- **Percakapan suara:** berbicara dengan AI melalui perangkat XiaoZhi.
- **Dashboard:** menyetujui perangkat, memilih AI, serta mengelola memori dan inbox.
- **Memori opsional:** menyimpan percakapan Gemini yang selesai dan catatan yang
  Anda masukkan. Awalnya nonaktif; memori dibagi oleh semua pengguna perangkat itu.
- **Inbox notifikasi:** menyimpan pesan dari agent, termasuk ketika perangkat offline.
- **Pengingat:** beep dicoba setiap 60 detik selama masih ada pesan belum dibaca.
  Pengingat ditunda ketika perangkat sedang digunakan untuk percakapan.
- **MCP dua arah:** agent mengirim pesan ke inbox; XiaoZhi memanggil tools agent
  untuk menjalankan permintaan atau mengirim balasan.

Paket ini sudah mencakup gateway MQTT dan nada beep contoh. Tidak perlu memasang
Redis atau broker MQTT tambahan untuk jalur bawaan.

## Menghubungkan agent: pilih, buat, salin

Server dan percakapan Gemini perlu sudah berjalan sebelum mengikuti langkah ini.

1. Login dashboard, lalu buka **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Pilih perangkat, kemudian klik **Buat konfigurasi**.
3. Klik **Salin untuk agent** dan tempel teksnya ke agent eksternal.
4. Setelah status **Terhubung dua arah** muncul, buka ulang percakapan XiaoZhi.

Dashboard membuat token inbox khusus perangkat secara otomatis. Anda tidak perlu
mengedit `.env` untuk membuat pengirim ini. Token adalah kunci akses; berikan teks
konfigurasi hanya kepada agent yang memang ingin Anda hubungkan.

Agent harus mendukung koneksi MCP dan menyediakan **server MCP** untuk tools
koneksi balik. Jika hanya mendukung MCP client, agent masih bisa mengirim inbox,
tetapi perlu server/adaptor tambahan agar bisa menerima permintaan dari XiaoZhi.
Lihat [panduan agent](docs/remote-mcp.md) untuk penjelasan status dan langkah lengkap.

## Cara notifikasi bekerja

1. Agent mengirim judul dan isi pesan; server menyimpannya ke inbox.
2. Perangkat yang online dan idle dapat memainkan beep melalui MQTT.
3. Jika masih unread, pengingat dicoba lagi tiap 60 detik secara default.
4. Buka percakapan dan ucapkan “halo”, “apa”, atau “ada apa”. Gemini membacakan
   judul terlebih dahulu, lalu menawarkan detail.
5. Judul yang terucap pada respons audio yang selesai ditandai **read** oleh server.
   Minta “bacakan isi pesan itu” bila Anda ingin detailnya.

Membuka pesan di dashboard saja **belum** menandainya read. Gunakan tombol
**Mark read** jika ingin menandainya dari dashboard. Read tidak menghapus pesan.
Jika semua pesan sudah read atau kedaluwarsa, pengingat berhenti.

Teks tetap tersimpan jika beep gagal. Status `published` berarti server sudah
meneruskan permintaan beep; itu bukan bukti suara terdengar. Perangkat yang mati
atau tidur dalam tidak dapat menerima beep. Detailnya ada di
[panduan pengguna](docs/panduan-pengguna.md).

## Memasang server baru

Siapkan Docker dengan Docker Compose, satu perangkat XiaoZhi, serta API key AI
milik Anda. Alternatif tanpa Docker membutuhkan Node.js **24 atau lebih baru**.
API key diperoleh dari provider AI; biaya pemakaian mengikuti akun tersebut.

[Panduan instalasi](docs/SETUP_ID.md) menjelaskan cara mengisi `.env`, menjalankan
layanan, menghubungkan satu perangkat, lalu mengaktifkan MQTT untuk beep.
Berkas `.env` berisi pengaturan dan kunci akses server; isi nilai contoh dengan
nilai milik Anda. Jangan menimpa `.env` atau data instalasi yang sudah berjalan.

Image Docker dipublikasikan oleh GitHub Actions ke
`ghcr.io/ojixzzz/xiaozhi-server-nodejs`, **AMD64 saja**. Tag `latest` mengikuti build
branch `main` yang berhasil; tag `sha-…` menunjuk build commit tertentu. Panduan
[memakai image dan memperbarui layanan](docs/docker.md) membedakan image GHCR
dari Compose bawaan yang membangun source sendiri.

## Data yang perlu Anda ketahui

| Data | Perilaku bawaan |
| --- | --- |
| Memori percakapan | Nonaktif sampai diaktifkan untuk perangkat |
| Inbox | Maksimal 100 pesan per perangkat, termasuk pesan read |
| Retensi inbox | Pesan disimpan sampai 30 hari sejak diterima, termasuk unread |
| Pengingat | 60 detik; `NOTIFY_REMINDER_INTERVAL_MS=0` mematikannya |
| Penyimpanan Docker | Volume `xiaozhi-data`, dipasang pada `/app/data` |

Inbox dan memori merupakan dua penyimpanan berbeda. Menghapus memori tidak
menghapus inbox. Inbox penuh menolak pesan baru; menandai read tidak mengosongkan
slot. Orang yang memakai perangkat bersama juga bisa mengakses memori dan inbox
perangkat itu. Isi yang diambil untuk menjawab akan dibagikan ke provider AI.

Saat memperbarui layanan, pertahankan volume dan nama proyek Compose yang lama.
`docker compose down -v` menghapus volume data. Baca
[panduan penyimpanan dan cadangan](docs/docker.md#persistent-data-and-migration)
sebelum memindahkan server.

## Jika ada masalah

| Gejala | Langkah awal |
| --- | --- |
| Pesan tersimpan tetapi tidak berbunyi | Periksa perangkat online/idle, pilihan MQTT, dan alamat audio |
| “Inbox siap · menunggu agent…” | Agent belum mendaftarkan server MCP untuk koneksi balik |
| Server agent terhubung tetapi tools belum aktif | Periksa pilihan tools di konfigurasi perangkat dan buka ulang percakapan |
| Pesan masih unread | Respons judul mungkin terputus; coba lagi atau gunakan **Mark read** |
| Pengaturan ditolak karena token perangkat | Perangkat membutuhkan token sendiri; minta administrator memeriksa provisioning |

Penjelasan lebih lengkap: [bantuan penggunaan](docs/panduan-pengguna.md#jika-ada-masalah)
atau [bantuan instalasi](docs/SETUP_ID.md#10-jika-belum-berhasil).

## Untuk pengembang

API dan batas teknis ada di [daftar dokumentasi](docs/README.md). Perintah pemeriksaan
source adalah `npm run check`; kumpulan tes menggunakan `npm test`.
[Laporan 7 Oktober 2026](TEST_RESULTS.md) merupakan hasil pemeriksaan versi saat
itu, bukan hasil tes ulang seluruh source terbaru. Fitur pengingat, pembacaan
judul, serta dashboard MCP terbaru belum menjalani tes lokal pada perubahan ini.
Build, deploy, koneksi agent nyata, dan suara perangkat perlu diverifikasi pada
lingkungan yang digunakan.

## Kredit

Gateway diturunkan dari proyek MIT
[78/xiaozhi-mqtt-gateway](https://github.com/78/xiaozhi-mqtt-gateway/tree/c5e3235df8db8f06d1710074ec10e870159e0844).
Lisensinya disertakan di [gateway/LICENSE.upstream](gateway/LICENSE.upstream).
Perangkat mengikuti protokol [XiaoZhi ESP32](https://github.com/78/xiaozhi-esp32).
