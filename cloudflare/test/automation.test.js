import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleMcp} from '../src/mcp.js';
const rpc=async(method,params,env={})=>(await (await handleMcp(new Request('https://example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env)).json()).result;
test('automation catalog has bounded schemas and no arbitrary eval',async()=>{
 const {tools}=await rpc('tools/list',{});
 for(const name of ['browser_sequence','parallel_branches','network_capture_window','network_filter','network_get_response_body','dom_snapshot','browser_click_element','spin_until','request_replay','request_replay_from_template','validate_response','session_context','state_checkpoint','history_export','branch_matrix','iframe_list','iframe_open_direct','artifact_get','job_cancel']) assert.ok(tools.some(t=>t.name===name),name);
 assert.ok(!tools.some(t=>t.name==='browser_eval_readonly'));
 assert.equal(tools.find(t=>t.name==='request_replay').annotations.readOnlyHint,false);
 assert.equal(tools.find(t=>t.name==='browser_sequence').inputSchema.properties.steps.maxItems,20);
});
test('new tools fail safely against an old agent without dispatching',async()=>{
 const env={CONTROL_TOKEN:'test',CONTROL:{fetch:async req=>{assert.equal(new URL(req.url).pathname,'/api/state');return Response.json({state:{connected:true,last_seen:Date.now(),meta:{state:{}}}});}}};
 const result=await rpc('tools/call',{name:'dom_snapshot',arguments:{browser_id:'a'.repeat(32)}},env);
 assert.equal(result.isError,true); assert.match(result.content[0].text,/Update.*agent/i);
});
test('malformed sequence never reaches control',async()=>{
 const result=await rpc('tools/call',{name:'browser_sequence',arguments:{browser_id:'a'.repeat(32),steps:[{action:'shell',args:{cmd:'bad'}}]}});
 assert.equal(result.isError,true);
});
