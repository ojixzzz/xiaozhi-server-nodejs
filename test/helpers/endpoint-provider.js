'use strict';

// Emulate precisely the calculator pipe's raw stdio JSON-RPC WebSocket frames.
const WebSocket = require('ws');

async function endpointProvider(url, tools, handleTool) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const calls = [];
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    const reply = result => ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') reply({ protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'local-stdio-example', version: '1.0' } });
    else if (message.method === 'tools/list') reply({ tools });
    else if (message.method === 'tools/call') {
      calls.push(message.params);
      Promise.resolve(handleTool(message.params)).then(reply, () => reply({ isError: true, content: [{ type: 'text', text: 'Rejected' }] }));
    } else if (pending.has(message.id)) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(handler.timer);
      handler.resolve(message);
    }
  });
  ws.on('close', () => {
    for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(new Error('Endpoint closed')); }
    pending.clear();
  });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, calls, request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('No inbox receipt')); }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  } };
}

module.exports = { endpointProvider };
