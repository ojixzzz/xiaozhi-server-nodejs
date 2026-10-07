'use strict';

// Wire-compatible with 78/xiaozhi-mqtt-gateway utils/mqtt_config_v2.js.
// Upstream MIT notice is retained in LICENSE.upstream; see NOTICE.md.
const crypto = require('node:crypto');

function secret(value, name) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512 || /change.?me|replace.?me|your[-_ ]|example|placeholder/i.test(value)) {
    throw new Error(`${name} must be a configured secret of at least 32 characters, not a placeholder`);
  }
  return value;
}
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function normalizeDeviceId(deviceId) {
  if (typeof deviceId !== 'string') throw new Error('Invalid device ID');
  const normalized = deviceId.replace(/_/g, ':').toLowerCase();
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(normalized)) throw new Error('Invalid device ID');
  return normalized;
}
function parseClientId(clientId) {
  if (typeof clientId !== 'string' || clientId.length > 256) throw new Error('Invalid client ID');
  const parts = clientId.split('@@@');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{1,128}$/.test(parts[2])) throw new Error('Invalid client ID');
  const deviceId = normalizeDeviceId(parts[1]);
  if (parts[1] !== deviceId.replace(/:/g, '_')) throw new Error('Noncanonical device ID');
  return {groupId: parts[0], macAddress: deviceId, deviceId, uuid: parts[2]};
}
function generatePasswordSignature(content, signatureKey) {
  secret(signatureKey, 'MQTT_SIGNATURE_KEY');
  return crypto.createHmac('sha256', signatureKey).update(content).digest('base64');
}
function validateMqttCredentials(clientId, username, password, signatureKey) {
  secret(signatureKey, 'MQTT_SIGNATURE_KEY');
  const identity = parseClientId(clientId);
  if (typeof username !== 'string' || username.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(username)) throw new Error('Invalid username');
  const expected = generatePasswordSignature(`${clientId}|${username}`, signatureKey);
  if (!equalSecret(password, expected)) throw new Error('Invalid MQTT credentials');
  const bytes = Buffer.from(username, 'base64');
  if (bytes.toString('base64') !== username) throw new Error('Invalid username encoding');
  const userData = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (!userData || Array.isArray(userData) || typeof userData !== 'object') throw new Error('Invalid user data');
  if (userData.device_id !== undefined && normalizeDeviceId(userData.device_id) !== identity.deviceId) throw new Error('Device mismatch');
  return {...identity, userData};
}
function generateMqttConfig({groupId = 'GID_local', deviceId, uuid, userData, signatureKey, endpoint, port = 8883}) {
  const normalized = normalizeDeviceId(deviceId);
  const clientId = `${groupId}@@@${normalized.replace(/:/g, '_')}@@@${uuid}`;
  parseClientId(clientId);
  if (typeof endpoint !== 'string' || !/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(endpoint)) throw new Error('MQTT endpoint must be hostname[:port]');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MQTT port');
  const username = Buffer.from(JSON.stringify(userData || {device_id: normalized})).toString('base64');
  const password = generatePasswordSignature(`${clientId}|${username}`, signatureKey);
  validateMqttCredentials(clientId, username, password, signatureKey);
  // Firmware parses the port from endpoint, not from the separate port field.
  const actualPort = endpoint.includes(':') ? Number(endpoint.split(':')[1]) : port;
  if (!Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65535) throw new Error('Invalid MQTT endpoint port');
  const advertisedEndpoint = endpoint.includes(':') ? endpoint : `${endpoint}:${port}`;
  return {endpoint: advertisedEndpoint, port: actualPort, client_id: clientId, username, password,
    publish_topic: 'device-server', subscribe_topic: 'null'};
}
module.exports = {generateMqttConfig, validateMqttCredentials, generatePasswordSignature, parseClientId, normalizeDeviceId, equalSecret, secret};
