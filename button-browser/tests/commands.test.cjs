const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand } = require('../src/commands.cjs');

test('commands preserve URL queries and text, parse coordinates, reject missing args', () => {
  assert.deepEqual(parseCommand('goto https://example.test/?a=1&b=two'), { action: 'goto', url: 'https://example.test/?a=1&b=two' });
  assert.deepEqual(parseCommand('click 123.5 200'), { action: 'click', x: 123.5, y: 200 });
  assert.deepEqual(parseCommand('click b3'), { action: 'click', id: 'b3' });
  assert.deepEqual(parseCommand('type un texto con espacios'), { action: 'type', text: 'un texto con espacios' });
  assert.deepEqual(parseCommand('scroll -400 20'), { action: 'scroll', dy: -400, dx: 20 });
  assert.equal(parseCommand('{"action":"observe","vision":true}').vision, true);
  assert.equal(parseCommand('verify').action,'verify');
  assert.equal(parseCommand('detect').action,'verify');
  assert.equal(parseCommand('observe').action,'verify');
  assert.equal(parseCommand('snapshot').action,'snapshot');
  assert.throws(()=>parseCommand({action:'click',x:1,y:1,vision:true}),/verify vision/);
  assert.throws(() => parseCommand('resize 1280'), /resize/);
  assert.throws(() => parseCommand('click NaN 5'), /coordenadas/);
  assert.throws(() => parseCommand('goto javascript:alert(1)'), /HTTP/);
  assert.throws(() => parseCommand({action:'click',x:Infinity,y:2}), /finito/);
});

test('verify accepts explicit exact labels without treating them as patterns', () => {
  const labels = ['BET_DEC', 'bet_inc', 'BET_.*'];
  const parsed = parseCommand({action:'verify',excludeLabels:labels});
  assert.deepEqual(parsed.excludeLabels, ['BET_DEC', 'bet_inc', 'BET_.*']);
  labels.push('Changed later');
  assert.deepEqual(parsed.excludeLabels, ['BET_DEC', 'bet_inc', 'BET_.*']);
  assert.deepEqual(parseCommand('{"action":"verify","excludeLabels":["BET_DEC","BET_INC"]}').excludeLabels, ['BET_DEC', 'BET_INC']);
  assert.deepEqual(parseCommand({action:'verify',excludeLabels:[]}).excludeLabels, []);
  assert.equal(parseCommand({action:'verify',excludeLabels:['a'.repeat(160)]}).excludeLabels[0].length, 160);
  assert.equal(parseCommand({action:'verify',excludeLabels:Array.from({length:50},(_,index)=>`Control ${index}`)}).excludeLabels.length, 50);
});

test('excludeLabels rejects invalid arrays and commands other than verify', () => {
  for (const excludeLabels of [undefined,null,'BET_DEC',{},[null],[1],[{}],[/BET/],[''],['   '],['a'.repeat(161)],Array(51).fill('BET_DEC')]) {
    assert.throws(()=>parseCommand({action:'verify',excludeLabels}), /excludeLabels/);
  }
  for (const command of [{action:'snapshot'},{action:'click',x:1,y:2},{action:'goto',url:'https://example.test/'},{action:'wait',ms:0}]) {
    assert.throws(()=>parseCommand({...command,excludeLabels:['BET_DEC']}), /excludeLabels/);
  }
});

test('fixed button commands use permanent IDs and preserve a chosen name',()=>{
  assert.deepEqual(parseCommand('pin b3 Giro normal'),{action:'pin',id:'b3',name:'Giro normal'});
  assert.deepEqual(parseCommand('pin b3'),{action:'pin',id:'b3'});
  assert.deepEqual(parseCommand('pins'),{action:'pins'});
  assert.deepEqual(parseCommand('rename f12 Información'),{action:'rename',id:'f12',name:'Información'});
  assert.deepEqual(parseCommand('unpin f12'),{action:'unpin',id:'f12'});
  assert.deepEqual(parseCommand('click f12'),{action:'click',id:'f12'});
  assert.deepEqual(parseCommand({action:'pin',id:'b3',name:'  Giro  ',observationId:'current'}),{action:'pin',id:'b3',name:'Giro',observationId:'current'});
  for(const bad of ['pin f1','pin','unpin b1','unpin f1 extra','pins extra','rename f1','click f0','click f1000000'])assert.throws(()=>parseCommand(bad),e=>e.code==='INVALID_COMMAND');
  for(const bad of [{action:'pin',id:'b1',name:''},{action:'pin',id:'b1',name:'x'.repeat(81)},{action:'rename',id:'f1',name:9},{action:'click',id:'f1',observationId:'old'},{action:'pin',id:'b1',x:1,y:2}])assert.throws(()=>parseCommand(bad),e=>e.code==='INVALID_COMMAND');
});
