import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp } from '../src/mcp.js';

const request=(method,params={},id=1)=>new Request('https://example.com/mcp',{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
test('MCP initializes and advertises browser tools with truthful annotations',async()=>{
  const init=await (await handleMcp(request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}),{})).json();
  assert.equal(init.result.serverInfo.name,'firetrace');
  assert.match(init.result.instructions,/browser_create/);
  assert.match(init.result.instructions,/browser_id/);
  assert.match(init.result.instructions,/persistent/);
  assert.match(init.result.instructions,/headless/);
  const result=await (await handleMcp(request('tools/list'),{})).json();
  assert.equal(result.result.tools.length,35);
  assert.equal(result.result.tools.find(t=>t.name==='browser_create').inputSchema.properties.headless.type,'boolean');
  for (const name of ['browser_create','browser_list','browser_close','browser_reopen']) {
    assert.ok(result.result.tools.find(t=>t.name===name));
  }
  for (const name of ['browser_open','browser_click','browser_screenshot','network_events','trigger_and_capture']) {
    assert.ok(result.result.tools.find(t=>t.name===name).inputSchema.properties.browser_id);
  }
  assert.equal(result.result.tools.find(t=>t.name==='browser_click').annotations.readOnlyHint,false);
  assert.equal(result.result.tools.find(t=>t.name==='browser_screenshot').annotations.readOnlyHint,true);
});
test('invalid URLs are rejected before reaching the control service',async()=>{
  const response=await handleMcp(request('tools/call',{name:'browser_open',arguments:{url:'file:///secret'}}),{});
  const result=await response.json();
  assert.equal(result.result.isError,true);
});
test('offline agent returns a tool error rather than false success',async()=>{
  const env={CONTROL_TOKEN:'secret',CONTROL:{fetch:async()=>Response.json({ok:true,state:{connected:false}})}};
  const result=await (await handleMcp(request('tools/call',{name:'browser_click',arguments:{x:1,y:2}}),env)).json();
  assert.equal(result.result.isError,true);
  assert.match(result.result.content[0].text,/not connected/);
});
