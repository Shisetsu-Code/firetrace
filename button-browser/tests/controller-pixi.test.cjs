const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {BrowserController}=require('../src/browser.cjs');

test('controller crops and clicks an actual Pixi polygon at its reachable point',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bb-pixi-controller-'));
  const controller=new BrowserController({artifactDir:dir});
  t.after(async()=>{await controller.close();await fs.rm(dir,{recursive:true,force:true});});
  await controller.start();
  await controller.page.setContent('<style>body{margin:0}</style>');
  const pixiPath=path.resolve(path.dirname(require.resolve('pixi.js')),'../browser/pixi.js');
  await controller.page.addScriptTag({path:pixiPath});
  await controller.page.evaluate(()=>{
    const P=window.PIXI,renderer=new P.Renderer({width:400,height:250});document.body.append(renderer.view);
    const stage=new P.Container(),button=new P.Graphics().beginFill(0x19b08f).drawRect(0,0,100,40).endFill();
    button.position.set(80,60);button.name='Canvas action';button.interactive=true;button.buttonMode=true;
    button.hitArea=new P.Polygon([0,0,100,0,0,20]);button.on('pointertap',()=>window.actualClicks=(window.actualClicks||0)+1);
    stage.addChild(button);renderer.render(stage);window.PIXI=undefined;
  });
  const obs=await controller.observe(),button=obs.buttons.find(b=>b.label==='Canvas action');
  assert(button);assert.equal(button.source,'pixi');
  assert(button.clickPoint.x<button.center.x&&button.clickPoint.y<button.center.y);
  const result=await controller.execute({action:'click',id:button.id,observationId:obs.observationId});
  assert.equal(result.result.clicked,button.id);
  assert.equal(await controller.page.evaluate(()=>window.actualClicks),1);
  assert((await fs.stat(path.join(dir,obs.observationId,`${button.id}.png`))).size>0);
});
