'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {mqttSettings,validSecret,safeEqual,provisioningUuid,mqttClientId,credentialsFor,createGatewayRpc}=require('../lib/mqtt-integration');
const {validateMqttCredentials}=require('../gateway/credentials');
function configured(extra={}){return mqttSettings({MQTT_ENABLED:'true',MQTT_SIGNATURE_KEY:'S'.repeat(40),MQTT_GATEWAY_KEY:'G'.repeat(40),MQTT_ENDPOINT:'192.168.1.50:1883',MQTT_GATEWAY_URL:'http://127.0.0.1:3001',MQTT_ALLOW_INSECURE:'true',...extra});}
test('MQTT settings preserve default WebSocket and reject missing or placeholder credentials',()=>{
 assert.equal(mqttSettings({}).enabled,false);assert.equal(mqttSettings({}).configured,false);
 assert.equal(validSecret('REPLACE_ME_WITH_OPERATOR_SUPPLIED_SIGNATURE_SECRET'),false);
 assert.equal(configured({MQTT_SIGNATURE_KEY:'short'}).configured,false);
 assert.equal(configured({MQTT_SIGNATURE_KEY:'G'.repeat(40)}).configured,false);
 assert.equal(configured().configured,true);
 assert.equal(configured({MQTT_ALLOW_INSECURE:'false'}).configured,false);
 assert.equal(configured({MQTT_ALLOW_INSECURE:'false',MQTT_ENDPOINT:'voice.example.org:8883'}).configured,true);
 for(const MQTT_ENDPOINT of ['mqtt://host:1883','host:70000','host:0','host/path','host name:1883']) assert.equal(configured({MQTT_ENDPOINT}).configured,false);
 for(const MQTT_GATEWAY_URL of ['ftp://host','http://user:pass@host','http://host/forward','http://host/?secret=x'])assert.equal(configured({MQTT_GATEWAY_URL}).configured,false);
});
test('OTA helper issues wire-compatible HMAC credentials for an explicitly bound device identity',()=>{
 const device={uuid:'12345678-abcd-1234-5678-1234567890ab'};const id='AA:BB:CC:DD:EE:FF';
 device.mqtt_client_id=mqttClientId(id,device);
 const cfg=configured();const result=credentialsFor(id,device,cfg);
 assert.equal(result.endpoint,'192.168.1.50:1883');assert.equal(result.publish_topic,'device-server');
 const decoded=validateMqttCredentials(result.client_id,result.username,result.password,cfg.signatureKey);
 assert.equal(decoded.deviceId,'aa:bb:cc:dd:ee:ff');assert.equal(decoded.uuid,device.uuid);
 assert.equal(result.password,crypto.createHmac('sha256',cfg.signatureKey).update(result.client_id+'|'+result.username).digest('base64'));
 assert.equal(provisioningUuid({uuid:'unknown_uuid'}),null);assert.equal(mqttClientId('invalid',device),null);
 assert.throws(()=>credentialsFor(id,{...device,mqtt_client_id:'different'},cfg));
 assert.equal(safeEqual('same','same'),true);assert.equal(safeEqual('same','no'),false);
});
test('built-in adapter authenticates only the configured gateway and preserves explicit publication boolean',async()=>{
 const cfg=configured();let received;
 const rpc=createGatewayRpc(cfg,{fetch:async(url,options)=>{received={url,options};return new Response(JSON.stringify({success:false}),{status:200});}});
 const envelope={method:'forward',clientId:'test',params:{type:'notify',audio_url:'https://audio.example.org/test.ogg'}};
 assert.deepEqual(await rpc(envelope),{success:false});assert.equal(received.url,'http://127.0.0.1:3001/forward');
 assert.equal(received.options.headers.Authorization,`Bearer ${cfg.serviceKey}`);assert.equal(received.options.redirect,'error');assert.deepEqual(JSON.parse(received.options.body),envelope);
 for(const response of [new Response('{}',{status:200}),new Response('{"success":true}',{status:401})]) {
   await assert.rejects(createGatewayRpc(cfg,{fetch:async()=>response})(envelope));
 }
});
