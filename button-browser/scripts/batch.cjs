'use strict';
// Runs an explicit command list on a server/CI runner. No automatic game actions.
const fs=require('node:fs/promises');
const path=require('node:path');
const {BrowserController}=require('../src/browser.cjs');
(async()=>{
  const input=process.argv[2];if(!input)throw new Error('Uso: node scripts/batch.cjs commands.json');
  const commands=JSON.parse(await fs.readFile(input,'utf8'));
  if(!Array.isArray(commands)||commands.length>200)throw new Error('Se requiere un array de hasta 200 comandos.');
  const browser=new BrowserController({artifactDir:path.resolve('data/observations')});
  try {
    await browser.start();
    for(const command of commands){const response=await browser.execute(command);process.stdout.write(JSON.stringify({ok:true,...response})+'\n');}
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
