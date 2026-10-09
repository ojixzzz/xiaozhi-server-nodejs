'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { validSecret } = require('./mqtt-integration');

const MAX_TTL_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ASSETS = 100;
const MAX_LIST_SCAN = 500;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.ogg$/;
const SIGNING_DOMAIN = 'xiaozhi-notification-audio:v1';

class AudioError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) { throw new AudioError(code, message, statusCode); }

function validName(name) {
  return typeof name === 'string' && FILE_NAME.test(name) && !name.includes('..');
}

function parseBaseUrl(value, allowHttp) {
  if (typeof value !== 'string' || !value || /[\s\\?#]/.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['https:', ...(allowHttp ? ['http:'] : [])].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || !parsed.hostname) return null;
  return parsed.origin;
}

// Validate the Ogg identification page without invoking a decoder or fetching URLs.
// Operators still need to validate the complete recording before installing it.
async function checkOpusHeader(handle) {
  const buffer = Buffer.alloc(512);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const segments = buffer[26];
  const offset = 27 + segments;
  if (bytesRead < offset + 19 || buffer.toString('ascii', 0, 4) !== 'OggS' ||
      buffer[4] !== 0 || !(buffer[5] & 2) || segments < 1 ||
      buffer[27] !== 19 || buffer.toString('ascii', offset, offset + 8) !== 'OpusHead' ||
      buffer[offset + 8] !== 1 || buffer[offset + 9] !== 1 || buffer[offset + 18] !== 0) {
    fail('INVALID_AUDIO', 'Audio must begin with a mono Ogg Opus identification page', 415);
  }
}

/**
 * Local-only audio assets. The signing key is supplied by the operator, never
 * generated or persisted here. Returned bearer URLs need no Authorization header
 * and expire within five minutes. Do not log their query strings.
 */
function createAudioService({ directory = path.join(__dirname, '../notification-audio'),
  publicBaseUrl, signingKey, allowHttp = false, ttlMs = MAX_TTL_MS,
  maxFileBytes = MAX_FILE_BYTES, now = Date.now, routePrefix = '/notification-audio' } = {}) {
  if (typeof directory !== 'string' || !directory || typeof allowHttp !== 'boolean' ||
      typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 47 || maxFileBytes > MAX_FILE_BYTES || !/^\/[a-z-]+$/.test(routePrefix)) {
    fail('INVALID_CONFIG', 'Invalid local notification audio configuration', 503);
  }
  const root = path.resolve(directory);
  const origin = parseBaseUrl(publicBaseUrl, allowHttp);
  const hasKey = validSecret(signingKey);
  const configured = Boolean(origin && hasKey);
  const reason = !hasKey ? 'An operator-provided MQTT_GATEWAY_KEY of 32–512 characters is required; example placeholders are not accepted.' :
    !origin ? 'Set NOTIFY_AUDIO_BASE_URL to a device-reachable HTTPS origin (HTTP requires explicit opt-in).' : null;
  // Separate URL-signing use from other MQTT_GATEWAY_KEY uses.
  const key = configured ? createHmac('sha256', signingKey).update(SIGNING_DOMAIN).digest() : null;

  function requireConfigured() {
    if (!configured) fail('AUDIO_NOT_CONFIGURED', reason, 503);
  }

  async function checkDirectory() {
    try {
      const stat = await fsp.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(root) !== root) {
        fail('UNSAFE_AUDIO_DIRECTORY', 'The audio directory must be a real directory without symbolic links', 503);
      }
    } catch (error) {
      if (error instanceof AudioError) throw error;
      fail('AUDIO_DIRECTORY_UNAVAILABLE', 'The local notification audio directory is unavailable', 503);
    }
  }

  async function openAsset(name) {
    if (!validName(name)) fail('INVALID_AUDIO_NAME', 'Choose a local .ogg audio filename');
    await checkDirectory();
    let handle;
    try {
      const filename = path.join(root, name);
      // O_NOFOLLOW protects the final component even if it changes after listing.
      handle = await fsp.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) fail('INVALID_AUDIO_FILE', 'Audio must be a regular file', 400);
      if (stat.size < 47 || stat.size > maxFileBytes) {
        fail('AUDIO_SIZE_LIMIT', `Audio must be between 47 and ${maxFileBytes} bytes`, 413);
      }
      await checkOpusHeader(handle);
      return { handle, size: stat.size };
    } catch (error) {
      if (handle) await handle.close();
      if (error instanceof AudioError) throw error;
      if (error.code === 'ENOENT') fail('AUDIO_NOT_FOUND', 'The selected audio file does not exist', 404);
      if (error.code === 'ELOOP') fail('INVALID_AUDIO_FILE', 'Symbolic links are not permitted', 400);
      fail('AUDIO_UNAVAILABLE', 'The selected audio file is unavailable', 503);
    }
  }

  function signatureFor(name, expires) {
    return createHmac('sha256', key).update(`${SIGNING_DOMAIN}\n${origin}${routePrefix === '/notification-audio' ? '' : routePrefix}\n${name}\n${expires}`).digest('hex');
  }

  return Object.freeze({
    configured,
    reason,
    async list() {
      if (!configured) return [];
      await checkDirectory();
      const files = [];
      // Never recurse or load an unbounded directory into memory. A large
      // operator-controlled directory may produce a partial list; see README.
      const entries = await fsp.opendir(root, { bufferSize: 32 });
      try {
        let scanned = 0;
        while (scanned < MAX_LIST_SCAN && files.length < MAX_LIST_ASSETS) {
          const entry = await entries.read();
          if (!entry) break;
          scanned++;
          if (!entry.isFile() || !validName(entry.name)) continue;
          try {
            const { handle, size } = await openAsset(entry.name);
            await handle.close();
            files.push({ name: entry.name, size });
          } catch (error) {
            if (!(error instanceof AudioError)) throw error;
            // Bad, oversized, removed, or replaced entries are not offered to send.
          }
        }
      } finally {
        await entries.close();
      }
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
    async issue(name) {
      requireConfigured();
      const { handle } = await openAsset(name);
      await handle.close();
      const expires = String(Math.floor((now() + ttlMs) / 1000));
      return {
        audio_url: `${origin}${routePrefix}/${encodeURIComponent(name)}?expires=${expires}&signature=${signatureFor(name, expires)}`,
        expires_at: new Date(Number(expires) * 1000).toISOString()
      };
    },
    async open({ name, expires, signature } = {}) {
      requireConfigured();
      if (!validName(name) || typeof expires !== 'string' || !/^[1-9][0-9]{0,12}$/.test(expires) ||
          typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
        fail('INVALID_AUDIO_SIGNATURE', 'Invalid or expired audio link', 403);
      }
      const expiry = Number(expires) * 1000;
      const current = now();
      if (!Number.isSafeInteger(expiry) || expiry <= current || expiry > current + MAX_TTL_MS) {
        fail('INVALID_AUDIO_SIGNATURE', 'Invalid or expired audio link', 403);
      }
      const expected = Buffer.from(signatureFor(name, expires), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
        fail('INVALID_AUDIO_SIGNATURE', 'Invalid or expired audio link', 403);
      }
      const { handle, size } = await openAsset(name);
      // Bound the response to the inspected size, even if an operator appends to it.
      return { stream: handle.createReadStream({ start: 0, end: size - 1 }), size, contentType: 'audio/ogg' };
    }
  });
}

module.exports = { createAudioService, AudioError, MAX_TTL_MS, MAX_FILE_BYTES, MAX_LIST_ASSETS, MAX_LIST_SCAN };
