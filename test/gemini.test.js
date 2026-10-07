'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const EventEmitter = require('node:events');

function fixture() {
  let request;
  const session = { closeCalls: 0, close() { this.closeCalls++; }, sendRealtimeInput() {} };
  class FakeGenAI { constructor() { this.live = { connect: async (r) => { request = r; return session; } }; } }
  class Base extends EventEmitter { constructor(config) { super(); this.config = config; } }
  const sandbox = { module: { exports: {} }, Buffer, console, require: (id) => id === './base' ? Base : { GoogleGenAI: FakeGenAI } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../providers/gemini'), 'utf8'), sandbox);
  const provider = new sandbox.module.exports({ apiKey: 'fake', prompt: 'test', voice: 'Aoede', model: 'fake', input_transcription: true, output_transcription: true });
  return { provider, session, request: () => request };
}
test('Gemini config preserves realtime audio and transcription while adding context', async () => {
  const f = fixture(); await f.provider.connect([]);
  assert.equal(f.request().config.systemInstruction.parts[0].text, 'test');
  assert.equal(f.request().config.responseModalities[0], 'audio');
  assert.ok(f.request().config.inputAudioTranscription);
  assert.ok(f.request().config.outputAudioTranscription);
});
test('Gemini interrupted+complete event never commits an interrupted turn', () => {
  const { provider } = fixture(); const events = [];
  for (const name of ['input_transcription', 'output_transcription', 'turn_complete', 'interrupted']) provider.on(name, () => events.push(name));
  provider.handleMessage({serverContent:{inputTranscription:{text:'hi'},outputTranscription:{text:'hello'},turnComplete:true,interrupted:true}});
  assert.deepEqual(events, ['input_transcription','output_transcription','interrupted']);
});
test('Gemini close closes actual session exactly once', async () => {
  const f = fixture(); await f.provider.connect([]); f.provider.close(); f.provider.close(); assert.equal(f.session.closeCalls, 1);
});
