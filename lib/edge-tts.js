'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createAudioService } = require('./notification-audio');
const runFile = promisify(execFile);

function announcementText(kind, language, restMinutes) {
  if (!['break_due','break_end'].includes(kind) || !['id','en'].includes(language) || !Number.isInteger(restMinutes) || restMinutes < 1 || restMinutes > 30) throw new TypeError('Invalid announcement');
  if (language === 'en') return kind === 'break_due' ? `Time for a screen break. Take ${restMinutes} minutes to rest.` : 'Your break is over. You can return to work.';
  return kind === 'break_due' ? `Yuk, istirahat layar sebentar. Luangkan ${restMinutes} menit untuk beristirahat.` : 'Waktu istirahat selesai. Silakan kembali bekerja.';
}
function createEdgeTts({ directory, publicBaseUrl, signingKey, allowHttp = false,
  command = process.env.EDGE_TTS_COMMAND || '/opt/edge-tts/bin/edge-tts', ffmpeg = process.env.FFMPEG_COMMAND || 'ffmpeg',
  run = runFile, now = Date.now } = {}) {
  const root = path.resolve(directory);
  const audio = createAudioService({ directory: root, publicBaseUrl, signingKey, allowHttp, routePrefix: '/announcement-audio', now });
  const pending = new Map(); let stopped = false;
  async function generate(name, text, voice) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Unsafe TTS directory');
    try { return await audio.issue(name); } catch (error) { if (error.code !== 'AUDIO_NOT_FOUND') throw error; }
    // Only fixed application phrases enter these commands; no shell is used.
    // Remove interrupted temporary generations; the two languages/durations
    // produce at most 62 immutable cached phrases with the current templates.
    const entries = await fs.opendir(root);
    try {
      for (let scanned = 0; scanned < 128; scanned++) {
        const entry = await entries.read(); if (!entry) break;
        if (!entry.isDirectory() || !/^\.edge-[A-Za-z0-9]+$/.test(entry.name)) continue;
        const filename = path.join(root,entry.name);
        if (now() - (await fs.lstat(filename)).mtimeMs > 3600000) await fs.rm(filename,{recursive:true,force:true});
      }
    } finally { await entries.close(); }
    const temporary = await fs.mkdtemp(path.join(root, '.edge-')); let installed = false;
    try {
      const mp3 = path.join(temporary, 'speech.mp3'), ogg = path.join(temporary, 'speech.ogg');
      await run(command, ['--voice', voice, '--text', text, '--write-media', mp3], { timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 65536 });
      if ((await fs.stat(mp3)).size > 2 * 1024 * 1024) throw new Error('TTS output too large');
      await run(ffmpeg, ['-nostdin','-hide_banner','-loglevel','error','-i',mp3,'-t','30','-ac','1','-ar','24000',
        '-c:a','libopus','-b:a','32k','-frame_duration','20','-f','ogg',ogg], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 });
      await fs.chmod(ogg, 0o600);
      await fs.rename(ogg, path.join(root, name));
      installed = true;
      const result = await audio.issue(name); // Validate the generated mono Opus header.
      return result;
    } catch (error) {
      if (installed) await fs.rm(path.join(root,name),{force:true});
      throw error;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  return { configured: audio.configured, reason: audio.reason, open: audio.open,
    async issue(kind, language, restMinutes) {
      if (stopped || !audio.configured) throw new Error('Announcement audio unavailable');
      const text = announcementText(kind, language, restMinutes), voice = language === 'id' ? 'id-ID-GadisNeural' : 'en-US-JennyNeural';
      const name = createHash('sha256').update(`edge-tts:7.2.8:${voice}:${text}`).digest('hex') + '.ogg';
      if (pending.has(name)) return pending.get(name);
      if (pending.size >= 2) throw new Error('TTS busy');
      const task = generate(name, text, voice).then(asset => ({ ...asset, text })).finally(() => pending.delete(name));
      pending.set(name, task); return task;
    },
    async close() { stopped = true; await Promise.allSettled([...pending.values()]); }
  };
}
module.exports = { createEdgeTts, announcementText };
