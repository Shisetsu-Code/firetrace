'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const {installProbe}=require('./dom-probe.cjs');
const {detectDOMButtons,guardDOMTarget,mergeCandidates}=require('./detector.cjs');
const {saveObservation,cropDifference}=require('./artifacts.cjs');
const {parseCommand,CommandError,HELP}=require('./commands.cjs');
const {STABILITY_RULES,compareSamples}=require('./stability.cjs');
const {showCoordinateOverlay,clearCoordinateOverlay}=require('./overlay.cjs');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function changed(a,b,tolerance=4){return ['x','y','width','height'].some(k=>Math.abs(a[k]-b[k])>tolerance);}
function safeURL(url) {
  try{const u=new URL(url);for(const key of u.searchParams.keys())if(/token|session|password|secret|auth|ticket/i.test(key))u.searchParams.set(key,'[redacted]');return u.href;}catch{return url;}
}
class BrowserController {
  constructor(options={}) {
    this.options=options;
    this.artifactDir=path.resolve(options.artifactDir||process.env.BUTTON_BROWSER_DATA||'data/observations');
    this.viewport=options.viewport||{width:1280,height:720};
    this.observationTTL=options.observationTTL??120000;
    this.vision=options.vision||null;
    this.observation=null;this.snapshot=null;this.page=null;this.epoch=0;this.notices=[];this.directories=[];
    this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
  }
  async start() {
    if(this.browser)return;
    await fs.mkdir(this.artifactDir,{recursive:true});
    this.browser=await chromium.launch({headless:this.options.headless!==false,channel:'chromium',
      executablePath:this.options.executablePath||process.env.BROWSER_EXECUTABLE||undefined,
      args:['--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
    this.context=await this.browser.newContext({viewport:this.viewport,deviceScaleFactor:1,acceptDownloads:false});
    await this.context.addInitScript(installProbe);
    this.context.on('page',page=>this.adoptPage(page));
    await this.context.newPage();
  }
  adoptPage(page) {
    const previous=this.page;
    if(previous&&previous!==page&&!previous.isClosed())void clearCoordinateOverlay(previous).catch(()=>{});
    this.page=page;this.epoch++;this.snapshot=null;this.observation=null;
    if(this.verification.status!=='checking')this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(30000);
    page.on('framenavigated',()=>{
      void clearCoordinateOverlay(page).catch(()=>{});
      if(this.page!==page)return;
      this.epoch++;this.snapshot=null;this.observation=null;
      if(this.verification.status!=='checking')this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    });
    page.on('dialog',async dialog=>{this.notices.push(`Diálogo ${dialog.type()} descartado: ${dialog.message().slice(0,120)}`);await dialog.dismiss().catch(()=>{});});
    page.on('close',()=>{if(this.page===page){this.page=this.context?.pages().find(p=>!p.isClosed())||null;this.epoch++;void this.invalidate();}});
  }
  async getPage(){if(!this.browser)await this.start();if(!this.page||this.page.isClosed())await this.context.newPage();return this.page;}
  async invalidate() {
    this.snapshot=null;this.observation=null;
    if(this.verification.status!=='checking')this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    if(this.page&&!this.page.isClosed())await clearCoordinateOverlay(this.page).catch(()=>{});
  }
  isSampleCurrent(sample) {
    const page=sample.page,viewport=page?.viewportSize();
    return page===this.page&&!page.isClosed()&&sample.epoch===this.epoch&&sample.url===page.url()&&
      sample.viewport.width===viewport?.width&&sample.viewport.height===viewport?.height;
  }
  async collectVerificationSample(page,options={}) {
    const viewport=page.viewportSize(),epoch=this.epoch,url=page.url(),warnings=[];
    let complete=true,phaseStarted=Date.now();
    const timingsMs={};
    await clearCoordinateOverlay(page);
    const dom=await detectDOMButtons(page,options);warnings.push(...dom.warnings);
    timingsMs.dom=Date.now()-phaseStarted;phaseStarted=Date.now();
    if(dom.warnings.length)complete=false;
    let engine={buttons:[],warnings:[],canvasCount:0};
    try {
      engine=await require('./engine-detector.cjs').detectEngineButtons(page,options);warnings.push(...engine.warnings);
      if(engine.warnings.some(message=>/cambió|tiempo|completar|límite de recorrido|límite de iframes|límite de canvas/.test(message)))complete=false;
    }catch(e){complete=false;warnings.push(`Detector de canvas: ${e.message.split('\n')[0].slice(0,180)}`);}
    timingsMs.engine=Date.now()-phaseStarted;phaseStarted=Date.now();
    const png=await page.screenshot({type:'png',scale:'css',timeout:10000});
    timingsMs.capture=Date.now()-phaseStarted;phaseStarted=Date.now();
    const capturedAt=Date.now(),timestamp=new Date(capturedAt).toISOString();
    let visual={buttons:[],warnings:[]};
    if(options.vision) {
      try {visual=await require('./vision.cjs').detectVisionButtons({png,viewport,...this.vision});warnings.push(...visual.warnings);}
      catch(e){complete=false;warnings.push(`Visión: ${e.message.slice(0,200)}`);}
    }
    timingsMs.vision=Date.now()-phaseStarted;
    if(this.epoch!==epoch||this.page!==page||page.url()!==url)complete=false;
    const candidates=mergeCandidates([dom.buttons,engine.buttons.map(button=>({...button,clickPoint:button.clickPoint||button.center})),visual.buttons],viewport);
    return {page,png,candidates,viewport,epoch,url,timestamp,capturedAt,complete,warnings,timingsMs,canvasCount:engine.canvasCount||0,
      detection:{dom:dom.buttons.length,engine:engine.buttons.length,vision:visual.buttons.length,visionRequested:!!options.vision}};
  }
  async publish(sample,{stability,started,warnings=[],verified=false}) {
    const {page,png,viewport}=sample,candidates=verified?sample.candidates:[];
    const observationId=crypto.randomUUID();
    const directory=path.join(this.artifactDir,observationId),staging=path.join(this.artifactDir,`.pending-${observationId}`);
    const discardStale=async()=>{
      await fs.rm(staging,{recursive:true,force:true});await fs.rm(directory,{recursive:true,force:true});
      await clearCoordinateOverlay(page).catch(()=>{});
      const rejected={...stability,status:'unstable',reasons:[...new Set([...(stability.reasons||[]),'La página cambió antes de publicar las posiciones.'])]};
      return this.publish(await this.rawSample(await this.getPage()),{stability:rejected,started,warnings,verified:false});
    };
    if(verified&&!this.isSampleCurrent(sample))return discardStale();
    let observation;
    try {
      observation={observationId,timestamp:sample.timestamp,url:safeURL(sample.url),title:await page.title(),
        viewport:{...viewport,deviceScaleFactor:await page.evaluate(()=>devicePixelRatio)},coordinateSpace:'viewport-css-px',
        warnings:[...new Set(warnings)],timingMs:Date.now()-started,canvasCount:sample.canvasCount||0,stability,
        detection:verified?sample.detection:{dom:0,engine:0,vision:0,visionRequested:false}};
      await saveObservation({directory:staging,png,observation,candidates});
      if(verified) {
        if(!this.isSampleCurrent(sample))return discardStale();
        try{await showCoordinateOverlay(page,observation.buttons,viewport);}catch{observation.warnings.push('No se pudo colocar el overlay en la página; las coordenadas siguen visibles en el panel y PNG.');}
      }
      observation.timingMs=Date.now()-started;
      await fs.writeFile(path.join(staging,'buttons.json'),JSON.stringify(observation,null,2));
      if(verified&&!this.isSampleCurrent(sample))return discardStale();
      await fs.rename(staging,directory);
      if(verified&&!this.isSampleCurrent(sample))return discardStale();
    }catch(e){
      await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
      if(verified&&!this.isSampleCurrent(sample))return discardStale();
      await clearCoordinateOverlay(page).catch(()=>{});throw e;
    }
    while(this.directories.length>=12)await fs.rm(this.directories.shift(),{recursive:true,force:true}).catch(()=>{});
    if(verified&&!this.isSampleCurrent(sample))return discardStale();
    // Commit only after the complete output is available and page identity is
    // still current. All coordinates come from the third sample, never averages.
    this.snapshot=verified?{observationId,createdAt:sample.capturedAt,page,url:sample.url,epoch:sample.epoch,viewport,png,candidates}:null;
    this.observation=observation;this.directories.push(directory);
    return observation;
  }
  async rawSample(page) {
    await clearCoordinateOverlay(page);
    const png=await page.screenshot({type:'png',scale:'css',timeout:10000}),capturedAt=Date.now();
    return {page,png,candidates:[],viewport:page.viewportSize(),epoch:this.epoch,url:page.url(),timestamp:new Date(capturedAt).toISOString(),capturedAt};
  }
  async capture() {
    const started=Date.now(),page=await this.getPage();await this.invalidate();
    this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    return this.publish(await this.rawSample(page),{started,warnings:this.notices.splice(0),stability:{status:'unverified',...STABILITY_RULES,completedSamples:0,reasons:[],samples:[]}});
  }
  async observe(options={}) {return this.verify(options);}
  async verify(options={}) {
    if(this.verification.status==='checking')throw new CommandError('VERIFICATION_BUSY','Ya hay una verificación en curso.');
    const started=Date.now(),page=await this.getPage();await this.invalidate();
    if(options.vision&&(!this.vision?.baseURL||!this.vision?.model))throw new CommandError('VISION_NOT_CONFIGURED','Configurá VISION_BASE_URL y VISION_MODEL antes de verify vision.');
    const samples=[],warnings=this.notices.splice(0);
    this.verification={status:'checking',currentSample:0,requiredSamples:3,intervalMs:2000};
    try {
      for(let index=0;index<STABILITY_RULES.requiredSamples;index++) {
        if(index>0)await delay(STABILITY_RULES.intervalMs);
        this.verification.currentSample=index+1;
        try {
          const sample=await this.collectVerificationSample(page,options);samples.push(sample);warnings.push(...sample.warnings);
        }catch(e){samples.push({complete:false,candidates:[],timestamp:new Date().toISOString()});warnings.push(`Lectura ${index+1}: ${e.message.split('\n')[0].slice(0,180)}`);}
      }
      const verdict=await compareSamples(samples);
      let last=samples[samples.length-1];
      if(this.page!==page||page.isClosed()||last.epoch!==this.epoch||last.url!==page.url()) {
        verdict.stable=false;verdict.reasons.push('La página cambió durante la verificación.');
      }
      const stability={status:verdict.stable?'stable':'unstable',...STABILITY_RULES,completedSamples:samples.length,
        reasons:[...new Set(verdict.reasons)],maxGeometryDeltaPx:verdict.maxGeometryDeltaPx,maxAppearanceDifference:verdict.maxAppearanceDifference,
        samples:samples.map((sample,index)=>({index:index+1,timestamp:sample.timestamp,candidateCount:sample.candidates?.length||0,...(sample.timingsMs?{timingsMs:sample.timingsMs}:{})}))};
      if(!last.png||this.page!==page||page.isClosed()||last.epoch!==this.epoch||last.url!==page.url())last=await this.rawSample(await this.getPage());
      const observation=await this.publish(last,{stability,started,warnings,verified:verdict.stable});
      this.verification={status:observation.stability.status,currentSample:3,requiredSamples:3,intervalMs:2000};
      return observation;
    }catch(e){await this.invalidate();this.verification={status:'unstable',currentSample:samples.length,requiredSamples:3,intervalMs:2000};throw e;}
  }
  assertPoint(x,y,viewport) {
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=viewport.width||y>=viewport.height)throw new CommandError('OUT_OF_VIEWPORT',`Punto fuera del viewport ${viewport.width}×${viewport.height}.`);
  }
  async clickTarget(command,page) {
    const snapshot=this.snapshot,observation=this.observation;
    if(!snapshot||!observation||observation.stability?.status!=='stable'||snapshot.page!==page||snapshot.url!==page.url()||snapshot.epoch!==this.epoch||
       (command.observationId&&command.observationId!==snapshot.observationId)||Date.now()-snapshot.createdAt>this.observationTTL) {
      throw new CommandError('STALE_OBSERVATION','No hay posiciones verificadas vigentes. La IA debe solicitar verify antes del clic.');
    }
    const index=observation.buttons.findIndex(b=>b.id===command.id);if(index<0)throw new CommandError('UNKNOWN_TARGET','Ese botón no está en la observación actual.');
    const button=observation.buttons[index],candidate=snapshot.candidates[index];
    const point=button.clickPoint||button.center;
    if(!button.actionable)throw new CommandError('DISABLED_TARGET','El control está deshabilitado.');
    if(candidate._target?.type==='dom') {
      let current;
      try{current=await guardDOMTarget(candidate._target.frame,candidate._target.key,snapshot.viewport,point);}catch{current=null;}
      if(!current||current.disabled||changed(current.bbox,button.bbox,1)||current.label!==button.label) {
        await this.invalidate();throw new CommandError('TARGET_CHANGED','El punto verificado dejó de alcanzar el botón. Solicitá verify; no se recalcula la posición al hacer clic.');
      }
    } else {
      await clearCoordinateOverlay(page);
      const current=await page.screenshot({type:'png',scale:'css'});
      const difference=await cropDifference(snapshot.png,current,button.bbox,snapshot.viewport);
      if(difference>STABILITY_RULES.maxCropDifference){await this.invalidate();throw new CommandError('TARGET_CHANGED','El recorte cambió desde la verificación. Solicitá verify antes del clic.');}
    }
    this.assertPoint(point.x,point.y,page.viewportSize());
    // Consume before input; even a downstream timeout cannot make this ID click repeat.
    await this.invalidate();
    await page.mouse.click(point.x,point.y);
    return {clicked:command.id,x:point.x,y:point.y,source:button.source};
  }
  async execute(input) {
    const command=parseCommand(input),action=command.action,page=await this.getPage();
    let result={action},needsObservation=true;
    switch(action) {
      case 'help': return {result:{commands:HELP,coordinateSpace:'viewport-css-px'}};
      case 'verify': {const observation=await this.verify(command);return {result:{action,status:observation.stability.status,positionsReady:observation.stability.status==='stable'&&observation.buttons.length>0},observation};}
      case 'snapshot': return {result:{action},observation:await this.capture()};
      case 'export': return {result:{observation:this.observation,...(this.observation?{jsonUrl:this.observation.jsonUrl,contactSheetUrl:this.observation.contactSheetUrl}:{})}};
      case 'tabs': return {result:{tabs:await Promise.all(this.context.pages().map(async(p,index)=>({index,url:safeURL(p.url()),title:await p.title().catch(()=>''),active:p===this.page})))}};
      case 'goto': await this.invalidate();await page.goto(command.url,{waitUntil:'domcontentloaded'});break;
      case 'back': await this.invalidate();await page.goBack({waitUntil:'domcontentloaded'});break;
      case 'forward': await this.invalidate();await page.goForward({waitUntil:'domcontentloaded'});break;
      case 'reload': await this.invalidate();await page.reload({waitUntil:'domcontentloaded'});break;
      case 'click':
        if(command.id)Object.assign(result,await this.clickTarget(command,page));
        else {this.assertPoint(command.x,command.y,page.viewportSize());await this.invalidate();await page.mouse.click(command.x,command.y);Object.assign(result,{x:command.x,y:command.y});}
        break;
      case 'move': this.assertPoint(command.x,command.y,page.viewportSize());await this.invalidate();await page.mouse.move(command.x,command.y);break;
      case 'scroll': await this.invalidate();await page.mouse.wheel(command.dx,command.dy);break;
      case 'type': await this.invalidate();await page.keyboard.insertText(command.text);break;
      case 'press': await this.invalidate();await page.keyboard.press(command.key);break;
      case 'wait': await this.invalidate();await delay(command.ms);break;
      case 'resize': await this.invalidate();await page.setViewportSize({width:command.width,height:command.height});this.viewport={width:command.width,height:command.height};this.epoch++;break;
      case 'newtab': {await this.invalidate();const newPage=await this.context.newPage();if(command.url)await newPage.goto(command.url,{waitUntil:'domcontentloaded'});break;}
      case 'switch': {const next=this.context.pages()[command.index];if(!next)throw new CommandError('UNKNOWN_TAB','No existe esa pestaña.');await this.invalidate();this.page=next;this.epoch++;await next.bringToFront();break;}
      case 'close': await this.invalidate();await page.close();await this.getPage();break;
      default: needsObservation=false;
    }
    if(needsObservation) {
      await delay(action==='wait'?0:180);
      try{return {result,observation:await this.capture()};}
      catch(e){this.snapshot=null;this.observation=null;return {result:{...result,actionExecuted:true,observationError:e.message},observation:null};}
    }
    return {result};
  }
  async close(){const browser=this.browser;this.browser=null;this.snapshot=null;this.observation=null;await browser?.close();}
}
module.exports={BrowserController,safeURL};
