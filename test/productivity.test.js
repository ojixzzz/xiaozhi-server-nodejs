'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { NotificationInbox } = require('../lib/inbox');
const { createReminderService } = require('../lib/reminders');
const { createReminderTools } = require('../lib/reminder-tools');
const { createScreenBreakService } = require('../lib/screen-breaks');
const { activeWindow } = require('../lib/screen-break-storage');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'xiaozhi-productivity-'));
  const filename = path.join(directory,'inbox.sqlite'); let now = Date.parse('2026-10-09T01:00:00Z');
  let store = new NotificationInbox({ databasePath: filename, now: () => now, ...options });
  t.after(async () => { await store.close(); fs.rmSync(directory,{recursive:true,force:true}); });
  return { get store() { return store; }, get now() { return now; }, filename,
    advance(ms) { now += ms; }, setNow(at) { now = at; },
    call(operation,input = {},device = 'a') { return store.reminders(device,operation,input,420); },
    async reopen() { await store.close(); store = new NotificationInbox({ databasePath: filename, now: () => now, ...options }); },
    sql(fn) { const db = new DatabaseSync(filename); try { return fn(db); } finally { db.close(); } }
  };
}
const reminder = schedule => ({title:'Kerja',text:'Lanjut pekerjaan.',schedule});
function screenService(f, { online = () => true, busy = () => false, allowed = () => true, send = async () => ({status:'published'}) } = {}) {
  const calls = [], announcements = [];
  const reminders = createReminderService({ inbox:f.store, deviceIds:() => ['a'], allowed, beep:async() => ({status:'not_published'}) });
  const service = createScreenBreakService({ reminders,deviceIds:() => ['a'],allowed,busy,online,
    tts:{ issue: async (...args) => { calls.push(args); return {audio_url:'https://audio.test/announcement.ogg',text:'Istirahat.'}; } },
    send:async (...args) => {announcements.push(args);return send(...args);}
  });
  return { service,calls,announcements };
}

test('skip an exact future occurrence, survive restart and keep recurring times anchored', async t => {
  const f = fixture(t); const created = await f.call('create',reminder({kind:'daily',time:'09:00'}));
  const agenda = await f.call('agenda',{from:'2026-10-09',days:3});
  assert.equal(agenda.agenda.length,3); const item = agenda.agenda[1];
  await f.call('skip',{id:created.reminder.id,due_at:item.due_at});
  assert.equal((await f.call('skip',{id:created.reminder.id,due_at:item.due_at})).duplicate,true);
  await f.reopen(); f.setNow(item.due_at);
  assert.equal((await f.call('tick')).notifications.length,0,'latest missed event was deliberately skipped; no earlier fallback');
  const next = (await f.call('get',{id:created.reminder.id})).reminder.next_at;
  assert.equal(next,item.due_at + 86400000);
  assert.equal((await f.call('get',{id:created.reminder.id})).occurrences[0].state,'skipped');
  f.setNow(next); assert.equal((await f.call('tick')).notifications.length,1);
  assert.equal((await f.call('calendar',{from:'2026-10-10',days:1})).days[0].count,1);
});

test('skip bypasses inbox capacity and silences an already open occurrence without completing it', async t => {
  const f = fixture(t,{maxPerDevice:1});
  const once = await f.call('create',reminder({kind:'once',after_seconds:60}));
  const scheduled = once.reminder.next_at;
  await f.store.enqueue('a',{sender:'agent',text:'Other message'});
  await f.call('skip',{id:once.reminder.id,due_at:scheduled}); f.advance(60000);
  assert.deepEqual((await f.call('tick')).deferred,[]);
  assert.equal((await f.call('get',{id:once.reminder.id})).reminder.status,'finished');
  const other = await f.call('create',reminder({kind:'once',after_seconds:60}),'b'); f.advance(60000);
  const due = await f.call('tick',{},'b'), item = (await f.call('get',{id:other.reminder.id},'b')).occurrences[0];
  await f.call('skip',{occurrence_id:item.id},'b');
  assert.equal((await f.store.get('b',due.notifications[0].id)).readAt,f.now);
  assert.equal((await f.call('can_beep',{notification_id:item.notification_id},'b')).allowed,false);
  await assert.rejects(f.call('complete',{occurrence_id:item.id},'b'));
  await assert.rejects(f.call('skip',{occurrence_id:item.id},'a'),{code:'REMINDER_NOT_FOUND'});
});

test('agenda is device scoped, paginated and handles leap dates, missing monthly dates and snooze dates', async t => {
  const f = fixture(t); f.setNow(Date.parse('2028-01-30T00:00:00Z'));
  await f.call('create',reminder({kind:'monthly',day:31,time:'08:00'}));
  await f.call('create',reminder({kind:'monthly',day:29,time:'08:00'}));
  const leap = await f.call('agenda',{from:'2028-02-01',days:29});
  assert.equal(leap.agenda.length,1); assert.match(leap.agenda[0].local,/2028-02-29/);
  assert.deepEqual((await f.call('agenda',{from:'2028-02-01',days:29},'b')).agenda,[]);
  await assert.rejects(f.call('agenda',{from:'2028-02-30'}));
  await assert.rejects(f.call('agenda',{days:43}));
  f.setNow(leap.agenda[0].due_at); await f.call('tick');
  const history = await f.call('get',{id:leap.agenda[0].reminder_id});
  await f.call('snooze',{occurrence_id:history.occurrences[0].id,seconds:86400});
  assert.equal((await f.call('agenda',{from:'2028-02-29',days:1})).agenda.length,0);
  const march = await f.call('agenda',{from:'2028-03-01',days:31,limit:1});
  assert.equal(march.agenda[0].state,'snoozed'); assert.equal(march.has_more,true);
  const page = await f.call('agenda',{from:'2028-03-01',days:31,limit:1,offset:1});
  assert.notEqual(page.agenda[0].due_at,march.agenda[0].due_at);
});

test('future skips retain their history until 30 days after their due date', async t => {
  const f = fixture(t); const created = await f.call('create',reminder({kind:'once',after_seconds:90*86400}));
  await f.call('skip',{id:created.reminder.id,due_at:created.reminder.next_at});
  f.advance(60*86400000); await f.store.cleanup();
  assert.equal((await f.call('get',{id:created.reminder.id})).occurrences.length,1);
});

test('dense interval agenda pages merge future skip records without duplicates or allocating the full range', async t => {
  const f = fixture(t);const saved=await f.call('create',reminder({kind:'interval',every_seconds:60}));
  const first=saved.reminder.next_at,skipped=first+2002*60000;
  await f.call('skip',{id:saved.reminder.id,due_at:skipped});
  const page=await f.call('agenda',{from:'2026-10-09',days:3,offset:2000,limit:3});
  assert.deepEqual(page.agenda.map(row=>row.due_at),[first+2000*60000,first+2001*60000,skipped]);
  assert.equal(page.agenda[2].state,'skipped');assert.equal(page.has_more,true);
  const calendar=await f.call('calendar',{from:'2026-10-09',days:3});
  assert.equal(calendar.days.reduce((sum,day)=>sum+day.count,0),3839);
});

test('delivery timeline persists due, storage, blockers, publication, read and done, without claiming playback', async t => {
  const f = fixture(t); const created = await f.call('create',reminder({kind:'once',after_seconds:60})); f.advance(60000);
  const due = await f.call('tick'), item = (await f.call('get',{id:created.reminder.id})).occurrences[0];
  await f.store.updateBeep('a',due.notifications[0].id,{status:'not_published',reason:'quiet_hours'});
  await f.store.updateBeep('a',due.notifications[0].id,{status:'not_published',reason:'quiet_hours'});
  await f.store.updateBeep('a',due.notifications[0].id,{status:'published',reason:'gateway_published'});
  await f.store.markRead('a',due.notifications[0].id); await f.call('complete',{occurrence_id:item.id});
  await f.reopen(); const trace = await f.call('trace',{occurrence_id:item.id});
  assert.deepEqual(trace.events.map(e => e.event),['due','stored','beep_deferred','beep_published','read','completed']);
  assert.equal(trace.playback_acknowledgement,false);
  await assert.rejects(f.call('trace',{notification_id:item.notification_id},'b'),{code:'REMINDER_NOT_FOUND'});
  const external = await f.store.enqueue('a',{sender:'hermes',text:'Hello'});
  await f.store.updateBeep('a',external.notification.id,{status:'not_published',reason:'device_offline_or_busy'});
  assert.equal((await f.call('trace',{notification_id:external.notification.id})).events.length,2);
});

test('v2 migration preserves existing schedules, occurrences and old read/beep snapshots', async t => {
  const f = fixture(t); const created = await f.call('create',reminder({kind:'once',after_seconds:60})); f.advance(60000);
  const due = await f.call('tick'); await f.store.markRead('a',due.notifications[0].id); await f.store.close();
  f.sql(db => db.exec('DROP TABLE notification_events; DROP TABLE reminder_skips; DROP TABLE screen_break_events; DROP TABLE screen_break_settings; PRAGMA user_version=2;'));
  await f.reopen(); const stored = await f.call('get',{id:created.reminder.id});
  assert.equal(stored.occurrences[0].read_at,f.now); assert.equal(stored.occurrences[0].state,'pending');
  const trace = await f.call('trace',{occurrence_id:stored.occurrences[0].id});
  assert.ok(trace.events.every(e => e.reason === 'legacy_snapshot'));
  assert.equal(f.sql(db => db.prepare('PRAGMA user_version').get().user_version),3);
});

test('screen announcements are sent once, never enter inbox and ignored announcements leave interval anchored', async t => {
  const f = fixture(t); await f.call('screen_command',{action:'start',request_key:'start'});
  const s = screenService(f); f.advance(30*60000); await s.service.tick();
  assert.equal(s.announcements.length,1); assert.equal((await f.store.list('a')).unreadCount,0);
  const after = await f.call('screen_get'); assert.equal(after.session.state,'working'); assert.equal(after.session.next_at,f.now + 30*60000);
  await s.service.tick(); assert.equal(s.announcements.length,1);
  await s.service.close(); await f.reopen(); const fresh = screenService(f); await fresh.service.tick();
  assert.equal(fresh.announcements.length,0);
  f.advance(30*60000); await fresh.service.tick(); assert.equal(fresh.announcements.length,1); await fresh.service.close();
});

test('confirmed rest produces an end announcement and starts the next interval from rest completion', async t => {
  const f = fixture(t); await f.call('screen_command',{action:'start'}); f.advance(30*60000);
  await f.call('screen_tick'); await f.call('screen_command',{action:'rest',minutes:2,request_key:'rest'});
  const rest = await f.call('screen_get'); f.advance(30000);
  assert.equal((await f.call('screen_command',{action:'rest',minutes:2,request_key:'rest'})).session.rest_until,rest.session.rest_until);
  await f.reopen(); f.advance(90000); const due = await f.call('screen_tick');
  assert.equal(due.events.length,1); assert.equal(due.events[0].kind,'break_end'); assert.equal(due.session.next_at,f.now + 30*60000);
  assert.equal((await f.store.list('a')).notifications.length,0);
  await f.call('screen_command',{action:'stop',request_key:'stop'});
  await f.call('screen_command',{action:'rest',minutes:2,request_key:'rest'});
  assert.equal((await f.call('screen_get')).session.state,'idle','retry of an earlier command cannot undo a later stop');
});

test('offline and quiet announcements are skipped once; a busy conversation waits until expiry', async t => {
  const f = fixture(t); await f.call('screen_command',{action:'start'}); f.advance(30*60000);
  const offline = screenService(f,{online:() => false}); await offline.service.tick();
  assert.equal(offline.calls.length,0); assert.equal((await f.call('screen_history')).events[0].reason,'device_offline'); await offline.service.close();
  f.advance(30*60000); await f.call('settings_update',{quiet_enabled:true,quiet_start:'00:00',quiet_end:'23:59'});
  const quiet = screenService(f); await quiet.service.tick(); assert.equal(quiet.calls.length,0);
  assert.equal((await f.call('screen_history')).events[0].reason,'quiet_hours'); await quiet.service.close();
  await f.call('settings_update',{quiet_enabled:false}); f.advance(30*60000);
  let busy = true; const active = screenService(f,{busy:() => busy}); await active.service.tick();
  assert.equal((await f.call('screen_history')).events[0].status,'pending');
  f.advance(120000); busy = false; await active.service.tick(); assert.equal(active.calls.length,0);
  assert.equal((await f.call('screen_history')).events[0].reason,'expired'); await active.service.close();
});

test('a claimed announcement interrupted by restart stays unknown and is never replayed', async t => {
  const f = fixture(t); await f.call('screen_command',{action:'start'}); f.advance(30*60000);
  const due = await f.call('screen_tick'), event = due.events[0];
  assert.equal((await f.call('screen_claim',{id:event.id,revision:event.revision})).allowed,true);
  await f.reopen(); f.advance(120000);
  const s = screenService(f); await s.service.tick();
  assert.equal(s.announcements.length,0); assert.equal((await f.call('screen_history')).events[0].status,'unknown'); await s.service.close();
});

test('snooze, skip, stop and settings changes invalidate pending announcements', async t => {
  const f = fixture(t); await f.call('screen_command',{action:'start'}); f.advance(30*60000);
  const old = (await f.call('screen_tick')).events[0];
  await f.call('screen_command',{action:'snooze',minutes:5});
  assert.equal((await f.call('screen_claim',{id:old.id,revision:old.revision})).allowed,false);
  assert.equal((await f.call('screen_get')).session.next_at,f.now+5*60000);
  f.advance(5*60000); await f.call('screen_tick'); const next = (await f.call('screen_get')).session.next_at;
  await f.call('screen_command',{action:'skip'}); assert.equal((await f.call('screen_get')).session.next_at,next);
  await f.call('screen_update',{interval_minutes:45}); assert.equal((await f.call('screen_get')).session.next_at,f.now+45*60000);
  await f.call('screen_command',{action:'stop'}); f.advance(60*60000); assert.deepEqual((await f.call('screen_tick')).events,[]);
});

test('active windows support midnight and auto start once, stop prevents restart in the same window', async t => {
  const window = activeWindow({active_start:'22:00',active_end:'07:00',weekdays:[5]},Date.parse('2026-10-09T18:00:00Z'),420);
  assert.equal(window.start,Date.parse('2026-10-09T15:00:00Z'));
  assert.equal(activeWindow({active_start:'22:00',active_end:'07:00',weekdays:[5]},Date.parse('2026-10-10T01:00:00Z'),420),null);
  const f = fixture(t); await f.call('screen_update',{auto_start:true}); await f.call('screen_tick');
  assert.equal((await f.call('screen_get')).session.state,'working');
  await f.call('screen_command',{action:'stop'}); await f.call('screen_tick'); assert.equal((await f.call('screen_get')).session.state,'idle');
  f.advance(3*86400000); await f.call('screen_tick'); assert.equal((await f.call('screen_get')).session.state,'working');
});

test('restart in a later active window does not resume a manual work session or announce weekend backlog', async t => {
  const f = fixture(t); await f.call('screen_command',{action:'start'});
  await f.reopen(); f.advance(3*86400000); const state = await f.call('screen_tick');
  assert.equal(state.session.state,'idle');assert.deepEqual(state.events,[]);
});

test('a settings change while TTS is being prepared prevents publishing an obsolete announcement', async t => {
  const f = fixture(t);await f.call('screen_command',{action:'start'});f.advance(30*60000);
  let release,prepared;
  const ready = new Promise(resolve=>{prepared=resolve;});const generated = new Promise(resolve=>{release=resolve;});let published=0;
  const reminders=createReminderService({inbox:f.store,deviceIds:()=>['a'],allowed:()=>true,beep:async()=>({status:'not_published'})});
  const service=createScreenBreakService({reminders,deviceIds:()=>['a'],allowed:()=>true,busy:()=>false,online:()=>true,
    tts:{issue:async()=>{prepared();await generated;return{audio_url:'https://audio.test/a.ogg',text:'Break'};}},send:async()=>{published++;return{status:'published'};}});
  const pending=service.tick();await ready;await f.call('screen_command',{action:'stop'});release();await pending;
  assert.equal(published,0);assert.equal((await f.call('screen_history')).events[0].reason,'user_stopped');await service.close();
});

test('voice tools isolate devices and deduplicate commands without creating reminder inbox messages', async t => {
  const f = fixture(t); const service = createReminderService({inbox:f.store,deviceIds:()=>['a'],allowed:()=>true,beep:async()=>({status:'not_published'})});
  const run = createReminderTools({service,deviceId:'a',allowed:()=>true,requestScope:()=> 'voice-1'});
  const args = {action:'start'}; const [a,b] = await Promise.all([run('screen_breaks_session',args),run('screen_breaks_session',args)]);
  assert.equal(a.session.next_at,b.session.next_at);
  await assert.rejects(run('screen_breaks_session',{action:'start',device_id:'b'}),TypeError);
  assert.equal((await f.call('screen_get',{},'b')).session.state,'idle');
  assert.equal((await f.store.list('a')).unreadCount,0); assert.equal((await f.call('list')).reminders.length,0);
  const small = createReminderTools({service,deviceId:'a',allowed:()=>true,requestScope:()=> 'small-voice',maxChars:512});
  const output = await small('screen_breaks_session',{action:'stop'});
  assert.equal(output.session.state,'idle');assert.equal(output.error,undefined);assert.ok(JSON.stringify(output).length<=512);
});
