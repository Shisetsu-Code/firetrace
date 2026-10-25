const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createService}=require('../src/server.cjs');

test('API performs real commands, caches command IDs, protects artifacts and rejects cross-origin mutations',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-api-'));
  const service=await createService({port:0,host:'127.0.0.1',token:'test-token-long-enough',artifactDir:dir});
  t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${service.server.address().port}`,headers={'content-type':'application/json',authorization:'Bearer test-token-long-enough'};
  assert.equal((await fetch(url+'/api/state')).status,401);
  assert.equal((await fetch(url+'/api/command',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify({command:'detect'})})).status,403);
  const post=body=>fetch(url+'/api/command',{method:'POST',headers,body:JSON.stringify(body)}).then(r=>r.json());
  const opened=await post({command:`goto ${url}/demo`,commandId:'go-demo'});assert(opened.ok);assert.deepEqual(opened.observation.buttons,[]);
  assert.equal(opened.observation.stability.status,'unverified');
  const verified=await post({command:'verify',commandId:'verify-demo'});assert(verified.ok);assert(verified.observation.buttons.length>0);
  assert.equal(verified.observation.stability.completedSamples,3);
  const duplicate=await post({command:'verify',commandId:'verify-demo'});
  assert.equal(duplicate.observation.observationId,verified.observation.observationId);
  const first=await post({command:'scroll 100',commandId:'once'});
  const retry=await post({command:'scroll 100',commandId:'once'});
  assert.equal(retry.observation.observationId,first.observation.observationId);
  assert.equal((await post({command:'scroll 200',commandId:'once'})).error.code,'COMMAND_ID_CONFLICT');
  assert.equal((await fetch(url+opened.observation.screenshotUrl)).status,401);
  assert.equal((await fetch(url+opened.observation.screenshotUrl,{headers})).status,200);
  assert.equal((await fetch(url+'/api/command',{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'{}'})).status,415);
});
