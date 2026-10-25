const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const sharp=require('sharp');
const {BrowserController}=require('../src/browser.cjs');
const {createService}=require('../src/server.cjs');
const {makeFixedContext}=require('../src/fixed-buttons.cjs');

function latch(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}
async function browserFixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bb-fixed-race-'));
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{margin:0;height:2000px;background:#eee}button{position:absolute;left:60px;top:70px;width:160px;height:50px;border:0;background:#245b78;color:white;font:16px sans-serif}button:hover,button:active,button:focus{background:#245b78;color:white;outline:0}</style><button onclick="window.clicks=(window.clicks||0)+1">Giro fijo</button>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/ContainerLauncher`;
  const browser=new BrowserController({artifactDir:directory});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  await browser.start();await browser.page.goto(base+'?gid=alpha');
  return {browser,base};
}

test('a delayed fixed-button listing cannot resurrect a context invalidated while reading the store',{timeout:10000},async()=>{
  const browser=new BrowserController({artifactDir:path.join(os.tmpdir(),'bb-fixed-race-no-write')});
  const scope=makeFixedContext({url:'https://demo.example/?gid=alpha',viewport:{width:1280,height:720}});
  const entered=latch(),resume=latch();
  browser.fixedContext=scope;browser.fixedButtons=[{id:'f1',scope,available:true}];
  browser.fixedStore.list=async()=>{entered.release();await resume.promise;return [{id:'f1',scope}];};
  const pending=browser.listFixedButtons();await entered.promise;
  browser.dropFixedContext();resume.release();const listed=await pending;
  assert.equal(browser.fixedContext,null,'GET/list must not restore the old scope after invalidation');
  assert.equal(browser.fixedButtons[0].available,false);
  assert.equal(listed[0].available,false,'the returned projection must use the current context');
});

test('state polling does not return an old observation when it is invalidated during the fixed-list read',{timeout:10000},async t=>{
  const entered=latch(),resume=latch();
  const controller={observation:{observationId:'old',stability:{status:'stable'}},verification:{status:'stable'},
    async listFixedButtons(){entered.release();await resume.promise;return [];},async close(){}};
  const service=await createService({controller,port:0});t.after(()=>service.close());
  const pending=fetch(`http://127.0.0.1:${service.server.address().port}/api/state`);
  await entered.promise;
  controller.observation=null;controller.verification={status:'idle'};resume.release();
  const response=await (await pending).json();
  assert.equal(response.observation,null,'all state fields must be selected after awaiting the list');
  assert.equal(response.verification.status,'idle');
});

test('snapshot rejects navigation after its PNG instead of publishing the old image with a new page context',async t=>{
  const {browser,base}=await browserFixture(t),page=browser.page;
  const screenshot=page.screenshot.bind(page);let captures=0;
  page.screenshot=async(...args)=>{
    const png=await screenshot(...args);captures++;
    await page.goto(base+'?gid=beta');
    return png;
  };
  await assert.rejects(browser.execute('snapshot'),error=>error.code==='CAPTURE_CONTEXT_CHANGED');
  assert.equal(captures,1,'a rejected capture must not trigger hidden verification or retries');
  assert.equal(browser.observation,null);assert.equal(browser.snapshot,null);
  assert(browser.fixedButtons.every(button=>!button.available));
});

test('a verification sample with scroll changing after its image is incomplete and has no fixed context',async t=>{
  const {browser}=await browserFixture(t),page=browser.page;
  const screenshot=page.screenshot.bind(page);
  page.screenshot=async(...args)=>{const png=await screenshot(...args);await page.evaluate(()=>window.scrollTo(0,100));return png;};
  const sample=await browser.collectVerificationSample(page);
  assert.equal(sample.complete,false,'a layout change cannot keep the earlier fixed scope valid');
  assert.equal(sample.fixedContext,null);
});

test('reading fixed context rejects navigation while its layout evaluation is in flight',async t=>{
  const {browser,base}=await browserFixture(t),page=browser.page;
  const evaluate=page.evaluate.bind(page);
  page.evaluate=async(...args)=>{
    const result=await evaluate(...args);page.evaluate=evaluate;
    await page.goto(base+'?gid=beta');
    return result;
  };
  await assert.rejects(browser.readFixedContext(page),error=>error.code==='FIXED_CONTEXT_CHANGED');
});

test('fixed click rechecks the page epoch after its final awaited context read, including same-URL reloads',async t=>{
  const {browser}=await browserFixture(t),page=browser.page;
  const bbox=await page.locator('button').boundingBox(),center={x:bbox.x+bbox.width/2,y:bbox.y+bbox.height/2};
  const scope=await browser.readFixedContext(page),png=await page.screenshot({type:'png',scale:'css'});
  const templatePNG=await sharp(png).extract({left:bbox.x,top:bbox.y,width:bbox.width,height:bbox.height}).png().toBuffer();
  await browser.fixedStore.add({name:'Girar',button:{label:'Giro fijo',kind:'button',source:'dom',bbox,center,clickPoint:center},scope,templatePNG,observationId:crypto.randomUUID()});
  const read=browser.readFixedContext.bind(browser);let reads=0;
  browser.readFixedContext=async(...args)=>{
    const context=await read(...args);
    if(++reads===2)await page.goto(page.url());
    return context;
  };
  await assert.rejects(browser.execute('click f1'),error=>error.code==='FIXED_CONTEXT_MISMATCH');
  assert.equal(await page.evaluate(()=>window.clicks||0),0,'the reloaded document must receive no click');
});
