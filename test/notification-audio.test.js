'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createAudioService, MAX_FILE_BYTES, MAX_TTL_MS, MAX_LIST_ASSETS, MAX_LIST_SCAN } = require('../lib/notification-audio');

const sample = path.join(__dirname, '../notification-audio/sample-chime.ogg');
const key = 'test-only-operator-key-32-bytes-or-longer';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-audio-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(sample, path.join(directory, 'chime.ogg'));
  return { directory, service: createAudioService({
    directory, publicBaseUrl: 'https://audio.example.test', signingKey: key,
    now: () => 1760000000000, ...options
  }) };
}

function requestFor(link) {
  const url = new URL(link.audio_url);
  return { name: decodeURIComponent(url.pathname.split('/').at(-1)),
    expires: url.searchParams.get('expires'), signature: url.searchParams.get('signature') };
}

async function consume(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('sample is a short, mono Opus chime with 20 ms packets', async t => {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,channels:format=duration:packet=duration_time', '-of', 'json', sample], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return t.skip('ffprobe is not installed; header checks still run');
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout);
  assert.equal(probe.streams[0].codec_name, 'opus');
  assert.equal(probe.streams[0].channels, 1);
  assert.ok(Number(probe.format.duration) >= 1 && Number(probe.format.duration) < 1.1);
  assert.ok(probe.packets.slice(1, -1).every(packet => Number(packet.duration_time) === 0.02));
});

test('local audio lists, signs, and streams only the verified asset', async t => {
  const { service } = await fixture(t);
  const expected = await fs.readFile(sample);
  assert.equal(service.configured, true);
  assert.equal(service.reason, null);
  assert.deepEqual(await service.list(), [{ name: 'chime.ogg', size: expected.length }]);
  const link = await service.issue('chime.ogg');
  assert.match(link.audio_url, /^https:\/\/audio\.example\.test\/notification-audio\/chime\.ogg\?expires=\d+&signature=[a-f0-9]{64}$/);
  assert.equal(Date.parse(link.expires_at), 1760000000000 + MAX_TTL_MS);
  assert.ok(!link.audio_url.includes(key));
  const asset = await service.open(requestFor(link));
  assert.equal(asset.contentType, 'audio/ogg');
  assert.equal(asset.size, expected.length);
  assert.deepEqual(await consume(asset.stream), expected);
});

test('audio fails closed without an operator key and explicit device-reachable origin', async () => {
  for (const options of [{}, { signingKey: key }, { publicBaseUrl: 'https://audio.example.test' },
    { signingKey: 'too-short', publicBaseUrl: 'https://audio.example.test' },
    ...['https://user:secret@audio.example.test', 'https://audio.example.test/path',
      'https://audio.example.test?query=1', 'https://audio.example.test#hash',
      'http://audio.example.test', 'file:///tmp', 'https://audio.example.test\\'].map(publicBaseUrl => ({ signingKey: key, publicBaseUrl }))]) {
    const service = createAudioService(options);
    assert.equal(service.configured, false);
    assert.deepEqual(await service.list(), []);
    await assert.rejects(service.issue('chime.ogg'), { code: 'AUDIO_NOT_CONFIGURED', statusCode: 503 });
    await assert.rejects(service.open({}), { code: 'AUDIO_NOT_CONFIGURED', statusCode: 503 });
  }
  assert.equal(createAudioService({ signingKey: key, publicBaseUrl: 'http://audio.example.test', allowHttp: true }).configured, true);
});

test('invalid configuration cannot extend lifetime or size beyond safe caps', () => {
  for (const options of [{ ttlMs: MAX_TTL_MS + 1 }, { ttlMs: 0 }, { maxFileBytes: MAX_FILE_BYTES + 1 },
    { maxFileBytes: 0 }, { now: 1 }, { allowHttp: 'true' }, { directory: '' }]) {
    assert.throws(() => createAudioService(options), { code: 'INVALID_CONFIG' });
  }
});

test('signed links reject expiry, changed filename, changed origin, changed key, and malformed values', async t => {
  let now = 1760000000000;
  const { directory, service } = await fixture(t, { now: () => now });
  const link = await service.issue('chime.ogg');
  const valid = requestFor(link);
  for (const mutation of [{ name: 'other.ogg' }, { signature: '0'.repeat(64) }, { signature: 'f'.repeat(63) },
    { expires: String(Number(valid.expires) + 1) }, { expires: [valid.expires] }, { expires: 'Infinity' },
    { signature: [valid.signature] }, { name: '../chime.ogg' }]) {
    await assert.rejects(service.open({ ...valid, ...mutation }), { code: 'INVALID_AUDIO_SIGNATURE', statusCode: 403 });
  }
  for (const options of [{ signingKey: key + '-changed' }, { publicBaseUrl: 'https://another.example.test' }]) {
    const other = createAudioService({ directory, signingKey: key, publicBaseUrl: 'https://audio.example.test', now: () => now, ...options });
    await assert.rejects(other.open(valid), { statusCode: 403 });
  }
  now += MAX_TTL_MS;
  await assert.rejects(service.open(valid), { statusCode: 403 });
});

test('asset selection rejects paths, links, non-audio, non-mono, oversized files and nested entries', async t => {
  const { directory, service } = await fixture(t);
  const content = await fs.readFile(sample);
  await fs.writeFile(path.join(directory, 'text.ogg'), Buffer.alloc(100, 'x'));
  const stereo = Buffer.from(content);
  stereo[27 + stereo[26] + 9] = 2;
  await fs.writeFile(path.join(directory, 'stereo.ogg'), stereo);
  await fs.writeFile(path.join(directory, 'large.ogg'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await fs.mkdir(path.join(directory, 'folder.ogg'));
  await fs.symlink(path.join(directory, 'chime.ogg'), path.join(directory, 'link.ogg'));
  assert.deepEqual(await service.list(), [{ name: 'chime.ogg', size: content.length }]);
  for (const name of ['../chime.ogg', '/chime.ogg', 'dir/chime.ogg', 'dir\\chime.ogg',
    '.hidden.ogg', 'chime.OGG', 'chime.ogg\0', 'chime..ogg', '%2e%2e.ogg', [], null]) {
    await assert.rejects(service.issue(name), { code: 'INVALID_AUDIO_NAME' });
  }
  await assert.rejects(service.issue('missing.ogg'), { statusCode: 404 });
  await assert.rejects(service.issue('link.ogg'), { code: 'INVALID_AUDIO_FILE' });
  await assert.rejects(service.issue('folder.ogg'), { code: 'INVALID_AUDIO_FILE' });
  await assert.rejects(service.issue('text.ogg'), { statusCode: 415 });
  await assert.rejects(service.issue('stereo.ogg'), { statusCode: 415 });
  await assert.rejects(service.issue('large.ogg'), { statusCode: 413 });
});

test('a signed file replaced by a symlink cannot be opened; symlink directories are rejected', async t => {
  const { directory, service } = await fixture(t);
  const link = await service.issue('chime.ogg');
  await fs.unlink(path.join(directory, 'chime.ogg'));
  await fs.symlink(sample, path.join(directory, 'chime.ogg'));
  await assert.rejects(service.open(requestFor(link)), { code: 'INVALID_AUDIO_FILE' });
  const alias = directory + '-link';
  t.after(() => fs.rm(alias, { force: true }));
  await fs.symlink(directory, alias);
  const viaAlias = createAudioService({ directory: alias, signingKey: key, publicBaseUrl: 'https://audio.example.test' });
  await assert.rejects(viaAlias.list(), { code: 'UNSAFE_AUDIO_DIRECTORY' });
});


test('shipped MQTT placeholders and oversized signing keys never enable audio', async () => {
  const example = await fs.readFile(path.join(__dirname, '../.env.mqtt.example'), 'utf8');
  const placeholders = [...example.matchAll(/^MQTT_(?:SIGNATURE|GATEWAY)_KEY=(.+)$/gm)].map(match => match[1]);
  assert.equal(placeholders.length, 2, 'Exercise the actual shipped MQTT key placeholders');
  for (const signingKey of [...placeholders, 'x'.repeat(513), 'your_' + 'x'.repeat(32),
    'change_me_' + 'x'.repeat(32), 'example_' + 'x'.repeat(32), 'placeholder_' + 'x'.repeat(32)]) {
    const service = createAudioService({ signingKey, publicBaseUrl: 'https://audio.example.test' });
    assert.equal(service.configured, false);
    assert.deepEqual(await service.list(), []);
    await assert.rejects(service.issue('sample-chime.ogg'), { code: 'AUDIO_NOT_CONFIGURED', statusCode: 503 });
  }
});

test('asset listing returns at most 100 validated assets and closes its directory', async t => {
  const { directory, service } = await fixture(t);
  await Promise.all(Array.from({ length: MAX_LIST_ASSETS + 2 }, (_, index) =>
    fs.copyFile(sample, path.join(directory, `clip-${String(index).padStart(3, '0')}.ogg`))));
  const originalOpenDir = fs.opendir.bind(fs);
  let reads = 0;
  let closed = false;
  t.mock.method(fs, 'opendir', async (...args) => {
    const handle = await originalOpenDir(...args);
    return {
      read: async () => { reads++; return handle.read(); },
      close: async () => { closed = true; return handle.close(); }
    };
  });
  const files = await service.list();
  assert.equal(files.length, MAX_LIST_ASSETS);
  assert.equal(reads, MAX_LIST_ASSETS);
  assert.equal(closed, true);
  assert.ok(files.every(file => file.size > 47 && file.name.endsWith('.ogg')));
  assert.deepEqual(files, [...files].sort((a, b) => a.name.localeCompare(b.name)));
});

test('asset listing scans at most 500 directory entries even when none are audio', async t => {
  const { service } = await fixture(t);
  let reads = 0;
  let closed = false;
  t.mock.method(fs, 'opendir', async () => ({
    read: async () => { reads++; return { name: `not-audio-${reads}.txt`, isFile: () => true }; },
    close: async () => { closed = true; }
  }));
  assert.deepEqual(await service.list(), []);
  assert.equal(reads, MAX_LIST_SCAN);
  assert.equal(closed, true);
});
