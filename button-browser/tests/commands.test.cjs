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
