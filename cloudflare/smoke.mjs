// Read-only production smoke: OAuth + MCP status. Never prints passwords or tokens.
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const base=process.env.MCP_URL||'https://firetrace-mcp.braian-n-l.workers.dev';
const {MCP_PASSWORD}=JSON.parse(await readFile(new URL('./secrets.json',import.meta.url),'utf8'));
const request=async(path,options={})=>fetch(base+path,{...options,redirect:'manual'});
const discovery=await request('/.well-known/oauth-authorization-server');
assert.equal(discovery.status,200);
const meta=await discovery.json();
const unauthorized=await request('/mcp');
assert.equal(unauthorized.status,401);
assert.ok(unauthorized.headers.get('www-authenticate'));
console.log('PASS OAuth discovery and unauthenticated rejection');
const redirect='http://127.0.0.1:18453/callback';
const registered=await fetch(meta.registration_endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Firetrace verification',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
assert.equal(registered.status,201);
const client=await registered.json();
const verifier=randomBytes(32).toString('base64url');
const params=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'browser:control offline_access',state:randomBytes(16).toString('hex'),resource:base+'/mcp',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
const consent=await request('/authorize?'+params);
assert.equal(consent.status,200);
const html=await consent.text();
const handle=html.match(/name="handle" value="([^"]+)"/)?.[1];
assert.ok(handle);
const cookie=consent.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const submit=async(password,cookieValue=cookie)=>request('/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base,cookie:cookieValue},body:new URLSearchParams({handle,password,decision:'approve'})});
assert.equal((await submit('incorrect')).status,401);
assert.equal((await submit(MCP_PASSWORD,'')).status,400);
const approved=await submit(MCP_PASSWORD);
assert.equal(approved.status,302);
const callback=new URL(approved.headers.get('location'));
assert.equal(callback.searchParams.get('state'),params.get('state'));
const tokenResponse=await fetch(meta.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,code:callback.searchParams.get('code'),code_verifier:verifier,resource:base+'/mcp'})});
assert.equal(tokenResponse.status,200);
const tokens=await tokenResponse.json();
console.log('PASS consent, password validation, CSRF protection and PKCE token exchange');
const rpc=async(method,params)=>{
  const res=await request('/mcp',{method:'POST',headers:{authorization:`Bearer ${tokens.access_token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  assert.equal(res.status,200);
  const data=await res.json(); assert.ok(!data.error); return data.result;
};
const initialization=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'smoke',version:'1'}});
assert.equal(initialization.serverInfo.name,'firetrace');
assert.match(initialization.instructions,/browser_create/);
assert.match(initialization.instructions,/headless/);
const advertised=(await rpc('tools/list',{})).tools;
assert.equal(advertised.length,35);
assert.equal(advertised.find(t=>t.name==='browser_create').inputSchema.properties.headless.type,'boolean');
for(const name of ['browser_create','browser_list','browser_close','browser_reopen']) assert.ok(advertised.some(t=>t.name===name));
console.log('PASS server '+initialization.serverInfo.version+' instructions and tool catalog: '+advertised.map(t=>t.name).join(', '));
const status=await rpc('tools/call',{name:'browser_status',arguments:{}});
assert.ok(!status.isError,JSON.stringify(status));
const data=JSON.parse(status.content[0].text);
console.log('PASS MCP initialize, tools/list and real browser_status; connected='+Boolean(data.state?.connected));
if(process.env.FIRETRACE_SMOKE_SESSIONS==='1') {
  const created=[];
  const call=async(name,args={})=>{
    const response=await rpc('tools/call',{name,arguments:args});
    assert.ok(!response.isError,JSON.stringify(response));
    const envelope=JSON.parse(response.content[0].text);
    assert.equal(envelope.status,'done',JSON.stringify(envelope));
    return envelope.result;
  };
  try {
    for(let i=0;i<2;i++) {
      const browser=await call('browser_create',{mode:'temporary',headless:true});
      assert.ok(browser.browser_id);
      created.push(browser.browser_id);
      assert.equal(browser.headless,true);
    }
    const list=await call('browser_list');
    assert.ok(created.every(id=>list.browsers.some(b=>b.browser_id===id && b.open)));
    await call('browser_close',{browser_id:created[0]});
    const closed=await rpc('tools/call',{name:'browser_wait',arguments:{browser_id:created[0],ms:0}});
    assert.equal(closed.isError,true);
    assert.match(closed.content[0].text,/browser_reopen/);
    await call('browser_wait',{browser_id:created[1],ms:0});
    await call('browser_reopen',{browser_id:created[0]});
    assert.equal((await call('browser_list')).browsers.find(b=>b.browser_id===created[0]).open,true);
    console.log('PASS two isolated headless browsers, targeted close, other browser alive, reopen through OAuth/MCP/WSS');
  } finally {
    for(const browser_id of created) await call('browser_close',{browser_id});
  }
}
if(process.env.FIRETRACE_SMOKE_AUTOMATION==='1') {
  const server=createServer((req,res)=>{
    const api=req.url==='/api/demo';
    const body=api?JSON.stringify({ok:true,terminal:true,mode:'demo'}):'<button onclick="fetch(\'/api/demo\',{method:\'POST\'}).then(r=>r.json()).then(()=>document.title=\'done\')">Demo</button>';
    res.writeHead(200,{'content-type':api?'application/json':'text/html','content-length':Buffer.byteLength(body)}); res.end(body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  const created=[];
  const call=async(name,args={})=>{
    const response=await rpc('tools/call',{name,arguments:args});
    assert.ok(!response.isError,JSON.stringify(response));
    const envelope=JSON.parse(response.content[0].text);
    assert.equal(envelope.status,'done',JSON.stringify(envelope));
    return envelope.result;
  };
  try {
    const branches=[];
    for(let i=0;i<2;i++) {
      const {browser_id}=await call('browser_create',{mode:'temporary',headless:true}); created.push(browser_id);
      await call('browser_open',{browser_id,url});
      const snap=await call('dom_snapshot',{browser_id});
      const button=snap.elements.find(e=>e.text==='Demo'); assert.ok(button,JSON.stringify(snap));
      branches.push({browser_id,label:`demo_${i}`,steps:[
        {action:'capture_start',args:{filters:{path:['/api/demo']}}},
        {action:'click_element',args:{snapshot_id:snap.snapshot_id,element_id:button.element_id}},
        {action:'wait',args:{ms:500}}, {action:'capture_read'}, {action:'screenshot'}, {action:'capture_stop'}]});
    }
    const submitted=await call('parallel_branches',{branches});
    let job;
    for(let i=0;i<30;i++) {
      job=await call('command_result',{id:submitted.job_id});
      if(!['queued','running'].includes(job.status)) break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(job.status,'done',JSON.stringify(job)); assert.equal(job.coverage.completed,2,JSON.stringify(job));
    for(const browser_id of created) {
      const events=await call('network_events',{browser_id});
      assert.ok(events.events.length); const request_id=events.events[0].request_id;
      const body=await call('network_get_response_body',{browser_id,request_id});
      assert.equal(JSON.parse(body.body).terminal,true);
      assert.equal((await call('validate_response',{browser_id,request_id,checks:[{path:'body.ok',op:'equals',value:true}]})).valid,true);
      await call('browser_close',{browser_id});
      assert.equal((await call('network_get_response_body',{browser_id,request_id})).body,body.body);
    }
    const exported=await rpc('tools/call',{name:'history_export',arguments:{job_id:submitted.job_id,format:'json'}});
    assert.ok(!exported.isError); assert.match(exported.content[0].text,/demo_0/);
    console.log('PASS real parallel demo branches, DOM clicks, capture/read/validation, evidence after close and history export');
  } finally {
    for(const browser_id of created) await call('browser_close',{browser_id});
    await new Promise(resolve=>server.close(resolve));
  }
}
if(process.env.FIRETRACE_SMOKE_SCREENSHOT==='1') {
  assert.equal(data.state?.connected,true,'Firetrace must be online for screenshot verification');
  const shot=await rpc('tools/call',{name:'browser_screenshot',arguments:{quality:40}});
  assert.ok(!shot.isError,JSON.stringify(shot));
  const image=shot.content.find(item=>item.type==='image');
  assert.equal(image?.mimeType,'image/jpeg');
  const bytes=Buffer.from(image.data,'base64');
  assert.equal(bytes[0],0xff);
  assert.equal(bytes[1],0xd8);
  assert.ok(bytes.length>1000);
  console.log('PASS live browser screenshot through OAuth/MCP/WSS/R2; JPEG bytes='+bytes.length);
}
const refresh=await fetch(meta.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:base+'/mcp'})});
assert.equal(refresh.status,200);
console.log('PASS refresh token');
// Revoke this smoke-test grant after validation.
const fresh=await refresh.json();
if(meta.revocation_endpoint) await fetch(meta.revocation_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:fresh.refresh_token,token_type_hint:'refresh_token',client_id:client.client_id})});
