'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
test('Docker config statically excludes secrets and SQLite sidecars (not a build test)',()=>{
  const ignores=read('.dockerignore').split(/\r?\n/);
  for(const item of ['.env','.env.*','devices.json','mcp_devices.json','sessions/*','*.sqlite','*.sqlite-*','node_modules']) assert.ok(ignores.includes(item),item);
  const docker=read('Dockerfile');
  assert.match(docker,/FROM node:24-/); assert.match(docker,/USER node/); assert.match(docker,/HEALTHCHECK/); assert.match(docker,/DATA_DIR=\/app\/data/);
  const compose=read('compose.yaml'); assert.match(compose,/WEB_BIND_ADDRESS:-127\.0\.0\.1/); assert.match(compose,/WEB_PORT:-3000/); assert.match(compose,/profiles: \[mqtt\]/); assert.match(compose,/MQTT_UDP_PORT:-8884/); assert.match(compose,/condition: service_healthy/); assert.match(compose,/PORT: 3000/); assert.match(compose,/xiaozhi-data:\/app\/data/);
});
