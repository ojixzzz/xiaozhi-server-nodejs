'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const WebSocket = require('ws');
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('clear and disable synchronously invalidate provider even when peer never acknowledges close', {timeout:15000}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'xiaozhi-lifecycle-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const eventsPath=path.join(directory,'events.jsonl');
  const hookPath=path.join(directory,'fake-provider.cjs');
  const hook=`
    const Module = require('node:module');
    const EventEmitter = require('node:events');
    const fs = require('node:fs');
    const originalLoad = Module._load;
    const record = data => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(data)+'\\n');
    class FakeGemini extends EventEmitter {
      constructor(config) { super(); this.config=config; }
      async connect() { record({type:'connect',prompt:this.config.prompt}); this.emit('connected'); }
      close() {
        record({type:'close'});
        // Late SDK callbacks must not restore memory, audio or execute tools.
        this.emit('input_transcription','late user text');
        this.emit('output_transcription','late assistant text');
        this.emit('turn_complete');
        this.emit('audio_output',Buffer.alloc(2880));
        this.emit('tool_call','late-call','server.update_config',{prompt:'SHOULD_NOT_RUN'});
      }
      sendAudio() {} sendToolResponse() {} interrupt() {}
    }
    Module._load = function(request,parent,isMain) {
      if(request==='./providers/gemini' && parent?.filename.endsWith('/app.js')) return FakeGemini;
      return originalLoad.apply(this,arguments);
    };
  `;
  await fs.writeFile(hookPath,hook);
  await fs.writeFile(path.join(directory,'devices.json'),JSON.stringify({alpha:{status:'approved',token:'test-token',prompt:'original prompt',enabled_mcp_devices:['parrot-dashboard']}}));
  const allocator=net.createServer(); await new Promise(r=>allocator.listen(0,'127.0.0.1',r));
  const port=allocator.address().port; await new Promise(r=>allocator.close(r));
  let output=''; const child=spawn(process.execPath,['--require',hookPath,'app.js'],{cwd:path.join(__dirname,'..'),env:{PATH:process.env.PATH,HOME:directory,DATA_DIR:directory,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'lifecycle-test-only',GEMINI_API_KEY:'fake-not-used',LLM_BACKEND:'gemini',DOTENV_CONFIG_PATH:path.join(directory,'none')}});
  child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await delay(25);}
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'lifecycle-test-only'})});
  assert.equal(login.status,200,output);
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json','X-Requested-With':'XiaozhiDashboard'};
  const memoryUrl=base+'/api/devices/alpha/memory';
  const readEvents=async()=>{try{return(await fs.readFile(eventsPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return[];}};
  for(const operation of ['clear','disable']){
    assert.equal((await fetch(memoryUrl,{method:'PUT',headers,body:JSON.stringify({enabled:true,facts:['Remember this old context']})})).status,200);
    const before=(await readEvents()).length;
    const ws=new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`,{headers:{'Device-Id':'alpha',Authorization:'Bearer test-token'}});
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
    // ws normally answers the peer's close automatically. Suppress that answer
    // to test the server's invalidation before its 30-second close timer expires.
    ws.close=()=>{};
    t.after(()=>ws.terminate());
    ws.send(JSON.stringify({type:'hello'}));
    for(let i=0;i<100 && (await readEvents()).length===before;i++)await delay(10);
    const connected=(await readEvents()).slice(before).find(e=>e.type==='connect');
    assert.ok(connected?.prompt.includes('Remember this old context'));
    const response=await fetch(memoryUrl,{method:operation==='clear'?'DELETE':'PUT',headers,body:JSON.stringify(operation==='clear'?{confirm:'alpha'}:{enabled:false,facts:[]})});
    assert.equal(response.status,200);
    assert.ok((await readEvents()).slice(before).some(e=>e.type==='close'),'provider closes before HTTP response, without close acknowledgement');
    const stored=await(await fetch(memoryUrl,{headers})).json();
    assert.deepEqual(stored.turns,[]); assert.deepEqual(stored.facts,[]);
    const devices=JSON.parse(await fs.readFile(path.join(directory,'devices.json'),'utf8'));
    assert.equal(devices.alpha.prompt,'original prompt','late tool call after invalidation is ignored');
    ws.terminate();
  }
  const exited=new Promise(r=>child.once('exit',r)); child.kill('SIGTERM'); assert.equal(await exited,0,output);
});
