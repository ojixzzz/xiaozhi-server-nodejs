# Local notification audio

[Beranda Indonesia](../README.md) · [Panduan pengguna](../docs/panduan-pengguna.md) · [Dokumentasi](../docs/README.md)

## Cara sederhana — Bahasa Indonesia

Paket menyediakan `sample-chime.ogg`: nada beep pendek tanpa ucapan. Untuk
pengingat inbox, tidak perlu membuat rekaman baru. Administrator dapat memakai
rekaman lain dengan menaruh file `.ogg` berformat **mono Opus** pada folder ini
lalu mengatur `NOTIFY_BEEP_ASSET` ke nama file tersebut. Mengganti ekstensi MP3/WAV
menjadi `.ogg` saja tidak mengubah format audio.

Untuk uji audio saja, buka **Memory & Notify → Audio-only test (no inbox message)**,
pilih file, klik **Use local audio**, kemudian **Send notification**.
Untuk mencoba pesan inbox dan beep bersama-sama, gunakan **Save message & beep**.
Jangan menaruh file pribadi atau kunci akses di folder rekaman ini.

Bagian Inggris berikut menjelaskan format audio, link sementara, dan konversi
menggunakan FFmpeg untuk administrator. Perintah konversi bukan langkah wajib
bila menggunakan sample bawaan.

`sample-chime.ogg` is a generated five-second **two-beep test tone, with no speech**. It is
mono Ogg Opus, encoded from 16 kHz PCM using 20 ms Opus frames. It is not a spoken
reminder or evidence that notification playback works on a physical device.
Opus decoders/ffprobe normally report a 48 kHz decoding clock even for this input.

## Configure

- Set `NOTIFY_AUDIO_BASE_URL` to the explicit HTTPS **origin** reachable by the
  device, e.g. `https://relay.example.com` (no path, credentials, query, or fragment)
- Supply your own `MQTT_GATEWAY_KEY` of 32–512 characters. Known example
  placeholders, including the shipped `REPLACE_ME...` values, never enable audio. The server derives a
  domain-separated signing key in memory; it never generates or saves a key
- `NOTIFY_AUDIO_DIR` defaults to this directory. Mount your recordings there
  read-only in Docker. Do not place private or secret files in the directory
- Add that same public origin to `NOTIFY_ALLOWED_AUDIO_ORIGINS`
- Local HTTP is available only with the explicit `NOTIFY_ALLOW_HTTP=true` option
  on a trusted network. HTTP exposes the recording and its temporary bearer link
- Configure and start the MQTT gateway before enabling MQTT for an approved
  device. Saving transport is an explicit action that closes the current voice connection;
  reboot/fetch OTA configuration
  on that device after changing it

In **Memory & Notify**, select a local recording and choose **Use local audio**.
This creates a five-minute URL without sending a notification. Check the device,
recording and subtitle, then press **Send notification** separately. Creating or
selecting an audio URL does not synthesize speech or call a paid API.

Anyone with a signed link can download that one recording until the link expires.
Do not publish the link or log its query string. Rotation of `MQTT_GATEWAY_KEY`
invalidates existing links and also changes gateway credentials. Authenticated
administrator routes list assets and issue links; only the expiring download
route is public, because stock firmware cannot add an Authorization header.

## Add recordings

Use a basename such as `meeting-reminder.ogg`: ASCII letters, numbers, `_`, `-`
and `.`, starting with a letter or digit, lowercase `.ogg` extension, no `..`,
and at most 124 characters. Only regular files of at most 5 MiB with a mono Opus
identification page are offered. Symlinks, nested directories and arbitrary URL
fetches are not supported. Install only trusted, fully validated recordings;
the server checks the container identification header, not every audio packet.
Use 20 ms frames for the bundled stock-firmware path and keep recordings short.

The dashboard returns at most 100 valid recordings and scans at most 500 directory
entries, in filesystem order, before sorting the selected names for display. This
can be a partial list in a large directory. Keep this dedicated directory small
and remove unrelated files if a recording is missing from the dropdown.

Example offline conversion using an installed FFmpeg:

```sh
ffmpeg -i your-recording.wav -ac 1 -ar 16000 -c:a libopus \
  -b:a 24k -frame_duration 20 notification-audio/meeting-reminder.ogg
ffprobe -v error -show_entries stream=codec_name,channels \
  -show_entries format=duration -of json notification-audio/meeting-reminder.ogg
```

Reproduce the bundled sample locally (no network/API):

```sh
ffmpeg -f lavfi -i 'anullsrc=r=16000:cl=mono' \
  -f lavfi -i 'sine=frequency=880:duration=0.18:sample_rate=16000' \
  -filter_complex '[1:a]volume=0.2,afade=t=in:d=0.01,afade=t=out:st=0.15:d=0.03,asplit=2[a][b];[a]adelay=80[a1];[b]adelay=420[b1];[0:a][a1][b1]amix=inputs=3:duration=first:normalize=0[out]' \
  -map '[out]' -t 5 -ac 1 -ar 16000 -c:a libopus -b:a 24k -frame_duration 20 \
  -metadata title='Two notification beeps - no speech' notification-audio/sample-chime.ogg
```

A publication result does not prove playback or that anyone heard it. Stock
firmware may ignore notifications while busy; there is no offline queue or heard
acknowledgement. Retrying with a new request ID can duplicate playback.
