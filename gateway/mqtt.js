'use strict';

const {EventEmitter} = require('node:events');
const utf8 = new TextDecoder('utf-8', {fatal: true});

function encodeLength(value) {
  if (!Number.isInteger(value) || value < 0 || value > 268435455) throw new Error('Invalid MQTT length');
  const bytes = [];
  do { let digit = value % 128; value = Math.floor(value / 128); if (value) digit |= 128; bytes.push(digit); } while (value);
  return Buffer.from(bytes);
}
function packet(typeFlags, body = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([typeFlags]), encodeLength(body.length), body]);
}
function string(value) {
  const bytes = Buffer.from(value);
  if (bytes.length > 65535) throw new Error('MQTT string too large');
  const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  remaining() { return this.buffer.length - this.offset; }
  bytes(length) { if (length < 0 || this.remaining() < length) throw new Error('Truncated MQTT packet'); const v = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return v; }
  byte() { return this.bytes(1)[0]; }
  uint16() { return this.bytes(2).readUInt16BE(); }
  string() { const v = utf8.decode(this.bytes(this.uint16())); if (/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/u.test(v)) throw new Error('Invalid MQTT string'); return v; }
  end() { if (this.remaining()) throw new Error('Trailing MQTT fields'); }
}
function parseConnect(body) {
  const r = new Reader(body);
  if (r.string() !== 'MQTT' || r.byte() !== 4) throw new Error('MQTT 3.1.1 required');
  const flags = r.byte(); const keepAlive = r.uint16();
  if ((flags & 1) || !(flags & 128) || !(flags & 64) || (!(flags & 4) && (flags & 56)) || ((flags >> 3) & 3) === 3) throw new Error('Invalid CONNECT flags');
  const clientId = r.string();
  if (flags & 4) { r.string(); r.bytes(r.uint16()); } // Accept/consume will, never rebroadcast it.
  const username = r.string(); const password = r.string(); r.end();
  return {clientId, username, password, keepAlive, cleanSession: Boolean(flags & 2)};
}

// Each complete packet is handled in order, including async CONNECT authorization.
// Input is paused while a handler runs; buffer, packet and write queues are bounded.
class MqttStream extends EventEmitter {
  constructor(socket, handler, options = {}) {
    super();
    this.socket = socket; this.handler = handler;
    this.maxPacket = options.maxPacket || 16384;
    this.maxBuffer = options.maxBuffer || 131072;
    this.maxWrite = options.maxWrite || 131072;
    this.writeTimeout = options.writeTimeout || 5000;
    this.buffer = Buffer.alloc(0); this.running = false; this.closed = false; this.pendingWrites = new Set();
    this.lastPacketAt = Date.now(); this.partialSince = 0;
    socket.setNoDelay(true);
    socket.on('data', (data) => {
      if (this.buffer.length + data.length > this.maxBuffer) return this.close();
      this.buffer = Buffer.concat([this.buffer, data]);
      if (!this.partialSince) this.partialSince = Date.now();
      void this.pump();
    });
    socket.on('error', () => this.close());
    socket.on('close', () => { this.closed = true; this.buffer = Buffer.alloc(0); for (const finish of this.pendingWrites) finish(false); this.emit('close'); });
  }
  async pump() {
    if (this.running || this.closed) return;
    this.running = true; this.socket.pause();
    try {
      while (!this.closed && this.buffer.length >= 2) {
        let remaining = 0; let multiplier = 1; let lengthBytes = 0; let done = false;
        for (let i = 1; i < this.buffer.length && i <= 4; i++) {
          const digit = this.buffer[i]; remaining += (digit & 127) * multiplier; lengthBytes++;
          if (!(digit & 128)) { done = true; break; }
          if (i === 4) throw new Error('Malformed MQTT length');
          multiplier *= 128;
        }
        if (!done) break;
        if (remaining > this.maxPacket || (lengthBytes > 1 && remaining < 128 ** (lengthBytes - 1))) throw new Error('Invalid MQTT length');
        const length = 1 + lengthBytes + remaining;
        if (this.buffer.length < length) break;
        const first = this.buffer[0]; const body = this.buffer.subarray(1 + lengthBytes, length);
        this.buffer = this.buffer.subarray(length);
        this.lastPacketAt = Date.now(); this.partialSince = this.buffer.length ? Date.now() : 0;
        await this.handler(first, body);
      }
    } catch { this.close(); }
    finally { this.running = false; if (!this.closed) this.socket.resume(); }
  }
  write(data) {
    if (this.closed || !this.socket.writable || this.pendingWrites.size >= 64 || this.socket.writableLength + data.length > this.maxWrite) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (success) => { if (settled) return; settled = true; clearTimeout(timer); this.pendingWrites.delete(finish); resolve(success); };
      const timer = setTimeout(() => { finish(false); this.close(); }, this.writeTimeout); timer.unref();
      this.pendingWrites.add(finish);
      this.socket.write(data, (error) => finish(!error && !this.closed));
    });
  }
  publish(topic, value) {
    const body = Buffer.concat([string(topic), Buffer.from(JSON.stringify(value))]);
    if (body.length > this.maxPacket) return Promise.resolve(false);
    return this.write(packet(0x30, body));
  }
  close() { if (this.closed) return; this.closed = true; this.buffer = Buffer.alloc(0); this.socket.destroy(); }
}
module.exports = {MqttStream, Reader, parseConnect, packet, string, encodeLength};
