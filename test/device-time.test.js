'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {parseDeviceTimezoneOffset,deviceServerTime}=require('../lib/device-time');
test('firmware time uses bounded minutes with explicit configurable WIB default',()=>{
 assert.equal(parseDeviceTimezoneOffset(undefined),420);assert.equal(parseDeviceTimezoneOffset(''),420);
 for(const value of [-720,0,330,420,480,840])assert.equal(parseDeviceTimezoneOffset(String(value)),value);
 for(const value of ['28800','3600','-721','841','420.5','Asia/Jakarta','true','1e2'])assert.throws(()=>parseDeviceTimezoneOffset(value));
});
test('server timestamp stays UTC epoch milliseconds and offset is added exactly once by firmware',()=>{
 const utc=Date.UTC(2026,9,7,0,0,0);const payload=deviceServerTime(420,utc);
 assert.deepEqual(payload,{timestamp:utc,timezone_offset:420});
 assert.equal(new Date(payload.timestamp+payload.timezone_offset*60*1000).toISOString(),'2026-10-07T07:00:00.000Z');
 assert.deepEqual(deviceServerTime(0,utc),{timestamp:utc,timezone_offset:0});
 assert.throws(()=>deviceServerTime(28800,utc));assert.throws(()=>deviceServerTime(420,1.5));
});
