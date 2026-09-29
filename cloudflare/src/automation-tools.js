import {z} from 'zod';
import {runCommand} from './bridge.js';
const id=z.string().regex(/^[a-f0-9]{32}$/);
const target={browser_id:id};
const filters=z.object(Object.fromEntries(['method','domain','path','resource_type','content_type'].map(k=>[k,z.union([z.string().min(1).max(500),z.array(z.string().min(1).max(500)).max(20)]).optional()]))).strict();
const condition=z.object({path:z.string().max(500).default(''),op:z.enum(['exists','equals','type','range','length']),value:z.unknown().optional(),min:z.number().optional(),max:z.number().optional()}).strict();
const step=z.discriminatedUnion('action',[
 z.object({action:z.literal('open'),args:z.object({url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol))}).strict()}),
 z.object({action:z.literal('click'),args:z.object({x:z.number().min(0).max(100000),y:z.number().min(0).max(100000)}).strict()}),
 z.object({action:z.literal('click_relative'),args:z.object({rx:z.number().min(0).max(1),ry:z.number().min(0).max(1)}).strict()}),
 z.object({action:z.literal('click_element'),args:z.object({snapshot_id:id,element_id:id}).strict()}),
 z.object({action:z.literal('wait'),args:z.object({ms:z.number().int().min(0).max(10000).default(1000)}).strict().optional()}),
 z.object({action:z.literal('screenshot'),args:z.object({quality:z.number().int().min(20).max(90).optional()}).strict().optional()}),
 z.object({action:z.literal('capture_start'),args:z.object({filters:filters.optional()}).strict().optional()}),
 z.object({action:z.literal('capture_stop'),args:z.object({capture_id:id.optional()}).strict().optional()}),
 z.object({action:z.literal('checkpoint'),args:z.object({label:z.string().min(1).max(120)}).strict()}),
 z.object({action:z.literal('dom_snapshot'),args:z.object({}).strict().optional()}),
 z.object({action:z.literal('inspect'),args:z.object({query:z.enum(['document','frames','storage_names'])}).strict()}),
 z.object({action:z.literal('status'),args:z.object({}).strict().optional()}),
]);
const steps=z.array(step).min(1).max(20);
const timeout_ms=z.number().int().min(1).max(300000).default(120000);
const text=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

export function registerAutomation(register,env){
 const add=(name,description,schema,readOnly=false)=>register(name,description,schema,readOnly,async args=>text(await runCommand(env,name,args,true)));
 add('browser_sequence','Execute up to 20 prevalidated steps in order on one browser. Returns job_id immediately; use command_result(id=job_id) to observe, never resubmit. Screenshots return artifact_id; retrieve with artifact_get. Demo/test automation only.',{...target,steps,timeout_ms,label:z.string().min(1).max(120).optional()});
 add('parallel_branches','Run labeled demo/test sequences concurrently on distinct browsers. Reserve each browser for its whole branch; duplicate or busy targets fail before effects. Existing clients must already be prepared, or include explicit open/setup steps. No automatic session/state cloning. Returns job_id.',{branches:z.array(z.object({label:z.string().min(1).max(120),browser_id:id.optional(),steps}).strict()).min(1).max(32),browser_ids:z.array(id).min(1).max(32).optional(),timeout_ms});
 add('network_capture_window','Start, stop or inspect a bounded network capture spanning multiple actions. Start returns capture_id; stop closes collection, completed bodies remain locally available for 15 minutes. At most 200 requests and 1 MiB/body; unsupported bodies are explicitly unavailable.',{...target,operation:z.enum(['start','stop','status']),capture_id:id.optional(),filters:filters.optional()});
 add('network_filter','Configure filters for the next capture while no capture is active. AND across fields, OR within field. domain is exact hostname; path is a prefix; content_type is matched on response.',{...target,filters});
 add('network_get_response_body','Read a sanitized body by request_id from this browser. Does not replay requests. May be expired, unavailable, binary-omitted or too large.',{...target,request_id:id},true);
 add('dom_snapshot','Inspect up to 500 interactive DOM elements across frames: text/aria, bounding boxes, enabled/visible, and element_id bound to snapshot_id. Canvas is a surface, not inferred internal controls. Navigation invalidates IDs.',target,true);
 add('interactive_elements','Alias of dom_snapshot: inspect interactive elements with IDs and bounding boxes.',target,true);
 add('browser_click_element','Click the actual element identified by snapshot_id and element_id. Stale or unavailable elements fail; no fallback to guessed coordinates.',{...target,snapshot_id:id,element_id:id});
 add('browser_inspect','Read a fixed structured query: document metadata, frame list or storage key names. Does not accept arbitrary JavaScript or return storage values.',{...target,query:z.enum(['document','frames','storage_names'])},true);
 add('iframe_list','List current frames and IDs with sanitized URLs. Frame IDs can be passed to iframe_open_direct.',target,true);
 add('iframe_open_direct','Open a selected frame HTTP(S) URL in a NEW isolated browser. Does not clone parent messages, cookies, memory or game state; may not reproduce the embedded application.',{...target,frame_id:id,headless:z.boolean().optional()});
 add('spin_until','Demo/test transitions only. Repeat explicit steps until a declarative condition over the iteration result matches, or a mandatory iteration/time bound stops it. Never searches for wins or adjusts wagers. Unknown conditions stop. Returns job_id.',{...target,steps,condition,max_iterations:z.number().int().min(1).max(100),timeout_ms});
 add('request_replay','Reissue a known captured demo/test HTTP request using only its originating live browser session. This can change server state. No automatic retries, cross-origin destinations or redirects. Signatures/nonces may have expired.',{...target,request_id:id});
 add('request_replay_from_template','Replay from a captured request with method/url/headers/body overrides. Same-origin only; {$ref: reference} resolves locally from session_context and never exports its value. Cookies stay in Chromium. No retries or redirects.',{...target,request_id:id,template:z.object({method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']).optional(),url:z.url().optional(),headers:z.record(z.string(),z.union([z.string(),z.object({$ref:id}).strict()])).optional(),body:z.unknown().optional()}).strict()});
 add('validate_response','Check captured sanitized response status/body with required paths, types, equals, ranges or lengths. Paths are dot separated, arrays use numeric indexes. Missing evidence is unknown. Does not execute JavaScript.',{...target,request_id:id,checks:z.array(condition).min(1).max(50)},true);
 add('session_context','Read cookie/header names, scopes and availability; never returns cookie/token values or their hashes. Opaque header refs are usable only in the same local session/origin for 15 minutes.',target,true);
 add('state_checkpoint','Label observed UI state and associate screenshot/network request IDs. An evidence marker, not a restorable clone of server/game state.',{...target,label:z.string().min(1).max(120)});
 add('branch_matrix','Execute a finite labeled demo/test tree over the selected available sessions. Each leaf replays its root-to-leaf path; explicit setup_steps and precondition must establish the desired state. No hidden state cloning. At most 100 nodes and depth 10; coverage counts requested leaves.',{browser_ids:z.array(id).min(1).max(32),nodes:z.array(z.object({label:z.string().min(1).max(120),parent:z.string().min(1).max(120).optional(),steps,setup_steps:steps.optional(),precondition:condition.optional()}).strict()).min(1).max(100),timeout_ms});
 add('job_cancel','Request cooperative cancellation of pending steps. An in-flight action may already have happened; cancellation is not rollback.',{job_id:id});
 register('artifact_get','Retrieve a step screenshot by artifact_id from the original browser. Does not capture again. Local artifacts expire after 15 minutes.',{...target,artifact_id:id},true,async args=>{
   const envelope=await runCommand(env,'artifact_get',args,true);
   if(envelope.status!=='done') return text(envelope);
   const artifact=envelope.result;
   if(artifact.mime==='image/jpeg') return {content:[{type:'image',mimeType:'image/jpeg',data:artifact.data}]};
   return text(envelope);
 });
 register('history_export','Export sanitized job actions, request/response evidence and artifact relationships as JSON or Markdown for Resultados. Does not write into arbitrary local directories.',{job_id:id,format:z.enum(['json','markdown']).default('json')},true,async args=>{
   const envelope=await runCommand(env,'history_export',args,true);
   if(envelope.status!=='done') return text(envelope);
   const data=envelope.result;
   const bytes=Uint8Array.from(atob(data.data),c=>c.charCodeAt(0));
   return {content:[{type:'text',text:new TextDecoder().decode(bytes)}]};
 });
}
