'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

const MAX_BUTTONS=200,MAX_ID=999999;
const ID=/^f[1-9]\d{0,5}$/;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const PRIVATE_PARAMETER=/token|session|password|passwd|secret|auth|ticket|jwt|nonce|timestamp|^(?:sid|ts|api[_-]?key|credential|signature)$/i;
const GAME_PARAMETER=/^(?:gid|game|gameid|gamecode|id)$/i;
const clone=value=>JSON.parse(JSON.stringify(value));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const error=(code,message,cause)=>Object.assign(new Error(message,cause?{cause}:undefined),{code});
const requireValue=(condition,code,message)=>{if(!condition)throw error(code,message);};

function layout({viewport,deviceScaleFactor=1,scroll={x:0,y:0}}={}) {
  requireValue(viewport&&['width','height'].every(key=>Number.isInteger(viewport[key])&&viewport[key]>0&&viewport[key]<=16384),
    'INVALID_FIXED_CONTEXT','El contexto necesita un viewport válido.');
  requireValue(finite(deviceScaleFactor)&&deviceScaleFactor>0&&deviceScaleFactor<=16,
    'INVALID_FIXED_CONTEXT','El contexto necesita una escala de píxeles válida.');
  requireValue(scroll&&finite(scroll.x)&&finite(scroll.y)&&Math.abs(scroll.x)<=1e9&&Math.abs(scroll.y)<=1e9,
    'INVALID_FIXED_CONTEXT','La posición de desplazamiento del contexto es inválida.');
  return {viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor,scroll:{x:scroll.x,y:scroll.y}};
}
function parseURL(value) {
  let url;try{url=new URL(value);}catch{throw error('INVALID_FIXED_CONTEXT','La URL del contexto es inválida.');}
  requireValue((['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)||url.href==='about:blank',
    'INVALID_FIXED_CONTEXT','El contexto requiere HTTP, HTTPS o about:blank, sin credenciales en la URL.');
  return url;
}
function contextLabel(url,parameters) {
  if(url.href==='about:blank')return 'about:blank';
  const game=new URLSearchParams(parameters.filter(([key])=>GAME_PARAMETER.test(key)));
  return url.origin+url.pathname+(game.size?'?'+game.toString():'');
}

/** Persist only a digest of URL identity; display labels never contain session parameters. */
function makeFixedContext(input={}) {
  const dimensions=layout(input),url=parseURL(input.url);
  // Sort names, retaining the order of duplicate values: selecting the first gid
  // and selecting the last gid need not refer to the same game.
  const parameters=[...url.searchParams].filter(([key])=>!PRIVATE_PARAMETER.test(key))
    .sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const identity=JSON.stringify({url:url.href==='about:blank'?'about:blank':url.origin+url.pathname,
    parameters,fragment:url.hash});
  const label=contextLabel(url,parameters);
  requireValue(label.length<=4096,'INVALID_FIXED_CONTEXT','La etiqueta del contexto es demasiado larga.');
  return {urlKey:createHash('sha256').update(identity).digest('hex'),label,...dimensions};
}
function validateScope(scope) {
  requireValue(scope&&typeof scope.urlKey==='string'&&/^[a-f0-9]{64}$/.test(scope.urlKey)&&typeof scope.label==='string'&&scope.label.length<=4096,
    'INVALID_FIXED_CONTEXT','El contexto guardado es inválido.');
  const dimensions=layout(scope),url=parseURL(scope.label);
  requireValue(!url.hash&&[...url.searchParams.keys()].every(key=>GAME_PARAMETER.test(key)&&!PRIVATE_PARAMETER.test(key)),
    'INVALID_FIXED_CONTEXT','La etiqueta del contexto contiene parámetros no permitidos.');
  return {urlKey:scope.urlKey,label:scope.label,...dimensions};
}
function matchesFixedContext(a,b) {
  if(!a||!b)return false;
  try {
    const x=validateScope(a),y=validateScope(b);
    return x.urlKey===y.urlKey&&x.viewport.width===y.viewport.width&&x.viewport.height===y.viewport.height&&
      x.deviceScaleFactor===y.deviceScaleFactor&&x.scroll.x===y.scroll.x&&x.scroll.y===y.scroll.y;
  }catch{return false;}
}
function checkID(id) {requireValue(typeof id==='string'&&ID.test(id),'INVALID_FIXED_ID','ID fijo inválido.');return id;}
function checkName(name) {
  requireValue(typeof name==='string'&&name.trim().length>0&&name.trim().length<=80&&!/[\u0000-\u001f\u007f]/.test(name),
    'INVALID_FIXED_NAME','El nombre debe contener entre 1 y 80 caracteres sin controles.');
  return name.trim().toWellFormed();
}
function checkTemplate(bytes) {
  requireValue(Buffer.isBuffer(bytes)&&bytes.length>=33&&bytes.length<=16*1024*1024&&bytes.subarray(0,8).equals(PNG_SIGNATURE)&&
    bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&
    bytes.readUInt32BE(16)<=16384&&bytes.readUInt32BE(20)<=16384,
    'INVALID_FIXED_TEMPLATE','El recorte fijo debe ser una imagen PNG válida de hasta 16 MiB.');
  return bytes;
}
function geometry(button,scope) {
  const box=button?.bbox,point=button?.clickPoint,center=button?.center;
  const {width,height}=scope.viewport,epsilon=.011;
  requireValue(box&&['x','y','width','height'].every(key=>finite(box[key]))&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&
    box.x+box.width<=width+epsilon&&box.y+box.height<=height+epsilon,
    'INVALID_FIXED_GEOMETRY','El recuadro fijo debe quedar dentro del viewport guardado.');
  const inside=p=>p&&finite(p.x)&&finite(p.y)&&p.x>=0&&p.y>=0&&p.x<width&&p.y<height&&
    p.x>=box.x-epsilon&&p.x<=box.x+box.width+epsilon&&p.y>=box.y-epsilon&&p.y<=box.y+box.height+epsilon;
  requireValue(inside(point)&&inside(center),'INVALID_FIXED_GEOMETRY','El punto de clic y el centro deben pertenecer al recuadro guardado.');
  return {bbox:{x:box.x,y:box.y,width:box.width,height:box.height},center:{x:center.x,y:center.y},clickPoint:{x:point.x,y:point.y},
    normalized:{x:Number((box.x/width).toFixed(6)),y:Number((box.y/height).toFixed(6)),width:Number((box.width/width).toFixed(6)),height:Number((box.height/height).toFixed(6))}};
}
function sourceFields(button) {
  requireValue(button&&typeof button.label==='string'&&button.label.length<=160&&typeof button.kind==='string'&&button.kind.length>0&&button.kind.length<=80&&
    typeof button.source==='string'&&button.source.length>0&&button.source.length<=40,'INVALID_FIXED_BUTTON','Los datos del botón son inválidos.');
  return {label:button.label,kind:button.kind,source:'fixed',detectedSource:button.source,fixed:true,verification:'user-fixed'};
}
function observationReference(id) {
  requireValue(typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
    'INVALID_FIXED_BUTTON','Falta una referencia válida a la observación de origen.');
  return id;
}
function knownFields(value,allowed) {
  requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key)),
    'INVALID_FIXED_INDEX','El catálogo contiene campos no reconocidos.');
}
function validateIndex(value) {
  try {
    knownFields(value,['version','nextId','buttons']);
    requireValue(value&&value.version===1&&Number.isInteger(value.nextId)&&value.nextId>=1&&value.nextId<=MAX_ID+1&&Array.isArray(value.buttons)&&value.buttons.length<=MAX_BUTTONS,
      'INVALID_FIXED_INDEX','Índice inválido.');
    const ids=new Set();
    for(const row of value.buttons) {
      knownFields(row,['id','name','label','kind','source','detectedSource','fixed','verification','bbox','center','clickPoint','normalized','scope','createdAt','updatedAt','basedOnObservationId','cropUrl']);
      knownFields(row.scope,['urlKey','label','viewport','deviceScaleFactor','scroll']);
      knownFields(row.scope.viewport,['width','height']);knownFields(row.scope.scroll,['x','y']);
      knownFields(row.bbox,['x','y','width','height']);knownFields(row.normalized,['x','y','width','height']);
      knownFields(row.center,['x','y']);knownFields(row.clickPoint,['x','y']);
      checkID(row?.id);requireValue(!ids.has(row.id)&&Number(row.id.slice(1))<value.nextId,'INVALID_FIXED_INDEX','ID duplicado o contador inválido.');ids.add(row.id);
      requireValue(checkName(row.name)===row.name,'INVALID_FIXED_NAME','Nombre inválido.');
      const scope=validateScope(row.scope),shape=geometry(row,scope);
      sourceFields({...row,source:row.detectedSource});observationReference(row.basedOnObservationId);
      requireValue(row.source==='fixed'&&row.fixed===true&&row.verification==='user-fixed'&&row.cropUrl===`/artifacts/fixed/${row.id}.png`,
        'INVALID_FIXED_INDEX','Tipo de registro inválido.');
      requireValue(row.normalized&&Object.keys(shape.normalized).every(key=>row.normalized[key]===shape.normalized[key]),'INVALID_FIXED_INDEX','Coordenadas normalizadas inválidas.');
      for(const date of [row.createdAt,row.updatedAt])requireValue(typeof date==='string'&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString()===date,
        'INVALID_FIXED_INDEX','Fecha inválida.');
    }
    return value;
  }catch(cause){throw error('FIXED_STORE_CORRUPT','El catálogo de botones fijos está dañado; se conservó sin cambios.',cause);}
}

class FixedButtonStore {
  constructor(directory) {
    requireValue(typeof directory==='string'&&directory.trim().length>0,'INVALID_FIXED_DIRECTORY','Falta el directorio de botones fijos.');
    this.directory=path.resolve(directory);this.indexPath=path.join(this.directory,'index.json');
    this._loadPromise=null;this._tail=Promise.resolve();this._data=null;
  }
  async _load() {
    if(!this._loadPromise)this._loadPromise=(async()=>{
      let bytes;
      try {
        const stat=await fs.stat(this.indexPath);
        if(!stat.isFile()||stat.size>2*1024*1024)throw error('FIXED_STORE_CORRUPT','El catálogo de botones fijos tiene un formato inválido; se conservó sin cambios.');
        bytes=await fs.readFile(this.indexPath,'utf8');
      }catch(cause) {
        if(cause.code==='ENOENT'){this._data={version:1,nextId:1,buttons:[]};return;}
        if(cause.code==='FIXED_STORE_CORRUPT')throw cause;
        throw error('FIXED_STORE_READ_FAILED','No se pudo leer el catálogo de botones fijos.',cause);
      }
      let value;try{value=JSON.parse(bytes);}catch(cause){throw error('FIXED_STORE_CORRUPT','El catálogo de botones fijos está dañado; se conservó sin cambios.',cause);}
      this._data=validateIndex(value);
    })();
    return this._loadPromise;
  }
  _mutate(action) {
    const operation=this._tail.then(async()=>{await this._load();return action();});
    this._tail=operation.then(()=>{},()=>{});return operation;
  }
  async _atomicWrite(filename,bytes,exclusive=false) {
    const temporary=path.join(this.directory,`.pending-${randomUUID()}`);
    try {
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600});
      // A template is introduced before its index entry; never overwrite an
      // unindexed file left by another process or an interrupted write.
      if(exclusive){await fs.link(temporary,filename);await fs.unlink(temporary);}
      else await fs.rename(temporary,filename);
    }catch(cause){
      await fs.rm(temporary,{force:true}).catch(()=>{});
      throw error(cause.code==='EEXIST'?'FIXED_STORE_CONFLICT':'FIXED_STORE_WRITE_FAILED',
        cause.code==='EEXIST'?'Ya existe un archivo con ese ID fijo; se conservó sin cambios.':'No se pudo guardar el catálogo de botones fijos.',cause);
    }
  }
  async _commit(next) {
    await this._atomicWrite(this.indexPath,JSON.stringify(next,null,2)+'\n');
    this._data=next;
  }
  _entry(id) {
    checkID(id);const entry=this._data.buttons.find(button=>button.id===id);
    if(!entry)throw error('UNKNOWN_FIXED_BUTTON','No existe ese botón fijo.');return entry;
  }
  async list() {await this._tail;await this._load();return clone(this._data.buttons);}
  async add({button,name,scope,templatePNG,observationId}={}) {
    return this._mutate(async()=>{
      requireValue(this._data.buttons.length<MAX_BUTTONS&&this._data.nextId<=MAX_ID,'FIXED_STORE_LIMIT','El catálogo alcanzó su límite de botones fijos.');
      const validScope=validateScope(scope),shape=geometry(button,validScope),fields=sourceFields(button),safeName=checkName(name),reference=observationReference(observationId);
      const bytes=checkTemplate(templatePNG),id='f'+this._data.nextId,now=new Date().toISOString();
      const entry={id,name:safeName,...fields,...shape,scope:validScope,createdAt:now,updatedAt:now,basedOnObservationId:reference,cropUrl:`/artifacts/fixed/${id}.png`};
      const file=path.join(this.directory,id+'.png');await this._atomicWrite(file,bytes,true);
      try {await this._commit({version:1,nextId:this._data.nextId+1,buttons:[...this._data.buttons,entry]});}
      catch(cause){await fs.rm(file,{force:true}).catch(()=>{});throw cause;}
      return clone(entry);
    });
  }
  async rename(id,name) {
    return this._mutate(async()=>{
      const old=this._entry(id),entry={...old,name:checkName(name),updatedAt:new Date().toISOString()};
      await this._commit({...this._data,buttons:this._data.buttons.map(button=>button.id===id?entry:button)});return clone(entry);
    });
  }
  async remove(id) {
    return this._mutate(async()=>{
      const entry=this._entry(id);
      await this._commit({...this._data,buttons:this._data.buttons.filter(button=>button.id!==id)});
      try{await fs.unlink(path.join(this.directory,id+'.png'));}catch(cause){if(cause.code!=='ENOENT')throw error('FIXED_TEMPLATE_CLEANUP_FAILED','El botón fijo se eliminó, pero no se pudo borrar su recorte.',cause);}
      return clone(entry);
    });
  }
  async template(id) {
    await this._tail;await this._load();this._entry(id);
    let bytes;try{bytes=await fs.readFile(path.join(this.directory,id+'.png'));}
    catch(cause){throw error('FIXED_TEMPLATE_UNAVAILABLE','No se pudo leer el recorte del botón fijo.',cause);}
    return checkTemplate(bytes);
  }
}

module.exports={FixedButtonStore,makeFixedContext,matchesFixedContext};
