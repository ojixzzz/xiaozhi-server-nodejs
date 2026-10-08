# Contoh MCP endpoint dua arah

**Indonesia** · [English](README.en.md) · [Panduan lengkap](../../docs/remote-mcp.md)

Gunakan Python **3.11+**. Buka terminal di folder ini, kemudian:

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Buka dashboard → **MCP Devices → Hubungkan agent · MCP dua arah** → pilih perangkat
Gemini → **Buat endpoint → Salin MCP_ENDPOINT**. Isi URL lengkap dari dashboard:

```sh
export MCP_ENDPOINT='URL_LENGKAP_DARI_DASHBOARD'
python mcp_pipe.py agent.py
```

Pada Windows PowerShell, set environment dengan `$env:MCP_ENDPOINT='URL_LENGKAP'`
dan aktifkan virtualenv melalui `.venv\Scripts\Activate.ps1`.

| File | Untuk apa |
| --- | --- |
| [mcp_pipe.py](mcp_pipe.py) | Menyambungkan stdio lokal ke endpoint WebSocket |
| [agent.py](agent.py) | Contoh `agent_echo` dan `agent_notify`; ganti dengan tools agent Anda |
| [calculator.py](calculator.py) | Contoh hitung dua angka, tanpa eval atau pengiriman notif otomatis |
| [xiaozhi_notify.py](xiaozhi_notify.py) | Mengirim inbox dengan MCP_ENDPOINT yang sama |
| [mcp_config.json](mcp_config.json) | Alternatif untuk menjalankan beberapa server stdio |

Untuk calculator saja: `python mcp_pipe.py calculator.py`. Calculator/pipe dari
proyek contoh pengguna juga dapat dipakai langsung dengan endpoint ini. Untuk
Node.js: `python mcp_pipe.py -- node /path/to/server.js`. Tanpa argumen, pipe
membaca `mcp_config.json` (atau `MCP_CONFIG`). Command berjalan relatif terhadap
folder terminal; gunakan path absolut bila diperlukan.

Arah XiaoZhi → agent: setelah tools tersambung, buka ulang percakapan lalu minta
menggunakan `agent_echo`. Ini hanya contoh echo, belum menjalankan Hermes nyata.
Arah agent → XiaoZhi: dari tools/background job custom, impor helper:

```python
from xiaozhi_notify import notify_send

receipt = notify_send("Laporan selesai", "Hasil sudah tersedia.", "job-123-complete")
```

Atau kirim satu pesan secara eksplisit di terminal kedua dengan environment sama:

```sh
python xiaozhi_notify.py --title 'Laporan selesai' --text 'Hasil sudah tersedia.' --idempotency-key 'job-123-complete'
```

Helper memakai HTTP(S) relay yang diturunkan dari MCP_ENDPOINT, tanpa token/device
lain. CLI membaca `.env` bila ada; fungsi impor membaca environment proses.
`stored: true` berarti tersimpan; beep mungkin belum terdengar. Key harus unik per
pesan. Saat hasil tidak pasti, periksa inbox dan ulangi hanya dengan key/isi sama.
Dalam tool async gunakan `await asyncio.to_thread(notify_send, title, text, key)`.

Jangan mencetak pesan/log ke stdout server MCP; stdout hanya JSON-RPC. Gunakan
stderr. Pipe tidak mencetak URL/token dan tidak mengulang tool call lama saat
reconnect. Koneksi yang putus akan memulai ulang proses server lokal, jadi simpan
job lama pada penyimpanan/antrean terpisah bila ingin tetap berjalan. Hentikan
pipe dengan Ctrl+C. Restart pipe bila tools berubah.

MCP_ENDPOINT berisi rahasia satu perangkat. Jangan commit `.env`, log atau token.
Contoh ini tidak mengirim apa pun saat startup. Belum dijalankan/dites pada perubahan ini.
