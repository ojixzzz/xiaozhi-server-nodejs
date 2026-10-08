'use strict';

// Isolated browser regression tests. No real device, gateway, or audio URL is contacted.
// DOM checks: node --test test/ui.test.js
// Optional real browser: RUN_BROWSER_TESTS=1 node --test test/ui.test.js
// Set CHROMIUM_PATH if needed. Browser checks require Chromium socket permissions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const chromium = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find(file => file && fs.existsSync(file));

test('dashboard inline JavaScript parses', () => {
    new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

function browserFixture() {
    window.__requests = [];
    window.__pending = [];
    window.__hold = null;
    window.__notificationMode = 'published';
    window.__memoryError = null;
    window.__gatewayStatus = { enabled: true, configured: true, notifyAllowHttp: false, audioConfigured: true };
    window.__audioAssets = { configured: true, files: [{ name: 'sample-chime.ogg', size: 2796 }] };
    window.__transportError = null;
    window.__loginError = null;
    window.__inboxMode = 'published';
    window.__beepMode = 'published';
    window.__inboxError = null;
    window.__inboxDetailError = null;
    window.__inboxReadError = null;
    window.__inboxKeys = {};
    window.__beepKeys = {};
    window.__beepPublications = 0;
    window.__inboxSequence = 20;
    const record = (number, read = false) => ({
        id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
        sender: number === 1 ? '<b>Sender</b>' : 'test sender', title: `Message ${number}`,
        text: number === 1 ? '<img src=x onerror="window.__injected=true">\nFull message, not executable HTML.' : `Saved message body ${number}`,
        createdAt: 1791350000000 - number * 1000, readAt: read ? 1791350050000 : null,
        beep: { status: 'not_published', reason: 'Device offline', updatedAt: 1791350000000 }
    });
    window.__inboxes = {
        'AA:BB:CC:DD:EE:01': Array.from({ length: 7 }, (_, i) => record(i + 1, i >= 5)),
        'AA:BB:CC:DD:EE:03': [record(8)]
    };
    window.__confirmAnswer = true;
    window.__confirmations = [];
    window.confirm = message => { window.__confirmations.push(message); return window.__confirmAnswer; };
    window.setInterval = () => 0;
    window.__devices = {
        'AA:BB:CC:DD:EE:01': { status: 'approved' },
        'AA:BB:CC:DD:EE:02': { status: 'pending' },
        'AA:BB:CC:DD:EE:03': { status: 'approved', transport: 'mqtt' }
    };
    window.__memories = {
        'AA:BB:CC:DD:EE:01': { enabled: false, facts: [], turns: [], retentionDays: 30, contextMaxChars: 6000, maxRecentTurns: 8 },
        'AA:BB:CC:DD:EE:03': {
            enabled: true, facts: ['Device three fact'], retentionDays: 30, contextMaxChars: 6000, maxRecentTurns: 8,
            turns: [{ user: '<img src=x onerror="window.__injected=true">', assistant: '<b>Text only</b>', createdAt: '2026-10-07T05:00:00Z' }]
        }
    };
    window.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : undefined;
        window.__requests.push({ url, method, body, headers: options.headers || {} });
        let data = {};
        let code = 200;
        if (url === '/api/login' && window.__loginError) { code = window.__loginError.status; data = window.__loginError.body; }
        else if (url === '/api/providers') data = { default_backend: 'gemini', providers: [] };
        else if (url === '/api/mqtt/status') data = window.__gatewayStatus;
        else if (url === '/api/notification-audio') data = window.__audioAssets;
        else if (url === '/api/notification-audio/url') data = {
            audio_url: `https://audio.example.test/notification-audio/${body.name}?expires=1791357000&signature=test-fixture`,
            expires_at: '2026-10-07T07:10:00.000Z'
        };
        else if (url === '/api/devices') data = window.__devices;
        else if (url === '/api/mcp_devices') data = {};
        else if (url.startsWith('/api/devices/')) {
            const requestUrl = new URL(url, 'https://dashboard.example.test');
            const parts = requestUrl.pathname.split('/');
            const mac = decodeURIComponent(parts[3]);
            if (parts[4] === 'inbox') {
                const records = window.__inboxes[mac];
                const entry = records.find(item => item.id === parts[5]);
                if (parts[6] === 'read') {
                    if (window.__inboxReadError) { code = window.__inboxReadError; data = { error: '<b>Read status unavailable</b>' }; }
                    else if (!entry) { code = 404; data = { error: 'Notification not found' }; }
                    else { entry.readAt ??= 1791350100000; data = entry; }
                } else if (parts[6] === 'beep') {
                    if (window.__beepMode === 'network_error') throw new TypeError('Offline');
                    if (!entry) { code = 404; data = { error: 'Notification not found' }; }
                    else {
                        const key = `${mac}/${entry.id}/${body.attempt_id}`;
                        if (!window.__beepKeys[key]) {
                            window.__beepPublications++;
                            entry.beep = { status: window.__beepMode === 'lost_response' ? 'published' : window.__beepMode, reason: '', updatedAt: 1791350100000 };
                            window.__beepKeys[key] = { stored: true, notification_id: entry.id, beep: { ...entry.beep, playback: 'unknown' }, beep_status_persisted: true };
                        }
                        data = window.__beepKeys[key];
                        if (window.__beepMode === 'lost_response') throw new TypeError('Response lost');
                    }
                } else if (parts[5]) {
                    if (window.__inboxDetailError) { code = window.__inboxDetailError; data = { error: '<b>Message unavailable</b>' }; }
                    else if (!entry) { code = 404; data = { error: 'Notification not found' }; }
                    else data = entry;
                } else if (method === 'POST') {
                    if (window.__inboxMode === 'network_error') throw new TypeError('Offline');
                    if (window.__inboxMode === 'storage_error') { code = 503; data = { error: { code: 'INBOX_UNAVAILABLE', message: '<b>Storage unavailable</b>' } }; }
                    else {
                        const key = `${mac}/${body.idempotency_key}`;
                        const duplicate = Boolean(window.__inboxKeys[key]);
                        let item = window.__inboxKeys[key];
                        if (!item) {
                            item = record(++window.__inboxSequence);
                            item.sender = 'dashboard'; item.title = body.title; item.text = body.text;
                            item.beep = { status: window.__inboxMode === 'lost_response' ? 'published' : window.__inboxMode, reason: window.__inboxMode === 'not_published' ? 'Device offline' : '', updatedAt: 1791350100000 };
                            records.unshift(item); window.__inboxKeys[key] = item;
                        }
                        data = { stored: true, notification_id: item.id, device_id: mac, duplicate, beep: { ...item.beep, playback: 'unknown' }, beep_status_persisted: true };
                        if (window.__inboxMode === 'lost_response') throw new TypeError('Response lost');
                    }
                } else if (window.__inboxError) { code = window.__inboxError; data = { error: '<b>Inbox unavailable</b>' }; }
                else {
                    const unreadOnly = requestUrl.searchParams.get('unread_only') !== 'false';
                    const filtered = unreadOnly ? records.filter(item => item.readAt === null) : records;
                    const start = Number(requestUrl.searchParams.get('cursor') || 0);
                    const page = filtered.slice(start, start + 5);
                    data = {
                        notifications: page.map(({ text, ...item }) => ({ ...item, preview: text.slice(0, 240) })),
                        unreadCount: records.filter(item => item.readAt === null).length,
                        nextCursor: start + 5 < filtered.length ? String(start + 5) : null
                    };
                }
            } else if (parts[4] === 'transport') {
                if (window.__transportError) {
                    code = window.__transportError;
                    data = { error: '<b>Device OTA identity is missing; fetch OTA first</b>' };
                } else {
                    window.__devices[mac].transport = body.transport;
                    data = { transport: body.transport };
                }
            } else if (parts[4] === 'memory') {
                if (window.__memoryError) {
                    code = window.__memoryError;
                    data = { error: '<b>Memory unavailable</b>' };
                } else {
                    if (method === 'PUT') {
                        window.__memories[mac] = {
                            ...window.__memories[mac], enabled: body.enabled,
                            facts: body.enabled ? body.facts : [],
                            turns: body.enabled ? window.__memories[mac].turns : []
                        };
                    }
                    if (method === 'DELETE') window.__memories[mac] = { ...window.__memories[mac], facts: [], turns: [] };
                    data = window.__memories[mac];
                }
            } else if (parts[4] === 'notifications') {
                if (window.__notificationMode === 'network_error') throw new TypeError('Offline');
                if (window.__notificationMode === 'not_published') code = 409;
                data = {
                    status: window.__notificationMode,
                    message: '<b>Gateway response</b>',
                    playback: 'unknown'
                };
            }
        }
        const snapshot = JSON.stringify(data);
        const respond = () => new Response(snapshot, { status: code, headers: { 'Content-Type': 'application/json' } });
        const pathname = new URL(url, 'https://dashboard.example.test').pathname;
        const inboxHold = window.__hold === 'inbox-list' && method === 'GET' && pathname.endsWith('/inbox') ||
            window.__hold === 'inbox-save' && method === 'POST' && pathname.endsWith('/inbox') ||
            window.__hold === 'inbox-detail' && method === 'GET' && /\/inbox\/[^/]+$/.test(pathname);
        if (window.__hold && (pathname.endsWith('/' + window.__hold) || inboxHold)) {
            // Deliberately ignore AbortSignal to model a response already in flight.
            return new Promise(resolve => window.__pending.push(() => resolve(respond())));
        }
        return respond();
    };
}

async function connectCdp(browser) {
    const ws = new WebSocket(browser.webSocketDebuggerUrl);
    await once(ws, 'open');
    let sequence = 0;
    const waiting = new Map();
    ws.addEventListener('message', event => {
        const reply = JSON.parse(event.data);
        if (!reply.id || !waiting.has(reply.id)) return;
        const { resolve, reject, timer } = waiting.get(reply.id);
        waiting.delete(reply.id);
        clearTimeout(timer);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result);
    });
    return {
        close: () => ws.close(),
        call(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
                waiting.set(id, { resolve, reject, timer });
                ws.send(JSON.stringify({ id, method, params }));
            });
        }
    };
}

test('memory and notification browser flows', { skip: !process.env.RUN_BROWSER_TESTS ? 'Opt-in browser check; not run (RUN_BROWSER_TESTS=1 requires Chromium socket permissions)' : !chromium && 'Chromium is not installed', timeout: 60000 }, async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhi-ui-'));
    const fixture = html.replace('<script>', `<script>(${browserFixture.toString()})();</script><script>`);
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const child = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let cdp;
    t.after(async () => {
        if (cdp) cdp.close();
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), delay(3000)]);
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
    });
    let port;
    for (let i = 0; i < 100; i++) {
        try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch (_) {}
        if (child.exitCode !== null) throw new Error(`Chromium exited: ${stderr}`);
        await delay(50);
    }
    assert.ok(port, `Chromium failed to start: ${stderr}`);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    cdp = await connectCdp(pages.find(page => page.type === 'page'));
    await cdp.call('Runtime.enable');
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    async function evaluate(expression) {
        const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    async function waitUntil(expression) {
        for (let i = 0; i < 100; i++) {
            if (await evaluate(expression)) return;
            await delay(20);
        }
        assert.fail(`Browser condition timed out: ${expression}`);
    }
    await exerciseUi(t, evaluate, waitUntil);

    if (process.env.UI_SCREENSHOT_PATH) {
        await evaluate(`openMemoryNotifyModal('AA:BB:CC:DD:EE:03')`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
        await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false });
        const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(process.env.UI_SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    }
});

async function exerciseUi(t, evaluate, waitUntil) {
    const A = 'AA:BB:CC:DD:EE:01';
    const C = 'AA:BB:CC:DD:EE:03';
    await waitUntil(`document.getElementById('deviceTableBody').children.length === 3`);

    await t.test('approved-only button and existing configuration modal still work', async () => {
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('#deviceTableBody button')).filter(b => b.textContent === 'Memory & Notify').length`), 2);
        await evaluate(`openConfigModal('${A}')`);
        assert.equal(await evaluate(`document.getElementById('configMacDisplay').textContent`), A);
        assert.equal(await evaluate(`document.getElementById('configVoiceIdleSeconds').value`), '');
        await evaluate(`document.getElementById('configVoiceIdleSeconds').value='1'; saveConfig()`);
        assert.match(await evaluate(`document.getElementById('configStatus').textContent`), /15–3600/);
        assert.equal(await evaluate(`document.getElementById('configModal').classList.contains('hidden')`), false);
        await evaluate(`closeConfigModal()`);
        assert.equal(await evaluate(`document.getElementById('configModal').classList.contains('hidden')`), true);
    });

    await t.test('memory starts unchecked and locked while loading, then requires explicit save', async () => {
        await evaluate(`window.__hold='memory'; openMemoryNotifyModal('${A}')`);
        assert.equal(await evaluate(`document.getElementById('memoryEnabled').checked`), false);
        assert.equal(await evaluate(`document.getElementById('memoryFields').disabled`), true);
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
        assert.match(await evaluate(`document.getElementById('memoryRetention').textContent`), /turns and explicit facts.*30 days.*saving facts renews/);
        assert.match(await evaluate(`document.getElementById('memoryContextLimit').textContent`), /6000 characters.*wrapper.*8 recent turns.*does not cap the ongoing live conversation/);
        await evaluate(`document.getElementById('memoryEnabled').checked=true; document.getElementById('memoryFacts').value='First fact\\nSecond fact'`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='PUT').length`), 0);
        await evaluate(`saveStoredMemory()`);
        assert.deepEqual(await evaluate(`__requests.find(r => r.method==='PUT').body`), { enabled: true, facts: ['First fact', 'Second fact'] });
    });

    await t.test('fact limits and explicit disable payload', async () => {
        const before = await evaluate(`__requests.filter(r => r.method==='PUT').length`);
        await evaluate(`document.getElementById('memoryFacts').value=Array(21).fill('fact').join('\\n'); saveStoredMemory()`);
        await evaluate(`document.getElementById('memoryFacts').value='a'.repeat(501); saveStoredMemory()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='PUT').length`), before);
        await evaluate(`document.getElementById('memoryFacts').value=Array(20).fill('a'.repeat(500)).join('\\n'); saveStoredMemory()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='PUT').at(-1).body.facts.length`), 20);
        await evaluate(`window.__confirmAnswer=false; document.getElementById('memoryEnabled').checked=false; saveStoredMemory()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='PUT').at(-1).body.enabled`), true);
        await evaluate(`window.__confirmAnswer=true; saveStoredMemory()`);
        assert.deepEqual(await evaluate(`__requests.filter(r => r.method==='PUT').at(-1).body`), { enabled: false, facts: [] });
        assert.match(await evaluate(`document.getElementById('memoryStatus').textContent`), /must reconnect/);
    });

    await t.test('transcripts render as text and deletion needs the exact device address', async () => {
        await evaluate(`openMemoryNotifyModal('${C}')`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('#memoryTurns img, #memoryTurns b').length`), 0);
        assert.match(await evaluate(`document.getElementById('memoryTurns').textContent`), /<img src=x onerror=/);
        assert.equal(await evaluate(`Boolean(window.__injected)`), false);
        await evaluate(`document.getElementById('forgetMemoryConfirm').value='${C.toLowerCase()}'; forgetStoredMemory()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='DELETE').length`), 0);
        await evaluate(`document.getElementById('forgetMemoryConfirm').value='${C}'; document.getElementById('forgetMemoryConfirm').dispatchEvent(new Event('input'))`);
        assert.equal(await evaluate(`document.getElementById('forgetMemoryButton').disabled`), false);
        await evaluate(`forgetStoredMemory()`);
        assert.deepEqual(await evaluate(`__requests.find(r => r.method==='DELETE').body`), { confirm: C });
        assert.equal(await evaluate(`document.getElementById('memoryEnabled').checked`), true);
        assert.equal(await evaluate(`document.getElementById('forgetMemoryButton').disabled`), true);
    });

    await t.test('repeated writes and closed or older memory responses cannot change a newer view', async () => {
        await evaluate(`window.__hold='memory'; document.getElementById('memoryFacts').value='saved for C'; saveStoredMemory(); saveStoredMemory()`);
        assert.equal(await evaluate(`__pending.length`), 1);
        await evaluate(`closeMemoryNotifyModal(); window.__hold=null; openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
        await evaluate(`window.__pending.shift()()`);
        await delay(20);
        assert.equal(await evaluate(`document.getElementById('memoryDeviceDisplay').textContent`), A);
        assert.equal(await evaluate(`document.getElementById('memoryFacts').value`), '');
        await evaluate(`closeMemoryNotifyModal(); window.__hold='memory'; openMemoryNotifyModal('${C}'); closeMemoryNotifyModal(); window.__pending.shift()()`);
        await delay(20);
        assert.equal(await evaluate(`document.getElementById('memoryNotifyModal').classList.contains('hidden')`), true);
        assert.equal(await evaluate(`document.getElementById('memoryFacts').value`), '');
        await evaluate(`window.__hold=null; openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
    });

    await t.test('API errors are safely displayed and memory can be refreshed', async () => {
        await evaluate(`window.__memoryError=401; refreshStoredMemory()`);
        assert.equal(await evaluate(`document.getElementById('memoryFields').disabled`), true);
        assert.equal(await evaluate(`document.querySelectorAll('#memoryStatus b').length`), 0);
        assert.match(await evaluate(`document.getElementById('memoryStatus').textContent`), /<b>Memory unavailable<\/b>/);
        await evaluate(`window.__memoryError=null; refreshStoredMemory()`);
        assert.equal(await evaluate(`document.getElementById('memoryFields').disabled`), false);
    });

    await t.test('transport defaults to WebSocket and disabled gateway blocks MQTT and notification writes', async () => {
        await waitUntil(`!document.getElementById('transportFields').disabled`);
        assert.equal(await evaluate(`document.getElementById('deviceTransport').value`), 'websocket');
        assert.equal(await evaluate(`document.getElementById('notificationFields').disabled`), true);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/transport')).length`), 0);
        await evaluate(`window.__gatewayStatus.enabled=false; window.__gatewayStatus.reason='<b>Set MQTT_GATEWAY_ENABLED</b>'; refreshNotificationSetup()`);
        assert.equal(await evaluate(`document.getElementById('mqttTransportOption').disabled`), true);
        assert.equal(await evaluate(`document.querySelectorAll('#mqttSetupStatus b').length`), 0);
        await evaluate(`document.getElementById('deviceTransport').value='mqtt'; saveDeviceTransport(); sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/transport') || r.url.endsWith('/notifications')).length`), 0);
        await evaluate(`window.__gatewayStatus.enabled=true; window.__gatewayStatus.reason=''; refreshNotificationSetup()`);
    });

    await t.test('MQTT cutover requires explicit confirmed save and does not reboot or send', async () => {
        await evaluate(`document.getElementById('deviceTransport').value='mqtt'; window.__confirmAnswer=false; saveDeviceTransport()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/transport')).length`), 0);
        await evaluate(`window.__confirmAnswer=true; window.__hold='transport'; saveDeviceTransport(); saveDeviceTransport()`);
        assert.equal(await evaluate(`__pending.length`), 1);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/transport')).length`), 1);
        const request = await evaluate(`__requests.filter(r => r.url.endsWith('/transport')).at(-1)`);
        assert.deepEqual(request.body, { transport: 'mqtt' });
        assert.equal(request.headers['X-Requested-With'], 'XiaozhiDashboard');
        assert.match(await evaluate(`__confirmations.at(-1)`), /reboot or fetch OTA/);
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('transportFields').disabled`);
        assert.match(await evaluate(`document.getElementById('transportStatus').textContent`), /MQTT transport saved.*Reboot/);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`), 0);
        assert.equal(await evaluate(`__requests.some(r => /reboot|flash/.test(r.url))`), false);
    });

    await t.test('transport API rejection is readable and requires refresh before another write', async () => {
        await evaluate(`window.__transportError=409; document.getElementById('deviceTransport').value='websocket'; saveDeviceTransport()`);
        assert.match(await evaluate(`document.getElementById('transportStatus').textContent`), /Device OTA identity is missing.*Refresh connection setup/);
        assert.equal(await evaluate(`document.querySelectorAll('#transportStatus b').length`), 0);
        assert.equal(await evaluate(`document.getElementById('transportFields').disabled`), true);
        await evaluate(`window.__transportError=null; refreshNotificationSetup()`);
        assert.equal(await evaluate(`document.getElementById('deviceTransport').value`), 'mqtt');
    });

    await t.test('local audio selection creates a link without playing, fetching, or synthesizing it', async () => {
        assert.match(await evaluate(`document.getElementById('notificationAudioAsset').textContent`), /test tone, no speech/);
        await evaluate(`document.getElementById('notificationAudioAsset').value='sample-chime.ogg'; window.__hold='url'; useLocalNotificationAudio(); useLocalNotificationAudio()`);
        assert.equal(await evaluate(`__pending.length`), 1);
        assert.equal(await evaluate(`__requests.filter(r => r.url==='/api/notification-audio/url').length`), 1);
        assert.deepEqual(await evaluate(`__requests.filter(r => r.url==='/api/notification-audio/url').at(-1).body`), { name: 'sample-chime.ogg' });
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('notificationAudioAsset').disabled`);
        assert.match(await evaluate(`document.getElementById('notificationAudioUrl').value`), /^https:\/\/audio\.example\.test\/notification-audio\/sample-chime\.ogg/);
        assert.match(await evaluate(`document.getElementById('notificationAudioStatus').textContent`), /Nothing has been sent/);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`), 0);
        assert.equal(await evaluate(`__requests.some(r => /^https?:/.test(r.url))`), false);
    });

    await t.test('notification validation, CSRF header, repeated-click guard and honest published status', async () => {
        await evaluate(`document.getElementById('notificationAudioUrl').value='http://example.com/audio.ogg'; sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`), 0);
        await evaluate(`document.getElementById('notificationAudioUrl').value='https://example.com/audio.ogg'; document.getElementById('notificationSubtitle').value='音'.repeat(171); sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`), 0);
        assert.match(await evaluate(`document.getElementById('notificationStatus').textContent`), /512 UTF-8 bytes/);
        await evaluate(`document.getElementById('notificationSubtitle').value='Hello'; window.__hold='notifications'; sendAudioNotification(); sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`), 1);
        const request = await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).at(-1)`);
        assert.equal(request.headers['X-Requested-With'], 'XiaozhiDashboard');
        assert.deepEqual(request.body.subtitles, [{ start_ms: 0, text: 'Hello' }]);
        assert.match(request.body.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('notificationFields').disabled`);
        assert.equal(await evaluate(`document.getElementById('sendNotificationButton').disabled`), true);
        assert.match(await evaluate(`document.getElementById('notificationStatus').textContent`), /Status: published.*Playback.*unconfirmed/);
        assert.equal(await evaluate(`document.querySelectorAll('#notificationStatus b').length`), 0);
        assert.equal(await evaluate(`__requests.some(r => r.url.startsWith('https:'))`), false);
        assert.equal(await evaluate(`__requests.filter(r => ['PUT','DELETE','POST'].includes(r.method)).every(r => r.headers['X-Requested-With']==='XiaozhiDashboard')`), true);
    });

    await t.test('transport failures reuse the request ID and unknown is never called delivered', async () => {
        await evaluate(`startAnotherNotification(); document.getElementById('notificationAudioUrl').value='https://example.com/retry.ogg'; window.__notificationMode='network_error'; sendAudioNotification()`);
        const firstKey = await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).at(-1).body.idempotency_key`);
        assert.match(await evaluate(`document.getElementById('notificationStatus').textContent`), /Delivery is unknown/);
        await evaluate(`window.__notificationMode='unknown'; sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).at(-1).body.idempotency_key`), firstKey);
        assert.match(await evaluate(`document.getElementById('notificationStatus').textContent`), /Status: unknown.*unconfirmed/);
        assert.equal(await evaluate(`document.getElementById('notificationStatus').dataset.tone`), 'warning');
    });

    await t.test('notification dismissal preserves its retry ID and a late response stays out of another device view', async () => {
        await evaluate(`startAnotherNotification(); document.getElementById('notificationAudioUrl').value='https://example.com/late.ogg'; window.__hold='notifications'; window.__notificationMode='published'; void sendAudioNotification()`);
        const key = await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).at(-1).body.idempotency_key`);
        await evaluate(`closeMemoryNotifyModal(); openMemoryNotifyModal('${C}'); window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
        assert.equal(await evaluate(`document.getElementById('notificationStatus').textContent`), '');
        await evaluate(`openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('memoryFields').disabled`);
        assert.match(await evaluate(`document.getElementById('notificationRequestId').textContent`), new RegExp(key));
        assert.match(await evaluate(`document.getElementById('notificationStatus').textContent`), /published/);
        await evaluate(`document.getElementById('memoryNotifyModal').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        assert.equal(await evaluate(`document.getElementById('memoryNotifyModal').classList.contains('hidden')`), true);
    });


    await t.test('HTTP audio is accepted only after server status explicitly allows it', async () => {
        await evaluate(`openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('transportFields').disabled`);
        await evaluate(`startAnotherNotification(); window.__gatewayStatus.notifyAllowHttp=true; refreshNotificationSetup()`);
        assert.match(await evaluate(`document.getElementById('notificationUrlHelp').textContent`), /explicitly enabled HTTP/);
        await evaluate(`document.getElementById('notificationAudioUrl').value='http://audio.example.test/local.ogg'; sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).at(-1).body.audio_url`), 'http://audio.example.test/local.ogg');
        const before = await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`);
        await evaluate(`startAnotherNotification(); window.__gatewayStatus.notifyAllowHttp=false; refreshNotificationSetup()`);
        await evaluate(`document.getElementById('notificationAudioUrl').value='http://audio.example.test/local.ogg'; sendAudioNotification()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/notifications')).length`), before);
        assert.match(await evaluate(`document.getElementById('notificationStatus').textContent`), /HTTPS audio URL/);
    });

    await t.test('a late local audio response cannot replace another device form', async () => {
        await evaluate(`document.getElementById('notificationAudioAsset').value='sample-chime.ogg'; window.__hold='url'; void useLocalNotificationAudio()`);
        await evaluate(`closeMemoryNotifyModal(); openMemoryNotifyModal('${C}'); window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('transportFields').disabled`);
        assert.equal(await evaluate(`document.getElementById('notificationAudioUrl').value`), '');
        assert.equal(await evaluate(`document.getElementById('memoryDeviceDisplay').textContent`), C);
    });

    await t.test('notification-service disabled status blocks sends even with configured MQTT', async () => {
        await evaluate(`window.__gatewayStatus.notifications={enabled:false,configured:true}; refreshNotificationSetup()`);
        assert.equal(await evaluate(`document.getElementById('notificationFields').disabled`), true);
        assert.equal(await evaluate(`document.getElementById('mqttTransportOption').disabled`), false);
        assert.match(await evaluate(`document.getElementById('mqttSetupStatus').textContent`), /NOTIFY_ENABLED=true/);
        await evaluate(`window.__gatewayStatus.notifications={enabled:true,configured:false}; refreshNotificationSetup()`);
        assert.equal(await evaluate(`document.getElementById('notificationFields').disabled`), true);
        assert.match(await evaluate(`document.getElementById('mqttSetupStatus').textContent`), /approved audio origins/);
        await evaluate(`window.__gatewayStatus.notifications={enabled:true,configured:true}; refreshNotificationSetup()`);
    });

    await t.test('unconfigured audio is disabled without blocking an approved external URL', async () => {
        await evaluate(`window.__audioAssets={configured:false,files:[]}; refreshNotificationSetup()`);
        assert.equal(await evaluate(`document.getElementById('notificationAudioAsset').disabled`), true);
        assert.equal(await evaluate(`document.getElementById('useLocalAudioButton').disabled`), true);
        assert.equal(await evaluate(`document.getElementById('notificationFields').disabled`), false);
        assert.match(await evaluate(`document.getElementById('notificationAudioStatus').textContent`), /NOTIFY_AUDIO_BASE_URL/);
        await evaluate(`closeMemoryNotifyModal()`);
    });


    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';

    await t.test('inbox defaults to all messages with accurate page counts, paging and explicit refresh', async () => {
        await evaluate(`openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        assert.equal(await evaluate(`document.getElementById('inboxFilter').value`), 'all');
        assert.equal(await evaluate(`__requests.filter(r => r.url.includes('/inbox?')).at(-1).url`), `/api/devices/${encodeURIComponent(A)}/inbox?unread_only=false`);
        assert.equal(await evaluate(`document.getElementById('inboxList').children.length`), 5);
        assert.match(await evaluate(`document.getElementById('inboxCounts').textContent`), /5 unread in this device.*This page: 5 unread, 0 read/);
        await evaluate(`changeInboxPage(true)`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        assert.match(await evaluate(`__requests.filter(r => r.url.includes('/inbox?')).at(-1).url`), /cursor=5$/);
        assert.equal(await evaluate(`document.getElementById('inboxList').children.length`), 2);
        assert.equal(await evaluate(`document.getElementById('inboxPageLabel').textContent`), 'Page 2');
        assert.match(await evaluate(`document.getElementById('inboxCounts').textContent`), /This page: 0 unread, 2 read/);
        assert.equal(await evaluate(`document.getElementById('inboxNextButton').disabled`), true);
        await evaluate(`changeInboxPage(false)`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        assert.equal(await evaluate(`document.getElementById('inboxPageLabel').textContent`), 'Page 1');
        await evaluate(`changeInboxPage(true)`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`refreshInbox()`);
        assert.equal(await evaluate(`document.getElementById('inboxPageLabel').textContent`), 'Page 1');
        await evaluate(`document.getElementById('inboxFilter').value='unread'; document.getElementById('inboxFilter').dispatchEvent(new Event('change'))`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        assert.equal(await evaluate(`document.getElementById('inboxList').children.length`), 5);
        assert.equal(await evaluate(`document.getElementById('inboxNextButton').disabled`), true);
    });

    await t.test('listing and safe detail do not mark read; explicit read is confirmed and repeated clicks are guarded', async () => {
        const before = await evaluate(`__requests.filter(r => r.url.endsWith('/read')).length`);
        await evaluate(`openInboxDetail('${firstId}')`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/read')).length`), before);
        assert.equal(await evaluate(`document.querySelectorAll('#inboxList img, #inboxList b, #inboxDetail img, #inboxDetail b').length`), 0);
        assert.match(await evaluate(`document.getElementById('inboxDetailText').textContent`), /<img src=x onerror=/);
        assert.match(await evaluate(`document.getElementById('inboxDetailStatus').textContent`), /Unread.*does not mark it read/);
        assert.equal(await evaluate(`Boolean(window.__injected)`), false);
        await evaluate(`window.__hold='read'; void markInboxRead(); void markInboxRead()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/read')).length`), before + 1);
        assert.equal(await evaluate(`document.getElementById('markInboxReadButton').disabled`), true);
        const request = await evaluate(`__requests.filter(r => r.url.endsWith('/read')).at(-1)`);
        assert.deepEqual(request.body, { confirm: true });
        assert.equal(request.headers['X-Requested-With'], 'XiaozhiDashboard');
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled && document.getElementById('inboxDetailStatus').textContent.startsWith('Read')`);
        assert.equal(await evaluate(`document.getElementById('inboxList').children.length`), 4);
        assert.equal(await evaluate(`document.getElementById('markInboxReadButton').disabled`), true);
        assert.match(await evaluate(`document.getElementById('inboxCounts').textContent`), /^4 unread/);
        await evaluate(`markInboxRead()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/read')).length`), before + 1);
    });

    await t.test('inbox errors are readable and safely rendered, with read and detail recovery', async () => {
        await evaluate(`window.__inboxError=503; refreshInbox()`);
        assert.match(await evaluate(`document.getElementById('inboxStatus').textContent`), /Inbox unavailable/);
        assert.equal(await evaluate(`document.querySelectorAll('#inboxStatus b').length`), 0);
        assert.equal(await evaluate(`document.getElementById('inboxList').children.length`), 0);
        await evaluate(`window.__inboxError=null; refreshInbox()`);
        await evaluate(`window.__inboxDetailError=404; openInboxDetail('${secondId}')`);
        assert.match(await evaluate(`document.getElementById('inboxDetailStatus').textContent`), /Message unavailable/);
        assert.equal(await evaluate(`document.getElementById('markInboxReadButton').disabled`), true);
        assert.equal(await evaluate(`document.querySelectorAll('#inboxDetailStatus b').length`), 0);
        await evaluate(`window.__inboxDetailError=null; openInboxDetail('${secondId}')`);
        await evaluate(`window.__inboxReadError=503; markInboxRead()`);
        assert.match(await evaluate(`document.getElementById('inboxDetailStatus').textContent`), /Read status unavailable.*not confirmed/);
        assert.equal(await evaluate(`document.querySelectorAll('#inboxDetailStatus b').length`), 0);
        await evaluate(`window.__inboxReadError=null; openInboxDetail('${secondId}')`);
        assert.match(await evaluate(`document.getElementById('inboxDetailStatus').textContent`), /^Unread/);
    });

    await t.test('closed and older detail/list responses cannot overwrite newer navigation', async () => {
        await evaluate(`window.__hold='inbox-detail'; void openInboxDetail('${firstId}')`);
        await evaluate(`window.__hold=null; openInboxDetail('${secondId}')`);
        await evaluate(`window.__pending.shift()()`);
        await delay(10);
        assert.equal(await evaluate(`document.getElementById('inboxDetailTitle').textContent`), 'Message 2');
        await evaluate(`window.__hold='inbox-detail'; void openInboxDetail('${firstId}'); closeInboxDetail(); window.__pending.shift()()`);
        await delay(10);
        assert.equal(await evaluate(`document.getElementById('inboxDetail').classList.contains('hidden')`), true);
        await evaluate(`window.__hold='inbox-list'; void refreshInbox(); closeMemoryNotifyModal(); window.__hold=null; openMemoryNotifyModal('${C}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`window.__pending.shift()()`);
        await delay(10);
        assert.match(await evaluate(`document.getElementById('inboxList').textContent`), /Message 8/);
        assert.doesNotMatch(await evaluate(`document.getElementById('inboxList').textContent`), /Message 2/);
        await evaluate(`openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        assert.equal(await evaluate(`document.getElementById('inboxFilter').value`), 'all');
    });

    await t.test('manual message validates bounded text and remains available without MQTT or Hermes', async () => {
        const before = await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).length`);
        await evaluate(`document.getElementById('inboxMessageText').value=''; saveInboxMessage()`);
        await evaluate(`document.getElementById('inboxMessageTitle').value='x'.repeat(121); document.getElementById('inboxMessageText').value='hello'; saveInboxMessage()`);
        await evaluate(`document.getElementById('inboxMessageTitle').value='title'; document.getElementById('inboxMessageText').value='x'.repeat(2001); saveInboxMessage()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).length`), before);
        await evaluate(`window.__gatewayStatus.enabled=false; refreshNotificationSetup()`);
        assert.equal(await evaluate(`document.getElementById('saveInboxMessageButton').disabled`), false);
        assert.equal(await evaluate(`document.getElementById('notificationFields').disabled`), true);
        assert.match(html, /No Hermes or external sender token is needed/);
        assert.match(html, /Audio-only test \(no inbox message\)/);
        assert.match(html, /numeric memory\/inbox limits are configured server-side/);
        await evaluate(`document.getElementById('inboxMessageTitle').value='Offline test'; document.getElementById('inboxMessageText').value='Save this even while offline'; window.__inboxMode='not_published'; window.__hold='inbox-save'; void saveInboxMessage(); void saveInboxMessage()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).length`), before + 1);
        assert.equal(await evaluate(`document.getElementById('saveInboxMessageButton').disabled`), true);
        assert.equal(await evaluate(`document.getElementById('inboxMessageText').disabled`), true);
        const request = await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).at(-1)`);
        assert.deepEqual(Object.keys(request.body).sort(), ['idempotency_key', 'text', 'title']);
        assert.equal(request.headers['X-Requested-With'], 'XiaozhiDashboard');
        assert.match(request.body.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`document.getElementById('inboxStorageStatus').textContent.includes('Message saved') && !document.getElementById('refreshInboxButton').disabled`);
        assert.match(await evaluate(`document.getElementById('inboxList').textContent`), /Offline test.*Save this even while offline/s);
        assert.match(await evaluate(`document.getElementById('inboxStorageStatus').textContent`), /Message saved/);
        assert.match(await evaluate(`document.getElementById('inboxBeepStatus').textContent`), /not_published.*Device offline.*remain unknown/);
        assert.equal(await evaluate(`document.getElementById('saveInboxMessageButton').disabled`), true);
        await evaluate(`saveInboxMessage()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).length`), before + 1);
        await evaluate(`window.__confirmAnswer=false; startNewInboxMessage()`);
        assert.equal(await evaluate(`document.getElementById('inboxMessageTitle').value`), 'Offline test');
        await evaluate(`window.__confirmAnswer=true; window.__gatewayStatus.enabled=true`);
    });

    await t.test('unknown storage retries reuse immutable payload and UUID without duplicating the saved message', async () => {
        await evaluate(`startNewInboxMessage(); document.getElementById('inboxMessageTitle').value='Lost response'; document.getElementById('inboxMessageText').value='Stored once'; window.__inboxMode='lost_response'; saveInboxMessage()`);
        const first = await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).at(-1).body`);
        const count = await evaluate(`__inboxes['${A}'].length`);
        assert.match(await evaluate(`document.getElementById('inboxStorageStatus').textContent`), /Storage is unknown/);
        assert.equal(await evaluate(`document.getElementById('saveInboxMessageButton').textContent`), 'Retry same message');
        await evaluate(`document.getElementById('inboxMessageText').value='tampered form'; window.__inboxMode='published'; saveInboxMessage()`);
        assert.deepEqual(await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).at(-1).body`), first);
        assert.equal(await evaluate(`__inboxes['${A}'].length`), count);
        assert.match(await evaluate(`document.getElementById('inboxStorageStatus').textContent`), /already saved.*no duplicate/);
        assert.match(await evaluate(`document.getElementById('inboxBeepStatus').textContent`), /published.*remain unknown/);
        assert.equal(await evaluate(`document.getElementById('inboxMessageText').value`), 'Stored once');
    });

    await t.test('message closure preserves retry state and late acknowledgement stays out of another device view', async () => {
        await evaluate(`startNewInboxMessage(); document.getElementById('inboxMessageTitle').value='Slow save'; document.getElementById('inboxMessageText').value='Still saved'; window.__hold='inbox-save'; void saveInboxMessage()`);
        const key = await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).at(-1).body.idempotency_key`);
        await evaluate(`closeMemoryNotifyModal(); window.__hold=null; openMemoryNotifyModal('${C}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`window.__pending.shift()()`);
        await delay(10);
        assert.equal(await evaluate(`document.getElementById('inboxStorageStatus').textContent`), '');
        assert.equal(await evaluate(`document.getElementById('inboxMessageText').value`), '');
        await evaluate(`openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        assert.match(await evaluate(`document.getElementById('inboxMessageRequestId').textContent`), new RegExp(key));
        assert.match(await evaluate(`document.getElementById('inboxStorageStatus').textContent`), /Message saved/);
        assert.equal(await evaluate(`document.getElementById('saveInboxMessageButton').disabled`), true);
        await evaluate(`startNewInboxMessage(); document.getElementById('inboxMessageText').value='Check storage failure'; window.__inboxMode='storage_error'; saveInboxMessage()`);
        assert.match(await evaluate(`document.getElementById('inboxStorageStatus').textContent`), /Storage is not confirmed.*Storage unavailable/);
        assert.equal(await evaluate(`document.querySelectorAll('#inboxStorageStatus b').length`), 0);
        const errorKey = await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).at(-1).body.idempotency_key`);
        await evaluate(`closeMemoryNotifyModal(); openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`window.__inboxMode='published'; saveInboxMessage()`);
        assert.equal(await evaluate(`__requests.filter(r => r.method==='POST' && r.url.endsWith('/inbox')).at(-1).body.idempotency_key`), errorKey);
    });

    await t.test('explicit beep-only retry is cancelable and never creates or reads an inbox message', async () => {
        await evaluate(`openInboxDetail('${secondId}')`);
        const storedCount = await evaluate(`__inboxes['${A}'].length`);
        const readBefore = await evaluate(`__requests.filter(r => r.url.endsWith('/read')).length`);
        const beepBefore = await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).length`);
        await evaluate(`window.__confirmAnswer=false; retryInboxBeep()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).length`), beepBefore);
        await evaluate(`window.__confirmAnswer=true; window.__beepMode='not_published'; window.__hold='beep'; void retryInboxBeep(); void retryInboxBeep()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).length`), beepBefore + 1);
        assert.equal(await evaluate(`document.getElementById('retryInboxBeepButton').disabled`), true);
        const request = await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).at(-1)`);
        assert.deepEqual(Object.keys(request.body).sort(), ['attempt_id', 'confirm']);
        assert.equal(request.body.confirm, true);
        assert.equal(request.headers['X-Requested-With'], 'XiaozhiDashboard');
        assert.match(await evaluate(`__confirmations.at(-1)`), /another beep may be heard.*No new message.*read status will not change/);
        await evaluate(`window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('retryInboxBeepButton').disabled && !document.getElementById('refreshInboxButton').disabled`);
        assert.match(await evaluate(`document.getElementById('inboxDetailBeepStatus').textContent`), /not_published.*existing message and its read status were kept/);
        assert.equal(await evaluate(`__inboxes['${A}'].length`), storedCount);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/read')).length`), readBefore);
        assert.match(await evaluate(`document.getElementById('inboxDetailStatus').textContent`), /^Unread/);
    });

    await t.test('lost beep acknowledgement reuses its attempt ID after reopening without automatic retry', async () => {
        await evaluate(`window.__beepMode='lost_response'; retryInboxBeep()`);
        const key = await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).at(-1).body.attempt_id`);
        const before = await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).length`);
        const publications = await evaluate(`__beepPublications`);
        assert.match(await evaluate(`document.getElementById('inboxDetailBeepStatus').textContent`), /unknown.*Unread messages may receive a later reminder/);
        await evaluate(`closeMemoryNotifyModal(); openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`openInboxDetail('${secondId}')`);
        assert.equal(await evaluate(`document.getElementById('retryInboxBeepButton').textContent`), 'Retry same beep request');
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).length`), before);
        await evaluate(`window.__beepMode='published'; retryInboxBeep()`);
        assert.equal(await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).at(-1).body.attempt_id`), key);
        assert.equal(await evaluate(`__beepPublications`), publications);
        assert.match(await evaluate(`document.getElementById('inboxDetailBeepStatus').textContent`), /published.*remain unknown/);
        assert.equal(await evaluate(`__inboxes['${A}'].find(item => item.id==='${secondId}').readAt`), null);
        await evaluate(`retryInboxBeep()`);
        assert.notEqual(await evaluate(`__requests.filter(r => r.url.endsWith('/beep')).at(-1).body.attempt_id`), key);
        assert.equal(await evaluate(`__beepPublications`), publications + 1);
    });

    await t.test('late beep and read responses do not reopen dismissed details or overwrite a new device', async () => {
        await evaluate(`window.__hold='beep'; void retryInboxBeep(); closeMemoryNotifyModal(); window.__hold=null; openMemoryNotifyModal('${C}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`window.__pending.shift()()`);
        await delay(10);
        assert.equal(await evaluate(`document.getElementById('inboxDetail').classList.contains('hidden')`), true);
        assert.match(await evaluate(`document.getElementById('inboxList').textContent`), /Message 8/);
        await evaluate(`openMemoryNotifyModal('${A}')`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await evaluate(`openInboxDetail('${secondId}')`);
        await evaluate(`window.__hold='read'; void markInboxRead(); closeInboxDetail(); window.__hold=null; window.__pending.shift()()`);
        await waitUntil(`!document.getElementById('refreshInboxButton').disabled`);
        await delay(10);
        assert.equal(await evaluate(`document.getElementById('inboxDetail').classList.contains('hidden')`), true);
        assert.equal(await evaluate(`__requests.filter(r => r.url.includes('/inbox')).some(r => /Hermes|token|secret/i.test(JSON.stringify(r.body || {})))`), false);
        await evaluate(`closeMemoryNotifyModal()`);
    });


    await t.test('login distinguishes safely displayed server setup errors from invalid passwords', async () => {
        await evaluate(`window.__loginError={status:503,body:{error:'Configure a unique ADMIN_PASSWORD of at least 12 characters; <b>example placeholders cannot log in</b>'}}; document.getElementById('password').value='fixture-password'; login()`);
        assert.match(await evaluate(`document.getElementById('loginError').textContent`), /Configure a unique ADMIN_PASSWORD.*example placeholders cannot log in/);
        assert.equal(await evaluate(`document.getElementById('loginError').style.display`), 'block');
        assert.equal(await evaluate(`document.querySelectorAll('#loginError b').length`), 0);
        await evaluate(`window.__loginError={status:401,body:{}}; login()`);
        assert.equal(await evaluate(`document.getElementById('loginError').textContent`), 'Invalid password.');
        await evaluate(`window.__loginError=null; document.getElementById('password').value=''`);
    });

}

// A deliberately small DOM harness exercises state and request flows when browser
// launch is unavailable. It is not a layout, browser-compatibility, or device test.
function createTestDocument(source) {
    const ids = new Map();
    const document = { activeElement: null };
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
            this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {};
            this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this._classes = new Set();
            this.classList = {
                add: (...values) => values.forEach(value => this._classes.add(value)),
                remove: (...values) => values.forEach(value => this._classes.delete(value)),
                contains: value => this._classes.has(value),
                toggle: (value, force) => {
                    const add = force === undefined ? !this._classes.has(value) : force;
                    if (add) this._classes.add(value); else this._classes.delete(value);
                    return add;
                }
            };
        }
        get id() { return this.attributes.id || ''; }
        set id(value) { this.attributes.id = value; ids.set(value, this); }
        get className() { return [...this._classes].join(' '); }
        set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set textContent(value) { this.replaceChildren(); this._text = String(value); }
        set innerHTML(value) { this.replaceChildren(); parse(value, this); }
        get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
        get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...children); }
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name === 'id') this.id = value;
            if (name === 'class') this.className = value;
            if (name === 'disabled') this.disabled = true;
            if (name === 'type') this.type = value;
            if (name === 'value') this.value = value;
        }
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
        dispatchEvent(event) {
            event.target ||= this; event.currentTarget = this;
            for (const listener of this.listeners[event.type] || []) listener(event);
            if (event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
            return true;
        }
        focus() { document.activeElement = this; }
        checkValidity() {
            if (this.type !== 'number' || this.value === '') return true;
            const number = Number(this.value);
            return Number.isFinite(number) && (this.attributes.min === undefined || number >= Number(this.attributes.min)) &&
                (this.attributes.max === undefined || number <= Number(this.attributes.max)) &&
                (this.attributes.step !== '1' || Number.isInteger(number));
        }
        matches(selector) {
            if (selector === ':disabled') return this.disabled || Boolean(this.parentElement?.closestDisabledFieldset());
            if (selector[0] === '.') return this.classList.contains(selector.slice(1));
            if (selector[0] === '#') return this.id === selector.slice(1);
            const match = selector.match(/^([\w-]+)?(?:\[([\w-]+)="([^"]*)"\])?$/);
            return Boolean(match && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || (this.attributes[match[2]] || this[match[2]]) === match[3]));
        }
        closestDisabledFieldset() { return this.tagName === 'FIELDSET' && this.disabled ? this : this.parentElement?.closestDisabledFieldset(); }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
        querySelectorAll(selector) {
            const all = [];
            const visit = element => element.children.forEach(child => { all.push(child); visit(child); });
            visit(this);
            const selectors = selector.split(',').map(value => value.trim());
            return all.filter(element => selectors.some(value => {
                const terms = value.split(/\s+/);
                if (!element.matches(terms.pop())) return false;
                let parent = element.parentElement;
                while (terms.length) {
                    const term = terms.pop();
                    while (parent && !parent.matches(term)) parent = parent.parentElement;
                    if (!parent) return false;
                    parent = parent.parentElement;
                }
                return true;
            }));
        }
    }
    function parse(markup, root) {
        const stack = [root];
        const tokens = markup.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').match(/<\/?[a-z][^>]*>|[^<]+/gi) || [];
        for (const token of tokens) {
            if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
            if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
            const tag = token.match(/^<([\w-]+)/)[1];
            const element = new Element(tag);
            const attrs = token.slice(tag.length + 1, -1);
            for (const match of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                element.setAttribute(match[1], match[2] ?? match[3] ?? match[4] ?? '');
            }
            stack.at(-1).appendChild(element);
            if (!['input', 'meta', 'link', 'br', 'hr', 'img'].includes(tag.toLowerCase())) stack.push(element);
        }
    }
    document.documentElement = new Element('document');
    document.createElement = tag => new Element(tag);
    document.getElementById = id => ids.get(id);
    document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
    parse(source, document.documentElement);
    document.activeElement = document.documentElement;
    return document;
}

test('memory and notification state flows in an isolated DOM simulation', async t => {
    class Event {
        constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
        preventDefault() { this.defaultPrevented = true; }
    }
    const context = vm.createContext({
        document: createTestDocument(html), URL, Response, AbortController, TextEncoder,
        setTimeout, clearTimeout, Event, KeyboardEvent: Event,
        crypto: require('node:crypto').webcrypto
    });
    vm.runInContext('window = globalThis', context);
    vm.runInContext(`(${browserFixture.toString()})();`, context);
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    async function evaluate(expression) {
        const result = await vm.runInContext(expression, context);
        return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    }
    async function waitUntil(expression) {
        for (let i = 0; i < 100; i++) {
            if (await evaluate(expression)) return;
            await delay(5);
        }
        assert.fail(`DOM condition timed out: ${expression}`);
    }
    await exerciseUi(t, evaluate, waitUntil);
});
