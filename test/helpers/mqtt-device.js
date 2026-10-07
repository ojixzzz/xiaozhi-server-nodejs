'use strict';

// Independent, loopback-only MQTT 3.1.1 protocol device used by integration tests.
// This is a wire-protocol mock, not execution of ESP32 firmware. Its hello and
// UDP framing follow xiaozhi-esp32/main/protocols/mqtt_protocol.cc; no production
// gateway codec or credential helper is imported here.
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');

function mqttString(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function mqttPacket(firstByte, body = Buffer.alloc(0)) {
  const length = [];
  let remaining = body.length;
  do {
    const digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    length.push(digit | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.concat([Buffer.from([firstByte, ...length]), body]);
}

class Inbox {
  constructor() { this.items = []; this.waiters = []; }

  push(item) {
    const index = this.waiters.findIndex(waiter => waiter.predicate(item));
    if (index < 0) { this.items.push(item); return; }
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(item);
  }

  wait(predicate = () => true, timeoutMs = 5000) {
    const index = this.items.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for mock MQTT device traffic'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  dispose() {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Mock MQTT device closed'));
    }
  }
}

class MqttDevice {
  constructor(config, { autoReplyMcp = true } = {}) {
    this.config = config;
    this.autoReplyMcp = autoReplyMcp;
    this.buffer = Buffer.alloc(0);
    this.packets = new Inbox();
    this.messages = new Inbox();
    this.audio = new Inbox();
    this.history = [];
    this.udpHistory = [];
    this.errors = [];
    this.sequence = 0;
    this.closed = false;
  }

  async connect({ host = '127.0.0.1', port, keepAlive = 30, fragmented = false } = {}) {
    if (!port) throw new Error('Tests must supply an explicit loopback MQTT port');
    if (host !== '127.0.0.1') throw new Error('Mock device is restricted to loopback');
    this.socket = net.createConnection({ host, port });
    this.socket.on('data', data => this.receive(data));
    this.socket.on('error', error => this.errors.push(error));
    this.socket.on('close', () => { this.closed = true; });
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    const protocol = Buffer.from([4, 0xc2, keepAlive >> 8, keepAlive & 255]);
    const packet = mqttPacket(0x10, Buffer.concat([
      mqttString('MQTT'), protocol,
      mqttString(this.config.client_id), mqttString(this.config.username), mqttString(this.config.password)
    ]));
    if (fragmented) {
      this.socket.write(packet.subarray(0, 1));
      await new Promise(resolve => setImmediate(resolve));
      this.socket.write(packet.subarray(1, 4));
      await new Promise(resolve => setImmediate(resolve));
      this.socket.write(packet.subarray(4));
    } else this.socket.write(packet);
    const connack = await this.packets.wait(packet => packet.type === 2);
    if (connack.body.length !== 2) throw new Error('Invalid MQTT CONNACK length');
    return connack.body[1];
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      let length = 0;
      let multiplier = 1;
      let offset = 1;
      let digit;
      do {
        if (offset >= this.buffer.length) return;
        digit = this.buffer[offset++];
        length += (digit & 127) * multiplier;
        multiplier *= 128;
        if (offset > 5) throw new Error('Invalid MQTT remaining length');
      } while (digit & 128);
      if (this.buffer.length < offset + length) return;
      const firstByte = this.buffer[0];
      const body = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const packet = { type: firstByte >> 4, firstByte, body };
      if (packet.type !== 3) { this.packets.push(packet); continue; }
      const topicLength = body.readUInt16BE(0);
      const topic = body.toString('utf8', 2, 2 + topicLength);
      const qos = (firstByte >> 1) & 3;
      const payload = JSON.parse(body.subarray(2 + topicLength + (qos ? 2 : 0)).toString('utf8'));
      const message = { topic, payload, qos, retained: Boolean(firstByte & 1) };
      this.history.push(message);
      this.messages.push(message);
      if (this.autoReplyMcp && payload.type === 'mcp') this.replyMcp(payload.payload);
    }
  }

  replyMcp(request) {
    if (!request || request.id === undefined) return;
    let result;
    if (request.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'loopback-device-mock', version: '1.0.0' } };
    } else if (request.method === 'tools/list') result = { tools: [] };
    else return;
    this.publish({ type: 'mcp', payload: { jsonrpc: '2.0', id: request.id, result } });
  }

  publish(payload, topic = this.config.publish_topic || 'device-server') {
    this.socket.write(mqttPacket(0x30, Buffer.concat([mqttString(topic), Buffer.from(JSON.stringify(payload))])));
  }

  async subscribe(topic, packetId = 1) {
    const id = Buffer.alloc(2); id.writeUInt16BE(packetId);
    this.socket.write(mqttPacket(0x82, Buffer.concat([id, mqttString(topic), Buffer.from([0])])));
    const result = await this.packets.wait(packet => packet.type === 9 && packet.body.readUInt16BE(0) === packetId);
    return result.body[2];
  }

  async ping() {
    this.socket.write(mqttPacket(0xc0));
    return this.packets.wait(packet => packet.type === 13);
  }

  waitForMessage(predicate, timeoutMs) {
    return this.messages.wait(message => predicate(message.payload, message), timeoutMs);
  }

  async openAudio({ features = { mcp: true } } = {}) {
    this.publish({
      type: 'hello', version: 3, transport: 'udp', features,
      audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 }
    });
    const { payload } = await this.waitForMessage(message => message.type === 'hello');
    this.hello = payload;
    this.sequence = 0;
    if (payload.udp?.server !== '127.0.0.1') throw new Error('Tests must receive a loopback UDP destination');
    if (this.udp) await new Promise(resolve => this.udp.close(resolve));
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', error => this.errors.push(error));
    this.udp.on('message', data => {
      this.udpHistory.push(Buffer.from(data));
      this.audio.push(Buffer.from(data));
    });
    await new Promise(resolve => this.udp.bind(0, '127.0.0.1', resolve));
    return payload;
  }

  async sendAudio(opus, timestamp = 0) {
    const header = Buffer.from(this.hello.udp.nonce, 'hex');
    header.writeUInt16BE(opus.length, 2);
    header.writeUInt32BE(timestamp, 8);
    header.writeUInt32BE(++this.sequence, 12);
    const cipher = crypto.createCipheriv('aes-128-ctr', Buffer.from(this.hello.udp.key, 'hex'), header);
    const packet = Buffer.concat([header, cipher.update(opus), cipher.final()]);
    await new Promise((resolve, reject) => this.udp.send(packet, this.hello.udp.port, this.hello.udp.server, error => error ? reject(error) : resolve()));
    return packet;
  }

  async receiveAudio(timeoutMs = 5000) {
    const packet = await this.audio.wait(() => true, timeoutMs);
    const header = packet.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-128-ctr', Buffer.from(this.hello.udp.key, 'hex'), header);
    return { packet, header, opus: Buffer.concat([decipher.update(packet.subarray(16)), decipher.final()]) };
  }

  goodbye() {
    this.publish({ type: 'goodbye', session_id: this.hello.session_id });
  }

  async waitClosed(timeoutMs = 5000) {
    if (this.closed) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT connection did not close')), timeoutMs);
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  async close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end(mqttPacket(0xe0));
      this.socket.destroy();
    }
    if (this.udp) {
      const udp = this.udp; this.udp = null;
      await new Promise(resolve => udp.close(resolve));
    }
    this.packets.dispose(); this.messages.dispose(); this.audio.dispose();
  }
}

module.exports = { MqttDevice };
