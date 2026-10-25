'use strict';

class CommandError extends Error {
  constructor(code, message) { super(message); this.name = 'CommandError'; this.code = code; }
}
const fail = (message) => { throw new CommandError('INVALID_COMMAND', message); };
const num = (value, name) => {
  if (value === '' || value == null || typeof value === 'boolean' || !Number.isFinite(Number(value))) fail(`${name} debe ser un número finito.`);
  return Number(value);
};
function httpURL(value) {
  let url; try { url = new URL(value); } catch { fail('Indicá una URL HTTP o HTTPS completa.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Usá una URL HTTP o HTTPS sin usuario/contraseña.');
  return url.href;
}
function parseCommand(input) {
  let c;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text.startsWith('{')) { try { return parseCommand(JSON.parse(text)); } catch (e) { if(e instanceof CommandError) throw e; fail('JSON inválido.'); } }
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) fail('Ingresá un comando.');
    const action = match[1].toLowerCase(), rest = match[2] || '', args = rest.split(/\s+/).filter(Boolean);
    c = { action };
    switch(action) {
      case 'goto': case 'open': c.url = rest; break;
      case 'click':
        if(args.length === 1) c.id = args[0];
        else if(args.length === 2 && args.every(v=>Number.isFinite(Number(v)))) { c.x=Number(args[0]); c.y=Number(args[1]); }
        else fail('click ID o click X Y: coordenadas numéricas.');
        break;
      case 'move': if(args.length!==2) fail('move X Y'); c.x=args[0]; c.y=args[1]; break;
      case 'scroll': if(args.length<1 || args.length>2) fail('scroll DY [DX]'); c.dy=args[0]; c.dx=args[1]||0; break;
      case 'type': c.text=rest; break;
      case 'press': c.key=rest; break;
      case 'wait': c.ms=rest; break;
      case 'resize': if(args.length!==2) fail('resize ANCHO ALTO'); c.width=args[0]; c.height=args[1]; break;
      case 'switch': c.index=rest; break;
      case 'newtab': if(rest)c.url=rest; break;
      case 'verify': case 'observe': case 'detect': if(rest==='vision')c.vision=true; else if(rest)fail('verify [vision]'); break;
      default: if(rest)fail(`El comando ${action} no acepta argumentos.`);
    }
  } else if(input && typeof input === 'object' && !Array.isArray(input)) c={...input};
  else fail('El comando debe ser texto o un objeto JSON.');
  c.action = String(c.action || '').toLowerCase();
  if(c.action==='open')c.action='goto';
  if(c.action==='detect'||c.action==='observe')c.action='verify';
  const known = ['goto','verify','snapshot','click','move','scroll','type','press','wait','resize','back','forward','reload','tabs','newtab','switch','close','export','help'];
  if(!known.includes(c.action))fail(`Comando desconocido: ${c.action}. Usá help.`);
  if(c.action==='goto' || (c.action==='newtab'&&c.url)) c.url=httpURL(c.url);
  if(c.action==='click') {
    if(c.id!=null) { if(typeof c.id!=='string'||!/^b\d{1,4}$/.test(c.id))fail('ID de botón inválido.'); if(c.x!=null||c.y!=null)fail('Usá ID o coordenadas, no ambos.'); }
    else { c.x=num(c.x,'x'); c.y=num(c.y,'y'); }
  }
  if(c.action==='move'){c.x=num(c.x,'x');c.y=num(c.y,'y');}
  if(c.action==='scroll'){c.dy=num(c.dy,'dy');c.dx=num(c.dx??0,'dx');if(Math.abs(c.dx)>10000||Math.abs(c.dy)>10000)fail('Desplazamiento máximo: 10000 px.');}
  if(c.action==='type'){if(typeof c.text!=='string'||c.text.length>20000)fail('type requiere texto de hasta 20000 caracteres.');}
  if(c.action==='press'){if(typeof c.key!=='string'||!c.key||c.key.length>80)fail('press requiere una tecla, por ejemplo Enter o Control+A.');}
  if(c.action==='wait'){c.ms=num(c.ms,'ms');if(c.ms<0||c.ms>30000)fail('wait acepta entre 0 y 30000 ms.');}
  if(c.action==='resize') {
    c.width=num(c.width,'width');c.height=num(c.height,'height');
    if(!Number.isInteger(c.width)||!Number.isInteger(c.height)||c.width<320||c.width>2560||c.height<240||c.height>1440)fail('resize: ancho 320–2560 y alto 240–1440, enteros.');
  }
  if(c.action==='switch'){c.index=num(c.index,'index');if(!Number.isInteger(c.index)||c.index<0)fail('Índice de pestaña inválido.');}
  if(c.vision!=null && typeof c.vision!=='boolean')fail('vision debe ser booleano.');
  if(c.vision&&c.action!=='verify')fail('La visión sólo se activa mediante verify vision.');
  if(c.observationId!=null&&(typeof c.observationId!=='string'||c.observationId.length>100))fail('observationId inválido.');
  return c;
}
const HELP = [
  'goto https://sitio.example','verify','verify vision','detect','snapshot','click b1','click 650 420',
  'move 650 420','scroll 500','type texto con espacios','press Enter','wait 1000',
  'back','forward','reload','resize 1280 720','tabs','newtab https://sitio.example','switch 0','close','export'
];
module.exports={parseCommand,CommandError,httpURL,HELP};
