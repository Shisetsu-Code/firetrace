import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { runCommand, readState, readCommand, screenshotForCommand } from './bridge.js';
import { description } from './brand.js';
import { registerAutomation } from './automation-tools.js';

const text = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const annotations = readOnly => ({readOnlyHint:readOnly, destructiveHint:!readOnly, idempotentHint:readOnly, openWorldHint:true});
const browserId = z.string().regex(/^[a-f0-9]{32}$/);
const headless = z.boolean().optional().describe('true runs without a visible window; false opens a visible window. Omit to use the agent default for creation or preserve the mode on reopen.');
const target = {browser_id:browserId.optional().describe('Target from browser_list/create. Required when multiple windows are open. Closed windows require browser_reopen; never guess another window.')};

export function createServer(env) {
  const server = new McpServer({name:'firetrace',title:'Firetrace',description,version:'2.0.0',websiteUrl:env.PUBLIC_URL || 'https://firetrace-mcp.braian-n-l.workers.dev',icons:[{src:`${env.PUBLIC_URL || 'https://firetrace-mcp.braian-n-l.workers.dev'}/logo.png`,mimeType:'image/png'}]}, {instructions:
    'Firetrace controls multiple independent browser windows on the user PC. Start with browser_list. Use browser_create once per window; choose mode temporary or persistent with a named profile, and headless true for background work or false for a visible window. Pass the returned browser_id to navigation, clicks, waits, screenshots and network tools. Use browser_close to close one window and browser_reopen to recover a closed ID. Closing all windows does not stop the agent. The window limit is reported by browser_list. '+
    'Temporary sessions start clean after closing; persistent profiles keep site storage and can be opened by name after an agent restart. IDs do not survive agent restart. Different profiles do not share cookies or local storage. Browser pages run simultaneously; commands are serialized. '+
    'Use browser_open for HTTP(S) navigation in an existing window, not for creating additional windows. For a running command, use command_result with its command ID instead of repeating the action. Use network_capture_window for multi-action capture; network_events returns the retained sanitized events. '+
    'For demo/test automation use browser_sequence or parallel_branches to reduce round trips. They return job_id; query command_result(id=job_id), never repeat an uncertain action. network_capture_window spans many steps, with filters and deferred bodies. dom_snapshot identifies actual elements; canvas interiors require visual interpretation. browser_inspect is structured read-only inspection, not arbitrary JS. Replay can change state and is limited to same-origin captured requests. spin_until requires explicit conditions and iteration limits. branch_matrix needs explicit setup; cookies do not clone game/server state. No real-money or prize gambling automation. Use history_export for sanitized Resultados evidence and artifact_get for individual screenshots. No typing, arbitrary JavaScript or shell tools are provided. Tools control Firetrace browsers, not arbitrary desktop applications. Refresh the MCP catalog after upgrades.'
  });
  const register = (name, description, inputSchema, readOnly, handler) => server.registerTool(name, {
    description, inputSchema, annotations:annotations(readOnly),
    _meta:{securitySchemes:[{type:'oauth2',scopes:['browser:control']}]},
  }, async args => {
    try { return await handler(args); }
    catch(error) { return {...text({error:error.message}),isError:true}; }
  });
  register('browser_status','Read the Firetrace agent connection and current browser state.',{},true,async()=>text(await readState(env)));
  register('browser_create','Create an independent Chromium browser/process, visible or headless. Call multiple times for simultaneous programs, up to the configured limit. Temporary sessions discard data on close; persistent sessions retain a named profile across restarts. Returns browser_id for subsequent actions. Does not attach to personal Chrome.',{headless,mode:z.enum(['temporary','persistent']).default('temporary'),profile:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional().describe('Required for persistent mode; omitted for temporary. An active profile cannot be opened twice.')},false,async args=>text(await runCommand(env,'browser_create',args)));
  register('browser_list','List open/closed browser sessions, IDs, saved persistent profiles and the concurrent window limit. Works even when all windows are closed.',{},true,async()=>text(await runCommand(env,'browser_list')));
  register('browser_close','Close only this browser. Temporary data is discarded; persistent profiles remain available. Firetrace and other windows stay connected.',{browser_id:browserId},false,async args=>text(await runCommand(env,'browser_close',args)));
  register('browser_reopen','Reopen a closed browser_id; optionally select headless. Close first before changing visibility. Temporary sessions start clean; persistent sessions reuse their profile. After agent restart, use browser_create with the saved profile name from browser_list.',{browser_id:browserId,headless},false,async args=>text(await runCommand(env,'browser_reopen',args)));
  register('browser_open','Navigate the selected browser to an HTTP(S) URL. Use browser_create to add another independent window. Without browser_id, uses the sole open window or creates the initial temporary window.',{...target,url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol),'HTTP(S) URL required')},false,async args=>text(await runCommand(env,'open',args)));
  register('browser_click','Click viewport pixel coordinates. May submit forms or trigger transactions; use only for the requested action.',{...target,x:z.number().min(0),y:z.number().min(0)},false,async args=>text(await runCommand(env,'click',args)));
  register('browser_click_relative','Click normalized viewport coordinates between 0 and 1. May trigger transactions.',{...target,rx:z.number().min(0).max(1),ry:z.number().min(0).max(1)},false,async args=>text(await runCommand(env,'click_relative',args)));
  register('browser_wait','Wait briefly for the browser page to settle.',{...target,ms:z.number().int().min(0).max(10000).default(1000)},false,async args=>text(await runCommand(env,'wait',args)));
  register('browser_screenshot','Capture the selected browser viewport and return a JPEG image.',{...target,quality:z.number().int().min(20).max(90).default(65)},true,async args=>{
    const result=await runCommand(env,'screenshot',args);
    if(result.status!=='done') return text(result);
    const shot=await screenshotForCommand(env,result.id);
    let binary='';
    for(let i=0;i<shot.bytes.length;i+=8192) binary+=String.fromCharCode(...shot.bytes.subarray(i,i+8192));
    return {content:[{type:'image',mimeType:'image/jpeg',data:btoa(binary)}]};
  });
  register('network_events','Read captured browser network events, with sensitive headers redacted.',target,true,async args=>text(await runCommand(env,'network_events',args)));
  register('network_clear','Clear the browser network capture buffer.',target,false,async args=>text(await runCommand(env,'network_clear',args)));
  register('trigger_and_capture','Click and capture matching HTTP requests/responses. The click may trigger a transaction; only use for an explicitly requested action.',{
    ...target,url_contains:z.string().min(1).max(2000),rx:z.number().min(0).max(1),ry:z.number().min(0).max(1),wait_ms:z.number().int().min(0).max(10000).default(2500),
  },false,async args=>text(await runCommand(env,'trigger_and_capture',args)));
  register('command_result','Read a previously submitted command result without repeating the action.',{id:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)},true,async({id})=>{
    if(/^[a-f0-9]{32}$/.test(id)) return text(await runCommand(env,'job_result',{job_id:id},true));
    return text(await readCommand(env,id));
  });
  registerAutomation(register,env);
  return server;
}

export async function handleMcp(request,env) {
  const server=createServer(env);
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  return transport.handleRequest(request);
}
