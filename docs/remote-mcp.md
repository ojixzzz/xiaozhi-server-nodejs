# Menghubungkan agent: MCP dua arah

**Bahasa Indonesia** · [English](remote-mcp.en.md) · [Semua dokumentasi](README.md)

Dengan koneksi ini, **agent bisa mengirim notifikasi ke XiaoZhi**, dan **XiaoZhi
bisa meminta agent melakukan tugas atau mengirim balasan** melalui tools agent.
Misalnya: minta laporan lewat suara, agent mengerjakan, lalu hasilnya masuk inbox.

Jika Anda hanya ingin membaca notifikasi, lihat [panduan pengguna](panduan-pengguna.md).
Pemasangan server ada di [panduan instalasi](SETUP_ID.md).

## Yang perlu disiapkan

- Server XiaoZhi dengan dashboard terbaru yang sudah dapat Anda buka.
- Perangkat approved (sudah disetujui administrator) dengan token sendiri dan percakapan Gemini yang berfungsi.
- Agent eksternal yang mendukung MCP. Untuk menerima permintaan dari XiaoZhi,
  agent juga perlu menyediakan **server MCP**, yaitu layanan yang menyediakan tools.
- Alamat relay yang bisa diakses agent; alamat server agent juga harus bisa
  diakses relay untuk koneksi balik.

**MCP client dan MCP server berbeda.** Client memakai tools, server menyediakan
tools. Agent yang hanya bisa memakai MCP client dapat mengirim inbox, tetapi
belum bisa menerima permintaan dari XiaoZhi tanpa server/adaptor tambahan.
Tidak ada endpoint Hermes nyata yang disertakan dalam paket ini.

## Cara paling mudah: salin dari dashboard

1. Login dashboard dan buka **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Pilih perangkat Gemini. Nama agent sudah terisi; ganti jika diperlukan.
3. Alamat relay diambil dari alamat dashboard. Jika agent memerlukan alamat
   lain, buka **Alamat dashboard yang bisa diakses agent** lalu ubah URL publiknya.
4. Klik **Buat konfigurasi**.
5. Klik **Salin untuk agent**, lalu tempel teks lengkap ke agent eksternal.
6. Agent mengikuti instruksi tersebut: memasang koneksi MCP ke relay dan
   mendaftarkan server MCP-nya untuk koneksi balik.
7. Setelah status **Terhubung dua arah** muncul, buka ulang percakapan XiaoZhi
   supaya tools terbaru dimuat.

Tidak perlu mengedit `.env` atau memasukkan token inbox sendiri. Dashboard
membuat token baru yang hanya mengizinkan agent mengirim ke perangkat pilihan.
Pengaturan ini langsung berlaku; tidak membutuhkan restart server.

Teks yang disalin berisi token rahasia. Tempel hanya ke agent yang ingin Anda
hubungkan. **Salin JSON MCP saja** tersedia jika aplikasi meminta konfigurasi
`mcpServers` di editor pengaturannya; format editor bisa berbeda antar aplikasi.
Jika tombol salin tidak didukung browser, teks akan dipilih agar bisa disalin
menggunakan Ctrl+C / Cmd+C.

## Apa yang dikerjakan agent setelah menerima teks itu?

Teks konfigurasi sudah memuat alamat relay, token inbox, ID perangkat, serta
petunjuk untuk dua kemampuan berikut:

| Kemampuan | Cara agent menggunakannya |
| --- | --- |
| Mengirim ke inbox | Memanggil `notify_send` dengan judul, isi, ID perangkat, dan ID pesan unik |
| Menyediakan tools untuk XiaoZhi | Menjalankan server MCP agent, lalu memanggil `agent_register` dengan URL server dan token server agent jika diperlukan |

Relay menemukan tools yang disediakan agent dan otomatis memilihnya untuk
perangkat yang dipasangkan. Anda tidak perlu mencentang tools satu per satu
untuk koneksi yang dibuat dengan alur sederhana ini.

Instruksi siap salin tidak dapat menambahkan kemampuan server pada aplikasi
agent yang memang belum memilikinya. Jika agent hanya mendukung MCP client,
siapkan server/adaptor agent terlebih dahulu. Koneksi inbox tetap bisa digunakan.

## Memahami status dashboard

| Status | Artinya | Langkah berikutnya |
| --- | --- | --- |
| **Inbox siap · menunggu agent mendaftarkan server MCP** | Token inbox tersedia; koneksi balik belum terdaftar | Tempel konfigurasi ke agent dan minta menyelesaikan registrasi server MCP |
| **Inbox siap · server agent belum terhubung** | Endpoint terdaftar tetapi relay belum bisa terhubung | Periksa server agent, URL, transport, dan tokennya |
| **Server agent terhubung · belum menyediakan tools** | Koneksi hidup tetapi daftar tools kosong | Agent perlu menyediakan tools, lalu registrasi ulang atau refresh tools |
| **Server agent terhubung · aktifkan tools di konfigurasi perangkat** | Koneksi hidup tetapi tools tidak aktif untuk perangkat | Periksa perangkat approved, Gemini, token khusus, serta pilihan tools pada **Config** |
| **Terhubung dua arah · … tools** | Server agent tersambung dan tools aktif untuk perangkat | Buka ulang percakapan lalu coba permintaan yang menggunakan tools tersebut |

Relay mencoba menghubungkan ulang server agent yang offline setiap 30 detik.
Status terhubung membuktikan koneksi dan penemuan tools, bukan bahwa semua tugas
agent akan berhasil. Hasil tugas tetap perlu diperiksa.

## Mencoba dan memutus koneksi

Untuk mencoba, minta agent mengirim satu pesan percobaan melalui `notify_send`.
Periksa inbox perangkat di **Memory & Notify**, lalu sapa perangkat untuk mendengar
judulnya. Beep memerlukan perangkat idle dan jalur MQTT yang berfungsi.

Selanjutnya, ucapkan permintaan sesuai tool yang benar-benar tersedia pada agent,
misalnya membuat laporan jika agent menyediakan tool tugas. Tools tugas, status,
dan balasan adalah kemampuan agent; relay tidak membuatnya sendiri.

**Hapus koneksi** mencabut token inbox, menghapus koneksi balik, dan melepas tools
dari perangkat. Pesan yang sudah tersimpan tetap ada sampai kedaluwarsa.
**Tutup** pada teks konfigurasi hanya menyembunyikan teks; koneksi tetap aktif.
Tombol **Konfigurasi untuk agent** menampilkan kembali konfigurasi yang sama.

Jika Anda hanya menghapus server di bagian konfigurasi manual, token inbox dari
pairing masih aktif. Hapus koneksi agent pada panel sederhana untuk mencabutnya.

## Jika koneksi belum berhasil

| Masalah | Yang diperiksa |
| --- | --- |
| Agent tidak bisa mencapai relay | Gunakan domain/IP yang dapat dicapai agent, bukan `localhost` milik mesin lain |
| Relay tidak bisa mencapai agent | URL server agent harus dapat dicapai dari mesin/container relay |
| Token ditolak | Pisahkan token inbox relay dari token server agent; gunakan token yang tepat untuk masing-masing arah |
| Endpoint memakai HTTP | HTTPS diterima secara default; HTTP lokal dan aturan LAN dijelaskan di bagian manual di bawah |
| Agent sudah terhubung tetapi XiaoZhi tidak melihat tools | Gunakan Gemini, periksa pilihan tools, dan buka percakapan baru |
| Menu baru belum muncul | Pastikan image/source yang dijalankan mencakup dashboard terbaru; refresh halaman setelah pembaruan |

Pada Docker biasa, `localhost` di container berarti container itu sendiri.
Jika memakai jaringan host, perilakunya mengikuti jaringan host. Ini berbeda
dari alamat `localhost` pada komputer agent yang berada di tempat lain.

## Konfigurasi manual — untuk administrator

Bagian ini alternatif bila Anda sudah memiliki server MCP dan ingin mengatur
koneksinya sendiri. Untuk penggunaan biasa, gunakan alur salin di atas.

1. Buka **MCP Devices → Konfigurasi MCP manual / lanjutan → Add external MCP**.
2. Isi nama, URL server agent, transport, dan Bearer token bila diperlukan.
   Pilih **Streamable HTTP** untuk server modern; **SSE** untuk server yang memakai
   transport HTTP+SSE lama.
3. Klik **Save & connect**. Lihat status dan **View Tools**.
4. Buka **Xiaozhi Devices → Config → Expose Tools from MCP Devices**, pilih koneksi,
   lalu simpan dan buka ulang percakapan.

Pengaturan tetap disimpan meskipun agent offline. **Reconnect** atau **Refresh tools** mencoba koneksi/penemuan tools secara langsung. Menyimpan, memperbarui,
atau menghapus server menutup percakapan yang memakai koneksi tersebut agar
definisi tools dapat dimuat ulang.

URL diterima bila memakai HTTPS atau HTTP loopback (`localhost`, `127.0.0.1`,
`::1`). Untuk HTTP pada LAN/container tepercaya, administrator perlu mengaktifkan
`MCP_ALLOW_HTTP=true` dan menerapkan ulang konfigurasi server. URL tidak boleh
berisi username/password, parameter query, atau fragment. Masukkan token pada
kolom terpisah. Kolom token kosong saat mengedit mempertahankan token lama;
**Remove saved token** menghapusnya.

Alur manual ini hanya membuat koneksi keluar. Untuk notifikasi masuk, buat
pairing lewat dashboard atau atur pengirim env sesuai [referensi HTTP/MCP](hermes-mcp.md).
`NOTIFY_SENDERS_JSON=[]` menonaktifkan pengirim dari env saja; pairing dashboard
harus dihapus dari dashboard untuk mencabut tokennya.

Koneksi ini tidak menjalankan command lokal `stdio` dan tidak menyediakan login
OAuth, sampling, pembacaan resource, atau elicitation.

## Penyimpanan konfigurasi

Pairing dan token inbox disimpan di `DATA_DIR/agent-connections.json`.
URL server agent dan token koneksi balik disimpan di
`DATA_DIR/remote-mcp-servers.json`. Keduanya berada di volume data yang sama dengan
inbox; izin file adalah `0600` pada sistem POSIX. File bersifat privat tetapi
bukan terenkripsi. Cadangan volume juga memuat token tersebut.

API daftar/status tidak mengembalikan token. Token inbox hanya diberikan pada
pembuatan/export yang diminta administrator; dashboard membersihkan teksnya saat
ditutup atau logout. Konfigurasi rusak tidak otomatis diganti dengan file kosong.
Pengaturan ingress env yang tidak valid tetap menolak akses; perbaiki sebelum
membuat koneksi agent baru.

## Referensi pengembang agent

Agent menyediakan MCP server nyata untuk `initialize`, `tools/list`, dan
`tools/call`. Relay memakai `@modelcontextprotocol/sdk` untuk koneksi keluar,
termasuk respons JSON/SSE dan session ID. Referensi:
[SDK client](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md)
dan [SDK server](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md).

Tool `agent_register` hanya tersedia bagi token pairing dashboard. Argumennya:

```json
{
  "url": "https://agent.example.com/mcp",
  "transport": "streamable-http",
  "token": "TOKEN_SERVER_AGENT"
}
```

Ganti contoh dengan endpoint nyata. `transport` opsional dan defaultnya
`streamable-http`; `token` opsional, terpisah dari token inbox. Jangan mengirim
`device_id` atau ID server pada registrasi: relay mengambil scope dari pairing.
Registrasi hanya memperbarui koneksi milik pairing tersebut. Jika endpoint offline,
respons dapat berisi `registered: true` dan `connected: false`.

Contoh tools bisnis yang **harus diimplementasikan oleh agent**, bukan tools
bawaan relay:

| Tool contoh | Argumen | Hasil yang disarankan |
| --- | --- | --- |
| `agent_submit_task` | `instruction` | `{ "accepted": true, "job_id": "job-123" }` |
| `agent_task_status` | `job_id` | Status tugas dan kemajuan singkat |
| `agent_reply` | `notification_id`, `message` | Konfirmasi penerimaan balasan pengguna |

Setiap tool menyediakan `inputSchema` bertipe object. Maksimal 64 tools unik per
server, dengan schema maksimal 8.000 karakter JSON masing-masing. Gunakan schema
yang kompatibel dengan Gemini.

Relay memasukkan konteks pemanggil dari autentikasi perangkat, bukan pilihan model:

```json
{
  "name": "agent_submit_task",
  "arguments": { "instruction": "Siapkan ringkasan laporan" },
  "_meta": {
    "xiaozhi/device_id": "aa:bb:cc:dd:ee:ff",
    "xiaozhi/session_id": "ID_SESI_PERCAKAPAN"
  }
}
```

Agent memeriksa perangkat tersebut terhadap scope-nya sendiri. Untuk tugas yang
lama, kembalikan job ID/status diterima dalam 30 detik, lanjutkan di antrean agent,
lalu kirim hasil menggunakan `notify_send`:

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "title": "Ringkasan laporan selesai",
  "text": "Hasil ringkasan untuk job-123 sudah tersedia.",
  "idempotency_key": "job-123-complete"
}
```

Simpan `notification_id` dari hasil pengiriman untuk menghubungkan balasan dengan
pesan asli. Jika hasil pengiriman tidak pasti, ulangi hanya dengan key dan isi
yang sama. Key mencegah pembuatan pesan ganda selama record masih disimpan.
Callback tidak bergantung pada percakapan suara yang mengawali tugas.

Nama tools diberi scope internal agar tidak bentrok; nama asli dikirim ke agent.
Hasil tools dibatasi 6.000 karakter JSON dan diperlakukan sebagai data eksternal.
Maksimal empat pemanggilan bersamaan per server. Error/timeout bukan keberhasilan;
relay tidak mengulang aksi otomatis, karena agent mungkin masih menjalankannya.

## API dashboard — untuk pengembang

Endpoint berikut memerlukan sesi admin dan password admin kuat. Perubahan
memerlukan JSON serta header `X-Requested-With: XiaozhiDashboard`.
Respons memakai `Cache-Control: no-store`.

| Endpoint | Fungsi |
| --- | --- |
| `GET /api/agent_connections` | Daftar pairing/status tanpa token |
| `POST /api/agent_connections` | `{name,device_id,public_url}`; membuat pairing dan mengembalikan instruksi + `mcp_config` |
| `POST /api/agent_connections/:id/export` | Menyalin ulang konfigurasi yang sama |
| `DELETE /api/agent_connections/:id` | Mencabut token serta menghapus koneksi balik/tools |
| `GET /api/remote_mcp_servers` | Daftar server keluar tanpa token |
| `POST /api/remote_mcp_servers` | `{id?,name,url,transport,token?,enabled?}`; membuat/mengedit server |
| `POST /api/remote_mcp_servers/:id/connect` | Koneksi ulang dan penemuan tools |
| `DELETE /api/remote_mcp_servers/:id` | Menghapus server dan pilihan tools perangkat |

Pada edit server, `token: null` menghapus token; string kosong mempertahankannya.
Server keluar juga muncul di `GET /api/mcp_devices` untuk pemilihan tools yang
sama dengan penyedia WebSocket lama. Pengingat, pembacaan judul, dan perubahan
MCP terbaru belum menjalani tes lokal pada iterasi ini. Status koneksi perlu
diverifikasi dengan agent, Gemini, dan perangkat yang benar-benar digunakan.
