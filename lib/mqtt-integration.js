'use strict';
const crypto = require('node:crypto');

function validSecret(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512 &&
    !/your_|change.?me|replace.?me|example|placeholder/i.test(value);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length && crypto.timingSafeEqual(left,right);
}
function mqttSettings(env=process.env) {
  const enabled=env.MQTT_ENABLED==='true';
  const allowInsecure=env.MQTT_ALLOW_INSECURE==='true';
  const signatureKey=env.MQTT_SIGNATURE_KEY;
  const serviceKey=env.MQTT_GATEWAY_KEY;
  const endpoint=env.MQTT_ENDPOINT || '';
  const gatewayUrl=env.MQTT_GATEWAY_URL || '';
  let reason=''; let parsed;
  if (!enabled) reason='MQTT is disabled; WebSocket remains available';
  else if (!validSecret(signatureKey) || !validSecret(serviceKey) || signatureKey===serviceKey) reason='Configure distinct MQTT_SIGNATURE_KEY and MQTT_GATEWAY_KEY secrets (at least 32 characters each)';
  else if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(endpoint) || endpoint.includes('://')) reason='MQTT_ENDPOINT must be a device-reachable host:port without a URL scheme';
  else {
    const pieces=endpoint.split(':'); const port=pieces[1]===undefined?8883:Number(pieces[1]);
    if(port<1 || port>65535) reason='Invalid MQTT endpoint port';
    else if(!allowInsecure && port!==8883) reason='TLS MQTT uses port 8883 for stock firmware; other ports require explicit MQTT_ALLOW_INSECURE=true';
    try { parsed=new URL(gatewayUrl); } catch {}
    if(!reason && (!parsed || !['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname!=='/')) reason='MQTT_GATEWAY_URL must be the private gateway HTTP(S) origin';
  }
  return {enabled,configured:enabled&&!reason,reason,allowInsecure,signatureKey,serviceKey,endpoint,gatewayUrl:parsed?.origin};
}
function provisioningUuid(device) {
  const id=device?.mqtt_uuid || device?.uuid;
  return typeof id==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) && !['unknown_uuid','unknown'].includes(id) ? id:null;
}
function mqttClientId(deviceId,device) {
  const uuid=provisioningUuid(device);
  if(!/^[a-fA-F0-9]{2}(?::[a-fA-F0-9]{2}){5}$/.test(deviceId) || !uuid) return null;
  return `GID_parrot@@@${deviceId.toLowerCase().replace(/:/g,'_')}@@@${uuid}`;
}
function credentialsFor(deviceId,device,settings) {
  if(!settings.configured) throw new Error('MQTT is not configured');
  const clientId=mqttClientId(deviceId,device);
  if(!clientId || device.mqtt_client_id!==clientId) throw new Error('Device MQTT identity is not provisioned');
  const username=Buffer.from(JSON.stringify({device_id:deviceId})).toString('base64');
  const password=crypto.createHmac('sha256',settings.signatureKey).update(clientId+'|'+username).digest('base64');
  return {endpoint:settings.endpoint,client_id:clientId,username,password,publish_topic:'device-server',subscribe_topic:`devices/p2p/${deviceId.toLowerCase().replace(/:/g,'_')}`,keepalive:60};
}
function createGatewayRpc(settings,{fetch:fetchImpl=globalThis.fetch}={}) {
  return async function rpc(envelope,{signal}={}) {
    if(!settings.configured) throw new Error('MQTT gateway is not configured');
    const response=await fetchImpl(settings.gatewayUrl+'/forward',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.serviceKey}`},body:JSON.stringify(envelope),signal,redirect:'error'});
    if(!response.ok) throw new Error('Gateway rejected notification');
    const text=await response.text();
    if(text.length>4096) throw new Error('Invalid gateway response');
    const result=JSON.parse(text);
    if(typeof result.success!=='boolean') throw new Error('Invalid gateway response');
    return {success:result.success};
  };
}
module.exports={mqttSettings,validSecret,safeEqual,provisioningUuid,mqttClientId,credentialsFor,createGatewayRpc};
