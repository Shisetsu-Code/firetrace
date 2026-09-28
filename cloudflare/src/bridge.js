export async function controlRequest(env, path, body) {
  if (!env.CONTROL_TOKEN) throw new Error('Control service is not configured');
  const response = await env.CONTROL.fetch(new Request(`https://control.internal${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-control-token': env.CONTROL_TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(28000),
  }));
  if (!response.ok) throw new Error(`Control service returned HTTP ${response.status}`);
  return response;
}

export async function readState(env) {
  return (await controlRequest(env, '/api/state?agent_id=firetrace')).json();
}

export async function runCommand(env, action, args = {}) {
  const {state} = await readState(env);
  if (!state?.connected || !Number.isFinite(state.last_seen) || Date.now() - state.last_seen > 60000) {
    throw new Error('Firetrace agent not connected. Start the Firetrace worker on your PC.');
  }
  return (await controlRequest(env, '/api/rpc', {
    id: crypto.randomUUID(), agent_id: 'firetrace', action, args, wait_ms: 25000,
  })).json();
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
