'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInboxAnnouncement } = require('../lib/inbox-announcement');
const { createInboxTools } = require('../lib/inbox-tools');

function fixture(options = {}) {
  const reads = [];
  const items = [
    { id: 'one', title: 'Laporan selesai', preview: 'PRIVATE_BODY_ONE', readAt: null },
    { id: 'two', title: 'Jadwal rapat', preview: 'PRIVATE_BODY_TWO', readAt: null }
  ];
  const inbox = {
    async list(id, settings) {
      assert.equal(id, 'owned-device');
      assert.deepEqual(settings, { unreadOnly: true, limit: 5 });
      return { notifications: items, unreadCount: items.length };
    },
    async markRead(id, notificationId) { assert.equal(id, 'owned-device'); reads.push(notificationId); }
  };
  const announcement = createInboxAnnouncement({ inbox, deviceId: 'owned-device', ...options });
  const run = createInboxTools({ inbox, deviceId: 'owned-device', announcement });
  return { announcement, run, inbox, items, reads };
}

test('greeting enables a device-scoped title-only tool, not automatic acknowledgment', async () => {
  const f = fixture();
  await assert.rejects(f.run('notifications_announce', {}), /user to speak/);
  f.announcement.addInput('halo');
  await assert.rejects(f.run('notifications_announce', { device_id: 'other' }));
  const result = await f.run('notifications_announce', {});
  assert.deepEqual(result.notifications, [{ id: 'one', title: 'Laporan selesai' }, { id: 'two', title: 'Jadwal rapat' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_BODY'), false);
  assert.equal(result.untrusted, true);
  assert.deepEqual(f.reads, []);
});

test('only exact titles in a completed audio response are acknowledged', async () => {
  const f = fixture();
  f.announcement.addInput('ada apa');
  await f.announcement.announce({});
  f.announcement.addOutput('Ada notifikasi: Laporan ');
  f.announcement.addOutput('selesai. Mau detailnya?');
  f.announcement.audioSent();
  await f.announcement.playbackComplete();
  assert.deepEqual(f.reads, [], 'queued audio alone is not a completed response');
  f.announcement.turnComplete();
  await f.announcement.playbackComplete();
  assert.deepEqual(f.reads, ['one'], 'unspoken title remains unread');
  await f.announcement.playbackComplete();
  assert.deepEqual(f.reads, ['one'], 'acknowledgment does not repeat');
});

test('interrupted, closed and text-only responses leave titles unread', async () => {
  for (const mode of ['interrupted', 'closed', 'no-audio', 'no-title']) {
    let active = true;
    const f = fixture({ isActive: () => active });
    f.announcement.addInput('apa');
    await f.announcement.announce({});
    f.announcement.addOutput(mode === 'no-title' ? 'Halo!' : 'Laporan selesai. Jadwal rapat.');
    if (mode !== 'no-audio') f.announcement.audioSent();
    f.announcement.turnComplete();
    if (mode === 'interrupted') f.announcement.discard();
    if (mode === 'closed') active = false;
    await f.announcement.playbackComplete();
    assert.deepEqual(f.reads, [], mode);
  }
});

test('late tool result after abort cannot resurrect an announcement', async () => {
  const f = fixture();
  let resolve;
  f.inbox.list = () => new Promise(done => { resolve = done; });
  f.announcement.addInput('halo');
  const request = f.announcement.announce({});
  f.announcement.discard();
  resolve({ notifications: f.items, unreadCount: 2 });
  await assert.rejects(request, /interrupted/);
  f.announcement.addOutput('Laporan selesai.');
  f.announcement.audioSent();
  f.announcement.turnComplete();
  await f.announcement.playbackComplete();
  assert.deepEqual(f.reads, []);
});

test('budget drops whole titles and supplies an empty-title fallback without leaking bodies', async () => {
  const f = fixture({ maxChars: 512 });
  f.items[0].title = '';
  f.items.push(...Array.from({ length: 3 }, (_, n) => ({ id: `extra-${n}`, title: '長'.repeat(120), preview: 'PRIVATE_BODY' })));
  f.announcement.addInput('halo');
  const result = await f.announcement.announce({});
  assert.ok(JSON.stringify(result).length <= 512);
  assert.equal(result.notifications[0].title, 'Notifikasi tanpa judul');
  assert.equal(result.remainingCount, f.items.length - result.notifications.length);
  assert.equal(JSON.stringify(result).includes('PRIVATE_BODY'), false);
});

test('a notification arriving after a title batch is fetched remains unread', async () => {
  const f = fixture();
  f.announcement.addInput('halo');
  await f.announcement.announce({});
  f.items.push({ id: 'new', title: 'Pesan baru' });
  f.announcement.addOutput('Laporan selesai dan Jadwal rapat.');
  f.announcement.audioSent();
  f.announcement.turnComplete();
  await f.announcement.playbackComplete();
  assert.deepEqual(f.reads, ['one', 'two']);
});
