import { OAuthProvider, AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.js';

const escape = value => String(value).replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
export async function passwordMatches(supplied,expected) {
  if(!expected || typeof supplied!=='string') return false;
  const hash=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [a,b]=await Promise.all([hash(supplied),hash(expected)]);
  let diff=0; for(let i=0;i<a.length;i++) diff|=a[i]^b[i];
  return diff===0;
}
const defaultHandler={async fetch(request,env) {
  const url=new URL(request.url);
  if(url.pathname==='/health') return Response.json({ok:true,service:'firetrace-mcp'});
  if(url.pathname!=='/authorize') return new Response('Firetrace MCP: connect /mcp using OAuth.',{status:404});
  const oauth=env.OAUTH_PROVIDER;
  try {
    if(request.method==='GET') {
      const auth=await oauth.parseAuthRequest(request);
      const details=await oauth.describeConsent(auth);
      const consent=await oauth.beginConsent(auth);
      consent.headers.set('content-type','text/html; charset=utf-8');
      consent.headers.set('cache-control','no-store');
      consent.headers.set('referrer-policy','no-referrer');
      return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conectar Firetrace</title><h1>Conectar Firetrace</h1><p>Aplicación: <strong>${escape(details.clientName)}</strong></p><p>Destino de autorización: ${escape(details.redirectHost)}</p><p>${details.clientDomain ? 'Dominio: '+escape(details.clientDomain) : 'El nombre de esta aplicación no está verificado.'}</p><p>Permite ver y controlar el navegador Firetrace, obtener capturas y leer tráfico de red. Los clics pueden enviar formularios o iniciar transacciones.</p><p>Permisos solicitados: ${escape(details.scope.join(', '))}</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><label>Clave de conexión Firetrace <input name="password" type="password" autocomplete="current-password" required></label><p><button name="decision" value="approve">Autorizar</button> <button name="decision" value="deny" formnovalidate>Cancelar</button></p></form></html>`,{headers:consent.headers});
    }
    if(request.method==='POST') {
      if(request.headers.get('origin')!==url.origin) return new Response('Invalid origin',{status:403});
      const form=await request.formData();
      const handle=String(form.get('handle')||'');
      if(form.get('decision')!=='approve') {
        const denied=await oauth.denyConsent(request,handle);
        return new Response(null,{status:302,headers:denied.headers});
      }
      if(!await passwordMatches(form.get('password'),env.MCP_PASSWORD)) return new Response('Clave incorrecta. Volvé a iniciar la conexión.',{status:401,headers:{'cache-control':'no-store'}});
      const approved=await oauth.approveConsent(request,handle);
      const scope=approved.request.scope;
      if(!scope.includes('browser:control')) return new Response('browser:control scope required',{status:400});
      const {redirectTo}=await oauth.completeAuthorization({request:approved.request,userId:'firetrace-owner',metadata:{},scope,props:{agentId:'firetrace'}});
      approved.headers.set('location',redirectTo);
      return new Response(null,{status:302,headers:approved.headers});
    }
    return new Response('Method not allowed',{status:405});
  } catch(error) {
    if(error instanceof AuthorizationError) return new Response('Solicitud inválida o vencida. Volvé a iniciar la conexión.',{status:400});
    throw error;
  }
}};

export default {fetch(request,env,ctx) {
  const origin=env.PUBLIC_URL;
  const provider=new OAuthProvider({
    apiRoute:'/mcp',
    apiHandler:{fetch(request,env,ctx) {
      if(ctx.props?.agentId!=='firetrace' || !ctx.auth?.scope?.includes('browser:control')) return new Response('Forbidden',{status:403});
      return handleMcp(request,env);
    }},defaultHandler,
    authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
    scopesSupported:['browser:control','offline_access'],requiredScopes:['browser:control'],
    resourceMetadata:{resource:`${origin}/mcp`,authorization_servers:[origin]},
    clientIdMetadataDocumentEnabled:true,
    accessTokenTTL:3600,refreshTokenTTL:2592000,
  });
  return provider.fetch(request,env,ctx);
}};
