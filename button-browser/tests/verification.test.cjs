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

test('explicit exclusions verify selected mixed controls while excluded occluders still hide controls beneath them',async(t)=>{
  const {browser,directory}=await fixture(t);
  const pixiPath=path.resolve(path.dirname(require.resolve('pixi.js')),'../browser/pixi.js');
  await browser.page.addScriptTag({path:pixiPath});
  await browser.page.evaluate(()=>{
    const P=window.PIXI,renderer=new P.Renderer({width:140,height:50,backgroundAlpha:0,antialias:false});
    renderer.view.style.cssText='position:absolute;left:240px;top:40px;width:140px;height:50px';
    document.body.appendChild(renderer.view);
    const root=new P.Container();
    const button=(label,color)=>{
      const node=new P.Graphics().beginFill(color).drawRect(0,0,140,50).endFill();
      node.name=label;node.interactive=true;node.buttonMode=true;node.on('pointertap',()=>{});
      root.addChild(node);return node;
    };
    button('Occluded',0x336699);
    const animated=button('BET_DEC',0x112233);
    window.paintAnimatedControl=color=>{
      animated.clear().beginFill(color).drawRect(0,0,140,50).endFill();
      renderer.render(root);
    };
    window.paintAnimatedControl(0x112233);window.PIXI=undefined;
  });
  let reads=0;const collect=browser.collectVerificationSample.bind(browser);
  browser.collectVerificationSample=async(...args)=>{
    await browser.page.evaluate(color=>window.paintAnimatedControl(color),reads%3===1?0xeeddcc:0x112233);
    reads++;return collect(...args);
  };
  const global=await browser.execute({action:'verify'});
  assert.equal(reads,3);
  assert.equal(global.observation.stability.status,'unstable');
  assert.deepEqual(global.observation.buttons,[]);
  assert.equal(global.observation.stability.scope,undefined,'default verification still covers every detected control');
  assert.deepEqual(global.observation.stability.samples.map(sample=>sample.candidateCount),[2,2,2]);
  assert(global.observation.stability.reasons.some(reason=>reason.includes('BET_DEC')&&reason.includes('apariencia')));

  const scoped=await browser.execute({action:'verify',excludeLabels:['BET_DEC']});
  const observation=scoped.observation;
  assert.equal(reads,6,'selection still requires three full detector readings');
  assert.equal(observation.stability.status,'stable');
  assert.equal(observation.stability.requiredSamples,3);
  assert.equal(observation.stability.geometryTolerancePx,1);
  assert.equal(observation.stability.maxCropDifference,0.015);
  assert.deepEqual(observation.stability.scope,{excludeLabels:['BET_DEC'],excludedCounts:[1,1,1]});
  assert.deepEqual(observation.stability.samples.map(sample=>sample.candidateCount),[1,1,1]);
  assert.deepEqual(observation.detection,{dom:1,engine:0,vision:0,visionRequested:false});
  assert.deepEqual(observation.buttons.map(button=>button.label),['Verifiable']);
  assert.deepEqual(browser.snapshot.candidates.map(button=>button.label),['Verifiable']);
  const persisted=JSON.parse(await fs.readFile(path.join(directory,observation.observationId,'buttons.json'),'utf8'));
  assert.deepEqual(persisted.buttons.map(button=>button.label),['Verifiable']);
  assert.deepEqual(persisted.stability.scope,{excludeLabels:['BET_DEC'],excludedCounts:[1,1,1]});
  assert.equal((await fs.readdir(path.join(directory,observation.observationId))).filter(name=>/^b\d+\.png$/.test(name)).length,1);
  for (const excludeLabels of [['bet_dec'],['BET_.*']]) {
    const sample=await collect(browser.page,{excludeLabels});
    assert.deepEqual(sample.candidates.map(button=>button.label).sort(),['BET_DEC','Verifiable']);
    assert.equal(sample.excludedCount,0,'labels are case-sensitive literals');
    assert.deepEqual(sample.detection,{dom:1,engine:1,vision:0,visionRequested:false});
  }
});
