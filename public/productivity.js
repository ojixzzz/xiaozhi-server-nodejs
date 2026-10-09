'use strict';

(() => {
  const $ = id => document.getElementById(id);
  let session;
  const attempts = new Map();
  const labels = { upcoming: 'Terjadwal', pending: 'Belum selesai', snoozed: 'Ditunda', completed: 'Selesai', cancelled: 'Dibatalkan', skipped: 'Dilewati',
    stored: 'Tersimpan di inbox', due: 'Waktunya tiba', read: 'Dibaca', beep_published: 'Beep dikirim ke gateway', beep_deferred: 'Beep belum dikirim', beep_unknown: 'Pengiriman belum terkonfirmasi',
    snooze_due: 'Waktu tunda tiba', paused: 'Jadwal dijeda', resumed: 'Jadwal dilanjutkan', working: 'Sedang kerja', resting: 'Sedang istirahat', idle: 'Belum mulai',
    published: 'Dikirim ke gateway', unknown: 'Belum terkonfirmasi', claimed: 'Pengiriman dimulai', break_due: 'Ajakan istirahat', break_end: 'Jeda selesai' };
  const reasons = { quiet_hours: 'jam tenang', device_offline: 'perangkat offline / koneksi gateway tidak tersedia', device_offline_or_busy: 'perangkat belum siap atau percakapan aktif',
    tts_unavailable: 'Edge TTS belum tersedia', expired: 'melewati batas keterlambatan 2 menit', outside_active_hours: 'di luar jam aktif', user_skipped: 'dilewati pengguna',
    user_snoozed: 'ditunda pengguna', user_stopped: 'sesi kerja dihentikan', rest_started: 'istirahat dimulai', gateway_published: 'gateway menerima perintah pemutaran',
    publication_unconfirmed: 'hasil pengiriman belum diketahui', legacy_snapshot: 'status terakhir dari versi server sebelumnya', missed_occurrences_coalesced: 'kejadian terlambat digabungkan' };
  const node = (tag, text = '') => { const e = document.createElement(tag); e.textContent = text; return e; };
  const current = s => s === session;
  const localDate = (at, offset) => new Date(at + offset * 60000).toISOString().slice(0,10);
  const time = (s, at) => at == null ? '-' : new Date(at + s.offset * 60000).toISOString().slice(0,16).replace('T',' ');
  function close() { if (session) for (const controller of session.controllers) controller.abort(); session = null; }
  async function request(s, suffix, method, body) {
    if (!current(s)) throw Object.assign(new Error('Dialog closed'), { name: 'AbortError' });
    const controller = new AbortController(); s.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(s.mac)}/${suffix}`, { credentials: 'same-origin', signal: controller.signal,
        ...(method ? { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XiaozhiDashboard' }, body: JSON.stringify(body) } : {}) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
    } finally { clearTimeout(timer); s.controllers.delete(controller); }
  }
  async function action(fn) {
    const s = session; if (!s || s.busy) return;
    s.busy = true; $('productivityControls').disabled = true;
    try { await fn(s); }
    catch (error) { if (current(s)) $('productivityStatus').textContent = error.name === 'AbortError' ? 'Permintaan berhenti menunggu. Muat ulang untuk memeriksa hasilnya.' : error.message; }
    finally { if (current(s)) { s.busy = false; $('productivityControls').disabled = false; } }
  }
  function button(parent, title, fn) { const b = node('button', title); b.type = 'button'; b.addEventListener('click', () => action(fn)); parent.appendChild(b); }
  function traceRows(target, data, s) {
    target.replaceChildren();
    if (!data.events.length) target.appendChild(node('li', 'Belum ada jejak pengiriman.'));
    for (const e of data.events) target.appendChild(node('li', `${time(s,e.at)} · ${labels[e.event] || e.event}${e.reason ? ` · ${reasons[e.reason] || e.reason}` : ''}`));
  }
  async function trace(suffix, title) {
    return action(async s => {
      const data = await request(s, suffix);
      if (!current(s)) return;
      $('deliveryTraceTitle').textContent = `Jejak: ${title}`; traceRows($('deliveryTrace'), data, s);
      $('deliveryTraceTitle').scrollIntoView?.({ block: 'nearest' });
    });
  }
  async function agenda(s) {
    const from = $('agendaFrom').value, days = Number($('agendaDays').value);
    const data = await request(s, `reminders/agenda?from=${encodeURIComponent(from)}&days=${days}&limit=20&offset=${s.agendaOffset}`);
    if (!current(s)) return;
    $('agendaList').replaceChildren();
    if (!data.agenda.length) $('agendaList').appendChild(node('li', 'Tidak ada pengingat dalam rentang ini.'));
    for (const row of data.agenda) {
      const li = node('li'); li.appendChild(node('strong', row.title));
      li.appendChild(node('p', `${row.local} · ${labels[row.state] || row.state}${row.state === 'snoozed' ? `\nJadwal semula: ${time(s,row.due_at)}` : ''}`));
      const controls = node('div'); controls.className = 'reminder-actions';
      if (row.state === 'upcoming' || ['pending','snoozed'].includes(row.state) && row.schedule_status !== 'cancelled') button(controls, 'Lewati kali ini', async s => {
        await request(s, 'reminders/skip', 'POST', row.occurrence_id ? { occurrence_id: row.occurrence_id } : { id: row.reminder_id, due_at: row.due_at });
        await agenda(s); await calendar(s); await window.XiaozhiReminders?.refresh(); $('productivityStatus').textContent = 'Satu kejadian dilewati. Jadwal rutin tetap berjalan.';
      });
      if (row.occurrence_id) {
        const b = node('button', 'Jejak pengiriman'); b.type = 'button'; b.addEventListener('click', () => trace(`reminders/occurrences/${row.occurrence_id}/trace`, row.title)); controls.appendChild(b);
      }
      li.appendChild(controls); $('agendaList').appendChild(li);
    }
    $('agendaPrevious').disabled = s.agendaOffset === 0; $('agendaNext').disabled = !data.has_more || s.agendaOffset >= 100000;
    $('agendaPage').textContent = `Halaman ${s.agendaOffset / 20 + 1}${data.truncated ? ' · Sebagian riwayat belum ditampilkan' : ''}`;
  }
  async function calendar(s) {
    const month = $('agendaMonth').value;
    if (!/^\d{4}-\d\d$/.test(month)) return;
    const [year,m] = month.split('-').map(Number), days = new Date(Date.UTC(year,m,0)).getUTCDate();
    const data = await request(s, `reminders/calendar?from=${month}-01&days=${days}`);
    if (!current(s)) return;
    const target = $('agendaCalendar'); target.replaceChildren();
    for (const label of ['Sen','Sel','Rab','Kam','Jum','Sab','Min']) target.appendChild(node('strong',label));
    const weekday = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
    for (let i = 0; i < weekday; i++) target.appendChild(node('span'));
    for (const day of data.days) {
      const b = node('button', `${Number(day.date.slice(8))}\n${day.count ? `${day.count} agenda` : '—'}`); b.type = 'button';
      b.setAttribute('aria-label', `${day.date}: ${day.count} agenda`);
      if (day.date === localDate(Date.now(),s.offset)) b.className = 'calendar-today';
      b.addEventListener('click', () => action(async s => { $('agendaFrom').value = day.date; $('agendaDays').value = '1'; s.agendaOffset = 0; await agenda(s); }));
      target.appendChild(b);
    }
  }
  function renderScreen(s, data) {
    const v = data.settings;
    s.offset = data.timezone_offset_minutes;
    $('screenInterval').value = v.interval_minutes; $('screenRest').value = v.rest_minutes;
    $('screenStart').value = v.active_start; $('screenEnd').value = v.active_end;
    $('screenAuto').checked = v.auto_start; $('screenLanguage').value = v.language;
    document.querySelectorAll('[name=screenWeekday]').forEach(e => { e.checked = v.weekdays.includes(Number(e.value)); });
    $('screenSession').textContent = `${labels[data.session.state]} · Berikutnya: ${data.next_local || '-'} · Jeda selesai: ${data.rest_until_local || '-'}`;
  }
  async function screen(s) {
    const data = await request(s, 'screen-breaks'); if (!current(s)) return; renderScreen(s,data);
    const history = await request(s, 'screen-breaks/history?limit=10'); if (!current(s)) return;
    $('screenHistory').replaceChildren();
    for (const row of history.events) $('screenHistory').appendChild(node('li', `${time(s,row.due_at)} · ${labels[row.kind]} · ${row.status === 'pending' ? 'Menunggu pengiriman' : labels[row.status]}${row.reason ? ` · ${reasons[row.reason] || row.reason}` : ''}`));
    if (!history.events.length) $('screenHistory').appendChild(node('li', 'Belum ada pengumuman istirahat.'));
  }
  async function command(s, command, minutes) {
    const body = { action: command, ...(minutes !== undefined ? { minutes } : {}) }, key = `${s.mac}:${JSON.stringify(body)}`;
    if (!attempts.has(key)) {
      const bytes = crypto.getRandomValues(new Uint8Array(16)); attempts.set(key, [...bytes].map(n => n.toString(16).padStart(2,'0')).join(''));
    }
    await request(s, 'screen-breaks/command', 'POST', { ...body, request_key: attempts.get(key) }); attempts.delete(key);
    if (current(s)) { await screen(s); $('productivityStatus').textContent = 'Sesi istirahat layar diperbarui.'; }
  }
  async function refresh(s) { await screen(s); if (current(s)) { await calendar(s); await agenda(s); } }
  async function open(mac) {
    close(); const s = { mac, controllers: new Set(), busy: false, offset: 420, agendaOffset: 0 }; session = s;
    $('screenSession').textContent = '';
    $('screenInterval').value = 30; $('screenRest').value = 2; $('screenStart').value = '08:00'; $('screenEnd').value = '17:00'; $('screenAuto').checked = false; $('screenLanguage').value = 'id';
    $('productivityStatus').textContent = 'Memuat agenda dan istirahat layar…';
    for (const id of ['agendaList','agendaCalendar','screenHistory','deliveryTrace']) $(id).replaceChildren();
    await action(async s => {
      await screen(s); if (!current(s)) return;
      const today = localDate(Date.now(),s.offset); $('agendaFrom').value = today; $('agendaMonth').value = today.slice(0,7); $('agendaDays').value = '7';
      await calendar(s); await agenda(s); if (current(s)) $('productivityStatus').textContent = 'Siap.';
    });
  }
  $('screenForm').addEventListener('submit', event => { event.preventDefault(); action(async s => {
    const data = await request(s,'screen-breaks','PUT',{ interval_minutes: Number($('screenInterval').value), rest_minutes: Number($('screenRest').value),
      active_start: $('screenStart').value, active_end: $('screenEnd').value, auto_start: $('screenAuto').checked, language: $('screenLanguage').value,
      weekdays: [...document.querySelectorAll('[name=screenWeekday]:checked')].map(e => Number(e.value)) });
    if (current(s)) { renderScreen(s,data); $('productivityStatus').textContent = 'Pengaturan istirahat tersimpan.'; }
  }); });
  for (const [id,name] of [['screenWork','start'],['screenStop','stop'],['screenTakeRest','rest'],['screenResume','resume'],['screenSkip','skip']]) $(id).addEventListener('click', () => action(s => command(s,name)));
  $('screenSnooze').addEventListener('click', () => action(async s => {
    const answer = prompt('Tunda berapa menit?', '5'); if (answer === null) return;
    if (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > 240) throw new Error('Isi 1 sampai 240 menit.');
    await command(s,'snooze',Number(answer));
  }));
  $('productivityRefresh').addEventListener('click', () => action(refresh));
  $('agendaMonth').addEventListener('change', () => action(calendar));
  $('agendaLoad').addEventListener('click', () => action(async s => { s.agendaOffset = 0; await agenda(s); }));
  $('agendaPrevious').addEventListener('click', () => action(async s => { s.agendaOffset = Math.max(0,s.agendaOffset - 20); await agenda(s); }));
  $('agendaNext').addEventListener('click', () => action(async s => { s.agendaOffset += 20; await agenda(s); }));
  window.XiaozhiProductivity = { open, close, trace, refresh: () => action(refresh), clear() { close(); attempts.clear(); } };
})();
