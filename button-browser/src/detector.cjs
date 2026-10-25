'use strict';
const {installProbe}=require('./dom-probe.cjs');

function clipBox(box,area) {
  const x=Math.max(box.x,area.x||0),y=Math.max(box.y,area.y||0);
  const right=Math.min(box.x+box.width,(area.x||0)+area.width),bottom=Math.min(box.y+box.height,(area.y||0)+area.height);
  return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
}
function iou(a,b) {
  const intersection=clipBox(a,b); if(!intersection)return 0;
  const area=intersection.width*intersection.height;
  return area/(a.width*a.height+b.width*b.height-area);
}
async function ancestorVisible(frame, point, bbox) {
  let clipped=bbox;
  while(frame.parentFrame()) {
    let handle;
    try {
      handle=await frame.frameElement();
      const box=await handle.boundingBox();if(!box)return null;
      const metrics=await handle.evaluate(el=>({left:el.clientLeft,top:el.clientTop,width:el.clientWidth,height:el.clientHeight,outerWidth:el.offsetWidth,outerHeight:el.offsetHeight}));
      const sx=box.width/metrics.outerWidth,sy=box.height/metrics.outerHeight;
      const content={x:box.x+metrics.left*sx,y:box.y+metrics.top*sy,width:metrics.width*sx,height:metrics.height*sy};
      clipped=clipBox(clipped,content);if(!clipped)return null;
      if(!point){frame=frame.parentFrame();continue;}
      const hit=await handle.evaluate((el,{point,box})=>{
        const r=el.getBoundingClientRect();
        const x=r.x+(point.x-box.x)*r.width/box.width,y=r.y+(point.y-box.y)*r.height/box.height;
        let top=document.elementFromPoint(x,y),next;
        while(top?.shadowRoot&&(next=top.shadowRoot.elementFromPoint(x,y))&&top!==next)top=next;
        return top===el;
      },{point,box});
      if(!hit)return null;
    }catch{return null;}finally{await handle?.dispose().catch(()=>{});}
    frame=frame.parentFrame();
  }
  return clipped;
}
async function describeTarget(frame,key,viewport) {
  const meta=await frame.evaluate(key=>globalThis.__buttonBrowserProbe?.describe(key),key);
  if(!meta)return null;
  const handle=await frame.evaluateHandle(key=>globalThis.__buttonBrowserProbe?.targets.get(key),key);
  try {
    const box=await handle.asElement()?.boundingBox();if(!box)return null;
    const clipped=meta.visibleBox||meta.localBox,sx=box.width/meta.localBox.width,sy=box.height/meta.localBox.height;
    const visibleBox={x:box.x+(clipped.x-meta.localBox.x)*sx,y:box.y+(clipped.y-meta.localBox.y)*sy,width:clipped.width*sx,height:clipped.height*sy};
    let bbox=clipBox(visibleBox,{x:0,y:0,...viewport});if(!bbox)return null;
    bbox=await ancestorVisible(frame,null,bbox);if(!bbox)return null;
    const points=[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>({x:bbox.x+bbox.width*x,y:bbox.y+bbox.height*y}));
    for(const point of points) {
      const local={x:meta.localBox.x+(point.x-box.x)*meta.localBox.width/box.width,y:meta.localBox.y+(point.y-box.y)*meta.localBox.height/box.height};
      const ownHit=await frame.evaluate(({key,local})=>globalThis.__buttonBrowserProbe?.hitsTarget(key,local.x,local.y),{key,local});
      if(ownHit&&await ancestorVisible(frame,point,bbox))return {...meta,bbox,clickPoint:point};
    }
    return null;
  } finally { await handle.dispose(); }
}
// Check the already-verified viewport point only. This must never call the
// normal describe/collect path, whose purpose is to discover reachable points.
async function guardDOMTarget(frame,key,viewport,verifiedPoint) {
  if(!viewport||!Number.isFinite(viewport.width)||!Number.isFinite(viewport.height)||
    viewport.width<=0||viewport.height<=0||!verifiedPoint||!Number.isFinite(verifiedPoint.x)||!Number.isFinite(verifiedPoint.y)||
    verifiedPoint.x<0||verifiedPoint.y<0||verifiedPoint.x>=viewport.width||verifiedPoint.y>=viewport.height)return null;
  const inside=(point,box)=>box&&point.x>=box.x&&point.y>=box.y&&point.x<box.x+box.width&&point.y<box.y+box.height;
  const sameBox=(a,b)=>a&&b&&['x','y','width','height'].every(key=>Number.isFinite(a[key])&&Number.isFinite(b[key])&&Math.abs(a[key]-b[key])<1e-4);
  let handle;
  try {
    handle=await frame.evaluateHandle(key=>globalThis.__buttonBrowserProbe?.targets.get(key),key);
    const element=handle.asElement();if(!element)return null;
    const meta=await element.evaluate((el,key)=>globalThis.__buttonBrowserProbe?.inspectTarget(key,el),key);
    if(!meta)return null;
    const box=await element.boundingBox();
    if(!box||box.width<=0||box.height<=0||meta.localBox?.width<=0||meta.localBox?.height<=0)return null;
    const clipped=meta.visibleBox||meta.localBox,sx=box.width/meta.localBox.width,sy=box.height/meta.localBox.height;
    const visibleBox={x:box.x+(clipped.x-meta.localBox.x)*sx,y:box.y+(clipped.y-meta.localBox.y)*sy,width:clipped.width*sx,height:clipped.height*sy};
    let bbox=clipBox(visibleBox,{x:0,y:0,...viewport});if(!inside(verifiedPoint,bbox))return null;
    bbox=await ancestorVisible(frame,verifiedPoint,bbox);if(!inside(verifiedPoint,bbox))return null;
    const local={x:meta.localBox.x+(verifiedPoint.x-box.x)*meta.localBox.width/box.width,y:meta.localBox.y+(verifiedPoint.y-box.y)*meta.localBox.height/box.height};
    const current=await element.evaluate((el,{key,local})=>globalThis.__buttonBrowserProbe?.checkPoint(key,local.x,local.y,el),{key,local});
    if(!current||!sameBox(meta.localBox,current.localBox)||!sameBox(meta.visibleBox,current.visibleBox))return null;
    // Geometry changing during the guard invalidates it instead of triggering
    // a new conversion or another point search.
    if(!sameBox(box,await element.boundingBox()))return null;
    return {...current,bbox};
  } catch {return null;}
  finally {await handle?.dispose().catch(()=>{});}
}
async function detectDOMButtons(page,{includeDisabled=false,includeLinks=true}={}) {
  const buttons=[],warnings=[],viewport=page.viewportSize(),frames=page.frames();
  for(let frameIndex=0;frameIndex<frames.length;frameIndex++) {
    const frame=frames[frameIndex];
    try {
      await frame.evaluate(installProbe);
      const candidates=await frame.evaluate(options=>globalThis.__buttonBrowserProbe.collect(options),{includeDisabled,includeLinks});
      for(const meta of candidates) {
        const current=await describeTarget(frame,meta.key,viewport);
        if(!current)continue;
        buttons.push({label:current.label,kind:current.kind,source:'dom',confidence:meta.confidence,actionable:!current.disabled,
          estimated:!!meta.heuristic,bbox:current.bbox,clickPoint:current.clickPoint,targetKey:`dom:${frameIndex}:${meta.key}`,
          _target:{type:'dom',frame,key:meta.key}});
      }
    } catch(e) {warnings.push(`No se pudo inspeccionar un frame: ${e.message.split('\n')[0].slice(0,180)}`);}
  }
  return {buttons,warnings};
}
function mergeCandidates(groups,viewport) {
  const result=[];
  for(const candidate of groups.flat()) {
    if(!candidate.bbox||!Object.values(candidate.bbox).every(Number.isFinite))continue;
    const bbox=clipBox(candidate.bbox,{x:0,y:0,...viewport});if(!bbox||bbox.width<3||bbox.height<3)continue;
    if(result.some(b=>iou(b.bbox,bbox)>.7))continue;
    result.push({...candidate,bbox});
  }
  return result.sort((a,b)=>Math.round(a.bbox.y/12)-Math.round(b.bbox.y/12)||a.bbox.x-b.bbox.x).slice(0,150);
}
module.exports={detectDOMButtons,describeTarget,guardDOMTarget,clipBox,iou,mergeCandidates};
