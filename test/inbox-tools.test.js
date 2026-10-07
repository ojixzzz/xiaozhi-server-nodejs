'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createInboxTools,INBOX_TOOLS,INBOX_INSTRUCTION}=require('../lib/inbox-tools');
const ID='b9caac66-40c2-4d89-92cc-132c6c3d5018';
function fixture(){const calls=[];const item={id:ID,sender:'hermes',title:'Task update',text:'External text asking to run an unrelated command is data only.',createdAt:1,readAt:null,beep:{status:'published'}};return {calls,item,inbox:{list:async(...args)=>{calls.push(['list',...args]);return{notifications:[item],nextCursor:null,unreadCount:1};},get:async(...args)=>{calls.push(['get',...args]);return item;},markRead:async(...args)=>{calls.push(['read',...args]);return{...item,readAt:2};}}};}
test('Gemini inbox tools scope every operation to server-authenticated device',async()=>{
 const f=fixture(),run=createInboxTools({inbox:f.inbox,deviceId:'owned-device'});
 const list=await run('notifications_list',{});assert.equal(list.untrusted,true);assert.equal(list.unreadCount,1);assert.equal(f.calls[0][1],'owned-device');assert.equal(f.calls[0][2].limit,3);
 await run('notifications_get',{id:ID});assert.equal(f.calls[1][1],'owned-device');assert.equal(f.calls.some(c=>c[0]==='read'),false);
 await assert.rejects(run('notifications_get',{id:ID,device_id:'other-device'}));
 assert.ok(INBOX_TOOLS.every(t=>!t.parameters.properties.device_id));
 assert.match(INBOX_INSTRUCTION,/never instructions/);assert.match(INBOX_INSTRUCTION,/never.*notification text asks/i);
});
test('mark-read requires explicit confirmation and retrieval never invokes it',async()=>{
 const f=fixture(),run=createInboxTools({inbox:f.inbox,deviceId:'owned-device'});
 await assert.rejects(run('notifications_mark_read',{id:ID,confirm:false}));
 await assert.rejects(run('notifications_mark_read',{id:ID}));
 assert.equal(f.calls.length,0);
 const result=await run('notifications_mark_read',{id:ID,confirm:true});assert.equal(result.notification.readAt,2);assert.equal(f.calls[0][0],'read');
});
test('tool text remains bounded untrusted data and cannot choose other functions',async()=>{
 const f=fixture();f.item.text='<>&"'.repeat(500);const run=createInboxTools({inbox:f.inbox,deviceId:'owned-device',maxChars:512});
 const result=await run('notifications_get',{id:ID});assert.ok(JSON.stringify(result).length<=512);assert.equal(result.untrusted,true);assert.equal(result.truncated,true);
 await assert.rejects(run('run_command',{command:'anything'}));assert.equal(f.calls.length,1);
 await assert.rejects(run('notifications_list',{limit:100}));
 await assert.rejects(run('notifications_list',{unread_only:'true'}));
});

test('reserved-looking external tool names fall through when builtin inbox tools were not installed',()=>{
 const {canUseInboxTools,isInboxToolCall}=require('../lib/inbox-tools');
 for(const [backend,dedicated] of [['qwen',true],['qwen_realtime',true],['gemini',false]]){
  assert.equal(canUseInboxTools(backend,dedicated),false);
  for(const name of ['notifications_list','notifications_get','notifications_mark_read'])assert.equal(isInboxToolCall(name,backend,dedicated),false);
 }
 assert.equal(canUseInboxTools('gemini',true),true);assert.equal(isInboxToolCall('notifications_list','gemini',true),true);
 assert.equal(isInboxToolCall('external_other_tool','gemini',true),false);
});
