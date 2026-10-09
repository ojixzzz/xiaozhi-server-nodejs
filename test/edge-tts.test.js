'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const { createEdgeTts, announcementText } = require('../lib/edge-tts');
const { createAudioService } = require('../lib/notification-audio');
const signingKey = 'test-only-edge-tts-signing-key-over-32-characters';

test('Edge TTS uses argument arrays, converts to mono Opus, signs audio and caches across restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'edge-tts-test-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const invocations = [];
  const run = async (command,args,options) => {
    invocations.push({command,args,options});
    if (command === 'edge-test') await fs.writeFile(args[args.indexOf('--write-media')+1],Buffer.from('fake mp3'));
    else await fs.copyFile(path.join(__dirname,'../notification-audio/sample-chime.ogg'),args.at(-1));
  };
  const options = {directory,command:'edge-test',ffmpeg:'ffmpeg-test',run,publicBaseUrl:'https://audio.test',signingKey,now:()=>1760000000000};
  let service = createEdgeTts(options);
  const [first,second] = await Promise.all([service.issue('break_due','id',2),service.issue('break_due','id',2)]);
  assert.equal(invocations.length,2); assert.equal(first.audio_url,second.audio_url);
  assert.ok(invocations[0].args.includes('id-ID-GadisNeural')); assert.equal(invocations[0].options.shell,undefined);
  assert.ok(invocations[1].args.includes('libopus')); assert.equal(invocations[1].args[invocations[1].args.indexOf('-ac')+1],'1');
  const link = new URL(first.audio_url), request = {name:link.pathname.split('/').at(-1),expires:link.searchParams.get('expires'),signature:link.searchParams.get('signature')};
  const asset = await service.open(request); assert.equal(asset.contentType,'audio/ogg'); asset.stream.destroy();
  const other = createAudioService({directory,publicBaseUrl:'https://audio.test',signingKey,now:()=>1760000000000});
  await assert.rejects(other.open(request),{code:'INVALID_AUDIO_SIGNATURE'});
  await service.close(); service = createEdgeTts(options); await service.issue('break_due','id',2); assert.equal(invocations.length,2); await service.close();
});

test('TTS failure leaves no reusable partial file and the next request can generate again', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'edge-tts-failure-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const service = createEdgeTts({directory,publicBaseUrl:'https://audio.test',signingKey,run:async()=>{throw new Error('unavailable');}});
  await assert.rejects(service.issue('break_due','en',2)); await assert.rejects(service.issue('break_due','en',2));
  assert.deepEqual(await fs.readdir(directory),[]); await service.close();
});

test('announcements are restricted to fixed supported phrases and durations', () => {
  assert.match(announcementText('break_due','id',2),/2 menit/);
  assert.match(announcementText('break_end','en',2),/break is over/);
  assert.match(announcementText('break_due','id',20,true),/istirahat panjang selama 20 menit/);
  assert.match(announcementText('break_due','en',60,true),/long break for 60 minutes/);
  for (const args of [['custom','id',2],['break_due','xx',2],['break_due','id',61],['break_due','id',5,'yes']]) assert.throws(()=>announcementText(...args),TypeError);
});

test('CI runtime can invoke Edge CLI and convert MP3 to the device Opus format without calling Microsoft', async t => {
  try { await runFile('/opt/edge-tts/bin/edge-tts',['--help'],{timeout:10000}); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Docker/CI Edge runtime is not installed'); throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'edge-tts-runtime-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const source = path.join(directory,'fixture.mp3');
  await runFile('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',path.join(__dirname,'../notification-audio/sample-chime.ogg'),source],{timeout:10000});
  const service = createEdgeTts({directory:path.join(directory,'cache'),publicBaseUrl:'https://audio.test',signingKey,
    run:async(command,args,options)=>command.endsWith('edge-tts') ? fs.copyFile(source,args[args.indexOf('--write-media')+1]) : runFile(command,args,options)});
  const asset = await service.issue('break_due','id',2);
  const output = path.join(directory,'cache',new URL(asset.audio_url).pathname.split('/').at(-1));
  const {stdout} = await runFile('ffprobe',['-v','error','-show_entries','stream=codec_name,channels:packet=duration_time','-of','json',output],{timeout:10000});
  const probe = JSON.parse(stdout); assert.equal(probe.streams[0].codec_name,'opus');assert.equal(probe.streams[0].channels,1);
  assert.ok(probe.packets.slice(1,-1).every(p=>Number(p.duration_time)===0.02));await service.close();
});
