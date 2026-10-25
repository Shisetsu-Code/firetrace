const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const {BrowserController}=require('../src/browser.cjs');
const {createService}=require('../src/server.cjs');

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bb-fixed-browser-'));
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{margin:0;height:2000px;background:#eee}button{position:absolute;left:60px;top:70px;width:160px;height:50px;border:0;outline:0;background:#245b78;color:white;font:16px sans-serif}button:hover,button:active,button:focus{background:#245b78;color:white;outline:0}</style><button onclick="window.clicks=(window.clicks||0)+1">Giro de prueba</button>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/ContainerLauncher`,url=base+'?gid=alpha&token=one';
  let browser=new BrowserController({artifactDir:directory});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  await browser.execute({action:'goto',url});
  return {directory,base,url,get browser(){return browser;},async restart(){await browser.close();browser=new BrowserController({artifactDir:directory});await browser.execute({action:'goto',url});return browser;}};
}

test('fixed controls survive invalidation, observation deletion and restart without new detector readings',async(t)=>{
  const f=await fixture(t);let browser=f.browser,reads=0;
  const collect=browser.collectVerificationSample.bind(browser);browser.collectVerificationSample=async(...args)=>{reads++;return collect(...args);};
  const verified=await browser.execute('verify'),original=verified.observation.buttons[0];
  const pinned=await browser.execute({action:'pin',id:original.id,name:'Girar',observationId:verified.observation.observationId});
  assert.equal(pinned.result.button.id,'f1');assert.equal(pinned.result.button.name,'Girar');
  assert.deepEqual(pinned.result.button.clickPoint,{x:140,y:95});
  assert.equal(reads,3);assert.equal(browser.observation.observationId,verified.observation.observationId,'pin preserves the verified observation');
  const raw=await browser.execute('snapshot');
  assert.deepEqual(raw.observation.buttons,[]);assert.equal(raw.observation.stability.status,'unverified');
  assert.deepEqual(raw.observation.fixedButtons.map(b=>b.id),['f1']);
  assert.equal(raw.observation.fixedButtons[0].verification,'user-fixed');
  assert.equal(await browser.page.locator('[data-coordinate-button="f1"]').count(),1);
  await fs.rm(path.join(f.directory,verified.observation.observationId),{recursive:true,force:true});
  assert((await browser.fixedStore.template('f1')).length>20,'saved crop is independent of removed observations');
  const clicked=await browser.execute('click f1');
  assert.equal(clicked.result.source,'fixed');assert.equal(clicked.result.clicked,'f1');
  assert.equal(await browser.page.evaluate(()=>window.clicks),1);assert.equal(reads,3);
  browser=await f.restart();browser.collectVerificationSample=async()=>{throw new Error('Fixed commands must not detect');};
  const listed=await browser.execute('pins');assert.equal(listed.fixedButtons[0].id,'f1');assert.equal(listed.fixedButtons[0].available,true);
  await browser.execute('rename f1 Giro guardado');
  assert.equal((await browser.execute('pins')).fixedButtons[0].name,'Giro guardado');
  const service=await createService({port:0,controller:browser,token:'fixed-test-token-long'});
  t.after(()=>service.close());
  const api=`http://127.0.0.1:${service.server.address().port}`,headers={authorization:'Bearer fixed-test-token-long'};
  assert.equal((await fetch(api+'/artifacts/fixed/f1.png')).status,401);
  assert.equal((await fetch(api+'/artifacts/fixed/f1.png',{headers})).status,200);
  assert.equal((await (await fetch(api+'/api/state',{headers})).json()).fixedButtons[0].name,'Giro guardado');
  await browser.execute('click f1');assert.equal(await browser.page.evaluate(()=>window.clicks),1);
  await browser.execute('unpin f1');
  assert.deepEqual((await browser.execute('pins')).fixedButtons,[]);
  assert.equal(await browser.page.locator('[data-coordinate-button="f1"]').count(),0);
  assert.equal((await fetch(api+'/artifacts/fixed/f1.png',{headers})).status,404);
  await assert.rejects(browser.execute('click f1'),e=>e.code==='UNKNOWN_FIXED_BUTTON');
});

test('fixed clicks reject other games, viewport or scroll changes and a covered target without sending input',async(t)=>{
  const f=await fixture(t),browser=f.browser;
  const {observation}=await browser.execute('verify');await browser.execute({action:'pin',id:observation.buttons[0].id});
  await browser.page.evaluate(()=>{const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:absolute;left:60px;top:70px;width:160px;height:50px;background:red';document.body.append(cover);});
  await assert.rejects(browser.execute('click f1'),e=>e.code==='FIXED_TARGET_CHANGED');
  assert.equal(await browser.page.evaluate(()=>window.clicks||0),0);
  await browser.page.locator('#cover').evaluate(el=>el.remove());
  await browser.execute('resize 800 600');
  assert.equal((await browser.execute('pins')).fixedButtons[0].available,false);
  await assert.rejects(browser.execute('click f1'),e=>e.code==='FIXED_CONTEXT_MISMATCH');
  await browser.execute('resize 1280 720');
  await browser.page.evaluate(()=>window.scrollTo(0,100));
  await assert.rejects(browser.execute('click f1'),e=>e.code==='FIXED_CONTEXT_MISMATCH');
  await browser.page.evaluate(()=>window.scrollTo(0,0));
  await browser.execute({action:'goto',url:f.base+'?gid=beta&token=two'});
  await assert.rejects(browser.execute('click f1'),e=>e.code==='FIXED_CONTEXT_MISMATCH');
  assert.equal(await browser.page.evaluate(()=>window.clicks||0),0);
  await browser.execute({action:'goto',url:f.base+'?token=rotated&gid=alpha'});
  await browser.execute('click f1');assert.equal(await browser.page.evaluate(()=>window.clicks),1);
});

test('pin requires a current stable observation and fixed coordinates never satisfy a failed dynamic verification',async(t)=>{
  const f=await fixture(t),browser=f.browser;
  await assert.rejects(browser.execute('pin b1'),e=>e.code==='STALE_OBSERVATION');
  const {observation}=await browser.execute('verify');
  await assert.rejects(browser.execute({action:'pin',id:'b1',observationId:'wrong'}),e=>e.code==='STALE_OBSERVATION');
  const capturedAt=browser.snapshot.createdAt;browser.snapshot.createdAt=Date.now()-120001;
  await assert.rejects(browser.execute('pin b1'),e=>e.code==='STALE_OBSERVATION');
  browser.snapshot.createdAt=capturedAt;await browser.execute('pin b1 Giro');
  let reads=0;const collect=browser.collectVerificationSample.bind(browser);
  browser.collectVerificationSample=async(...args)=>{const sample=await collect(...args);if(++reads===1)await browser.page.locator('button').evaluate(el=>el.style.left='360px');return sample;};
  const failed=await browser.execute('verify');
  assert.equal(reads,3);assert.equal(failed.observation.stability.status,'unstable');assert.deepEqual(failed.observation.buttons,[]);
  assert.equal(failed.observation.fixedButtons.length,1);assert.equal(failed.observation.fixedButtons[0].verification,'user-fixed');
  assert.equal(browser.snapshot,null);
  await assert.rejects(browser.execute('click f1'),e=>e.code==='FIXED_TARGET_CHANGED');
  assert.equal(await browser.page.evaluate(()=>window.clicks||0),0);
});

test('a failed page overlay never turns a committed catalog change into an uncertain command failure',async(t)=>{
  const {browser}=await fixture(t);await browser.execute('verify');
  browser.renderFixedCoordinates=async()=>{throw new Error('Page presentation unavailable');};
  const pinned=await browser.execute('pin b1 Giro guardado');
  assert.equal(pinned.result.button.id,'f1');assert(pinned.result.warning);
  assert.equal((await browser.fixedStore.list()).length,1);
  const renamed=await browser.execute('rename f1 Giro renombrado');
  assert.equal(renamed.result.button.name,'Giro renombrado');assert(renamed.result.warning);
  const removed=await browser.execute('unpin f1');
  assert.equal(removed.result.button.id,'f1');assert(removed.result.warning);
  assert.deepEqual(await browser.fixedStore.list(),[]);
});
