'use strict';
const net=require('node:net');
// Only explicit proxy IPs/subnets; never trust a forwarded header from everyone.
function parseTrustedProxies(value) {
  if(value===undefined || value==='') return false;
  if(typeof value!=='string') throw new TypeError('TRUST_PROXY must list proxy IPs or CIDRs');
  const entries=value.split(',').map(v=>v.trim());
  if(!entries.length || entries.length>16) throw new TypeError('Too many trusted proxies');
  for(const entry of entries){
    if(entry==='loopback')continue;
    const parts=entry.split('/');const family=net.isIP(parts[0]);
    if(!family || parts.length>2 || parts[0]==='0.0.0.0' || parts[0]==='::') throw new TypeError('Use explicit trusted proxy IPs/CIDRs, not true or hop counts');
    if(parts.length===2 && (!/^\d+$/.test(parts[1]) || Number(parts[1])<1 || Number(parts[1])>(family===4?32:128))) throw new TypeError('Invalid trusted proxy prefix');
  }
  return entries;
}
module.exports={parseTrustedProxies};
