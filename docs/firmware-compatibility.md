# Firmware compatibility evidence and limits

[Beranda](../README.md) · [Instalasi](SETUP_ID.md) · [Semua dokumentasi](README.md)

**Ringkasan Bahasa Indonesia:** halaman ini mencatat pemeriksaan source firmware,
bukan bukti program yang sedang terpasang pada perangkat Anda. Perangkat perlu
mendukung notifikasi dan tetap online untuk beep. Perangkat yang tidur dalam atau
mati tidak dapat dibangunkan oleh jalur ini. Bagian Inggris berikut menyimpan
referensi commit dan batas bukti teknisnya.

This is source/protocol evidence, **not proof of the firmware binary currently
installed on your board**. No minimum firmware release number is claimed.

## Pinned references

- Firmware: [78/xiaozhi-esp32 at
  0d576d3d4c049c6f55eaf879725dc23e516511b4](https://github.com/78/xiaozhi-esp32/tree/0d576d3d4c049c6f55eaf879725dc23e516511b4)
- Gateway wire reference: [78/xiaozhi-mqtt-gateway at
  c5e3235df8db8f06d1710074ec10e870159e0844](https://github.com/78/xiaozhi-mqtt-gateway/tree/c5e3235df8db8f06d1710074ec10e870159e0844)

The firmware MQTT, OTA and application source snapshots used during implementation
were downloaded from official main on 2026-10-07. An independent pinned checkout
was subsequently obtained; all three files matched those snapshots byte-for-byte.
The gateway implementation and wire-device mock are separate implementations;
the mock does not import the gateway's MQTT, credential or UDP codec helpers.

## Evidence matrix

| Area | Evidence | Remaining limit |
| --- | --- | --- |
| MQTT credentials/control | HMAC credentials, MQTT 3.1.1, device topics and protocol-v3 hello compared with pinned source; independent wire mock authenticates against the actual gateway | Not executed on ESP32 networking hardware |
| Audio bridge | Independent AES-CTR UDP framing and real Opus encode/decode roundtrips through actual Node/WebSocket gateway, including goodbye/reconnect | Microphone, speaker, acoustic quality and actual firmware timing not tested |
| Notification JSON | Pinned application accepts type notify, audio_url and timed subtitle arrays; actual gateway tests deliver the same shape | Firmware may ignore it while busy; publication never proves playback |
| Sample audio | Pinned firmware OggDemuxer, unchanged except external logging macros, successfully parses sample-chime.ogg at four chunk sizes | This tests Ogg/Opus packet parsing, not the Opus decoder/DAC/speaker or HTTP client |
| OTA clock | Confirmed firmware expects UTC epoch milliseconds plus timezone_offset in minutes; both pending/approved relay paths corrected and regression-tested | Static offset needs operator selection; no automatic DST/location inference |
| TLS and networking | Stock MQTT drivers select TLS on port 8883; guide uses that port and trusted certificates | Actual certificate trust, NAT, container networking and public routing untested |
| Board power state | Pinned Spotpear 1.28 Box source includes battery idle shutdown/deep sleep | Offline/deep-sleep hardware cannot receive or be awakened by this MQTT notification |

## Corrected OTA clock units

Earlier relay code sent offsets 28800 and 3600, treating the field as seconds.
The audited firmware multiplies the field by 60, so those values were incorrect.
The relay now uses `DEVICE_TIMEZONE_OFFSET_MINUTES`: integer -720 through 840,
with the explicit package default 420 (WIB / UTC+7). Set 0 for UTC, 480 for UTC+8,
etc. The timestamp is not pre-shifted. This default is not an inferred user setting.

Source: [pinned ota.cc](https://github.com/78/xiaozhi-esp32/blob/0d576d3d4c049c6f55eaf879725dc23e516511b4/main/ota.cc).

## Spotpear 1.28 Box power caveat

For the specific board at
[main/boards/spotpear/sp-esp32-s3-1.28-box/sp-esp32-s3-1.28-box.cc](https://github.com/78/xiaozhi-esp32/blob/0d576d3d4c049c6f55eaf879725dc23e516511b4/main/boards/spotpear/sp-esp32-s3-1.28-box/sp-esp32-s3-1.28-box.cc),
the inspected implementation configures idle display saving after 60 seconds and
shutdown/deep sleep after 290 seconds when its battery power-save timer is enabled.
Charging disables that timer; the shared power-save helper also checks the saved
wifi sleep_mode preference. These are source behaviors, not a remotely verified
state of your device or every board branded Xiaozhi.

For a sustained standby-notification test, use the board in a powered/charging
state that keeps its network connection active and verify it remains online.
MQTT cannot wake a powered-off or deep-sleep board. Text still persists in the
server inbox if the beep cannot be delivered; after waking/reconnecting, ask
Gemini for it. This package does not silently change firmware power policy, NVS
settings or flash an image. Power-policy changes would need a separate conscious
operator decision, with battery-life implications.

## Independent parser check, reproducible separately from npm

The independent audit compiled the pinned firmware `OggDemuxer` with only logging
stubbed. For chunk sizes 1, 31, 1024 and 4096 bytes, the sample finished without
parser errors: 51 packets, all 20 ms, 16000 Hz metadata. A reproduction harness
is included under `scripts/firmware-audit/`; the firmware parser itself is not
copied or modified in this package.

Given an existing clean checkout at the exact pin and a C++20 compiler:

```sh
sh scripts/firmware-audit/check-sample.sh /path/to/pinned/xiaozhi-esp32
```

The script checks the commit and parser working-tree cleanliness, compiles into
a temporary directory and removes the temporary executable afterward. It makes
no download and no device/API call. This optional test is **not counted in npm
test**, and does not require the full ESP-IDF toolchain. Firmware source retains
its upstream MIT license; see that checkout's LICENSE.

## Required physical acceptance test

Confirm your exact board/build includes notify, retain the old OTA configuration,
and test one owned device: working WebSocket speech → MQTT speech → return to
online Idle → two-beep notification → greet to hear titles → completed-title
read acknowledgment → ask for message details. Test a charging/standby interval longer than the board's idle
shutdown threshold. Check wake/cancel and rollback as well.

Docker build/run, actual ESP32 execution, real Gemini/Hermes, audible playback and
production TLS were not tested in this workspace. Stock UDP remains unauthenticated
AES-CTR with inherited confidentiality limits; MQTT TLS does not repair it.
Keep the audio transport on a trusted private network.
