'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname,'../public/productivity.js'),'utf8');
const settings = {interval_minutes:30,rest_minutes:2,active_start:'08:00',active_end:'17:00',weekdays:[1,2,3,4,5],auto_start:false,language:'id'};
const view = {settings,session:{state:'idle'},timezone_offset_minutes:420,next_local:null,rest_until_local:null};
function fixture(handler) {
  const nodes = new Map(), requests = [];
  class Element {
    constructor() {this.value='';this.checked=false;this.children=[];this.listeners={};this.textContent='';this.disabled=false;}
    addEventListener(name,fn) {this.listeners[name]=fn;}
    appendChild(child) {this.children.push(child);}
    replaceChildren() {this.children=[];}
    setAttribute() {}
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id,new Element()); return nodes.get(id); };
  const window = {};
  const document = {getElementById:$,querySelectorAll:()=>[],createElement:()=>new Element()};
  vm.runInNewContext(script,{document,window,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,prompt:()=> '5',
    fetch:async(url,options={})=>{requests.push({url,...options});const data = await handler(url,options);return{ok:!data.error,status:data.error?503:200,json:async()=>data};}});
  return {$,window,requests,async flush(){for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));},click(id){$(id).listeners.click({});}};
}
function empty(url) {
  if (url.includes('screen-breaks/history')) return {events:[]};
  if (url.includes('screen-breaks')) return view;
  if (url.includes('reminders/calendar')) return {days:[{date:'2026-10-09',count:0}]};
  return {agenda:[],has_more:false};
}

test('a late screen-break response from a closed device cannot overwrite the current modal', async()=>{
  let release;const f=fixture(url=>url.endsWith('/a/screen-breaks')?new Promise(resolve=>{release=resolve;}):empty(url));
  const first=f.window.XiaozhiProductivity.open('a');await f.window.XiaozhiProductivity.open('b');
  release({...view,settings:{...settings,interval_minutes:120}});await first;
  assert.equal(f.$('screenInterval').value,30);f.window.XiaozhiProductivity.close();
});

test('an uncertain command retry retains its key and writes only the device-scoped session API', async()=>{
  let failed=true;const keys=[];
  const f=fixture((url,options)=>{
    if(options.method==='POST'){const body=JSON.parse(options.body);keys.push(body.request_key);return failed?{error:'unknown outcome'}:view;}
    return empty(url);
  });
  await f.window.XiaozhiProductivity.open('a');f.click('screenWork');await f.flush();
  failed=false;f.click('screenWork');await f.flush();
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  assert.ok(f.requests.filter(r=>r.method==='POST').every(r=>r.url.endsWith('/a/screen-breaks/command')));
  assert.equal(f.requests.find(r=>r.method==='POST').headers['X-Requested-With'],'XiaozhiDashboard');
  f.window.XiaozhiProductivity.clear();
});

test('agenda renders user text safely and skips the exact selected occurrence without editing its schedule', async()=>{
  const row={title:'<img onerror=alert(1)>',reminder_id:'schedule-id',due_at:123456789,state:'upcoming',local:'2026-10-09 09:00 WIB'};
  let skipped;
  const f=fixture((url,options)=>{
    if(options.method==='POST'){skipped=JSON.parse(options.body);return{};}
    if(url.includes('reminders/agenda'))return{agenda:[row],has_more:false};
    return empty(url);
  });
  await f.window.XiaozhiProductivity.open('a');const li=f.$('agendaList').children[0];
  assert.equal(li.children[0].textContent,row.title);
  li.children[2].children[0].listeners.click();await f.flush();
  assert.deepEqual(skipped,{id:row.reminder_id,due_at:row.due_at});
  assert.ok(!f.requests.some(r=>r.method==='PATCH'));
  f.window.XiaozhiProductivity.clear();
});
