# Protocol and license attribution

This gateway interoperates with the Xiaozhi MQTT/UDP wire protocol. The credential
format and bridge packet layout were adapted from:

- [78/xiaozhi-mqtt-gateway](https://github.com/78/xiaozhi-mqtt-gateway), commit
  `c5e3235df8db8f06d1710074ec10e870159e0844`
- Relevant upstream files: `utils/mqtt_config_v2.js`, `app.js`, `mqtt-protocol.js`
- Copyright (c) 2025 Xiaoxia, MIT license, preserved in `LICENSE.upstream`

The parser, connection lifecycle, private HTTP forwarding API, Node-device
registry integration, bounds, and tests in this directory are a local
implementation. This is not the upstream service and does not implement or claim
compatibility with a Redis RPC API.

The following official sources were inspected for interoperability on 2026-10-07
(no firmware source is bundled here):

- [Firmware MQTT handshake and UDP framing](https://github.com/78/xiaozhi-esp32/blob/main/main/protocols/mqtt_protocol.cc)
- [Firmware OTA configuration](https://github.com/78/xiaozhi-esp32/blob/main/main/ota.cc)
- [ESP Wi-Fi MQTT transport and TLS selection](https://github.com/78/esp-ml307/blob/main/src/esp/esp_mqtt.cc)
- [ML307 MQTT transport](https://github.com/78/esp-ml307/blob/main/src/ml307/ml307_mqtt.cc)

The main-branch firmware links are mutable. Compatibility tests are protocol
mocks, not a claim that every firmware version or physical board was tested.
