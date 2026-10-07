'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {parseTrustedProxies}=require('../lib/proxy-config');
test('proxy trust defaults off and accepts only explicit bounded proxy addresses',()=>{
 assert.equal(parseTrustedProxies(undefined),false);assert.equal(parseTrustedProxies(''),false);
 assert.deepEqual(parseTrustedProxies('loopback,172.18.0.1,10.20.0.0/16'),['loopback','172.18.0.1','10.20.0.0/16']);
 for(const value of ['true','1','0.0.0.0/0','::/0','127.0.0.1/99','hostname','loopback,', '10.0.0.1/'.repeat(17)])assert.throws(()=>parseTrustedProxies(value));
});
