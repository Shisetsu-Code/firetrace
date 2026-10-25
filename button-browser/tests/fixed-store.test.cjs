const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');

let api={};
try {api=require('../src/fixed-buttons.cjs');}
catch(error) {if(error.code!=='MODULE_NOT_FOUND'||!error.message.includes("'../src/fixed-buttons.cjs'"))throw error;}
const {FixedButtonStore,makeFixedContext,matchesFixedContext}=api;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
const observationId='b70c103e-8688-42f2-ac63-1c1dd4630614';

async function directory(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bb-fixed-store-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return path.join(root,'fixed-buttons');
}
function context(overrides={}) {
  assert.equal(typeof makeFixedContext,'function','fixed contexts must be implemented');
  return makeFixedContext({url:'https://demo.example/ContainerLauncher?gid=rise&practice=1',viewport:{width:1280,height:720},deviceScaleFactor:1,scroll:{x:0,y:0},...overrides});
}
function target(overrides={}) {
  return {label:'spinBtn',kind:'button',source:'pixi',bbox:{x:900,y:590,width:100,height:100},center:{x:950,y:640},clickPoint:{x:930.25,y:615.75},...overrides};
}
function input(overrides={}) {return {name:'Giro',button:target(),scope:context(),templatePNG:png,observationId,...overrides};}

test('fixed buttons persist their exact point and independent template across restart; reads stay lazy',async t=>{
  assert.equal(typeof FixedButtonStore,'function','persistent fixed-button store must be implemented');
  const dir=await directory(t),store=new FixedButtonStore(dir);
  assert.deepEqual(await store.list(),[]);
  await assert.rejects(fs.stat(dir),{code:'ENOENT'});
  const button=target();button._target={};button._target.circular=button;
  const saved=await store.add(input({button}));
  assert.equal(saved.id,'f1');assert.equal(saved.name,'Giro');
  assert.deepEqual(saved.clickPoint,{x:930.25,y:615.75});
  assert.notDeepEqual(saved.clickPoint,saved.center,'never replace a reachable polygon point with its center');
  assert.equal(saved.source,'fixed');assert.equal(saved.detectedSource,'pixi');
  assert.equal(saved.verification,'user-fixed');assert.equal(saved.fixed,true);
  assert.equal(saved.basedOnObservationId,observationId);
  assert.equal(saved.cropUrl,'/artifacts/fixed/f1.png');
  assert.deepEqual(await store.template(saved.id),png);
  const index=JSON.parse(await fs.readFile(path.join(dir,'index.json'),'utf8'));
  assert.equal(index.version,1);assert.equal(index.nextId,2);
  assert(!JSON.stringify(index).includes('_target'));
  const restart=new FixedButtonStore(dir),entries=await restart.list();
  assert.deepEqual(entries,[saved]);assert.deepEqual(await restart.template('f1'),png);
  entries[0].bbox.x=10;entries[0].scope.viewport.width=400;
  assert.deepEqual((await restart.list())[0],saved,'returned entries cannot mutate stored coordinates');
});

test('contexts separate games, layout and nonsecret query while ignoring parameter order and rotating credentials',()=>{
  const a=context({url:'https://demo.example/ContainerLauncher?gid=rise&practice=1&lang=en&session=TOPSECRET&token=ABC'});
  const b=context({url:'https://demo.example/ContainerLauncher?token=DIFFERENT&lang=en&practice=1&gid=rise&session=NEW'});
  assert.equal(typeof matchesFixedContext,'function');assert(matchesFixedContext(a,b));
  assert(!JSON.stringify(a).includes('TOPSECRET'));assert(!JSON.stringify(a).includes('ABC'));
  assert.equal(a.label,'https://demo.example/ContainerLauncher?gid=rise');
  const changed=[
    {url:'https://demo.example/ContainerLauncher?gid=other&practice=1&lang=en'},
    {url:'https://demo.example/ContainerLauncher?gid=rise&practice=0&lang=en'},
    {url:'https://demo.example/ContainerLauncher?gid=rise&practice=1&lang=en#purchase'},
    {url:'https://demo.example/ContainerLauncher?gid=rise&practice=1&lang=en&layout=mobile'},
    {viewport:{width:800,height:600}}, {deviceScaleFactor:2}, {scroll:{x:0,y:1}}
  ];
  for(const change of changed)assert(!matchesFixedContext(a,context({url:b.label+'&practice=1&lang=en',...change})),JSON.stringify(change));
  assert(!matchesFixedContext(a,null));
  const first=context({url:'https://demo.example/?gid=rise&gid=other'}),second=context({url:'https://demo.example/?gid=other&gid=rise'});
  assert(!matchesFixedContext(first,second),'duplicate parameter value order can change the selected game');
  assert.equal(context({url:'about:blank'}).label,'about:blank');
});

test('renaming and deleting persist without reusing a published fixed ID',async t=>{
  assert.equal(typeof FixedButtonStore,'function');
  const dir=await directory(t),store=new FixedButtonStore(dir);
  const first=await store.add(input());
  const renamed=await store.rename(first.id,'  Giro principal  ');
  assert.equal(renamed.name,'Giro principal');assert.deepEqual(renamed.clickPoint,first.clickPoint);
  assert.equal((await new FixedButtonStore(dir).list())[0].name,'Giro principal');
  const removed=await store.remove(first.id);assert.equal(removed.id,first.id);
  await assert.rejects(fs.stat(path.join(dir,'f1.png')),{code:'ENOENT'});
  const restart=new FixedButtonStore(dir);assert.deepEqual(await restart.list(),[]);
  const second=await restart.add(input({name:'Información'}));assert.equal(second.id,'f2');
  await assert.rejects(restart.template('f1'),e=>e.code==='UNKNOWN_FIXED_BUTTON');
  await assert.rejects(restart.remove('f1'),e=>e.code==='UNKNOWN_FIXED_BUTTON');
  await assert.rejects(restart.rename('../index','bad'),e=>e.code==='INVALID_FIXED_ID');
});

test('concurrent additions are serialized and preserve every committed ID',async t=>{
  assert.equal(typeof FixedButtonStore,'function');
  const dir=await directory(t),store=new FixedButtonStore(dir);
  const rows=await Promise.all(Array.from({length:8},(_,index)=>store.add(input({name:'Botón '+index}))));
  assert.deepEqual(rows.map(row=>row.id),['f1','f2','f3','f4','f5','f6','f7','f8']);
  const saved=await new FixedButtonStore(dir).list();assert.equal(saved.length,8);
  assert.deepEqual(new Set(saved.map(row=>row.name)),new Set(rows.map(row=>row.name)));
});

test('invalid geometry, names and templates are rejected without creating or changing data',async t=>{
  assert.equal(typeof FixedButtonStore,'function');
  const dir=await directory(t),store=new FixedButtonStore(dir);
  const bad=[
    input({name:'   '}),input({name:'x'.repeat(81)}),
    input({button:target({bbox:{x:1200,y:590,width:100,height:100}})}),
    input({button:target({clickPoint:{x:NaN,y:615}})}),
    input({button:target({clickPoint:{x:200,y:200}})}),
    input({button:target({clickPoint:undefined})}),
    input({templatePNG:Buffer.from('not a PNG')})
  ];
  for(const value of bad)await assert.rejects(store.add(value),error=>/^INVALID_FIXED_/.test(error.code));
  assert.deepEqual(await store.list(),[]);await assert.rejects(fs.stat(dir),{code:'ENOENT'});
  const saved=await store.add(input());
  await assert.rejects(store.rename(saved.id,''),e=>e.code==='INVALID_FIXED_NAME');
  assert.equal((await store.list())[0].name,saved.name);
});

test('corrupt indexes and invalid persisted coordinates are reported without rewriting their bytes',async t=>{
  assert.equal(typeof FixedButtonStore,'function');
  const dir=await directory(t);await fs.mkdir(dir);
  const file=path.join(dir,'index.json'),broken='{"version":1, broken';await fs.writeFile(file,broken);
  const failed=new FixedButtonStore(dir);
  await assert.rejects(failed.list(),e=>e.code==='FIXED_STORE_CORRUPT');
  await assert.rejects(failed.add(input()),e=>e.code==='FIXED_STORE_CORRUPT');
  assert.equal(await fs.readFile(file,'utf8'),broken);
  await fs.unlink(file);
  const good=new FixedButtonStore(dir);await good.add(input());
  const index=JSON.parse(await fs.readFile(file,'utf8'));index.buttons[0].bbox.x=-10;
  const invalid=JSON.stringify(index);await fs.writeFile(file,invalid);
  await assert.rejects(new FixedButtonStore(dir).list(),e=>e.code==='FIXED_STORE_CORRUPT');
  assert.equal(await fs.readFile(file,'utf8'),invalid);
});

test('a failed atomic index write leaves the published catalog unchanged and can be retried',async t=>{
  assert.equal(typeof FixedButtonStore,'function');
  const dir=await directory(t),store=new FixedButtonStore(dir);await store.list();
  await fs.mkdir(path.join(dir,'index.json'),{recursive:true});
  await assert.rejects(store.add(input()),e=>e.code==='FIXED_STORE_WRITE_FAILED');
  assert.deepEqual(await store.list(),[]);
  assert.equal((await fs.stat(path.join(dir,'index.json'))).isDirectory(),true,'failed writes do not remove conflicting user data');
  await fs.rmdir(path.join(dir,'index.json'));
  const saved=await store.add(input());assert.equal(saved.id,'f1');
  assert.equal((await new FixedButtonStore(dir).list()).length,1);
});

test('damaged template reads fail explicitly and do not delete the stored file',async t=>{
  assert.equal(typeof FixedButtonStore,'function');
  const dir=await directory(t),store=new FixedButtonStore(dir);await store.add(input());
  const file=path.join(dir,'f1.png');await fs.writeFile(file,'damaged image');
  await assert.rejects(new FixedButtonStore(dir).template('f1'),e=>e.code==='INVALID_FIXED_TEMPLATE');
  assert.equal(await fs.readFile(file,'utf8'),'damaged image');
});

test('persisted catalogs reject unexpected fields instead of carrying private transient data into exports',async t=>{
  const dir=await directory(t),store=new FixedButtonStore(dir);await store.add(input());
  const file=path.join(dir,'index.json'),original=JSON.parse(await fs.readFile(file,'utf8'));
  for(const insert of [index=>{index.buttons[0]._target={session:'private'};},index=>{index.buttons[0].scope.url='https://demo.example/?token=private';}]) {
    const changed=JSON.parse(JSON.stringify(original));insert(changed);
    const bytes=JSON.stringify(changed);await fs.writeFile(file,bytes);
    await assert.rejects(new FixedButtonStore(dir).list(),e=>e.code==='FIXED_STORE_CORRUPT');
    assert.equal(await fs.readFile(file,'utf8'),bytes,'unsupported metadata stays untouched for the owner to inspect');
  }
});
