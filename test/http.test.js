'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
let dependenciesAvailable = true;
try { require.resolve('express'); require.resolve('@google/genai'); } catch { dependenciesAvailable = false; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('HTTP auth, device ownership, memory persistence and graceful shutdown (no live provider)', {skip: !dependenciesAvailable, timeout: 30000}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-http-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'devices.json'), JSON.stringify({alpha:{status:'approved',token:'test-alpha',enabled_mcp_devices:[]}, beta:{status:'approved',token:'test-beta',enabled_mcp_devices:[]}, pending:{status:'pending',token:'test-pending'},legacy:{status:'approved'},shared1:{status:'approved',token:'shared'},shared2:{status:'approved',token:'shared'}}));
  const allocation = net.createServer(); await new Promise(r => allocation.listen(0,'127.0.0.1',r));
  const port = allocation.address().port; await new Promise(r => allocation.close(r));
  const base = `http://127.0.0.1:${port}`;
  let child; let output = '';
  async function start(extraEnv = {}) {
    child = spawn(process.execPath,['app.js'],{cwd:path.join(__dirname,'..'),env:{PATH:process.env.PATH,HOME:directory,DATA_DIR:directory,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'local-smoke-only',LLM_BACKEND:'gemini',DOTENV_CONFIG_PATH:path.join(directory,'no-env'),...extraEnv}});
    child.stdout.on('data', b => output+=b); child.stderr.on('data',b=>output+=b);
    for(let i=0;i<100;i++) {
      if(child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${output}`);
      try { if((await fetch(base+'/health')).ok) return; } catch {}
      await delay(50);
    }
    throw new Error(`Server not ready: ${output}`);
  }
  async function stop() {
    const exit = new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
    child.kill('SIGTERM'); const result=await exit; assert.equal(result.code,0,output);
  }
  t.after(()=> {if(child && child.exitCode===null) child.kill('SIGKILL');});
  await start();
  const WebSocket = require('ws');
  async function socket(id, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {headers:{'Device-Id':id, Authorization:`Bearer ${token}`}});
    await new Promise((resolve,reject) => {ws.once('open',resolve);ws.once('error',reject);});
    return ws;
  }
  const rejected = await socket('pending','test-pending');
  assert.equal(await new Promise(resolve=>rejected.once('close',resolve)),1008);
  const badToken = await socket('alpha','incorrect');
  assert.equal(await new Promise(resolve=>badToken.once('close',resolve)),1008);
  assert.equal((await fetch(base+'/health')).headers.get('set-cookie'),null,'health checks must not create dashboard sessions');
  const login = await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'local-smoke-only'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {'Cookie':cookie,'Content-Type':'application/json','X-Requested-With':'XiaozhiDashboard'};
  const agentUrl = base + '/api/agent_connections';
  assert.equal((await fetch(agentUrl)).status, 401);
  assert.equal((await fetch(agentUrl, { method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}' })).status, 403);
  assert.equal((await fetch(agentUrl, { method:'POST',headers,body:JSON.stringify({name:'Agent',device_id:'shared1',public_url:base}) })).status, 409);
  const pairedResponse = await fetch(agentUrl, { method:'POST',headers,body:JSON.stringify({name:'Agent',device_id:'alpha',public_url:base}) });
  assert.equal(pairedResponse.status, 201);
  const pairing = await pairedResponse.json();
  const bearer = pairing.mcp_config.mcpServers.xiaozhi.headers.Authorization;
  const senderHeaders = { Authorization:bearer,'Content-Type':'application/json' };
  assert.equal(JSON.stringify(await (await fetch(agentUrl,{headers})).json()).includes(bearer.slice(7)), false);
  assert.equal((await fetch(`${agentUrl}/${pairing.connection.id}/export`, { method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}' })).status, 403);
  const inboxPayload = {device_id:'alpha',title:'Agent setup',text:'Saved with dashboard token',idempotency_key:'pairing-http-test'};
  assert.equal((await fetch(base+'/api/notifications',{method:'POST',headers:senderHeaders,body:JSON.stringify({...inboxPayload,device_id:'beta'})})).status, 403);
  assert.equal((await fetch(base+'/api/notifications',{method:'POST',headers:senderHeaders,body:JSON.stringify(inboxPayload)})).status, 201);
  const remoteUrl=base+'/api/remote_mcp_servers';
  assert.equal((await fetch(remoteUrl)).status,401);
  assert.equal((await fetch(remoteUrl,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  const remoteSettings={name:'Custom agent',url:'https://agent.example.com/mcp',transport:'streamable-http',token:'temporary-remote-test-token',enabled:false};
  const createdRemote=await fetch(remoteUrl,{method:'POST',headers,body:JSON.stringify(remoteSettings)});
  assert.equal(createdRemote.status,200);
  const remote=(await createdRemote.json()).server;
  assert.equal(remote.enabled,false);
  assert.equal(remote.connected,false);
  assert.equal(remote.tokenConfigured,true);
  assert.equal(JSON.stringify(remote).includes(remoteSettings.token),false);
  const mcpConnections=await (await fetch(base+'/api/mcp_devices',{headers})).json();
  assert.equal(mcpConnections[remote.id].remote,true);
  assert.equal(mcpConnections[remote.id].name,'Custom agent');
  assert.equal(JSON.stringify(mcpConnections).includes(remoteSettings.token),false);
  const url=base+'/api/devices/alpha/memory';
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(base+'/api/devices/pending/memory',{headers})).status,404);
  assert.equal((await fetch(base+'/api/devices/missing/notifications',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/devices/legacy/memory',{method:'PUT',headers,body:JSON.stringify({enabled:true,facts:[]})})).status,409);
  assert.equal((await fetch(base+'/api/devices/shared1/memory',{method:'PUT',headers,body:JSON.stringify({enabled:true,facts:[]})})).status,409);
  const initial=await (await fetch(url,{headers})).json(); assert.equal(initial.enabled,false);
  assert.equal((await fetch(url,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  const enabled=await fetch(url,{method:'PUT',headers,body:JSON.stringify({enabled:true,facts:['Likes concise replies']})}); assert.equal(enabled.status,200);
  assert.deepEqual((await enabled.json()).facts,['Likes concise replies']);
  assert.deepEqual((await (await fetch(base+'/api/devices/beta/memory',{headers})).json()).facts,[]);
  assert.equal((await fetch(url,{method:'DELETE',headers,body:JSON.stringify({confirm:'beta'})})).status,400);
  const notify=await fetch(base+'/api/devices/alpha/notifications',{method:'POST',headers,body:JSON.stringify({audio_url:'https://example.com/audio.ogg'})}); assert.equal(notify.status,503);
  await stop(); await start({NOTIFY_ENABLED:'true',NOTIFY_ADAPTER_MODULE:path.join(directory,'missing-adapter.js')});
  assert.match(output, /Notification configuration invalid; notifications disabled/);
  const relogin=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'local-smoke-only'})});
  headers.Cookie=relogin.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await (await fetch(`${agentUrl}/${pairing.connection.id}/export`,{method:'POST',headers,body:'{}'})).json()).mcp_config,pairing.mcp_config);
  assert.equal((await fetch(agentUrl+'/'+pairing.connection.id,{method:'DELETE',headers,body:'{}'})).status,200);
  assert.equal((await fetch(base+'/api/notifications',{method:'POST',headers:senderHeaders,body:JSON.stringify(inboxPayload)})).status,404);
  assert.equal((await (await fetch(remoteUrl,{headers})).json())[0].id,remote.id,'remote MCP settings survive an app restart');
  assert.equal((await fetch(`${remoteUrl}/${remote.id}`,{method:'DELETE',headers,body:'{}'})).status,200);
  assert.deepEqual(await (await fetch(remoteUrl,{headers})).json(),[]);
  assert.deepEqual((await (await fetch(url,{headers})).json()).facts,['Likes concise replies']);
  const liveSocket = await socket('alpha','test-alpha');
  const voiceClosed = new Promise(resolve=>liveSocket.once('close',resolve));
  const cleared=await fetch(url,{method:'DELETE',headers,body:JSON.stringify({confirm:'alpha'})}); assert.equal(cleared.status,200); assert.deepEqual((await cleared.json()).facts,[]);
  assert.equal(await voiceClosed,1000);
  await stop();
  const adapterPath=path.join(directory,'fake-adapter.js');
  const envelopePath=path.join(directory,'envelope.json');
  await fs.writeFile(adapterPath, `exports.rpc = async envelope => { await require('node:fs/promises').writeFile(${JSON.stringify(envelopePath)}, JSON.stringify(envelope)); return {success:true}; };`);
  await start({NOTIFY_ENABLED:'true',NOTIFY_ADAPTER_MODULE:adapterPath,NOTIFY_CLIENT_IDS_JSON:JSON.stringify({alpha:'gateway-alpha'}),NOTIFY_ALLOWED_AUDIO_ORIGINS:'https://audio.example.com'});
  const thirdLogin=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'local-smoke-only'})});
  headers.Cookie=thirdLogin.headers.get('set-cookie').split(';')[0];
  const notificationUrl=base+'/api/devices/alpha/notifications';
  const notificationBody={audio_url:'https://audio.example.com/test.ogg',idempotency_key:'smoke-request-1'};
  assert.equal((await fetch(notificationUrl,{method:'POST',headers,body:JSON.stringify({...notificationBody,clientId:'unowned-target'})})).status,400);
  const sent=await fetch(notificationUrl,{method:'POST',headers,body:JSON.stringify(notificationBody)});
  assert.equal(sent.status,200); const sentResult=await sent.json(); assert.equal(sentResult.status,'published'); assert.equal(sentResult.playback,'unknown');
  assert.deepEqual(JSON.parse(await fs.readFile(envelopePath,'utf8')),{method:'forward',clientId:'gateway-alpha',params:{type:'notify',audio_url:notificationBody.audio_url}});
  const retry=await (await fetch(notificationUrl,{method:'POST',headers,body:JSON.stringify(notificationBody)})).json(); assert.equal(retry.duplicate,true); assert.equal(retry.id,sentResult.id);
  assert.deepEqual((await (await fetch(url,{headers})).json()).facts,[]);
  await stop();
  await start({ADMIN_PASSWORD:'your_unique_admin_password_here'});
  const placeholderLogin=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'your_unique_admin_password_here'})});
  assert.equal(placeholderLogin.status,503,'shipped example admin passwords must never authorize the dashboard');
  await stop();
});
