'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('sharp');
const {chromium}=require('playwright');
const {installProbe}=require('./dom-probe.cjs');
const {detectDOMButtons,guardDOMTarget,mergeCandidates}=require('./detector.cjs');
const {saveObservation,cropDifference,pixelBox}=require('./artifacts.cjs');
const {parseCommand,CommandError,HELP}=require('./commands.cjs');
const {STABILITY_RULES,compareSamples}=require('./stability.cjs');
const {showCoordinateOverlay,clearCoordinateOverlay}=require('./overlay.cjs');
const {FixedButtonStore,makeFixedContext,matchesFixedContext}=require('./fixed-buttons.cjs');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function changed(a,b,tolerance=4){return ['x','y','width','height'].some(k=>Math.abs(a[k]-b[k])>tolerance);}
function safeURL(url) {
  try{const u=new URL(url);for(const key of u.searchParams.keys())if(/token|session|password|secret|auth|ticket/i.test(key))u.searchParams.set(key,'[redacted]');return u.href;}catch{return url;}
}
class BrowserController {
  constructor(options={}) {
    this.options=options;
    this.artifactDir=path.resolve(options.artifactDir||process.env.BUTTON_BROWSER_DATA||'data/observations');
    this.fixedStore=new FixedButtonStore(options.fixedButtonDir||process.env.BUTTON_BROWSER_FIXED_DATA||path.join(this.artifactDir,'fixed-buttons'));
    this.fixedButtons=[];this.fixedContext=null;this.fixedRevision=0;
    this.viewport=options.viewport||{width:1280,height:720};
    this.observationTTL=options.observationTTL??120000;
    this.vision=options.vision||null;
    this.observation=null;this.snapshot=null;this.page=null;this.epoch=0;this.notices=[];this.directories=[];
    this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
  }
  async start() {
    if(this.browser)return;
    await this.refreshFixedButtons(null);
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
    this.page=page;this.epoch++;this.snapshot=null;this.observation=null;this.dropFixedContext();
    if(this.verification.status!=='checking')this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(30000);
    page.on('framenavigated',()=>{
      void clearCoordinateOverlay(page).catch(()=>{});
      if(this.page!==page)return;
      this.epoch++;this.snapshot=null;this.observation=null;this.dropFixedContext();
      if(this.verification.status!=='checking')this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    });
    page.on('dialog',async dialog=>{this.notices.push(`Diálogo ${dialog.type()} descartado: ${dialog.message().slice(0,120)}`);await dialog.dismiss().catch(()=>{});});
    page.on('close',()=>{if(this.page===page){this.page=this.context?.pages().find(p=>!p.isClosed())||null;this.epoch++;void this.invalidate();}});
  }
  async getPage(){if(!this.browser)await this.start();if(!this.page||this.page.isClosed())await this.context.newPage();return this.page;}
  async invalidate() {
    this.snapshot=null;this.observation=null;this.dropFixedContext();
    if(this.verification.status!=='checking')this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    if(this.page&&!this.page.isClosed())await clearCoordinateOverlay(this.page).catch(()=>{});
  }
  dropFixedContext() {
    this.fixedContext=null;this.fixedRevision++;
    this.fixedButtons=this.fixedButtons.map(button=>({...button,available:false,unavailableReason:'Falta una captura del contexto actual.'}));
  }
  async readFixedContext(page) {
    const identity={page,url:page.url(),epoch:this.epoch,viewport:page.viewportSize()};
    const layout=await page.evaluate(()=>({deviceScaleFactor:devicePixelRatio,scroll:{x:scrollX,y:scrollY}}));
    if(!this.isSampleCurrent(identity))throw new CommandError('FIXED_CONTEXT_CHANGED','La página cambió mientras se leía el contexto de los botones fijos.');
    return makeFixedContext({url:identity.url,viewport:identity.viewport,...layout});
  }
  projectFixedButtons(entries,context=this.fixedContext) {
    return entries.map(button=>{
      const available=matchesFixedContext(button.scope,context);
      return {...button,available,...(!available?{unavailableReason:'La página, el tamaño o el desplazamiento no coinciden con los guardados.'}:{})};
    });
  }
  async refreshFixedButtons(context=this.fixedContext) {
    this.fixedContext=context;const revision=++this.fixedRevision;
    const entries=await this.fixedStore.list();
    if(revision!==this.fixedRevision)return this.projectFixedButtons(entries);
    this.fixedButtons=this.projectFixedButtons(entries);
    return this.fixedButtons;
  }
  async listFixedButtons(){const entries=await this.fixedStore.list();return this.projectFixedButtons(entries);}
  async syncFixedContext() {
    return this.refreshFixedButtons(this.page&&!this.page.isClosed()?await this.readFixedContext(this.page):null);
  }
  async renderFixedCoordinates() {
    const page=this.page;if(!page||page.isClosed())return;
    await this.syncFixedContext();
    const dynamic=this.snapshot&&this.observation?.stability?.status==='stable'&&this.isSampleCurrent(this.snapshot)&&Date.now()-this.snapshot.createdAt<=this.observationTTL?this.observation.buttons:[];
    await showCoordinateOverlay(page,[...this.fixedButtons.filter(button=>button.available),...dynamic],page.viewportSize());
  }
  async updateFixedPresentation() {
    try{await this.renderFixedCoordinates();return {};}
    catch {
      this.dropFixedContext();
      if(this.page&&!this.page.isClosed())await clearCoordinateOverlay(this.page).catch(()=>{});
      return {warning:'La lista se guardó, pero no se pudo actualizar su marcación en la página. Pedí snapshot para recuperar la vista; no repitas el guardado.'};
    }
  }
  isSampleCurrent(sample) {
    const page=sample.page,viewport=page?.viewportSize();
    return page===this.page&&!page.isClosed()&&sample.epoch===this.epoch&&sample.url===page.url()&&
      sample.viewport.width===viewport?.width&&sample.viewport.height===viewport?.height;
  }
  async collectVerificationSample(page,options={}) {
    const viewport=page.viewportSize(),epoch=this.epoch,url=page.url(),warnings=[];
    let fixedContext=await this.readFixedContext(page);
    const hasScope=Object.hasOwn(options,'excludeLabels'),{excludeLabels,...detectionOptions}=options;
    let complete=true,phaseStarted=Date.now();
    const timingsMs={};
    await clearCoordinateOverlay(page);
    const dom=await detectDOMButtons(page,detectionOptions);warnings.push(...dom.warnings);
    timingsMs.dom=Date.now()-phaseStarted;phaseStarted=Date.now();
    if(dom.warnings.length)complete=false;
    let engine={buttons:[],warnings:[],canvasCount:0};
    try {
      engine=await require('./engine-detector.cjs').detectEngineButtons(page,detectionOptions);warnings.push(...engine.warnings);
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
    try {
      if(!matchesFixedContext(fixedContext,await this.readFixedContext(page)))throw new Error('context changed');
    }catch {
      complete=false;fixedContext=null;warnings.push('Cambió el contexto de la página durante la lectura.');
    }
    const merged=mergeCandidates([dom.buttons,engine.buttons.map(button=>({...button,clickPoint:button.clickPoint||button.center})),visual.buttons],viewport);
    // Keep all scene/DOM occlusion checks intact; selection happens only after
    // the complete detectors and merge have finished.
    const excluded=hasScope?new Set(excludeLabels):null,candidates=excluded?merged.filter(button=>!excluded.has(button.label)):merged;
    const detection=hasScope?{
      dom:candidates.filter(button=>button.source==='dom').length,
      engine:candidates.filter(button=>button.source!=='dom'&&button.source!=='vision').length,
      vision:candidates.filter(button=>button.source==='vision').length,visionRequested:!!options.vision
    }:{dom:dom.buttons.length,engine:engine.buttons.length,vision:visual.buttons.length,visionRequested:!!options.vision};
    return {page,png,candidates,viewport,epoch,url,timestamp,capturedAt,complete,warnings,timingsMs,fixedContext,canvasCount:engine.canvasCount||0,
      excludedCount:merged.length-candidates.length,detection};
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
    let observation,hasFixed=false;
    try {
      const fixedButtons=(await this.refreshFixedButtons(sample.fixedContext||null)).filter(button=>button.available);
      hasFixed=fixedButtons.length>0;
      if(hasFixed&&!this.isSampleCurrent(sample))return discardStale();
      observation={observationId,timestamp:sample.timestamp,url:safeURL(sample.url),title:await page.title(),
        viewport:{...viewport,deviceScaleFactor:await page.evaluate(()=>devicePixelRatio)},coordinateSpace:'viewport-css-px',
        warnings:[...new Set(warnings)],timingMs:Date.now()-started,canvasCount:sample.canvasCount||0,stability,fixedButtons,
        detection:(verified||stability.scope)&&sample.detection?sample.detection:{dom:0,engine:0,vision:0,visionRequested:false}};
      await saveObservation({directory:staging,png,observation,candidates});
      if(verified||hasFixed) {
        if(!this.isSampleCurrent(sample))return discardStale();
        try{await showCoordinateOverlay(page,[...fixedButtons,...observation.buttons],viewport);}catch{observation.warnings.push('No se pudo colocar el overlay en la página; las coordenadas siguen visibles en el panel y PNG.');}
      }
      observation.timingMs=Date.now()-started;
      await fs.writeFile(path.join(staging,'buttons.json'),JSON.stringify(observation,null,2));
      if((verified||hasFixed)&&!this.isSampleCurrent(sample))return discardStale();
      await fs.rename(staging,directory);
      if((verified||hasFixed)&&!this.isSampleCurrent(sample))return discardStale();
    }catch(e){
      await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
      if((verified||hasFixed)&&!this.isSampleCurrent(sample))return discardStale();
      await clearCoordinateOverlay(page).catch(()=>{});throw e;
    }
    while(this.directories.length>=12)await fs.rm(this.directories.shift(),{recursive:true,force:true}).catch(()=>{});
    if((verified||hasFixed)&&!this.isSampleCurrent(sample))return discardStale();
    // Commit only after the complete output is available and page identity is
    // still current. All coordinates come from the third sample, never averages.
    this.snapshot=verified?{observationId,createdAt:sample.capturedAt,page,url:sample.url,epoch:sample.epoch,viewport,png,candidates,fixedContext:sample.fixedContext}:null;
    this.observation=observation;this.directories.push(directory);
    return observation;
  }
  async rawSample(page) {
    const identity={page,viewport:page.viewportSize(),epoch:this.epoch,url:page.url()};
    let fixedContext,png,capturedAt;
    try {
      fixedContext=await this.readFixedContext(page);
      await clearCoordinateOverlay(page);
      png=await page.screenshot({type:'png',scale:'css',timeout:10000});capturedAt=Date.now();
      const finalContext=await this.readFixedContext(page);
      if(!this.isSampleCurrent(identity)||!matchesFixedContext(fixedContext,finalContext))throw new CommandError('FIXED_CONTEXT_CHANGED','La página cambió.');
    }catch(error) {
      if(error.code==='FIXED_CONTEXT_CHANGED'||!this.isSampleCurrent(identity)) {
        this.dropFixedContext();throw new CommandError('CAPTURE_CONTEXT_CHANGED','La página cambió durante la captura. Solicitá otra captura cuando esté lista.');
      }
      throw error;
    }
    return {...identity,png,candidates:[],timestamp:new Date(capturedAt).toISOString(),capturedAt,fixedContext};
  }
  async capture() {
    const started=Date.now(),page=await this.getPage();await this.invalidate();
    this.verification={status:'idle',currentSample:0,requiredSamples:3,intervalMs:2000};
    return this.publish(await this.rawSample(page),{started,warnings:this.notices.splice(0),stability:{status:'unverified',...STABILITY_RULES,completedSamples:0,reasons:[],samples:[]}});
  }
  async observe(options={}) {return this.verify(options);}
  async verify(options={}) {
    if(this.verification.status==='checking')throw new CommandError('VERIFICATION_BUSY','Ya hay una verificación en curso.');
    const hasScope=Object.hasOwn(options,'excludeLabels');
    if(hasScope)options={...options,excludeLabels:parseCommand({action:'verify',excludeLabels:options.excludeLabels}).excludeLabels};
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
        ...(hasScope?{scope:{excludeLabels:[...options.excludeLabels],excludedCounts:samples.map(sample=>sample.excludedCount||0)}}:{}),
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
  verifiedTarget(command,page) {
    const snapshot=this.snapshot,observation=this.observation;
    if(!snapshot||!observation||observation.stability?.status!=='stable'||snapshot.page!==page||snapshot.url!==page.url()||snapshot.epoch!==this.epoch||
       !this.isSampleCurrent(snapshot)||(command.observationId&&command.observationId!==snapshot.observationId)||Date.now()-snapshot.createdAt>this.observationTTL) {
      throw new CommandError('STALE_OBSERVATION','No hay posiciones verificadas vigentes. La IA debe solicitar verify antes del clic.');
    }
    const index=observation.buttons.findIndex(b=>b.id===command.id);if(index<0)throw new CommandError('UNKNOWN_TARGET','Ese botón no está en la observación actual.');
    const button=observation.buttons[index],candidate=snapshot.candidates[index];
    if(!button.actionable)throw new CommandError('DISABLED_TARGET','El control está deshabilitado.');
    return {snapshot,observation,button,candidate};
  }
  async pinTarget(command,page) {
    const {snapshot,button}=this.verifiedTarget(command,page),scope=await this.readFixedContext(page);
    if(!matchesFixedContext(snapshot.fixedContext,scope))throw new CommandError('STALE_OBSERVATION','Cambió el contexto de la observación; solicitá verify antes de guardar el botón.');
    const templatePNG=await sharp(snapshot.png).extract(pixelBox(button.bbox,snapshot.viewport.width,snapshot.viewport.height)).png().toBuffer();
    const saved=await this.fixedStore.add({button,name:command.name||(button.label||'Botón fijo').slice(0,80),scope,templatePNG,observationId:snapshot.observationId});
    return {button:saved,...await this.updateFixedPresentation()};
  }
  async clickFixedTarget(command,page) {
    const button=(await this.fixedStore.list()).find(entry=>entry.id===command.id);
    if(!button)throw new CommandError('UNKNOWN_FIXED_BUTTON','No existe ese botón fijo.');
    const scope=await this.readFixedContext(page),epoch=this.epoch,url=page.url();
    if(!matchesFixedContext(button.scope,scope)) {
      await this.refreshFixedButtons(scope);throw new CommandError('FIXED_CONTEXT_MISMATCH','El botón fijo pertenece a otro juego, tamaño o desplazamiento. Restaurá su contexto antes del clic.');
    }
    await clearCoordinateOverlay(page);
    const current=await page.screenshot({type:'png',scale:'css',timeout:10000});
    const viewport=page.viewportSize(),box=pixelBox(button.bbox,viewport.width,viewport.height);
    const template=await this.fixedStore.template(command.id),metadata=await sharp(template).metadata();
    if(metadata.width!==box.width||metadata.height!==box.height)throw new CommandError('FIXED_TEMPLATE_MISMATCH','El recorte guardado no coincide con su recuadro. Volvé a guardar el botón.');
    const crop=await sharp(current).extract(box).png().toBuffer();
    const difference=await cropDifference(template,crop,{x:0,y:0,width:box.width,height:box.height},{width:box.width,height:box.height});
    if(difference>STABILITY_RULES.maxCropDifference) {
      await this.invalidate();throw new CommandError('FIXED_TARGET_CHANGED','Cambió el recorte en la posición fija; no se hizo clic ni se recalculó la posición.');
    }
    let finalScope;
    try{finalScope=await this.readFixedContext(page);}catch{finalScope=null;}
    if(this.page!==page||this.epoch!==epoch||page.url()!==url||!matchesFixedContext(scope,finalScope)) {
      await this.invalidate();throw new CommandError('FIXED_CONTEXT_MISMATCH','El contexto cambió antes de usar el botón fijo.');
    }
    const point=button.clickPoint;this.assertPoint(point.x,point.y,viewport);
    await this.invalidate();await page.mouse.click(point.x,point.y);
    return {clicked:command.id,name:button.name,x:point.x,y:point.y,source:'fixed',guard:{type:'saved-crop',difference},verification:'user-fixed'};
  }
  async clickTarget(command,page) {
    const {snapshot,button,candidate}=this.verifiedTarget(command,page),point=button.clickPoint||button.center;
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
    const response=await this.executeCommand(input);
    return {...response,fixedButtons:await this.listFixedButtons()};
  }
  async executeCommand(input) {
    const command=parseCommand(input),action=command.action;
    if(action==='pins'){await this.syncFixedContext();return {result:{action,count:this.fixedButtons.length}};}
    if(action==='rename'||action==='unpin') {
      const button=action==='rename'?await this.fixedStore.rename(command.id,command.name):await this.fixedStore.remove(command.id);
      await this.refreshFixedButtons();
      return {result:{action,button,...await this.updateFixedPresentation()}};
    }
    const page=await this.getPage();
    let result={action},needsObservation=true;
    switch(action) {
      case 'help': return {result:{commands:HELP,coordinateSpace:'viewport-css-px'}};
      case 'verify': {const observation=await this.verify(command);return {result:{action,status:observation.stability.status,positionsReady:observation.stability.status==='stable'&&observation.buttons.length>0},observation};}
      case 'snapshot': return {result:{action},observation:await this.capture()};
      case 'pin': return {result:{action,...await this.pinTarget(command,page)}};
      case 'export': return {result:{observation:this.observation,...(this.observation?{jsonUrl:this.observation.jsonUrl,contactSheetUrl:this.observation.contactSheetUrl}:{})}};
      case 'tabs': return {result:{tabs:await Promise.all(this.context.pages().map(async(p,index)=>({index,url:safeURL(p.url()),title:await p.title().catch(()=>''),active:p===this.page})))}};
      case 'goto': await this.invalidate();await page.goto(command.url,{waitUntil:'domcontentloaded'});break;
      case 'back': await this.invalidate();await page.goBack({waitUntil:'domcontentloaded'});break;
      case 'forward': await this.invalidate();await page.goForward({waitUntil:'domcontentloaded'});break;
      case 'reload': await this.invalidate();await page.reload({waitUntil:'domcontentloaded'});break;
      case 'click':
        if(command.id)Object.assign(result,await (command.id.startsWith('f')?this.clickFixedTarget(command,page):this.clickTarget(command,page)));
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
  async close(){const browser=this.browser;this.browser=null;this.snapshot=null;this.observation=null;this.dropFixedContext();await browser?.close();}
}
module.exports={BrowserController,safeURL};
