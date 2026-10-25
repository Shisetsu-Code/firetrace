const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const sharp=require('sharp');

test('panel saves fixed controls, preserves them without dynamic verification and sends explicit fixed clicks',async(t)=>{
  const publicDir=path.resolve(__dirname,'../public'),commands=[],imageRequests=[];
  const png=await sharp({create:{width:1280,height:720,channels:3,background:'#18283a'}}).png().toBuffer();
  let serial=1,fixedButtons=[],commandGate=null;
  const target={id:'b1',label:'Spin',source:'pixi',kind:'button',actionable:true,bbox:{x:120,y:150,width:80,height:60},center:{x:160,y:180},clickPoint:{x:170,y:180},cropUrl:'/artifacts/demo/b1.png'};
  const raw=()=>({observationId:`ui-${serial++}`,timestamp:new Date().toISOString(),url:'https://game.example/ContainerLauncher?gid=one',viewport:{width:1280,height:720},buttons:[],fixedButtons:fixedButtons.filter(b=>b.available),stability:{status:'unverified',requiredSamples:3,completedSamples:0,intervalMs:2000},screenshotUrl:`/artifacts/demo/screen-${serial}.png`,annotatedUrl:`/artifacts/demo/annotated-${serial}.png`});
  let observation={...raw(),buttons:[target],stability:{status:'stable',requiredSamples:3,completedSamples:3,intervalMs:2000},annotatedUrl:'/artifacts/demo/annotated.png',contactSheetUrl:'/artifacts/demo/buttons.png'};
  const initialObservationId=observation.observationId;
  const respond=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,...value}));};
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.url==='/api/state')return respond(res,{observation,fixedButtons,busy:false,verification:{status:observation?.stability.status||'idle',requiredSamples:3,currentSample:observation?.stability.completedSamples||0,intervalMs:2000}});
      if(req.url==='/api/command') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks));commands.push(body.command);
        if(commandGate)await commandGate;
        const c=body.command,action=typeof c==='string'?c.split(' ')[0]:c.action;
        if(action==='pin')fixedButtons=[{...target,id:'f1',name:c.name,label:target.label,source:'fixed',detectedSource:'pixi',fixed:true,verification:'user-fixed',scope:{urlKey:'test',label:'game.example · one',viewport:{width:1280,height:720},deviceScaleFactor:1,scroll:{x:0,y:0}},cropUrl:'/artifacts/fixed/f1.png',available:true}];
        else if(action==='rename')fixedButtons[0]={...fixedButtons[0],name:c.name};
        else if(action==='unpin')fixedButtons=[];
        else if(action==='goto'){fixedButtons=fixedButtons.map(b=>({...b,available:false,unavailableReason:'El sitio no coincide.'}));observation=raw();}
        else observation=raw();
        return respond(res,{result:{action},...(['pin','pins','rename','unpin'].includes(action)?{}:{observation}),fixedButtons});
      }
      if(req.url.startsWith('/artifacts/')){imageRequests.push({url:req.url,authorization:req.headers.authorization});res.writeHead(200,{'content-type':'image/png'});return res.end(png);}
      const name=req.url==='/'?'index.html':req.url.slice(1);
      if(!['index.html','app.js','styles.css'].includes(name)){res.writeHead(404);return res.end();}
      res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
      res.end(await fs.readFile(path.join(publicDir,name)));
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const context=await browser.newContext({viewport:{width:1400,height:1100}});
  await context.addInitScript(()=>sessionStorage.setItem('button-browser.token','ui-fixed-token'));
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#button-results .button-card').waitFor();
  assert.equal(await page.locator('#export-fixed-buttons').count(),1,'the fixed list has its own export action');
  assert.equal(await page.locator('#export-fixed-buttons').isDisabled(),true);
  const name=page.getByLabel('Nombre fijo para b1');
  assert.equal(await name.count(),1,'verified controls offer an editable saved name');
  await name.fill('Giro principal');
  await page.getByRole('button',{name:'Guardar b1 como fijo'}).click();
  await page.waitForFunction(()=>document.querySelector('#fixed-button-count')?.textContent==='1');
  assert.deepEqual(commands[0],{action:'pin',id:'b1',name:'Giro principal',observationId:initialObservationId});
  assert.equal(await page.locator('#button-count').textContent(),'1','pinning must not discard the verified dynamic result');
  const exportFixed=async()=>{
    const pending=page.waitForEvent('download');
    await page.getByRole('button',{name:'Exportar lista'}).click();
    const downloaded=await pending;
    assert.equal(downloaded.suggestedFilename(),'button-browser-fixed-buttons.json');
    return JSON.parse(await fs.readFile(await downloaded.path(),'utf8'));
  };
  assert.deepEqual(observation.fixedButtons,[],'the historical observation deliberately has no newly pinned entries');
  assert.deepEqual(await exportFixed(),{fixedButtons},'export uses the current catalog independently of its historical observation');
  await page.getByLabel('Nombre de f1').fill('Giro guardado');
  await page.getByRole('button',{name:'Renombrar f1'}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Nombre de f1"]')?.value==='Giro guardado'&&!document.querySelector('#send-command').disabled);
  let releaseCommand;commandGate=new Promise(resolve=>{releaseCommand=resolve;});
  await page.locator('#command-input').fill('snapshot');await page.locator('#command-form').evaluate(form=>form.requestSubmit());
  assert.equal(await page.locator('#export-fixed-buttons').isDisabled(),true,'export is unavailable while a browser command is running');
  releaseCommand();commandGate=null;
  await page.waitForFunction(()=>document.querySelector('#verification-strip').dataset.status==='unverified'&&!document.querySelector('#send-command').disabled);
  assert.equal(await page.locator('#button-results .button-card').count(),0);
  assert.equal(await page.locator('#fixed-button-results .fixed-button-card').count(),1);
  assert.equal(await page.locator('.bounding-box.source-fixed[data-button-id="f1"]').count(),1);
  assert.match(await page.locator('.bounding-box-label.source-fixed').textContent(),/Fijo.*f1.*x 170.*y 180/);
  await page.locator('#open-annotated[href]').waitFor();
  assert.equal(await page.locator('#open-annotated').getAttribute('aria-disabled'),null,'a raw capture with published fixed annotations remains downloadable');
  await page.getByRole('button',{name:'Usar f1: Giro guardado'}).click();
  await page.waitForFunction(()=>!document.querySelector('#send-command').disabled);
  assert.deepEqual(commands.find(c=>c?.action==='click'),{action:'click',id:'f1'},'fixed clicks do not attach a dynamic observationId');
  assert.equal(commands.some(c=>c?.action==='verify'||c==='verify'),false,'saving and using a fixed control never requests another verification');
  await page.reload();
  await page.locator('#fixed-button-results .fixed-button-card').waitFor();
  assert.equal(await page.getByLabel('Nombre de f1').inputValue(),'Giro guardado');
  await page.locator('.bounding-box.source-fixed').waitFor();
  if(process.env.BUTTON_BROWSER_UI_SCREENSHOTS){
    await fs.mkdir(process.env.BUTTON_BROWSER_UI_SCREENSHOTS,{recursive:true});
    await page.screenshot({path:path.join(process.env.BUTTON_BROWSER_UI_SCREENSHOTS,'fixed-ui-desktop.png'),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),true,'the saved controls remain usable without horizontal overflow on mobile');
  if(process.env.BUTTON_BROWSER_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.BUTTON_BROWSER_UI_SCREENSHOTS,'fixed-ui-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1400,height:1100});
  await page.locator('#command-input').fill('click f1');await page.locator('#command-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>!document.querySelector('#send-command').disabled);
  assert.deepEqual(commands.at(-1),{action:'click',id:'f1'});
  await page.locator('#command-input').fill('goto https://different.example/');await page.locator('#command-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#fixed-button-results .fixed-button-unavailable')&&!document.querySelector('#send-command').disabled);
  assert.equal(await page.getByRole('button',{name:'Usar f1: Giro guardado'}).isDisabled(),true);
  assert.equal(await page.locator('.bounding-box.source-fixed').count(),0);
  assert.equal(await page.locator('#fixed-button-results .fixed-button-card').count(),1,'context mismatch preserves the saved entry');
  observation=null;await page.reload();
  await page.locator('#fixed-button-results .fixed-button-card').waitFor();
  assert.equal(await page.locator('#export-fixed-buttons').isDisabled(),false,'an inactive catalog can be exported even without an observation');
  assert.deepEqual(await exportFixed(),{fixedButtons});
  await page.getByRole('button',{name:'Quitar f1 de la lista'}).click();
  await page.waitForFunction(()=>document.querySelector('#fixed-button-count').textContent==='0');
  assert.equal(await page.locator('#fixed-buttons-empty').isVisible(),true);
  assert.equal(await page.locator('#export-fixed-buttons').isDisabled(),true);
  assert(imageRequests.some(r=>r.url==='/artifacts/fixed/f1.png'&&r.authorization==='Bearer ui-fixed-token'));
  assert.deepEqual(errors,[]);
});
