'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../public/reminders.js'), 'utf8');

function fixture(handler) {
  const nodes = new Map(), requests = [];
  const defaults = { reminderKind: 'once', reminderOnceMode: 'after', reminderAfter: '5', reminderEvery: '120', reminderDay: '1', reminderTime: '08:00', reminderFilter: 'all' };
  class Element {
    constructor(id = '') { this.id = id; this.value = defaults[id] || ''; this.checked = false; this.children = []; this.listeners = {}; this.textContent = ''; this.disabled = false; this.dataset = {}; this.classList = { add() {}, remove() {} }; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    focus() {}
    reset() { for (const [id,node] of nodes) if (id !== 'reminderFilter') node.value = defaults[id] || ''; }
    querySelectorAll() { return []; }
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const window = {};
  const document = { getElementById: $, querySelectorAll: () => [], createElement: () => new Element(), activeElement: new Element() };
  const context = { document, window, AbortController, setTimeout, clearTimeout, console, crypto: require('node:crypto').webcrypto,
    confirm: () => true, prompt: () => '10', fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      const value = await handler(url, options);
      return { ok: value?.error === undefined, status: value?.error ? 503 : 200, json: async () => value };
    } };
  vm.runInNewContext(script, context);
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { $, window, requests, flush, submit() { $('reminderForm').listeners.submit({ preventDefault() {} }); }, click(id) { $(id).listeners.click({}); } };
}
const settings = { timezone_offset_minutes: 420, quiet_enabled: false, quiet_start: '22:00', quiet_end: '07:00' };
const empty = url => url.includes('reminder-settings') ? settings : url.includes('occurrences') ? { occurrences: [], has_more: false } : { reminders: [], has_more: false };

test('a closed/switched device cannot receive a late dashboard response', async () => {
  let release;
  const f = fixture(url => url.includes('/a/reminder-settings') ? new Promise(resolve => { release = resolve; }) : empty(url));
  const first = f.window.XiaozhiReminders.open('a');
  await f.window.XiaozhiReminders.open('b');
  release({ ...settings, timezone_offset_minutes: 540 }); await first;
  assert.equal(f.$('reminderDevice').textContent, 'b');
  assert.equal(f.$('reminderDefaultOffset').value, 420);
  f.window.XiaozhiReminders.close();
});

test('a failed create keeps its request key; a successful create resets the form without restarting the device', async () => {
  const keys = []; let fail = true;
  const f = fixture((url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); keys.push(body.request_key);
      return fail ? { error: 'outcome unknown' } : { reminder: { summary: 'Sekali', next_local: '2026-10-09T08:00 WIB' } };
    }
    return empty(url);
  });
  await f.window.XiaozhiReminders.open('a');
  f.$('reminderTitle').value = 'Minum'; f.submit(); await f.flush();
  fail = false; f.submit(); await f.flush();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(f.$('reminderTitle').value, '');
  assert.match(f.$('reminderStatus').textContent, /Tersimpan/);
  assert.ok(f.requests.every(row => !row.url.includes('/config')));
  const write = f.requests.find(row => row.method === 'POST');
  assert.equal(write.headers['X-Requested-With'], 'XiaozhiDashboard');
  f.window.XiaozhiReminders.close();
});

test('saved reminder text renders as text, and editing only its title preserves the original timing', async () => {
  const row = { id: 'test-id', title: '<img src=x onerror=alert(1)>', text: '<b>data</b>', status: 'active', revision: 2,
    summary: 'Setiap hari 08:00 WIB', next_local: '2026-10-10T08:00 WIB',
    schedule: { kind: 'daily', minute: 480, timezone_offset_minutes: 420, start_at: Date.parse('2026-10-09T00:00:22Z'), end_at: null } };
  let patch;
  const f = fixture((url, options) => {
    if (options.method === 'PATCH') { patch = JSON.parse(options.body); return { reminder: row }; }
    if (url.endsWith('/test-id')) return { reminder: row, occurrences: [] };
    if (url.includes('/reminders?')) return { reminders: [row], has_more: false };
    return empty(url);
  });
  await f.window.XiaozhiReminders.open('a');
  const li = f.$('reminderList').children[0];
  assert.equal(li.children[0].textContent, row.title);
  const edit = li.children[2].children.find(button => button.textContent === 'Ubah');
  edit.listeners.click(); await f.flush();
  f.$('reminderTitle').value = 'Judul baru'; f.submit(); await f.flush();
  assert.equal(patch.title, 'Judul baru'); assert.equal(patch.revision, 2);
  assert.equal(Object.hasOwn(patch, 'schedule'), false);
  f.window.XiaozhiReminders.clear();
});
