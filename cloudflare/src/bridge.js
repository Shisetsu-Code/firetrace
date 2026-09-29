export async function controlRequest(env, path, body) {
  if (!env.CONTROL_TOKEN) throw new Error('Control service is not configured');
  const response = await env.CONTROL.fetch(new Request(`https://control.internal${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-control-token': env.CONTROL_TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(28000),
  }));
  if (!response.ok) {
    if(path==='/api/rpc' && response.status===502) {
      const data=await response.json().catch(()=>null);
      // Expose only fixed messages for known lifecycle errors, never raw upstream
      // bodies (which can contain paths, URLs, or credentials).
      const messages = {
        'Browser window closed':'Browser window closed. Use browser_reopen with its browser_id.',
        'Unknown browser_id':'Unknown browser_id. Use browser_list to find current IDs.',
        'Multiple windows open':'Multiple windows open. Specify browser_id from browser_list.',
        'No open window':'No open window. Use browser_create or browser_reopen.',
        'Browser limit reached':'Browser limit reached. Use browser_list and close an unused browser.',
        'Persistent profile is already open':'Persistent profile is already open. Use its browser_id from browser_list.',
        'profile must be':'Persistent mode requires a valid lowercase profile name.',
        'profile is only valid':'Only persistent mode accepts a profile name.',
        'Reserved profile name':'Choose another profile name; this name is reserved by Windows.',
      };
      for(const [prefix,message] of Object.entries(messages)) {
        if(data?.status==='error' && data.error?.startsWith(`ValueError: ${prefix}`)) throw new Error(message);
      }
    }
    throw new Error(`Control service returned HTTP ${response.status}`);
  }
  return response;
}

export async function readState(env) {
  return (await controlRequest(env, '/api/state?agent_id=firetrace')).json();
}

export async function readCommand(env,id) {
  const data=await (await controlRequest(env,`/api/command/${encodeURIComponent(id)}`)).json();
  const command=data.command;
  if(command?.agent_id!=='firetrace' || command.id!==id) throw new Error('Command not found');
  // The legacy control worker can process "started" after "result". A recorded
  // finish and result are authoritative; never resubmit a completed action.
  if(Number.isFinite(command.finished_at) && ['running','sent','queued'].includes(command.status)) {
    if(command.error) command.status='error';
    else if(command.result!==null && command.result!==undefined) command.status='done';
  }
  return data;
}

export async function runCommand(env, action, args = {}) {
  const {state} = await readState(env);
  if (!state?.connected || !Number.isFinite(state.last_seen) || Date.now() - state.last_seen > 60000) {
    throw new Error('Firetrace agent not connected. Start the Firetrace worker on your PC.');
  }
  const response=await (await controlRequest(env, '/api/rpc', {
    id: crypto.randomUUID(), agent_id: 'firetrace', action, args, wait_ms: 25000,
  })).json();
  if(response.status==='running') {
    const {command}=await readCommand(env,response.id);
    if(command.status==='done') return {ok:true,id:response.id,status:'done',result:command.result};
    if(command.status==='error') throw new Error('Browser command failed. Inspect browser_list before retrying.');
  }
  return response;
}

export async function screenshotForCommand(env, id) {
  // R2 writes can finish after the command result; wait for this specific event.
  for(let attempt=0;attempt<20;attempt++) {
    const row=await env.DB.prepare("SELECT payload_json FROM events WHERE agent_id = ? AND command_id = ? AND type = 'screenshot' ORDER BY seq DESC LIMIT 1").bind('firetrace',id).first();
    if(row) {
      const key=JSON.parse(row.payload_json).key;
      if(!key?.startsWith('screenshots/firetrace/')) throw new Error('Invalid screenshot key');
      const object=await env.SCREENSHOTS.get(key);
      if(object) return {bytes:new Uint8Array(await object.arrayBuffer())};
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Screenshot upload is not ready. Request another screenshot.');
}
