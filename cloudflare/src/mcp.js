import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { runCommand, readState, controlRequest, screenshotForCommand } from './bridge.js';

const text = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const annotations = readOnly => ({readOnlyHint:readOnly, destructiveHint:!readOnly, idempotentHint:readOnly, openWorldHint:true});

export function createServer(env) {
  const server = new McpServer({name:'firetrace',version:'1.0.0'});
  const register = (name, description, inputSchema, readOnly, handler) => server.registerTool(name, {
    description, inputSchema, annotations:annotations(readOnly),
    _meta:{securitySchemes:[{type:'oauth2',scopes:['browser:control']}]},
  }, async args => {
    try { return await handler(args); }
    catch(error) { return {...text({error:error.message}),isError:true}; }
  });
  register('browser_status','Read the Firetrace agent connection and current browser state.',{},true,async()=>text(await readState(env)));
  register('browser_open','Open an HTTP or HTTPS page in the local Firetrace browser.',{url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol),'HTTP(S) URL required')},false,async args=>text(await runCommand(env,'open',args)));
  register('browser_click','Click viewport pixel coordinates. May submit forms or trigger transactions; use only for the requested action.',{x:z.number().min(0),y:z.number().min(0)},false,async args=>text(await runCommand(env,'click',args)));
  register('browser_click_relative','Click normalized viewport coordinates between 0 and 1. May trigger transactions.',{rx:z.number().min(0).max(1),ry:z.number().min(0).max(1)},false,async args=>text(await runCommand(env,'click_relative',args)));
  register('browser_wait','Wait briefly for the browser page to settle.',{ms:z.number().int().min(0).max(10000).default(1000)},false,async args=>text(await runCommand(env,'wait',args)));
  register('browser_screenshot','Capture the current browser viewport and return a JPEG image.',{quality:z.number().int().min(20).max(90).default(65)},true,async args=>{
    const result=await runCommand(env,'screenshot',args);
    if(result.status!=='done') return text(result);
    const shot=await screenshotForCommand(env,result.id);
    let binary='';
    for(let i=0;i<shot.bytes.length;i+=8192) binary+=String.fromCharCode(...shot.bytes.subarray(i,i+8192));
    return {content:[{type:'image',mimeType:'image/jpeg',data:btoa(binary)}]};
  });
  register('network_events','Read captured browser network events, with sensitive headers redacted.',{},true,async()=>text(await runCommand(env,'network_events')));
  register('network_clear','Clear the browser network capture buffer.',{},false,async()=>text(await runCommand(env,'network_clear')));
  register('trigger_and_capture','Click and capture matching HTTP requests/responses. The click may trigger a transaction; only use for an explicitly requested action.',{
    url_contains:z.string().min(1).max(2000),rx:z.number().min(0).max(1),ry:z.number().min(0).max(1),wait_ms:z.number().int().min(0).max(10000).default(2500),
  },false,async args=>text(await runCommand(env,'trigger_and_capture',args)));
  register('command_result','Read a previously submitted command result without repeating the action.',{id:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)},true,async({id})=>{
    const data=await (await controlRequest(env,`/api/command/${encodeURIComponent(id)}`)).json();
    if(data.command?.agent_id!=='firetrace') throw new Error('Command not found');
    return text(data);
  });
  return server;
}

export async function handleMcp(request,env) {
  const server=createServer(env);
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  return transport.handleRequest(request);
}
