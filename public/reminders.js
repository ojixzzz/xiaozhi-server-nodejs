'use strict';

(() => {
  const $ = id => document.getElementById(id);
  let session = null;
  const attempts = new Map();
  const pageSize = 10;
  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const stateLabel = { active: 'Aktif', paused: 'Dijeda', finished: 'Jadwal berakhir', cancelled: 'Dibatalkan', pending: 'Belum selesai', snoozed: 'Ditunda', completed: 'Selesai', skipped: 'Dilewati' };
  const current = s => session === s;
  const localInput = (at, offset) => at === null ? '' : new Date(at + offset * 60000).toISOString().slice(0, 16);
  const displayTime = (s, at) => at === null ? '-' : localInput(at, s.settings.timezone_offset_minutes).replace('T', ' ');
  function status(s, text) { if (current(s)) $('reminderStatus').textContent = text; }
  function close() {
    window.XiaozhiProductivity?.close();
    if (session) for (const controller of session.controllers) controller.abort();
    const opener = session?.opener;
    session = null; $('reminderModal').classList.add('hidden'); opener?.focus();
  }
  async function request(s, suffix, method, body) {
    if (!current(s)) throw Object.assign(new Error('Dialog closed'), { name: 'AbortError' });
    const controller = new AbortController(); s.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(s.mac)}/${suffix}`, { credentials: 'same-origin', signal: controller.signal,
        ...(method ? { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XiaozhiDashboard' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timeout); s.controllers.delete(controller); }
  }
  async function action(fn) {
    const s = session;
    if (!s || s.busy) return;
    s.busy = true; $('reminderControls').disabled = true;
    try { await fn(s); }
    catch (error) { status(s, error.name === 'AbortError' ? 'Permintaan berhenti menunggu. Perubahan mungkin tersimpan; muat ulang sebelum mencoba lagi.' : error.message); }
    finally { if (current(s)) { s.busy = false; $('reminderControls').disabled = false; } }
  }
  function visibility() {
    const kind = $('reminderKind').value, mode = $('reminderOnceMode').value;
    document.querySelectorAll('[data-reminder-kind]').forEach(element => { element.hidden = !element.dataset.reminderKind.split(' ').includes(kind); });
    document.querySelectorAll('[data-reminder-once]').forEach(element => { element.hidden = kind !== 'once' || element.dataset.reminderOnce !== mode; });
  }
  function reset(s) {
    if (!current(s)) return;
    s.editing = null; $('reminderForm').reset(); $('reminderOffset').value = s.settings.timezone_offset_minutes;
    $('reminderFormHeading').textContent = 'Buat pengingat'; visibility();
  }
  function edit(s, row) {
    if (!current(s)) return;
    reset(s); s.editing = row;
    const v = row.schedule;
    $('reminderFormHeading').textContent = `Ubah: ${row.title}`;
    $('reminderTitle').value = row.title; $('reminderText').value = row.text;
    $('reminderKind').value = v.kind; $('reminderOffset').value = v.timezone_offset_minutes;
    if (v.kind === 'once') { $('reminderOnceMode').value = 'at'; $('reminderAt').value = localInput(v.at, v.timezone_offset_minutes); }
    if (v.minute !== undefined) $('reminderTime').value = `${String(Math.floor(v.minute / 60)).padStart(2, '0')}:${String(v.minute % 60).padStart(2, '0')}`;
    document.querySelectorAll('[name=reminderWeekday]').forEach(input => { input.checked = v.weekdays?.includes(Number(input.value)) || false; });
    $('reminderDay').value = v.day || 1; $('reminderEvery').value = v.every_ms ? v.every_ms / 60000 : 120;
    $('reminderStart').value = v.kind === 'interval' ? localInput(v.anchor, v.timezone_offset_minutes) : localInput(v.start_at, v.timezone_offset_minutes);
    $('reminderEnd').value = localInput(v.end_at, v.timezone_offset_minutes);
    s.scheduleSnapshot = JSON.stringify(formSchedule());
    visibility(); $('reminderTitle').focus();
  }
  const node = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
  function button(parent, label, fn) { const b = node('button', label); b.type = 'button'; b.addEventListener('click', () => action(fn)); parent.appendChild(b); }
  async function lists(s) {
    const data = await request(s, `reminders?status=${encodeURIComponent($('reminderFilter').value)}&limit=${pageSize}&offset=${s.offset}`);
    if (!current(s)) return;
    s.rows = data.reminders; $('reminderList').replaceChildren();
    if (!data.reminders.length) $('reminderList').appendChild(node('li', 'Tidak ada pengingat pada halaman ini.'));
    for (const row of data.reminders) {
      const li = node('li', ''); li.appendChild(node('strong', row.title));
      li.appendChild(node('p', `${row.summary}\n${stateLabel[row.status]} · Berikutnya: ${row.next_local || '-'}\n${row.text}`));
      const buttons = node('div', ''); buttons.className = 'reminder-actions';
      button(buttons, 'Riwayat', async s => { s.historyReminder = row.id; s.historyOffset = 0; await history(s); });
      if (row.status !== 'cancelled') {
        button(buttons, 'Ubah', async s => { const data = await request(s, `reminders/${row.id}`); if (current(s)) edit(s, data.reminder); });
        if (row.status === 'active' || row.status === 'paused') button(buttons, row.status === 'paused' ? 'Lanjutkan' : 'Jeda', async s => {
          await request(s, `reminders/${row.id}`, 'PATCH', { status: row.status === 'paused' ? 'active' : 'paused', revision: row.revision }); await lists(s); await history(s); await window.XiaozhiProductivity?.refresh();
        });
        button(buttons, 'Batalkan', async s => { if (!confirm(`Batalkan pengingat ${row.title} dan kejadian yang masih terbuka?`)) return;
          await request(s, `reminders/${row.id}`, 'DELETE', { confirm: true }); if (s.editing?.id === row.id) reset(s); await lists(s); await history(s); await window.XiaozhiProductivity?.refresh(); });
      }
      li.appendChild(buttons); $('reminderList').appendChild(li);
    }
    $('reminderPrevious').disabled = s.offset === 0; $('reminderNext').disabled = !data.has_more;
    $('reminderPage').textContent = `Halaman ${s.offset / pageSize + 1}`;
  }
  async function history(s) {
    const suffix = `reminders/occurrences?limit=${pageSize}&offset=${s.historyOffset}${s.historyReminder ? `&reminder_id=${s.historyReminder}` : ''}`;
    const data = await request(s, suffix);
    if (!current(s)) return;
    $('reminderHistory').replaceChildren();
    $('reminderHistoryHeading').textContent = s.historyReminder ? 'Riwayat pengingat yang dipilih' : 'Riwayat semua pengingat';
    if (!data.occurrences.length) $('reminderHistory').appendChild(node('li', 'Belum ada kejadian pengingat.'));
    for (const row of data.occurrences) {
      const li = node('li', ''); li.appendChild(node('strong', row.title));
      li.appendChild(node('p', `${stateLabel[row.state]} · ${!row.notification_id ? 'Tanpa pesan inbox' : row.read_at === null ? 'Belum dibaca' : 'Dibaca'}\nJatuh tempo: ${displayTime(s, row.due_at)}${row.snooze_until ? `\nDitunda sampai: ${displayTime(s, row.snooze_until)}` : ''}${row.completed_at ? `\nSelesai: ${displayTime(s, row.completed_at)}` : ''}${row.skipped_count ? `\n${row.skipped_count} kejadian terdahulu dilewati saat server tidak tersedia.` : ''}`));
      const traceButton = node('button', 'Jejak pengiriman'); traceButton.type = 'button';
      traceButton.addEventListener('click', () => window.XiaozhiProductivity?.trace(`reminders/occurrences/${row.id}/trace`, row.title)); li.appendChild(traceButton);
      if (['pending','snoozed'].includes(row.state) && row.schedule_status !== 'cancelled') {
        const buttons = node('div', ''); buttons.className = 'reminder-actions';
        button(buttons, 'Lewati kali ini', async s => { await request(s, 'reminders/skip', 'POST', { occurrence_id: row.id }); await history(s); await window.XiaozhiProductivity?.refresh(); });
        button(buttons, 'Sudah selesai', async s => { await request(s, `reminders/occurrences/${row.id}/complete`, 'POST', { confirm: true }); await history(s); await window.XiaozhiProductivity?.refresh(); });
        if (row.notification_id) button(buttons, 'Tunda…', async s => {
          const value = prompt('Ingatkan kembali berapa menit lagi?', '10'); if (value === null) return;
          if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 43200) throw new Error('Isi 1 sampai 43.200 menit.');
          const key = `snooze:${s.mac}:${row.id}:${value}`;
          if (!attempts.has(key)) attempts.set(key, requestId());
          await request(s, `reminders/occurrences/${row.id}/snooze`, 'POST', { seconds: Number(value) * 60, request_key: attempts.get(key) });
          attempts.delete(key); await history(s); await window.XiaozhiProductivity?.refresh();
        });
        li.appendChild(buttons);
      }
      $('reminderHistory').appendChild(li);
    }
    $('reminderHistoryPrevious').disabled = s.historyOffset === 0; $('reminderHistoryNext').disabled = !data.has_more;
    $('reminderHistoryPage').textContent = `Halaman ${s.historyOffset / pageSize + 1}`;
  }
  async function reload(s) {
    const settings = await request(s, 'reminder-settings');
    if (!current(s)) return;
    s.settings = settings;
    $('reminderDefaultOffset').value = settings.timezone_offset_minutes; $('reminderQuietEnabled').checked = settings.quiet_enabled;
    $('reminderQuietStart').value = settings.quiet_start; $('reminderQuietEnd').value = settings.quiet_end;
    if (!s.editing) $('reminderOffset').value = settings.timezone_offset_minutes;
    await lists(s); if (current(s)) await history(s);
  }
  async function open(mac) {
    close();
    const s = { mac, controllers: new Set(), offset: 0, historyOffset: 0, historyReminder: null, editing: null, busy: false,
      opener: document.activeElement, settings: { timezone_offset_minutes: 420 } };
    session = s; $('reminderDevice').textContent = mac; $('reminderModal').classList.remove('hidden');
    $('reminderStatus').textContent = 'Memuat pengingat…'; $('reminderList').replaceChildren(); $('reminderHistory').replaceChildren();
    $('reminderFilter').value = 'all'; reset(s); $('reminderClose').focus();
    await action(async s => { await reload(s); if (current(s)) await window.XiaozhiProductivity?.open(s.mac); status(s, 'Siap.'); });
  }
  function formSchedule() {
      const kind = $('reminderKind').value;
      const schedule = { kind, timezone_offset_minutes: Number($('reminderOffset').value) };
      if (kind === 'once') {
        if ($('reminderOnceMode').value === 'after') schedule.after_seconds = Number($('reminderAfter').value) * 60;
        else schedule.at = $('reminderAt').value;
      } else {
        if ($('reminderStart').value) schedule.start_at = $('reminderStart').value;
        if ($('reminderEnd').value) schedule.end_at = $('reminderEnd').value;
        if (kind === 'interval') schedule.every_seconds = Number($('reminderEvery').value) * 60;
        else schedule.time = $('reminderTime').value;
        if (kind === 'weekly') schedule.weekdays = [...document.querySelectorAll('[name=reminderWeekday]:checked')].map(input => Number(input.value));
        if (kind === 'monthly') schedule.day = Number($('reminderDay').value);
      }
      return schedule;
  }
  $('reminderForm').addEventListener('submit', event => {
    event.preventDefault(); action(async s => {
      const schedule = formSchedule();
      const body = { title: $('reminderTitle').value, text: $('reminderText').value || $('reminderTitle').value, schedule };
      let data;
      if (s.editing) {
        if (JSON.stringify(schedule) === s.scheduleSnapshot) delete body.schedule;
        data = await request(s, `reminders/${s.editing.id}`, 'PATCH', { ...body, revision: s.editing.revision });
      }
      else {
        const key = `create:${s.mac}:${JSON.stringify(body)}`;
        if (!attempts.has(key)) attempts.set(key, requestId());
        data = await request(s, 'reminders', 'POST', { ...body, request_key: attempts.get(key) }); attempts.delete(key);
      }
      if (!current(s)) return;
      status(s, `Tersimpan: ${data.reminder.summary}\nBerikutnya: ${data.reminder.next_local || '-'}`);
      reset(s); await lists(s); await history(s); await window.XiaozhiProductivity?.refresh();
    });
  });
  $('reminderSettingsForm').addEventListener('submit', event => { event.preventDefault(); action(async s => {
    await request(s, 'reminder-settings', 'PUT', { timezone_offset_minutes: Number($('reminderDefaultOffset').value), quiet_enabled: $('reminderQuietEnabled').checked,
      quiet_start: $('reminderQuietStart').value, quiet_end: $('reminderQuietEnd').value });
    await reload(s); await window.XiaozhiProductivity?.refresh(); status(s, 'Pengaturan tersimpan. Jadwal lama mempertahankan zona waktunya.');
  }); });
  $('reminderClose').addEventListener('click', close);
  $('reminderModal').addEventListener('click', event => { if (event.target === $('reminderModal')) close(); });
  $('reminderModal').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const focusable = [...$('reminderModal').querySelectorAll('button,input,select,textarea')].filter(el => !el.matches(':disabled') && !el.closest('[hidden]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('reminderKind').addEventListener('change', visibility); $('reminderOnceMode').addEventListener('change', visibility);
  $('reminderNew').addEventListener('click', () => { if (session) { reset(session); $('reminderTitle').focus(); } });
  $('reminderReset').addEventListener('click', () => { if (session) reset(session); });
  $('reminderRefresh').addEventListener('click', () => action(async s => { await reload(s); await window.XiaozhiProductivity?.refresh(); }));
  $('reminderFilter').addEventListener('change', () => action(async s => { s.offset = 0; await lists(s); }));
  $('reminderPrevious').addEventListener('click', () => action(async s => { s.offset = Math.max(0, s.offset - pageSize); await lists(s); }));
  $('reminderNext').addEventListener('click', () => action(async s => { s.offset += pageSize; await lists(s); }));
  $('reminderAllHistory').addEventListener('click', () => action(async s => { s.historyReminder = null; s.historyOffset = 0; await history(s); }));
  $('reminderHistoryPrevious').addEventListener('click', () => action(async s => { s.historyOffset = Math.max(0, s.historyOffset - pageSize); await history(s); }));
  $('reminderHistoryNext').addEventListener('click', () => action(async s => { s.historyOffset += pageSize; await history(s); }));
  window.XiaozhiReminders = { open, close, refresh: () => action(reload), clear() { close(); attempts.clear(); window.XiaozhiProductivity?.clear(); } };
})();
