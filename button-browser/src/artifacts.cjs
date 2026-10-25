'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const {createCoordinateSVG}=require('./overlay.cjs');
const xml=text=>String(text).toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const rounded=value=>Math.round(value*100)/100;
function pixelBox(box,width,height) {
  const left=Math.max(0,Math.floor(box.x)),top=Math.max(0,Math.floor(box.y));
  const right=Math.min(width,Math.ceil(box.x+box.width)),bottom=Math.min(height,Math.ceil(box.y+box.height));
  return {left,top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
}
async function saveObservation({directory,png,observation,candidates}) {
  const {width,height}=observation.viewport,base=`/artifacts/${observation.observationId}`;
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'screenshot.png'),png);
  const buttons=[],crops=[];
  for(let index=0;index<candidates.length;index++) {
    const c=candidates[index],id=`b${index+1}`,box=pixelBox(c.bbox,width,height);
    const crop=await sharp(png).extract(box).png().toBuffer();
    await fs.writeFile(path.join(directory,`${id}.png`),crop);crops.push(crop);
    const bbox=Object.fromEntries(Object.entries(c.bbox).map(([k,v])=>[k,rounded(v)]));
    const clickPoint=[c.clickPoint,c.center,{x:c.bbox.x+c.bbox.width/2,y:c.bbox.y+c.bbox.height/2}].find(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y));
    buttons.push({id,label:String(c.label||'Control').slice(0,160),kind:c.kind||'button',source:c.source,confidence:c.confidence,
      actionable:c.actionable!==false,estimated:!!c.estimated,bbox,
      center:{x:rounded(c.bbox.x+c.bbox.width/2),y:rounded(c.bbox.y+c.bbox.height/2)},
      clickPoint:{x:rounded(clickPoint.x),y:rounded(clickPoint.y)},
      normalized:{x:Number((c.bbox.x/width).toFixed(6)),y:Number((c.bbox.y/height).toFixed(6)),width:Number((c.bbox.width/width).toFixed(6)),height:Number((c.bbox.height/height).toFixed(6))},
      cropUrl:`${base}/${id}.png`});
  }
  const overlay=Buffer.from(createCoordinateSVG([...(observation.fixedButtons||[]),...buttons],observation.viewport));
  await sharp(png).composite([{input:overlay}]).png().toFile(path.join(directory,'annotated.png'));
  const columns=4,cellW=260,cellH=130,sheetW=columns*cellW,sheetH=Math.max(cellH,Math.ceil(crops.length/columns)*cellH);
  const pieces=[];
  for(let i=0;i<crops.length;i++) {
    const left=(i%columns)*cellW,top=Math.floor(i/columns)*cellH,b=buttons[i];
    const thumb=await sharp(crops[i]).resize({width:cellW-24,height:78,fit:'contain',background:'#14202b'}).png().toBuffer();
    pieces.push({input:thumb,left:left+12,top:top+8});
    const label=Buffer.from(`<svg width="${cellW}" height="42" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" fill="#e4eef5" font-size="12" font-family="sans-serif">${xml((b.id+' · '+b.label).slice(0,32))}</text><text x="12" y="34" fill="#90a8bc" font-size="11" font-family="sans-serif">x ${b.clickPoint.x} · y ${b.clickPoint.y} · ${xml(b.source)}</text></svg>`);
    pieces.push({input:label,left,top:top+86});
  }
  await sharp({create:{width:sheetW,height:sheetH,channels:3,background:'#101923'}}).composite(pieces).png().toFile(path.join(directory,'buttons.png'));
  Object.assign(observation,{buttons,screenshotUrl:`${base}/screenshot.png`,annotatedUrl:`${base}/annotated.png`,contactSheetUrl:`${base}/buttons.png`,jsonUrl:`${base}/buttons.json`});
  await fs.writeFile(path.join(directory,'buttons.json'),JSON.stringify(observation,null,2));
  return observation;
}
async function cropDifference(before,after,bbox,viewport) {
  const box=pixelBox(bbox,viewport.width,viewport.height);
  const raw=async bytes=>sharp(bytes).extract(box).resize(32,32,{fit:'fill'}).removeAlpha().raw().toBuffer();
  const [a,b]=await Promise.all([raw(before),raw(after)]);let sum=0;
  for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/(a.length*255);
}
module.exports={saveObservation,pixelBox,cropDifference};
