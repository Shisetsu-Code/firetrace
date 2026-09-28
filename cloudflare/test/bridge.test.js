import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, readState } from '../src/bridge.js';

test('offline agents are rejected before a command can be queued', async () => {
  const env = { CONTROL_TOKEN: 'secret', CONTROL: { async fetch(req) {
    assert.equal(new URL(req.url).pathname, '/api/state');
    return Response.json({ok:true,state:{connected:false}});
  }}};
  await assert.rejects(() => runCommand(env, 'click', {x:1,y:2}), /not connected/);
});
test('commands target firetrace and authenticate only the internal request', async () => {
  const env = { CONTROL_TOKEN: 'secret', CONTROL: { async fetch(req) {
    assert.equal(req.headers.get('x-control-token'), 'secret');
    if (new URL(req.url).pathname === '/api/state') return Response.json({ok:true,state:{connected:true,last_seen:Date.now()}});
    const body = await req.json();
    assert.equal(body.agent_id, 'firetrace');
    assert.equal(body.action, 'click');
    assert.deepEqual(body.args, {x:1,y:2});
    return Response.json({ok:true,status:'done',result:{clicked:true}});
  }}};
  assert.deepEqual(await runCommand(env,'click',{x:1,y:2}), {ok:true,status:'done',result:{clicked:true}});
});
test('upstream errors do not leak credentials or response bodies', async () => {
  const env = {CONTROL_TOKEN:'secret',CONTROL:{fetch:async()=>new Response('secret',{status:401})}};
  await assert.rejects(()=>readState(env), /^Error: Control service returned HTTP 401$/);
});
