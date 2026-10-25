const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {BrowserController}=require('../src/browser.cjs');

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bb-publication-'));
  const browser=new BrowserController({artifactDir:directory});
  t.after(async()=>{await browser.close();await fs.rm(directory,{recursive:true,force:true});});
  await browser.start();
  await browser.page.setContent('<button>Verified target</button><iframe srcdoc="<p>Initial frame</p>"></iframe>');
  const sample=await browser.collectVerificationSample(browser.page);
  // Exercise the publication stage with a previously approved sample. Scheduling
  // and the three-reading verdict are covered in verification.test.cjs.
  const options={started:Date.now(),verified:true,stability:{status:'stable',completedSamples:3,requiredSamples:3,intervalMs:2000,reasons:[]}};
  return {browser,directory,sample,options};
}

test('navigation during publication withholds stale positions and removes their artifacts',async(t)=>{
  const {browser,directory,sample,options}=await fixture(t);
  const page=browser.page,originalTitle=page.title.bind(page);
  page.title=async()=>{page.title=originalTitle;await page.goto('about:blank');return originalTitle();};
  const observation=await browser.publish(sample,options);
  assert.equal(observation.stability.status,'unstable');
  assert.deepEqual(observation.buttons,[]);assert.equal(browser.snapshot,null);
  assert.equal(await page.locator('[data-button-browser-coordinate-overlay]').count(),0);
  const names=await fs.readdir(directory);
  assert.equal(names.length,1,'only the coordinate-free result may be retained');
  assert(!(await fs.readdir(path.join(directory,names[0]))).some(n=>/^b\d+\.png$/.test(n)));
});

test('a subframe navigation invalidates both the published state and the actual-page labels',async(t)=>{
  const {browser,sample,options}=await fixture(t);
  await browser.publish(sample,options);
  browser.verification={status:'stable',currentSample:3,requiredSamples:3,intervalMs:2000};
  assert.equal(await browser.page.locator('[data-button-browser-coordinate-overlay]').count(),1);
  await browser.page.locator('iframe').evaluate(el=>el.srcdoc='<p>Changed frame</p>');
  await browser.page.waitForFunction(()=>document.querySelector('iframe').contentDocument?.body?.textContent==='Changed frame');
  await browser.page.waitForFunction(()=>!document.querySelector('[data-button-browser-coordinate-overlay]'));
  assert.equal(browser.observation,null);assert.equal(browser.snapshot,null);
  assert.notEqual(browser.verification.status,'stable');
});
