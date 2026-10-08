'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const EventEmitter = require('node:events');

function fixture({ autoSetup = true, delaySession = false, reject = null, fakeTimers = false } = {}) {
  let request, resolveSession, timeoutCallback;
  const session = { closeCalls: 0, inputs: [], close() { this.closeCalls++; }, sendRealtimeInput(input) { this.inputs.push(input); } };
  class FakeGenAI { constructor() { this.live = { connect: r => {
    request = r;
    r.callbacks.onopen();
    if (reject) return Promise.reject(new Error(reject));
    if (autoSetup) r.callbacks.onmessage({ setupComplete: {} });
    return delaySession ? new Promise(resolve => { resolveSession = resolve; }) : Promise.resolve(session);
  } }; } }
  class Base extends EventEmitter { constructor(config) { super(); this.config = config; } }
  const sandbox = {
    module: { exports: {} }, Buffer, console,
    setTimeout: fakeTimers ? callback => { timeoutCallback = callback; return { unref() {} }; } : setTimeout,
    clearTimeout: fakeTimers ? () => {} : clearTimeout,
    require: id => id === './base' ? Base : id === 'node:perf_hooks' ? require(id) : { GoogleGenAI: FakeGenAI }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../providers/gemini'), 'utf8'), sandbox);
  const provider = new sandbox.module.exports({ apiKey: 'fake', prompt: 'test', voice: 'Aoede', model: 'fake', input_transcription: true, output_transcription: true });
  return { provider, session, request: () => request, resolveSession: () => resolveSession(session), timeout: () => timeoutCallback() };
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

test('Gemini waits for setup acceptance and a usable session before connected/audio', async () => {
  const f = fixture({ autoSetup: false });
  let connected = 0;
  f.provider.on('connected', () => { connected++; f.provider.sendAudio(Buffer.from([0, 1])); });
  const pending = f.provider.connect([]);
  await Promise.resolve();
  f.provider.sendAudio(Buffer.from([0, 1]));
  assert.equal(connected, 0, 'opening the socket is not setup acceptance');
  assert.equal(f.session.inputs.length, 0);
  f.request().callbacks.onmessage({ setupComplete: {} });
  await pending;
  assert.equal(connected, 1);
  assert.equal(f.session.inputs.length, 1, 'session handle exists when connected is emitted');
  f.provider.close();
});
test('setup acceptance before the SDK resolves its session does not lose early transcripts', async () => {
  const f = fixture({ delaySession: true }); const events = [];
  f.provider.on('connected', () => events.push('connected'));
  f.provider.on('input_transcription', text => events.push(text));
  const pending = f.provider.connect([]);
  f.request().callbacks.onmessage({ serverContent: { inputTranscription: { text: 'halo' } } });
  assert.deepEqual(events, []);
  f.resolveSession(); await pending;
  assert.deepEqual(events, ['connected', 'halo']);
  f.provider.close();
});
test('Gemini rejected setup preserves close details and settles a still pending SDK connect', async () => {
  const f = fixture({ autoSetup: false, delaySession: true });
  const closes = []; let connected = false; let toolCalls = 0;
  f.provider.on('close', details => closes.push(details));
  f.provider.on('connected', () => { connected = true; });
  f.provider.on('tool_call', () => { toolCalls++; });
  const pending = f.provider.connect([]);
  f.request().callbacks.onclose({ code: 1008, reason: 'Invalid model configuration', wasClean: true });
  await pending;
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1008); assert.equal(closes[0].reason, 'Invalid model configuration');
  assert.equal(closes[0].wasClean, true); assert.equal(connected, false);
  f.request().callbacks.onmessage({ setupComplete: {}, toolCall: { functionCalls: [{ id: 'late', name: 'action' }] } });
  f.request().callbacks.onclose({ code: 1006 });
  f.resolveSession(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.provider.session, null); assert.equal(f.session.closeCalls, 1);
  assert.equal(toolCalls, 0); assert.equal(closes.length, 1);
});
test('local teardown during setup closes a late SDK session without restoring connected', async () => {
  const f = fixture({ delaySession: true }); let connected = false;
  f.provider.on('connected', () => { connected = true; });
  const pending = f.provider.connect([]); f.provider.close(); await pending;
  f.resolveSession(); await Promise.resolve(); await Promise.resolve();
  assert.equal(connected, false); assert.equal(f.provider.session, null); assert.equal(f.session.closeCalls, 1);
});
test('setup timeout settles stalled connection and prevents late readiness', async () => {
  const f = fixture({ autoSetup: false, fakeTimers: true }); let close;
  f.provider.on('close', details => { close = details; });
  const pending = f.provider.connect([]); await Promise.resolve();
  f.timeout(); await pending;
  assert.equal(close.code, 1006); assert.match(close.reason, /setup timed out/);
  assert.equal(f.session.closeCalls, 1); assert.equal(f.provider.ready, false);
});
test('SDK connection rejection reports an error without a retry loop', async () => {
  const f = fixture({ reject: 'Invalid API configuration' }); const errors = []; let close;
  f.provider.on('error', error => errors.push(error.message));
  f.provider.on('close', details => { close = details; });
  await f.provider.connect([]);
  assert.match(errors[0], /Invalid API configuration/); assert.equal(close.retryable, false);
});


test('Gemini trace distinguishes socket open, setup acceptance and close without copying config contents', async () => {
  const f = fixture(); const events = [];
  f.provider.on('diagnostic', event => events.push(event));
  await f.provider.connect([]);
  f.request().callbacks.onclose({ code: 1008, reason: 'Invalid configuration', wasClean: true });
  assert.deepEqual(events.map(event => event.event), [
    'gemini.sdk_connect', 'gemini.socket_open', 'gemini.setup_accepted', 'gemini.session_handle_received', 'gemini.socket_closed'
  ]);
  assert.equal(events.at(-1).setup_accepted, true);
  assert.equal(events.at(-1).code, 1008);
  assert.equal(JSON.stringify(events).includes('apiKey'), false);
  assert.equal(JSON.stringify(events).includes('prompt'), false);
});
