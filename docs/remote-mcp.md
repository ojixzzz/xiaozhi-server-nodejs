# Menghubungkan agent: MCP dua arah

**Bahasa Indonesia** · [English](remote-mcp.en.md) · [Semua dokumentasi](README.md)

Repo source: [ojixzzz/xiaozhi-server-nodejs](https://github.com/ojixzzz/xiaozhi-server-nodejs).
Tombol **Salin untuk agent** di dashboard menyertakan tautan repo, panduan ini,
dan folder contoh agar agent dapat menemukan file integrasinya.

Cukup salin **MCP_ENDPOINT** dari dashboard, lalu jalankan server MCP lokal agent
lewat `mcp_pipe.py`. Polanya sama seperti proyek `xiaozhi-esp32-server` dan contoh
`mcp-calculator`: agent menyambung ke relay lewat WebSocket, sedangkan tools di
mesin agent berjalan melalui stdio. Agent tidak perlu membuka port HTTP publik.

Dua arah yang tersedia:

| Arah | Kegunaan |
| --- | --- |
| XiaoZhi → agent | Gemini memanggil tools lokal agent untuk tugas atau balasan |
| Agent → XiaoZhi | Agent mengirim judul dan isi ke inbox, termasuk hasil tugas setelah percakapan selesai |

## 1. Salin endpoint dari dashboard

Server dan percakapan Gemini perlu sudah berfungsi. Perangkat harus **approved**
dan memiliki token sendiri.

1. Buka **MCP Devices → Hubungkan agent · MCP dua arah**.
2. Pilih perangkat dan isi nama agent bila diperlukan.
3. Periksa **Alamat dashboard yang bisa diakses agent**. Jika agent ada di mesin
   lain, gunakan domain/IP relay yang dapat dijangkau, bukan `localhost` mesin agent.
4. Klik **Buat endpoint**, lalu **Salin MCP_ENDPOINT**. **Salin untuk agent**
   menyalin petunjuk lengkap jika Anda ingin agent menyiapkan integrasinya.
5. Simpan endpoint sebagai environment pada mesin agent.

```sh
export MCP_ENDPOINT='wss://relay.example.com/mcp_endpoint/mcp/?token=TOKEN_DARI_DASHBOARD'
```

Contoh di atas adalah placeholder: salin URL lengkap yang dibuat dashboard.
URL ini **berisi token rahasia khusus satu perangkat**; jangan masukkan ke repo,
log, atau tangkapan layar publik. HTTPS dashboard menghasilkan `wss://`; HTTP
menghasilkan `ws://`. Gunakan TLS untuk koneksi melalui internet.

Tidak perlu mengubah `.env` server atau melakukan restart hanya untuk membuat
pairing. Pengaturan agent dan token disimpan pada volume data server.

## 2. Jalankan MCP lokal

Jika sudah memakai proyek `mcp-calculator`, jalankan perintah yang sama di folder
proyek tersebut setelah mengisi environment:

```sh
python mcp_pipe.py calculator.py
```

Pipe dari contoh tersebut dapat dipakai tanpa mengubah framing JSON-RPC-nya.
Untuk contoh yang disertakan dalam repo ini, buka
[examples/mcp-endpoint](../examples/mcp-endpoint/README.md), gunakan Python **3.11+**,
lalu jalankan:

```sh
cd examples/mcp-endpoint
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export MCP_ENDPOINT='URL_LENGKAP_DARI_DASHBOARD'
python mcp_pipe.py agent.py
```

`agent.py` menyediakan contoh `agent_echo` dan `agent_notify`. Ganti fungsi contoh
dengan integrasi Hermes/agent Anda. Tidak ada instance Hermes atau antrean tugas
nyata yang otomatis disiapkan oleh relay.

Server MCP agent perlu menyediakan tools melalui **stdio**: input/output JSON-RPC
per baris. Tools bisa dibuat dengan FastMCP seperti calculator. Program Node.js
atau command lain juga bisa dijalankan:

```sh
python mcp_pipe.py -- node /path/to/agent-mcp-server.js
```

Tanpa argumen, pipe membaca `mcp_config.json` atau file pada `MCP_CONFIG`.
Setiap server stdio mendapat koneksi sendiri ke endpoint yang sama; nama tools
yang sama tidak saling menimpa. Contoh pipe bawaan hanya menjalankan stdio;
HTTP/SSE lokal memerlukan adaptor, atau gunakan pengaturan HTTP lanjutan di bawah.

Setelah tools ditemukan, relay otomatis memilih koneksi untuk perangkat pasangan.
Tunggu **Terhubung dua arah · … tools**, lalu buka ulang percakapan XiaoZhi.
Discovery, putus koneksi, dan sambung ulang pipe tidak menutup percakapan aktif.
Tools baru dimuat pada percakapan berikutnya. Tool dari koneksi lama yang sudah
putus tidak diteruskan ke koneksi baru; buka ulang percakapan untuk memakai tools
yang sudah tersambung kembali. Jika Anda mengubah tools saat agent berjalan,
restart pipe untuk menemukan daftar tools baru. Menghapus/mencabut koneksi atau
mengubah pengaturan HTTP lanjutan melalui dashboard tetap menutup sesi terkait.

## 3. Agent mengirim inbox memakai endpoint yang sama

Calculator asli hanya menyediakan tool hitung; menjalankannya tidak mengirim
notifikasi. Untuk mengirim hasil dari agent custom, gunakan helper bawaan:

```python
from xiaozhi_notify import notify_send

receipt = notify_send(
    title="Laporan selesai",
    text="Ringkasan laporan sudah tersedia.",
    idempotency_key="job-123-complete",
)
```

Helper membaca **MCP_ENDPOINT yang sama**, mengambil token, lalu mengirim lewat
HTTP(S) ke `/api/notifications` pada relay. `device_id` diambil dari pairing;
tidak perlu alamat, token, atau konfigurasi tambahan. Helper tetap dapat dipakai
setelah percakapan suara selesai, bahkan ketika koneksi tools sedang offline.
Untuk fungsi async, jalankan helper sinkron ini lewat `asyncio.to_thread`.

Untuk mengirim satu pesan secara eksplisit dari terminal:

```sh
python xiaozhi_notify.py --title 'Laporan selesai' --text 'Hasil siap dibaca.' --idempotency-key 'job-123-complete'
```

`stored: true` mengonfirmasi pesan sudah disimpan, bukan bahwa beep sudah terdengar.
Simpan `notification_id` untuk menghubungkan balasan pengguna ke pesan asli.
Gunakan key unik per pesan; jika pengiriman belum pasti, periksa inbox dan ulangi
hanya dengan **key serta isi yang sama**. Helper tidak mengulang pengiriman otomatis.

Inbox dan pengingat tetap bekerja seperti sebelumnya: beep dicoba setiap satu
menit hingga read, berhenti sementara selama percakapan, dan sapaan “halo”, “apa”,
atau “ada apa” membacakan **judul dahulu**. Detail ada di
[panduan pengguna](panduan-pengguna.md).

## Memahami status dan masalah umum

| Status / gejala | Langkah berikutnya |
| --- | --- |
| **Inbox siap · menunggu koneksi MCP pipe** | Isi MCP_ENDPOINT dan jalankan pipe di mesin agent |
| **Menghubungkan MCP · membaca daftar tools…** | Tunggu handshake; periksa stderr server jika tidak selesai |
| **MCP terhubung · belum menyediakan tools** | Tambahkan tools pada server MCP lalu restart pipe |
| **MCP terhubung · aktifkan tools di konfigurasi perangkat** | Periksa Gemini, token perangkat dan pilihan tools pada Config |
| **Terhubung dua arah · … tools** | Buka percakapan baru dan gunakan tool yang tersedia |
| **Inbox siap · MCP belum terhubung** | Periksa endpoint, jaringan, proses agent dan pesan status |
| Sambungan ditolak | Perangkat harus approved, bertoken khusus, memakai Gemini; token pairing belum dicabut |
| Tools tidak terlihat setelah perubahan | Restart pipe dan buka ulang percakapan |
| WebSocket gagal melalui domain | Reverse proxy harus meneruskan Upgrade WebSocket ke port dashboard |

Pipe bawaan mencoba menyambung kembali dengan jeda 1–60 detik. Pemanggilan tool
lama tidak diulang otomatis karena agent mungkin sudah menjalankannya. Perangkat
XiaoZhi dan agent tidak harus berada dalam LAN yang sama; agent cukup bisa
menjangkau relay. `localhost` pada container/komputer lain menunjuk mesin itu sendiri.

**Hapus koneksi** mencabut token endpoint dan inbox, menutup semua pipe milik
pairing, serta melepas tools dari perangkat. Pesan yang tersimpan tetap ada hingga
retensinya habis. **Tutup** hanya menyembunyikan teks. **Konfigurasi untuk agent**
menampilkan endpoint yang sama tanpa mengganti token.

## Referensi pengembang: WebSocket dan konteks tool

Endpoint utama: `/mcp_endpoint/mcp/?token=TOKEN_PAIRING`. Token Bearer di header
juga diterima untuk bridge custom; bila header dan query sama-sama diberikan,
keduanya harus cocok. Endpoint ini memakai transport WebSocket khusus yang
mengikuti pipe calculator. Ia tidak menggantikan endpoint MCP Streamable HTTP.

Relay bertindak sebagai MCP client melalui SDK: `initialize`,
`notifications/initialized`, `tools/list` (termasuk pagination), lalu `tools/call`.
Satu frame teks berisi satu object JSON-RPC. Payload maksimal 256 KiB; handshake
maksimal 10 detik. Maksimal 16 provider bersamaan dan 64 tools per pairing,
64 provider global, schema tool maksimal 8.000 karakter JSON.

Nama tools diberi alias internal agar tidak bentrok; nama asli dikirim ke agent.
Konteks pemanggil berasal dari autentikasi perangkat:

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "tools/call",
  "params": {
    "name": "agent_submit_task",
    "arguments": { "instruction": "Siapkan laporan" },
    "_meta": {
      "xiaozhi/device_id": "aa:bb:cc:dd:ee:ff",
      "xiaozhi/session_id": "ID_SESI_PERCAKAPAN"
    }
  }
}
```

`agent_submit_task`, `agent_task_status`, dan `agent_reply` adalah contoh tools
bisnis yang perlu dibuat agent sendiri. Agent harus memeriksa scope perangkatnya.
Untuk pekerjaan lama, kembalikan status `accepted` dan `job_id` dalam 30 detik,
kerjakan di antrean agent, lalu kirim hasil melalui helper inbox. Maksimal empat
pemanggilan bersamaan per provider; hasil dibatasi 6.000 karakter JSON dan dianggap
data eksternal. Error atau timeout memiliki hasil eksekusi tidak pasti, tidak
boleh dianggap sukses atau diulang otomatis.

Bridge WebSocket custom juga dapat mengirim inbox **langsung pada sambungan sama**:

```json
{
  "jsonrpc": "2.0",
  "id": "notify-job-123",
  "method": "xiaozhi/notify",
  "params": {
    "title": "Laporan selesai",
    "text": "Hasil siap dibaca.",
    "idempotency_key": "job-123-complete"
  }
}
```

Alternatif framing: `tools/call` dengan `params.name: "notify_send"` dan payload
pada `params.arguments`. Ini **ekstensi relay untuk arah server → client**, bukan
fitur bawaan setiap MCP stdio SDK. Jangan memasukkan request custom ini ke stdout
FastMCP tanpa bridge yang bisa memisahkan request/response. Untuk server stdio
biasa, gunakan helper HTTP di atas.

Relay membalas ID yang sama dengan `result.content`, `result.structuredContent`
(receipt), dan `result.isError`. Request inbox wajib ber-ID; fire-and-forget tidak
disimpan. Device diambil dari token; ID device berbeda ditolak. Token yang dicabut
menolak kiriman baru. Duplikasi pesan ditangani oleh `idempotency_key` inbox.

## HTTP/SSE lanjutan dan integrasi lama

Integrasi lama tetap tersedia. Gunakan bagian
**MCP Devices → Konfigurasi MCP manual / lanjutan → Add external MCP** bila agent
sudah menyediakan server Streamable HTTP atau SSE yang dapat dijangkau relay.
Simpan nama, URL, transport dan token server terpisah. Pilih koneksi pada
**Xiaozhi Devices → Config → Expose Tools from MCP Devices**, lalu buka ulang
percakapan. **Reconnect / Refresh tools** memuat ulang tools.

HTTPS dan HTTP loopback diterima. HTTP LAN/container memerlukan `MCP_ALLOW_HTTP=true`.
URL server HTTP tidak boleh memuat kredensial, query atau fragment. Kolom token
kosong saat edit mempertahankan token lama; **Remove saved token** menghapusnya.
Pengaturan lanjutan ini membuat koneksi keluar saja; inbox memakai pairing dashboard
atau pengirim env pada [referensi ingress HTTP/MCP](hermes-mcp.md).

Export admin tetap menyertakan `mcp_config` HTTP untuk klien lama, menuju
`/mcp/notifications`. Token pairing tersebut tetap dapat memakai `agent_register`
dengan `{url,transport?,token?}` untuk memilih server HTTP-nya otomatis. Token
server agent harus terpisah dari token pairing. **Alur pipe tidak memerlukan
agent_register**. Menghapus server HTTP manual tidak mencabut token pairing;
hapus pairing di panel utama untuk mencabut seluruh akses.

## Penyimpanan, proxy, dan API admin

`DATA_DIR/agent-connections.json` menyimpan pairing serta token endpoint/inbox;
`DATA_DIR/remote-mcp-servers.json` menyimpan koneksi HTTP lanjutan. Izin POSIX
`0600`, privat tetapi tidak terenkripsi. Cadangan volume memuat token. Pairing
lama dapat diexport ulang untuk mendapatkan URL WebSocket memakai token yang sama;
tidak perlu migrasi inbox atau volume. API status tidak mengembalikan token.
Dashboard menghapus teks rahasia saat ditutup/logout.

Endpoint memakai port dashboard yang sama; tidak perlu service endpoint tambahan.
Proxy harus meneruskan `/mcp_endpoint/mcp/` dan header Upgrade. Hindari mencatat
query token dalam access log proxy. Helper perlu akses `/api/notifications` juga.

| Endpoint admin | Fungsi |
| --- | --- |
| `GET /api/agent_connections` | Status tanpa token, termasuk jumlah tools/provider |
| `POST /api/agent_connections` | `{name,device_id,public_url}` → pairing, `mcp_endpoint`, `environment`, instruksi, dan export HTTP lama |
| `POST /api/agent_connections/:id/export` | Menampilkan ulang konfigurasi yang sama |
| `DELETE /api/agent_connections/:id` | Mencabut endpoint/inbox dan tools |
| `GET /api/remote_mcp_servers` | Daftar server HTTP lanjutan tanpa token |
| `POST /api/remote_mcp_servers` | `{id?,name,url,transport,token?,enabled?}` |
| `POST /api/remote_mcp_servers/:id/connect` | Koneksi ulang HTTP dan penemuan tools |
| `DELETE /api/remote_mcp_servers/:id` | Menghapus server HTTP dan pilihan tools |

API memerlukan sesi admin dengan password kuat; mutasi memerlukan JSON dan
`X-Requested-With: XiaozhiDashboard`. Respons admin memakai `Cache-Control: no-store`.
Sampling, resource, OAuth, dan elicitation tidak disediakan oleh integrasi ini.
Tes untuk transport dan scope tersedia di source, tetapi perubahan ini belum
menjalani tes/build lokal atau verifikasi dengan agent/perangkat nyata.
