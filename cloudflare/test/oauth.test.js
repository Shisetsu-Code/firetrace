import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.wrangler/test/index.js',compatibilityDate:'2026-09-28',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],bindings:{PUBLIC_URL:'https://example.com',MCP_PASSWORD:'test-password'}}));
after(()=>mf.dispose());
test('MCP requires OAuth and advertises discovery without accessing the browser',async()=>{
  const response=await mf.dispatchFetch('https://example.com/mcp');
  assert.equal(response.status,401);
  assert.match(response.headers.get('www-authenticate'),/resource_metadata=/);
  const metadata=await mf.dispatchFetch('https://example.com/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadata.status,200);
  assert.equal((await metadata.json()).resource,'https://example.com/mcp');
});
test('authorization rejects cross-origin form submissions',async()=>{
  const response=await mf.dispatchFetch('https://example.com/authorize',{method:'POST',headers:{origin:'https://attacker.example'},body:'decision=approve'});
  assert.equal(response.status,403);
});
test('authorization rejects incorrect passwords',async()=>{
  const response=await mf.dispatchFetch('https://example.com/authorize',{method:'POST',headers:{origin:'https://example.com','content-type':'application/x-www-form-urlencoded'},body:'decision=approve&password=wrong&handle=invalid'});
  assert.equal(response.status,401);
});
