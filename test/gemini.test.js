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
    if (reject) return Promise.reject(typeof reject === 'string' ? new Error(reject) : reject);
    if (autoSetup) r.callbacks.onmessage({ setupComplete: {} });
    return delaySession ? new Promise(resolve => { resolveSession = resolve; }) : Promise.resolve(session);
  } }; } }
  class Base extends EventEmitter { constructor(config) { super(); this.config = config; } }
  const sandbox = {
    module: { exports: {} }, Buffer, console,
    setTimeout: fakeTimers ? callback => { timeoutCallback = callback; return { unref() {} }; } : setTimeout,
    clearTimeout: fakeTimers ? () => {} : clearTimeout,
    require: id => id === './base' ? Base : id === 'node:perf_hooks' || id === '../lib/live-recovery' ? require(id) : { GoogleGenAI: FakeGenAI }
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
test('Gemini sends MCP JSON Schema in the JSON field without losing nested constraints or mutating routes', async () => {
  const f = fixture(); const diagnostics = [];
  f.provider.on('diagnostic', event => diagnostics.push(event));
  const tools = [
    { name: 'server.get_pending_devices', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'mcp_0242e885a27b_hermes_reminder_create', description: 'Create reminder', parameters: {
      type: 'object', properties: {
        days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, uniqueItems: true },
        options: { type: 'object', properties: { channels: { type: 'array', items: { type: 'string' }, uniqueItems: true } } },
        schedule: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      }, required: ['days'], additionalProperties: false
    } }
  ];
  const original = JSON.stringify(tools);
  await f.provider.connect(tools);
  const declarations = f.request().config.tools[0].functionDeclarations;
  assert.equal(declarations.length, 2);
  for (let index = 0; index < tools.length; index++) {
    assert.equal(declarations[index].name, tools[index].name);
    assert.equal('parameters' in declarations[index], false, 'never send the restricted Schema alongside JSON Schema');
    assert.equal(JSON.stringify(declarations[index].parametersJsonSchema), JSON.stringify(tools[index].parameters));
  }
  const prepared = diagnostics.find(event => event.event === 'gemini.tool_schema_prepared');
  assert.equal(prepared.tool_count, 2);
  assert.equal(prepared.tools[1].index, 1);
  assert.equal(prepared.tools[1].name, tools[1].name);
  assert.equal(prepared.tools[1].schema_format, 'parametersJsonSchema');
  assert.equal(JSON.stringify(prepared).includes('uniqueItems'), false, 'trace lists names/formats rather than raw schemas');
  declarations[1].parametersJsonSchema.properties.days.items.minimum = 99;
  assert.equal(JSON.stringify(tools), original, 'SDK/config mutations cannot change the original MCP route schema');
  assert.equal(f.provider.ready, true);
  f.provider.close();
});
test('Gemini preserves an explicit JSON schema and tools without parameters', async () => {
  const f = fixture();
  const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } } };
  await f.provider.connect([
    { name: 'already_json', parametersJsonSchema: schema },
    { name: 'no_arguments' }
  ]);
  const declarations = f.request().config.tools[0].functionDeclarations;
  assert.equal(JSON.stringify(declarations[0].parametersJsonSchema), JSON.stringify(schema));
  assert.notEqual(declarations[0].parametersJsonSchema, schema);
  assert.equal('parameters' in declarations[0], false);
  assert.equal('parameters' in declarations[1], false);
  assert.equal('parametersJsonSchema' in declarations[1], false);
  f.provider.close();
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

test('temporary SDK failure can retry and endAudio is sent only after setup', async () => {
  const failed = fixture({ reject: new Error('Network failed', { cause: { code: 'ECONNRESET' } }) });
  let details; failed.provider.on('error', () => {}); failed.provider.on('close', value => { details = value; });
  await failed.provider.connect([]); assert.equal(details.retryable, true);
  const f = fixture({ autoSetup: false });
  const pending = f.provider.connect([]);
  assert.equal(f.provider.endAudio(), false);
  f.request().callbacks.onmessage({ setupComplete: {} }); await pending;
  assert.equal(f.provider.endAudio(), true);
  assert.equal(f.session.inputs[0].audioStreamEnd, true);
  f.provider.close(); assert.equal(f.provider.endAudio(), false);
});

test('resumption handle is configured and updates/goAway are handled without logging the handle', async () => {
  const f = fixture({ fakeTimers: true }); const updates = [], diagnostics = [];
  f.provider.config.resumptionHandle = 'private-resumption-handle';
  f.provider.on('resumption_update', value => updates.push(value));
  f.provider.on('diagnostic', value => diagnostics.push(value));
  await f.provider.connect([]);
  assert.equal(f.request().config.sessionResumption.handle, 'private-resumption-handle');
  assert.ok(f.request().config.contextWindowCompression.slidingWindow);
  f.request().callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'next-private-handle' } });
  assert.equal(updates[0].handle, 'next-private-handle');
  f.request().callbacks.onmessage({ goAway: { timeLeft: '5s' } });
  assert.equal(diagnostics.at(-1).reconnect_in_ms, 4000);
  let details; f.provider.on('close', value => { details = value; }); f.timeout();
  assert.equal(details.retryable, true); assert.equal(f.session.closeCalls, 1);
  assert.equal(JSON.stringify(diagnostics).includes('private-handle'), false);
  assert.equal(JSON.stringify(diagnostics).includes('private-resumption-handle'), false);
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
