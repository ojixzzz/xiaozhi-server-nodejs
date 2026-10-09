# Pomodoro dengan Edge TTS

[Beranda](../README.md) · [English](screen-breaks.en.md) · [Pengingat dan kalender](reminders.md)

Pomodoro membantu membagi waktu menjadi sesi fokus dan istirahat. XiaoZhi
membacakan pergantian fase melalui **Edge TTS**, satu kali per pergantian.
Pengumuman ini **tidak masuk inbox**, tidak memiliki status read, dan tidak diulang.

## Mulai dari dashboard

1. Buka **Xiaozhi Devices → Pengingat → Pomodoro**.
2. Atur durasi fokus, istirahat pendek, istirahat panjang, dan jumlah sesi sebelum
   istirahat panjang. Simpan juga jam/hari aktif serta bahasa pengumuman.
3. Tekan **Mulai Pomodoro**. Fokus dan istirahat selanjutnya berganti otomatis.

Default: **fokus 25 menit → istirahat 5 menit**. Setelah **4 sesi fokus selesai**,
istirahat menjadi **20 menit**, lalu hitungan blok kembali ke nol. Total sesi
selesai tetap terlihat hingga memulai blok baru. Contoh mulai 09.00: istirahat
09.25–09.30, fokus lagi 09.30–09.55. Istirahat panjang pertama 10.55–11.15.

Batas pengaturan: fokus **5–240 menit**, istirahat pendek **1–30 menit**,
istirahat panjang **1–60 menit**, **1–12 sesi** sebelum istirahat panjang.
Jam aktif default **Senin–Jumat 08.00–17.00**, bahasa Indonesia, mulai otomatis
**nonaktif**. Semua waktu memakai zona waktu perangkat. Rentang yang melintasi
tengah malam mengikuti hari mulainya.

## Kontrol dashboard dan suara

| Kontrol / contoh ucapan | Hasil |
| --- | --- |
| Mulai Pomodoro / “Mulai Pomodoro” | Mulai blok baru; jika sudah fokus, timer tetap |
| Jeda timer / “Jeda Pomodoro” | Bekukan sisa waktu fokus atau istirahat |
| Lanjutkan / “Lanjutkan Pomodoro” | Teruskan fase yang dijeda dengan sisa waktu yang sama |
| Lanjutkan saat istirahat / “Kembali fokus” | Akhiri istirahat lebih awal dan mulai fokus |
| Mulai istirahat / “Istirahat lima menit” | Istirahat lebih awal; tidak menghitung fokus sebagai selesai |
| Tunda akhir fokus / “Tunda akhir fokus lima menit” | Akhir fokus menjadi lima menit dari sekarang; hanya saat fokus |
| Lewati fase / “Lewati fase Pomodoro” | Fokus → istirahat, atau istirahat → fokus; fokus yang dilewati tidak dihitung selesai |
| Hentikan / “Hentikan Pomodoro” | Hentikan sesi hingga dimulai lagi |
| “Atur Pomodoro fokus 40 menit, istirahat 10 menit” | Simpan durasi melalui tool internal |

Sapaan tidak mengubah timer. Pengumuman bukan bukti pengguna benar-benar
beristirahat; timer otomatis menghitung fase yang selesai menurut jadwal.
Perintah manual dikonfirmasi melalui percakapan, tanpa pengumuman tambahan.
Untuk memakai kontrol suara, buka percakapan baru setelah memperbarui server.

Simpan pengaturan mengatur ulang durasi fase aktif (atau sisa fase yang dijeda).
Mengubah jumlah siklus mengatur ulang hitungan blok. Mulai otomatis berjalan
sekali per rentang aktif dari saat server pertama memeriksanya. Hentikan mencegah
mulai otomatis lagi pada rentang yang sama. Sesi berhenti di luar jam/hari aktif,
termasuk sesi yang dijeda; tidak dilanjutkan otomatis pada hari berikutnya kecuali
mulai otomatis diaktifkan.

## Restart dan pembaruan

Sisa fase, hitungan siklus, jeda, serta riwayat pengiriman disimpan di SQLite.
Restart saat dijeda mempertahankan sisa waktunya. Jika server mati lama tetapi
masih pada rentang aktif yang sama, server maju **satu fase** dan memberi fase
berikutnya durasi penuh dari waktu pemrosesan. Tidak membuat banyak fokus selesai
atau memutar tumpukan pengumuman yang terlewat. Pengumuman lebih dari dua menit
terlambat dilewati.

Timer interval dari versi lama diubah menjadi Pomodoro sekali. Sesi lama dihentikan
beserta pengumuman yang belum dikirim; tekan Mulai Pomodoro lagi. Pasangan default
lama **30/2 menit** menjadi **25/5 menit**; pasangan durasi lain tetap tersimpan.
Istirahat panjang default 20 menit setelah 4 sesi. Pembaruan ini menggunakan tabel
schema 3 yang sudah ada, tanpa menaikkan versi schema.

## Perangkat dan koneksi

Gunakan **MQTT melalui gateway bawaan**, firmware yang mendukung audio `notify`,
dan konfigurasi notifikasi/audio yang sudah dipakai untuk beep inbox:

```dotenv
NOTIFY_ENABLED=true
NOTIFY_AUDIO_BASE_URL=https://alamat-server-anda
NOTIFY_ALLOWED_AUDIO_ORIGINS=https://alamat-server-anda
MQTT_AUDIO_ALLOWED_ORIGINS=https://alamat-server-anda
```

URL harus dapat diakses perangkat. Contoh HTTP untuk LAN mengikuti pengaturan
`NOTIFY_ALLOW_HTTP` pada [panduan MQTT](notifications.md).
Gateway harus memiliki konfigurasi secret dan transport MQTT perangkat yang benar.
Transport WebSocket dan adapter notifikasi custom belum mendukung pengumuman ini.

Image Docker sudah menyediakan **edge-tts 7.2.8**, Python, dan FFmpeg. Edge TTS
menghasilkan MP3, lalu FFmpeg mengubahnya menjadi mono Ogg Opus sebelum dikirim.
Tidak memakai API key Gemini untuk TTS. Edge TTS membutuhkan akses internet
ke layanan suara Microsoft saat membuat audio pertama kali. Kalimat tetap
disimpan di cache volume data dan dipakai lagi pada pengumuman berikutnya.
Bahasa Indonesia menggunakan `id-ID-GadisNeural`; English `en-US-JennyNeural`.
Lihat [dokumentasi proyek Edge TTS](https://github.com/rany2/edge-tts).

Untuk instalasi tanpa Docker, sediakan executable `edge-tts` dan `ffmpeg` sendiri.
Gunakan `EDGE_TTS_COMMAND` untuk path executable Edge TTS dan `FFMPEG_COMMAND`
untuk FFmpeg jika tidak memakai path default image Docker. Jangan mengisi perintah
shell atau token di field tersebut; keduanya hanya path executable.

## Pengumuman sekali dan jejak

- Percakapan aktif: tunggu selesai, paling lama **2 menit dari waktu terjadwal**.
- Perangkat offline atau gateway belum tersedia: **lewati**, tanpa antrean untuk
  dibacakan saat perangkat kembali online.
- Jam tenang: **lewati pengumuman**, sementara siklus fokus/istirahat tetap berjalan.
- Edge TTS gagal: lewati kejadian itu dan catat `tts_unavailable`.
- Pengiriman sudah dimulai lalu server restart atau respons hilang: status
  **belum terkonfirmasi**, tanpa mencoba ulang kejadian yang sama.

Riwayat pengumuman tersedia pada panel tersebut selama **30 hari**. Status
“Dikirim ke gateway” menunjukkan perintah dikirim; firmware belum memberikan
bukti audio terdengar. Untuk menjaga pengumuman sekali, kegagalan setelah claim
penyimpanan dapat berarti pengumuman terlewat. Sesi dan jadwal berikutnya tetap
disimpan, tanpa pesan inbox tambahan.

## API

Semua rute memakai login admin, perangkat approved bertoken sendiri, dan prefix
`/api/devices/:mac/`. Perubahan memakai JSON dan header dashboard yang sudah ada.

| Method / path | Isi |
| --- | --- |
| GET `screen-breaks` | Pengaturan, status sesi, waktu berikutnya, zona waktu |
| PUT `screen-breaks` | `interval_minutes` (fokus), `rest_minutes` (pendek), `long_rest_minutes`, `cycles_before_long_rest`, `active_start`, `active_end`, `weekdays`, `auto_start`, `language` |
| POST `screen-breaks/command` | `action`: start/stop/rest/pause/resume/snooze/skip; `minutes` untuk rest/snooze; `request_key` stabil |
| GET `screen-breaks/history` | Riwayat; `limit` 1–50, `offset` 0–1000 |

Tools suara: `screen_breaks_settings` (action get/update), `screen_breaks_session`.
Identitas perangkat berasal dari sesi, bukan argumen tool. Key retry perintah
disimpan hingga 128 perintah terakhir dalam 30 hari; retry memakai key dan isi sama.
Agent eksternal tidak perlu membuat pengingat atau mengirim inbox untuk fitur ini.

Sebelum deployment, hentikan server dan cadangkan volume data karena schema inbox
berubah menjadi versi 3. Detail ada di [panduan pengingat](reminders.md#pembaruan-server).
