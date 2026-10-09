# Pengingat internal XiaoZhi

[Beranda](../README.md) · [English](reminders.en.md) · [Panduan pengguna](panduan-pengguna.md)

Pengingat berjalan di server dan tidak memerlukan Hermes, agent eksternal, atau
endpoint tambahan. Gunakan perangkat **approved**, token perangkat sendiri, dan
Gemini untuk membuat atau mengelola pengingat lewat suara. Dashboard dapat
mengelolanya tanpa membuka percakapan. Beep memerlukan konfigurasi MQTT/notifikasi.

## Contoh percakapan

| Ucapan | Hasil |
| --- | --- |
| “Ingatkan minum 5 menit lagi” | Satu pengingat, 5 menit dari saat disimpan |
| “Setiap hari jam 8 pagi, ingatkan minum obat” | Setiap hari pukul 08.00 |
| “Setiap Senin dan Jumat jam 7 malam, ingatkan olahraga” | Hari yang dipilih, pukul 19.00 |
| “Tanggal 20 Oktober 2026 jam 9 pagi, ingatkan bayar tagihan” | Sekali pada tanggal dan jam tersebut |
| “Setiap 2 jam, ingatkan istirahat” | Interval tetap; pertama setelah 2 jam |
| “Setiap tanggal 31 jam 8 pagi, ingatkan bayar sewa” | Bulanan; bulan tanpa tanggal 31 dilewati |
| “Mulai besok sampai akhir bulan” | Rentang jadwal; sebutkan jam akhir bila perlu |
| “Apa saja pengingat saya?” | Daftar jadwal; tidak menandai selesai |
| “Pindahkan pengingat olahraga ke jam 8 malam” | Mengubah jadwal berikutnya |
| “Hentikan pengingat olahraga dulu” / “lanjutkan lagi” | Pause/resume |
| “Tunda pengingat ini 10 menit” | Menunda satu kejadian; jadwal rutin tetap |
| “Sudah minum” | Menandai kejadian minum yang dipilih selesai |

XiaoZhi menanyakan pagi/malam jika “jam 7” belum jelas, dan meminta pilihan jika
beberapa pengingat cocok. Setelah penyimpanan berhasil, XiaoZhi mengucapkan
jadwal dan zona waktunya. Konfirmasi pembuatan **tidak** dikirim sebagai notif kedua.

## Menggunakan dashboard

1. Pada **Xiaozhi Devices**, klik **Pengingat** di perangkat tujuan.
2. Isi judul, isi, jenis jadwal, waktu, dan zona waktu. Untuk jadwal rutin, tanggal
   mulai dan berakhir boleh dikosongkan. Interval pertama jatuh setelah interval
   yang dipilih, atau tepat pada waktu mulai bila diisi.
3. Klik **Simpan pengingat**, lalu periksa waktu kejadian berikutnya.
4. Gunakan **Ubah**, **Jeda**, **Lanjutkan**, atau **Batalkan** pada jadwal.
5. Pada riwayat, gunakan **Tunda…** atau **Sudah selesai** untuk satu kejadian.

Pengaturan dan perubahan diterapkan langsung tanpa memutus percakapan. Jika
permintaan terputus, muat ulang sebelum mengirim ulang. Key pembuatan/tunda tetap
dipertahankan selama halaman terbuka untuk retry dengan isi yang sama.

## Zona waktu dan jam tenang

Perangkat lama mewarisi `DEVICE_TIMEZONE_OFFSET_MINUTES`, default **420 / WIB**.
Dashboard menerima offset menit dari UTC: **420 WIB**, **480 WITA**, **540 WIT**.
Ini offset tetap, bukan zona IANA yang mengubah offset otomatis saat DST.
Setiap jadwal menyimpan offset sendiri. Mengubah default hanya berlaku untuk
jadwal baru; ubah jadwal tertentu bila ingin menggeser zona waktunya.

Jam tenang default nonaktif; formulir menyediakan contoh **22.00–07.00**.
Saat aktif, **semua beep inbox** ditunda, termasuk notif agent, pengingat internal,
beep berulang, dan retry manual. Pesan tetap disimpan pada waktu jatuh tempo;
pengguna tetap bisa meminta XiaoZhi membacakannya. Uji audio terpisah bukan beep
inbox. Sesudah jam tenang, beep mengikuti interval bersama perangkat, default
60 detik, tanpa membunyikan seluruh backlog sekaligus.

## Dibaca, ditunda, dan selesai

“Halo”, “apa”, atau “ada apa” membacakan judul terlebih dahulu. Sesudah respons
audio selesai dikirim, notif menjadi read dan beep berhenti. Ini **tidak** berarti
tugas sudah dikerjakan. **Sudah selesai** mengubah status kejadian, bukan jadwal
rutin. Jadwal besok tetap berjalan.

Tunda menghentikan beep kejadian tersebut dan menggunakan kembali **ID notif
yang sama** saat waktu tunda tiba. Notif kembali unread; tidak ada pesan kedua.
Tunda dapat dipilih hingga 30 hari, selama notif masih tersedia. Riwayat dan
pesan tundaan tetap mengikuti retensi: data yang sudah kedaluwarsa tidak dibuat
ulang. Jeda menahan kejadian baru dan beep pengingat terkait; melanjutkan tidak
membuat backlog dari waktu selama dijeda. Pembatalan menghentikan kejadian terbuka
dan mempertahankan riwayat.

## Lewati satu kejadian, agenda, dan jejak pengiriman

Pada **Agenda kalender**, klik tanggal atau pilih rentang hari. Tombol **Lewati
kali ini** melewati satu kejadian yang tepat; jadwal rutin tetap berjalan.
Contoh suara: “Lewati pengingat olahraga besok” atau “Apa agenda hari ini?”.
Jika beberapa kejadian cocok, XiaoZhi meminta pilihan. Pengingat yang dilewati
sudah tersimpan sebagai riwayat; tidak menambah notif inbox. Melewati kejadian
terbuka menghentikan beep-nya. Batas 1.000 kejadian mendatang yang dilewati per
perangkat; retensinya dihitung setelah waktu kejadian tiba.

Agenda memakai zona waktu perangkat dan memuat terjadwal, ditunda, dilewati,
selesai, serta riwayat yang masih tersimpan. Jadwal yang dijeda tidak diproyeksikan
ke masa depan. Pilih **Jejak pengiriman** pada agenda/riwayat untuk melihat waktu
jatuh tempo, penyimpanan, penundaan beep, pengiriman, read dan done. Detail inbox
juga memuat jejak notif dari agent. “Beep dikirim ke gateway” bukan bukti audio
terdengar. Status dari versi server lama ditandai `legacy_snapshot`; jejak lama
yang tidak pernah direkam tidak dibuat-buat. Jejak menyimpan hingga 100 kejadian
pengiriman terbaru per notif, ditambah kejadian penting penyimpanan/read.

Pomodoro memiliki panel dan tools tersendiri: **pengumuman Edge TTS sekali,
tanpa pesan inbox**. Lihat [panduan Pomodoro](screen-breaks.md).

## Offline, restart, dan batas

Jadwal diperiksa saat startup dan setiap detik. Perangkat offline tetap memiliki
pesan di inbox untuk dibaca saat kembali terhubung. Jika server mati, pengingat
sekali yang terlewat dikirim ketika server hidup. Pada jadwal rutin, hanya
kejadian terakhir yang terlewat dikirim; jumlah kejadian yang dilewati dicatat.
Interval tetap dihitung dari waktu awal, tanpa bergeser karena pemrosesan terlambat.

Pembuatan kejadian, notif, dan waktu berikutnya disimpan dalam satu transaksi.
Restart/retry tidak membuat notif ganda. Beep yang dipublikasikan tetap bukan
bukti speaker sudah memutarnya; mekanisme unread mencoba ulang sesuai interval.

- Maksimal **100 jadwal aktif atau dijeda per perangkat**.
- Judul maksimal **120**, isi maksimal **2.000 karakter UTF-16**; emoji dapat
  dihitung dua karakter. Pesan terlalu panjang ditolak.
- Riwayat kejadian disimpan **30 hari**, seperti retensi inbox.
- Inbox penuh menunda kejadian baru hingga ada kapasitas; jadwal tidak dibuang.
  Menandai read tidak membebaskan slot inbox.
- Penghapusan perangkat menghapus jadwal, pengaturan, dan riwayatnya. Perangkat
  yang tidak approved tidak diproses scheduler.

## Referensi API dan tools

Tools internal: `reminders_create`, `reminders_list`, `reminders_get`,
`reminders_update`, `reminders_cancel`, `reminders_snooze`, `reminders_complete`,
`reminders_settings`, `reminders_agenda`, `reminders_skip`, dan `reminders_trace`.
Tools Pomodoro: `screen_breaks_settings` dan `screen_breaks_session`. Identitas perangkat selalu berasal dari sesi suara; tools
tidak menerima `device_id`. Hasil adalah data tidak tepercaya, bukan instruksi.
Tool list/get dibatasi 5 item per halaman dan budget hasil inbox yang dikonfigurasi;
Agenda menerima offset 0–100000; kalender menghitung seluruh interval dalam rentang.
periksa `has_more` dan `truncated` sebelum mengklaim hasil lengkap.

API admin menggunakan login dashboard dan `X-Requested-With: XiaozhiDashboard`
untuk perubahan JSON. Semua rute berikut diawali `/api/devices/:mac/`:

| Method / rute | Fungsi |
| --- | --- |
| GET / POST `reminders` | Daftar / buat jadwal |
| GET / PATCH / DELETE `reminders/:id` | Detail / ubah / batalkan jadwal |
| GET `reminders/occurrences` | Riwayat; filter `reminder_id` opsional |
| POST `reminders/occurrences/:id/snooze` | `{seconds, request_key}` untuk tunda |
| POST `reminders/occurrences/:id/complete` | `{confirm:true}` untuk selesai |
| GET `reminders/agenda` | Agenda; `from` YYYY-MM-DD, `days` 1–42, `limit`, `offset` |
| GET `reminders/calendar` | Jumlah agenda per hari; `from`, `days` |
| POST `reminders/skip` | `{occurrence_id}` atau `{id,due_at}` tepat dari agenda |
| GET `reminders/occurrences/:id/trace` | Jejak satu kejadian |
| GET `inbox/:id/trace` | Jejak pesan internal/eksternal |
| GET / PUT `reminder-settings` | Offset default dan jam tenang |

Daftar/riwayat menerima `limit` (1–50), `offset`, serta filter `status` pada daftar
jadwal. Update dapat mengirim `revision` dari hasil sebelumnya untuk mendeteksi
edit bersamaan. DELETE memerlukan `{confirm:true}`. `reminders_settings` menerima
`action:get/update`; pengaturan berupa `timezone_offset_minutes`, `quiet_enabled`,
`quiet_start`, dan `quiet_end`.

Contoh isi POST pembuatan, tanpa token atau koneksi agent:

```json
{
  "title": "Minum",
  "text": "Minum air.",
  "schedule": {"kind": "once", "after_seconds": 300},
  "request_key": "ID_UNIK_PER_PERMINTAAN"
}
```

`schedule.kind`: `once` memakai `after_seconds` atau `at`; `daily` memakai `time`;
`weekly` memakai `time` dan `weekdays` (Senin=1, Minggu=7); `monthly` memakai `time`
dan `day`; `interval` memakai `every_seconds` minimal 60. `at`, `start_at`, dan
`end_at` adalah waktu lokal `YYYY-MM-DDTHH:mm`. `end_at` inklusif. Offset opsional
disimpan pada jadwal. Key retry dan isi harus tetap sama; jangan gunakan key baru
untuk retry yang hasilnya belum pasti.

## Pembaruan server

Database `DATA_DIR/notifications.sqlite` dimigrasikan dari versi 1 atau 2 ke 3 secara
transaksional. Pesan lama dipertahankan. **Sebelum deployment, hentikan server
dan cadangkan volume data**, termasuk database/sidecar SQLite. Jangan menyalin
hanya database utama saat server aktif. Versi server lama menolak schema versi 3;
rollback membutuhkan pemulihan backup dari sebelum migrasi.

Log `reminder.changed`, `reminder.due`, `reminder.capacity_deferred`, dan
`reminder.error` memuat ID dan status, tanpa isi pengingat atau token. Tool suara
memakai trace `tool.requested` dengan `route:reminder`. Tes disiapkan untuk CI
Node 24; perubahan ini tidak memerlukan layanan Gemini/Hermes nyata untuk tes.
