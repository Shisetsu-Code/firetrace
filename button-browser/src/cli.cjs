#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const readline = require('node:readline');

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseOptions(argv, env) {
  const options = { url: env.BUTTON_BROWSER_URL || 'http://127.0.0.1:8766', token: env.BUTTON_BROWSER_TOKEN || '', command: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--') {
      options.command = argv.slice(index + 1).join(' ');
      break;
    }
    if (argument === '--url' || argument === '--token') {
      if (index + 1 >= argv.length) throw cliError('CLI_USAGE', `Falta el valor de ${argument}.`);
      options[argument.slice(2)] = argv[++index];
    } else if (argument.startsWith('--url=') || argument.startsWith('--token=')) {
      const equals = argument.indexOf('=');
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
    } else if (argument.startsWith('--')) {
      throw cliError('CLI_USAGE', 'Opción desconocida. Usa --url, --token o --help.');
    } else {
      options.command = argv.slice(index).join(' ');
      break;
    }
  }
  let url;
  try {
    url = new URL(options.url);
  } catch {
    throw cliError('CLI_USAGE', 'La URL del servicio debe ser HTTP o HTTPS.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw cliError('CLI_USAGE', 'La URL del servicio debe usar HTTP o HTTPS sin credenciales en la URL.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api/command') ? path : `${path}/api/command`;
  url.hash = '';
  options.endpoint = url;
  if (/[\r\n\u0000]/.test(options.token)) throw cliError('CLI_USAGE', 'El token de acceso no es válido.');
  return options;
}

function parseRequest(line) {
  const text = line.trim();
  if (!text) return null;
  let command = text;
  let commandId;
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw cliError('CLI_JSON', 'El comando no contiene JSON válido.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw cliError('CLI_JSON', 'El comando JSON debe ser un objeto.');
    }
    if (Object.hasOwn(parsed, 'command')) {
      command = parsed.command;
      commandId = parsed.commandId;
    } else {
      command = parsed;
    }
  }
  if ((typeof command !== 'string' || !command.trim()) && (!command || typeof command !== 'object' || Array.isArray(command))) {
    throw cliError('CLI_JSON', 'command debe ser texto o un objeto de comando.');
  }
  if (commandId !== undefined && (typeof commandId !== 'string' || !commandId.trim() || commandId.length > 100 || /[\p{Cc}\p{Cf}]/u.test(commandId))) {
    throw cliError('CLI_JSON', 'commandId debe ser un identificador de texto no vacío de hasta 100 caracteres.');
  }
  return { command, commandId: commandId ?? randomUUID() };
}

async function submit(request, options) {
  const headers = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetch(options.endpoint, { method: 'POST', headers, body: JSON.stringify(request), redirect: 'error' });
  } catch {
    throw cliError('CLI_NETWORK', 'No se pudo conectar con Button Browser. Comprueba la URL y que el servidor esté iniciado.');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw cliError('CLI_RESPONSE', `El servidor devolvió una respuesta que no es JSON válido (HTTP ${response.status}).`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.ok !== 'boolean') {
    throw cliError('CLI_RESPONSE', 'El servidor devolvió JSON sin el campo booleano ok esperado.');
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!response.ok || !payload.ok) {
    const code = typeof payload.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`;
    const message = typeof payload.error?.message === 'string' ? payload.error.message : 'El servidor rechazó el comando.';
    throw cliError(code, message);
  }
}

function report(error, token) {
  let text = `Error [${error.code || 'CLI_ERROR'}]: ${error.message || 'Error inesperado.'}`;
  if (token) text = text.split(token).join('[redacted]');
  process.stderr.write(`${text.replace(/[\r\n]+/g, ' ')}\n`);
}

async function runCli(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    report(error, env.BUTTON_BROWSER_TOKEN);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${JSON.stringify({ usage: 'node src/cli.cjs [--url URL] [--token TOKEN] [comando texto...]', stdin: 'Sin comando, lee un comando de texto u objeto JSON por línea.', environment: ['BUTTON_BROWSER_URL', 'BUTTON_BROWSER_TOKEN'], examples: ['npm run cli -- "goto https://example.com"', 'echo \'{"action":"observe","vision":true}\' | node src/cli.cjs'] })}\n`);
    return 0;
  }
  let exitCode = 0;
  async function handle(line) {
    try {
      const request = parseRequest(line);
      if (request) await submit(request, options);
    } catch (error) {
      report(error, options.token);
      exitCode = 1;
    }
  }
  if (options.command.trim()) {
    await handle(options.command);
  } else {
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) await handle(line);
  }
  return exitCode;
}

if (require.main === module) {
  runCli().then(code => { process.exitCode = code; }).catch(error => {
    report(error, process.env.BUTTON_BROWSER_TOKEN);
    process.exitCode = 1;
  });
}

module.exports = { runCli };
