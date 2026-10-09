# Istirahat layar dengan Edge TTS

[Beranda](../README.md) · [English](screen-breaks.en.md) · [Pengingat dan kalender](reminders.md)

XiaoZhi dapat mengumumkan waktu istirahat langsung lewat speaker ketika perangkat
standby: “Yuk, istirahat layar sebentar. Luangkan 2 menit untuk beristirahat.”
Pengumuman ini **tidak masuk inbox**, tidak memiliki status read, dan tidak
diulang untuk kejadian yang sama.

## Mulai dari dashboard

1. Buka **Xiaozhi Devices → Pengingat → Istirahat layar**.
2. Atur interval kerja, durasi istirahat, jam/hari aktif, dan bahasa pengumuman.
3. Klik **Simpan istirahat layar**, kemudian **Mulai kerja**.
4. Gunakan **Mulai istirahat**, **Kembali kerja**, **Tunda…**, **Lewati sekali**,
   atau **Selesai kerja** sesuai kebutuhan.

Default: kerja **30 menit**, istirahat **2 menit**, **Senin–Jumat 08.00–17.00**,
bahasa Indonesia, mulai otomatis **nonaktif**. Interval dapat diatur **5–240 menit**
dan durasi istirahat **1–30 menit**. Semua jam memakai zona waktu perangkat di
panel Pengingat. Jam aktif yang melewati tengah malam mengikuti hari mulainya.

Aktifkan **Mulai otomatis** jika ingin sesi dimulai pada rentang jam aktif tanpa
perintah suara. Sesi dimulai saat server pertama kali memeriksa rentang tersebut,
bukan mengejar interval yang sudah lewat. **Selesai kerja** mencegah mulai otomatis
lagi pada rentang jam yang sama. Di luar jam aktif sesi otomatis berhenti.

## Lewat suara

Gunakan Gemini dengan perangkat approved dan token perangkat sendiri. Setelah
update server, buka percakapan baru agar tools baru dimuat.

| Ucapan | Perilaku |
| --- | --- |
| “Mulai kerja, ingatkan istirahat layar setiap 30 menit” | Simpan interval lalu mulai sesi |
| “Ubah interval istirahat jadi 45 menit” | Mengatur ulang interval kerja aktif dari sekarang |
| “Mulai istirahat” | Memulai jeda sesuai durasi tersimpan |
| “Istirahat lima menit” | Jeda lima menit untuk sesi ini |
| “Kembali kerja” | Mengakhiri jeda dan menghitung interval kerja baru |
| “Tunda lima menit” | Pengumuman berikutnya lima menit dari sekarang |
| “Lewati kali ini” | Lewati ajakan terbaru atau kejadian berikutnya jika belum ada ajakan baru |
| “Selesai kerja” | Menghentikan sesi dan pengumuman yang menunggu |

Contoh: mulai kerja **09.00** → ajakan istirahat **09.30**. Tanpa respons,
pengumuman berikutnya tetap **10.00**. Jika mulai istirahat dua menit pada 09.30,
pengumuman jeda selesai pada **09.32**, lalu ajakan berikutnya **10.02**.
Sapaan “halo” dan pengumuman yang dibacakan tidak dianggap memulai istirahat.
Jika server melewati akhir jeda saat mati, interval kerja baru dihitung dari
waktu server kembali memproses sesi; tidak ada tumpukan ajakan lama.

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
- Jam tenang: **lewati pengumuman**, sementara interval tetap berjalan.
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
| PUT `screen-breaks` | `interval_minutes`, `rest_minutes`, `active_start`, `active_end`, `weekdays`, `auto_start`, `language` |
| POST `screen-breaks/command` | `action`: start/stop/rest/resume/snooze/skip; `minutes` untuk rest/snooze; `request_key` stabil |
| GET `screen-breaks/history` | Riwayat; `limit` 1–50, `offset` 0–1000 |

Tools suara: `screen_breaks_settings` (action get/update), `screen_breaks_session`.
Identitas perangkat berasal dari sesi, bukan argumen tool. Key retry perintah
disimpan hingga 128 perintah terakhir dalam 30 hari; retry memakai key dan isi sama.
Agent eksternal tidak perlu membuat pengingat atau mengirim inbox untuk fitur ini.

Sebelum deployment, hentikan server dan cadangkan volume data karena schema inbox
berubah menjadi versi 3. Detail ada di [panduan pengingat](reminders.md#pembaruan-server).
