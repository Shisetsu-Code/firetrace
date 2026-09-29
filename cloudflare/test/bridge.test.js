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
test('browser lifecycle failures give safe actionable instructions',async()=>{
  const env={CONTROL_TOKEN:'secret',CONTROL:{fetch:async req=>new URL(req.url).pathname==='/api/state'
    ? Response.json({state:{connected:true,last_seen:Date.now()}})
    : Response.json({status:'error',error:'ValueError: Browser window closed; use browser_reopen with this browser_id'},{status:502})}};
  await assert.rejects(()=>runCommand(env,'click',{browser_id:'a'.repeat(32),x:1,y:2}),/browser_reopen/);
});
test('a late started event cannot hide an already completed browser command',async()=>{
  let commands=0;
  const env={CONTROL_TOKEN:'secret',CONTROL:{fetch:async req=>{
    const path=new URL(req.url).pathname;
    if(path==='/api/state') return Response.json({state:{connected:true,last_seen:Date.now()}});
    if(path==='/api/rpc') { commands++; return Response.json({id:'test-id',status:'running'}); }
    return Response.json({command:{id:'test-id',agent_id:'firetrace',status:'running',finished_at:123,result:{active_count:2},error:null}});
  }}};
  const result=await runCommand(env,'browser_list');
  assert.equal(result.status,'done');
  assert.deepEqual(result.result,{active_count:2});
  assert.equal(commands,1);
});
