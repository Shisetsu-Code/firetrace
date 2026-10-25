const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const sharp=require('sharp');
const {BrowserController}=require('../src/browser.cjs');

test('real browser: buttons, shadow DOM, occlusion, crops, command actions and stale observations',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-test-'));
  const browser=new BrowserController({artifactDir:dir,headless:true,viewport:{width:1000,height:700}});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});
  await browser.start();
  await browser.page.setContent(`<!doctype html><style>body{margin:0}button{width:100px;height:40px}#hidden{display:none}#blocked{position:absolute;left:300px;top:100px}#cover{position:absolute;left:290px;top:90px;width:130px;height:70px;background:#000}</style>
  <button id="normal" onclick="this.textContent='Hecho'">Navegar</button><button disabled>Deshabilitado</button><button id="hidden">Invisible</button>
  <button id="blocked">Tapado</button><div id="cover"></div><input id="text"><div id="shadow"></div>
  <script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<button style="width:120px;height:40px">Sombra</button>';</script>`);
  let obs=await browser.observe();
  assert.deepEqual(obs.buttons.map(b=>b.label).sort(),['Navegar','Sombra']);
  const button=obs.buttons.find(b=>b.label==='Navegar');
  assert.equal(button.bbox.width,100);assert.equal(button.bbox.height,40);
  const crop=await sharp(path.join(dir,obs.observationId,`${button.id}.png`)).metadata();
  assert.equal(crop.width,100);assert.equal(crop.height,40);
  const firstId=obs.observationId;
  const result=await browser.execute({action:'click',id:button.id,observationId:firstId});
  assert.equal(result.observation.stability.status,'unverified');assert.deepEqual(result.observation.buttons,[]);
  assert.equal(await browser.page.locator('#normal').innerText(),'Hecho');
  await assert.rejects(browser.execute({action:'click',id:button.id,observationId:firstId}),e=>e.code==='STALE_OBSERVATION');
  await browser.execute({action:'click',x:260,y:20});
  await browser.execute({action:'type',text:'hola'});
  assert.equal(await browser.page.locator('#text').inputValue(),'hola');
  await browser.execute({action:'resize',width:800,height:600});
  assert.equal(browser.observation.viewport.width,800);
});

test('cross-origin iframe coordinates account for border and scale, blocked frame is excluded',async(t)=>{
  const inner=http.createServer((req,res)=>res.end('<style>body{margin:0}</style><button style="position:absolute;left:30px;top:20px;width:100px;height:50px" onclick="this.textContent=\'Clicked\'">Frame</button>'));
  await new Promise(r=>inner.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>inner.close(r)));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-frame-'));
  const browser=new BrowserController({artifactDir:dir,viewport:{width:1000,height:700}});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});
  await browser.start();
  await browser.page.setContent(`<iframe src="http://127.0.0.1:${inner.address().port}" style="position:absolute;left:100px;top:150px;width:400px;height:200px;border:4px solid;transform:scale(.75);transform-origin:top left"></iframe>`);
  await browser.page.frameLocator('iframe').locator('button').waitFor();
  const obs=await browser.observe(),button=obs.buttons.find(b=>b.label==='Frame');
  assert(button);assert(Math.abs(button.bbox.x-125.5)<1);assert(Math.abs(button.bbox.y-168)<1);
  assert(Math.abs(button.bbox.width-75)<1);
  await browser.execute({action:'click',id:button.id,observationId:obs.observationId});
  assert.equal(await browser.page.frameLocator('iframe').locator('button').innerText(),'Clicked');
  await browser.page.evaluate(()=>{const div=document.createElement('div');div.style='position:absolute;inset:0;background:black;z-index:999';document.body.appendChild(div)});
  assert.equal((await browser.observe()).buttons.length,0);
});

test('moved targets and expired observations reject clicks without side effects',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-stale-'));
  const browser=new BrowserController({artifactDir:dir,observationTTL:1000});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});await browser.start();
  await browser.page.setContent('<button onclick="window.clicked=true">Move me</button>');
  const obs=await browser.observe();
  await browser.page.locator('button').evaluate(el=>el.style.marginLeft='200px');
  await assert.rejects(browser.execute({action:'click',id:obs.buttons[0].id,observationId:obs.observationId}),e=>e.code==='TARGET_CHANGED');
  assert.equal(await browser.page.evaluate(()=>window.clicked),undefined);
  const current=await browser.observe();browser.snapshot.createdAt-=1500;
  await assert.rejects(browser.execute({action:'click',id:current.buttons[0].id}),e=>e.code==='STALE_OBSERVATION');
});

test('a newly covered center never clicks the overlay instead of the requested button',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-cover-'));
  const browser=new BrowserController({artifactDir:dir});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});await browser.start();
  await browser.page.setContent('<button style="position:absolute;left:20px;top:20px;width:160px;height:80px" onclick="window.targetClicks=(window.targetClicks||0)+1">Target</button>');
  const obs=await browser.observe();
  await browser.page.evaluate(()=>{const overlay=document.createElement('div');overlay.style='position:absolute;left:80px;top:40px;width:40px;height:40px;background:red';overlay.onclick=()=>window.overlayClicks=(window.overlayClicks||0)+1;document.body.append(overlay)});
  await assert.rejects(browser.execute({action:'click',id:obs.buttons[0].id,observationId:obs.observationId}),e=>e.code==='TARGET_CHANGED');
  assert.equal(await browser.page.evaluate(()=>window.overlayClicks||0),0);
  assert.equal(await browser.page.evaluate(()=>window.targetClicks||0),0);
});

test('partially off-screen frame button has a visible clickable point',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-clipped-'));
  const browser=new BrowserController({artifactDir:dir});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});await browser.start();
  await browser.page.setContent('<iframe style="position:absolute;left:-100px;top:100px;width:400px;height:200px;border:0"></iframe>');
  await browser.page.locator('iframe').evaluate(el=>{el.srcdoc='<button style="position:absolute;left:10px;top:10px;width:150px;height:60px" onclick="this.textContent=\'Done\'">Partial</button>';});
  await browser.page.frameLocator('iframe').locator('button').waitFor();
  const obs=await browser.observe(),button=obs.buttons.find(b=>b.label==='Partial');
  assert(button);assert.equal(button.bbox.x,0);assert.equal(button.bbox.width,60);
  await browser.execute({action:'click',id:button.id,observationId:obs.observationId});
  assert.equal(await browser.page.frameLocator('iframe').locator('button').innerText(),'Done');
});

test('one-shot DOM listener disappears from interactive targets after it fires',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-once-'));
  const browser=new BrowserController({artifactDir:dir});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});await browser.start();
  await browser.page.setContent('<div id="once" style="width:140px;height:50px">One shot</div><script>document.querySelector("#once").addEventListener("click",()=>{}, {once:true})</script>');
  const obs=await browser.observe();assert(obs.buttons.some(b=>b.label==='One shot'));
  const result=await browser.execute({action:'click',id:obs.buttons[0].id});
  assert.equal(result.observation.stability.status,'unverified');
  assert(!(await browser.observe()).buttons.some(b=>b.label==='One shot'));
});

test('an executed action with failed capture clears the old current observation',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-capture-failure-'));
  const browser=new BrowserController({artifactDir:dir});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});await browser.start();
  await browser.page.setContent('<button onclick="window.clicked=true">Action</button>');
  const obs=await browser.observe();
  const original=browser.page.screenshot.bind(browser.page);
  browser.page.screenshot=async()=>{throw new Error('Capture unavailable');};
  const response=await browser.execute({action:'click',id:obs.buttons[0].id,observationId:obs.observationId});
  browser.page.screenshot=original;
  assert.equal(await browser.page.evaluate(()=>window.clicked),true);
  assert.equal(response.result.actionExecuted,true);assert.equal(response.observation,null);
  assert.equal(browser.observation,null);assert.equal(browser.snapshot,null);
});

test('crops include only the portion visible through an overflow container',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-overflow-'));
  const browser=new BrowserController({artifactDir:dir});
  t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});await browser.start();
  await browser.page.setContent('<div style="position:absolute;left:100px;top:100px;width:100px;height:60px;overflow:hidden"><button style="width:200px;height:50px" onclick="window.clicked=true">Clipped button</button></div>');
  const obs=await browser.observe(),button=obs.buttons[0];
  assert.deepEqual(button.bbox,{x:100,y:100,width:100,height:50});
  assert.equal((await sharp(path.join(dir,obs.observationId,`${button.id}.png`)).metadata()).width,100);
  await browser.execute({action:'click',id:button.id,observationId:obs.observationId});
  assert.equal(await browser.page.evaluate(()=>window.clicked),true);
});
