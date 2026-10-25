const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {BrowserController}=require('../src/browser.cjs');

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bb-verification-'));
  const browser=new BrowserController({artifactDir:directory});
  t.after(async()=>{await browser.close();await fs.rm(directory,{recursive:true,force:true});});
  await browser.start();
  await browser.page.setContent('<style>body{margin:0}</style><button style="position:absolute;left:40px;top:40px;width:140px;height:50px" onclick="window.clicks=(window.clicks||0)+1">Verifiable</button>');
  return {browser,directory};
}

test('only an explicit verification publishes positions, after three real readings two seconds apart',async(t)=>{
  const {browser}=await fixture(t);
  const raw=await browser.execute('wait 0');
  assert.equal(raw.observation.buttons.length,0);
  assert.equal(raw.observation.stability.status,'unverified');
  await assert.rejects(browser.execute('click b1'),e=>e.code==='STALE_OBSERVATION');
  let reads=0;const collect=browser.collectVerificationSample.bind(browser);
  browser.collectVerificationSample=async(...args)=>{reads++;return collect(...args);};
  const start=Date.now(),pending=browser.execute('verify');
  await new Promise(r=>setTimeout(r,350));
  assert.equal(browser.observation,null,'intermediate coordinates must not be exposed');
  assert.equal(browser.verification.status,'checking');
  const response=await pending,obs=response.observation;
  assert.equal(reads,3);assert(Date.now()-start>=4000);
  assert.equal(obs.stability.status,'stable');assert.equal(obs.stability.completedSamples,3);
  assert.equal(obs.buttons.length,1);
  const times=obs.stability.samples.map(s=>Date.parse(s.timestamp));
  assert(times[1]-times[0]>=2000);assert(times[2]-times[1]>=2000);
  const clicked=await browser.execute({action:'click',id:obs.buttons[0].id,observationId:obs.observationId});
  assert.equal(reads,3,'click must not initiate another detector run');
  assert.equal(await browser.page.evaluate(()=>window.clicks),1);
  assert.equal(clicked.observation.buttons.length,0);
  assert.equal(clicked.observation.stability.status,'unverified');
  const snapshot=await browser.execute('snapshot');
  assert.equal(snapshot.observation.buttons.length,0);assert.equal(reads,3);
});

test('a changing middle reading withholds every coordinate even if the third returns to the first',async(t)=>{
  const {browser,directory}=await fixture(t);
  let reads=0;const collect=browser.collectVerificationSample.bind(browser);
  browser.collectVerificationSample=async(...args)=>{
    const sample=await collect(...args);reads++;
    if(reads===1)await browser.page.locator('button').evaluate(el=>el.style.left='240px');
    if(reads===2)await browser.page.locator('button').evaluate(el=>el.style.left='40px');
    return sample;
  };
  const {observation}=await browser.execute({action:'verify'});
  assert.equal(reads,3);assert.equal(observation.stability.status,'unstable');
  assert.deepEqual(observation.buttons,[]);assert.equal(browser.snapshot,null);
  assert(observation.stability.reasons.length>0);
  const names=await fs.readdir(path.join(directory,observation.observationId));
  assert(!names.some(name=>/^b\d+\.png$/.test(name)),'no crops from intermediate candidates');
  const json=JSON.parse(await fs.readFile(path.join(directory,observation.observationId,'buttons.json'),'utf8'));
  assert.deepEqual(json.buttons,[]);
  assert(!JSON.stringify(json.stability).includes('"bbox"'));
  await assert.rejects(browser.execute('click b1'),e=>e.code==='STALE_OBSERVATION');
});

test('observe and detect are explicit aliases, while navigation never requests vision or verification',async(t)=>{
  const {browser}=await fixture(t);
  let verifications=0;const verify=browser.verify.bind(browser);
  browser.verify=async(...args)=>{verifications++;return verify(...args);};
  await browser.execute('snapshot');assert.equal(verifications,0);
  const output=await browser.execute('detect');
  assert.equal(verifications,1);assert.equal(output.observation.stability.status,'stable');
  await browser.execute('resize 800 600');
  assert.equal(verifications,1);assert.equal(browser.observation.stability.status,'unverified');
});
