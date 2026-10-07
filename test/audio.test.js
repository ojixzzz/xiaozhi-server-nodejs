'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let prism;
try { prism = require('prism-media'); } catch {}
test('existing Opus path encodes and decodes one silent mono frame locally', {skip:!prism}, () => {
  const encoder = new prism.opus.Encoder({frameSize:1440,channels:1,rate:24000});
  const decoder = new prism.opus.Decoder({frameSize:1440,channels:1,rate:24000});
  let decoded=0;
  encoder.on('data', b=>decoder.write(b));
  decoder.on('data', b=>decoded+=b.length);
  try { encoder.write(Buffer.alloc(2880)); assert.equal(decoded,2880); }
  finally { encoder.destroy(); decoder.destroy(); }
});
