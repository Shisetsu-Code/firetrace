'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {BrowserController}=require('./browser.cjs');
const {parseCommand}=require('./commands.cjs');
const PUBLIC=path.resolve(__dirname,'../public');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const publicFiles=new Set(['index.html','styles.css','app.js']);
function send(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
function equalSecret(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function readBody(req) {
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>262144)throw Object.assign(new Error('Solicitud demasiado grande.'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('JSON inválido.'),{status:400});}
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
async function createService(options={}) {
  const host=options.host||process.env.HOST||'127.0.0.1',port=options.port??Number(process.env.PORT||8766);
  const token=options.token??process.env.BUTTON_BROWSER_TOKEN??'';
  if(!['127.0.0.1','localhost','::1'].includes(host)&&token.length<16)throw new Error('Para escuchar en una IP remota, configurá BUTTON_BROWSER_TOKEN con al menos 16 caracteres.');
  const vision=options.vision||(process.env.VISION_BASE_URL&&process.env.VISION_MODEL?{baseURL:process.env.VISION_BASE_URL,model:process.env.VISION_MODEL,apiKey:process.env.VISION_API_KEY}:null);
  const controller=options.controller||new BrowserController({artifactDir:options.artifactDir,fixedButtonDir:options.fixedButtonDir,headless:process.env.HEADLESS!=='false',vision});
  let chain=Promise.resolve(),pending=0;const cache=new Map();
  const allowedOrigins=(process.env.BUTTON_BROWSER_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean);
  function enqueue(command,commandId) {
    const fingerprint=JSON.stringify(canonical(command));
    if(commandId&&cache.has(commandId)) {
      const cached=cache.get(commandId);
      if(cached.fingerprint!==fingerprint)return Promise.resolve({ok:false,error:{code:'COMMAND_ID_CONFLICT',message:'commandId ya se usó con otro comando.'}});
      return cached.promise;
    }
    if(pending>=8)return Promise.resolve({ok:false,error:{code:'BUSY',message:'Hay demasiados comandos pendientes. Esperá a que termine el actual.'}});
    pending++;
    const promise=chain.then(async()=>{
      try{return {ok:true,...await controller.execute(command)};}
      catch(e){return {ok:false,error:{code:e.code||'BROWSER_ERROR',message:e.message.split('\n')[0].slice(0,400)}};}
      finally{pending--;}
    });
    chain=promise.then(()=>{});
    if(commandId){cache.set(commandId,{fingerprint,promise});while(cache.size>256)cache.delete(cache.keys().next().value);}
    return promise;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    try {
      let url;try{url=new URL(req.url,'http://localhost');}catch{return send(res,400,{ok:false,error:{code:'BAD_URL',message:'URL inválida.'}});}
      const isPrivate=url.pathname.startsWith('/api/')||url.pathname.startsWith('/artifacts/');
      if(isPrivate) {
        if(token&&!equalSecret(req.headers.authorization||'',`Bearer ${token}`))return send(res,401,{ok:false,error:{code:'UNAUTHORIZED',message:'Ingresá el token del servidor.'}});
        // A visited web page cannot issue commands to the controller through CSRF.
        const origin=req.headers.origin;
        const matches=origin===`http://${req.headers.host}`||origin===`https://${req.headers.host}`||allowedOrigins.includes(origin);
        if(origin&&!matches)return send(res,403,{ok:false,error:{code:'ORIGIN_REJECTED',message:'Origen de solicitud no permitido.'}});
        if(!token){const hostname=(req.headers.host||'').replace(/:\d+$/,'');if(!['127.0.0.1','localhost','[::1]'].includes(hostname))return send(res,403,{ok:false,error:{code:'HOST_REJECTED',message:'Host no permitido sin token.'}});}
      }
      if(req.method==='GET'&&url.pathname==='/api/state') {
        const fixedButtons=await controller.listFixedButtons?.()||[];
        return send(res,200,{ok:true,observation:controller.observation,verification:controller.verification,fixedButtons,busy:pending>0,visionConfigured:!!vision,requiresToken:!!token});
      }
      if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,service:'button-browser',busy:pending>0});
      if(req.method==='POST'&&url.pathname==='/api/command') {
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return send(res,415,{ok:false,error:{code:'CONTENT_TYPE',message:'Usá Content-Type: application/json.'}});
        const body=await readBody(req);
        if(!body||typeof body!=='object'||Array.isArray(body))return send(res,400,{ok:false,error:{code:'INVALID_REQUEST',message:'Se requiere un objeto JSON.'}});
        if(body.commandId!=null&&(typeof body.commandId!=='string'||!body.commandId.length||body.commandId.length>100))return send(res,400,{ok:false,error:{code:'INVALID_COMMAND_ID',message:'commandId debe contener 1–100 caracteres.'}});
        let command;try{command=parseCommand(body.command);}catch(e){return send(res,400,{ok:false,error:{code:e.code||'INVALID_COMMAND',message:e.message}});}
        return send(res,200,await enqueue(command,body.commandId));
      }
      if(req.method==='GET') {
        const fixed=url.pathname.match(/^\/artifacts\/fixed\/(f[1-9]\d{0,5})\.png$/);
        if(fixed&&controller.fixedStore) {
          try {const bytes=await controller.fixedStore.template(fixed[1]);res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});return res.end(bytes);}
          catch(e){if(!['UNKNOWN_FIXED_BUTTON','FIXED_TEMPLATE_UNAVAILABLE'].includes(e.code))throw e;return send(res,404,{ok:false,error:{code:'NOT_FOUND',message:'Recorte fijo no encontrado.'}});}
        }
        let file;
        if(url.pathname==='/demo')file=path.join(PUBLIC,'demo.html');
        else if(url.pathname==='/')file=path.join(PUBLIC,'index.html');
        else if(publicFiles.has(url.pathname.slice(1)))file=path.join(PUBLIC,url.pathname.slice(1));
        else {
          const match=url.pathname.match(/^\/artifacts\/([a-f0-9-]{36})\/(screenshot\.png|annotated\.png|buttons\.png|buttons\.json|b\d{1,4}\.png)$/);
          if(match)file=path.join(controller.artifactDir,match[1],match[2]);
        }
        if(file) {
          try{const bytes=await fs.readFile(file);res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','cache-control':isPrivate?'no-store':'no-cache'});return res.end(bytes);}
          catch(e){if(e.code!=='ENOENT')throw e;}
        }
      }
      send(res,404,{ok:false,error:{code:'NOT_FOUND',message:'Recurso no encontrado.'}});
    }catch(e){if(!res.headersSent)send(res,e.status||500,{ok:false,error:{code:'SERVER_ERROR',message:e.status?e.message:'No se pudo procesar la solicitud.'}});else res.end();}
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,controller,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await chain;await controller.close();}};
}
if(require.main===module) {
  createService().then(service=>{
    const address=service.server.address();console.log(`Button Browser: http://${process.env.HOST||'127.0.0.1'}:${address.port}`);
    console.log('Abrí el panel, cargá una URL y solicitá verify para tres lecturas estables. CLI: npm run cli -- "help"');
    let closing=false;const close=async()=>{if(closing)return;closing=true;await service.close();process.exit(0);};
    process.on('SIGINT',close);process.on('SIGTERM',close);
  }).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={createService};
