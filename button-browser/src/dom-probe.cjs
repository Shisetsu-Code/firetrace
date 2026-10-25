'use strict';

// Runs in each frame before page scripts. It records listeners without firing them.
function installProbe() {
  if (globalThis.__buttonBrowserProbe) return;
  const listeners = new WeakMap(), ids = new WeakMap();
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove=EventTarget.prototype.removeEventListener;
  const pointerEvents = new Set(['click','pointerdown','pointerup','mousedown','mouseup','touchstart','touchend']);
  let serial=0;
  EventTarget.prototype.addEventListener=function(type,fn,options) {
    if(pointerEvents.has(type)&&fn) {
      let map=listeners.get(this);if(!map){map=new Map();listeners.set(this,map);}
      let set=map.get(type);if(!set){set=new Set();map.set(type,set);}
      const capture=typeof options==='boolean'?options:!!options?.capture;
      if(![...set].some(entry=>entry.fn===fn&&entry.capture===capture)&&!options?.signal?.aborted) {
          const entry={fn,capture,signal:options?.signal};set.add(entry);
          const forget=()=>{set.delete(entry);if(entry.cleanup)nativeRemove.call(this,type,entry.cleanup,capture);if(entry.abort)nativeRemove.call(options.signal,'abort',entry.abort,false);};
          if(options?.once){entry.cleanup=forget;nativeAdd.call(this,type,forget,{once:true,capture});}
          if(options?.signal){entry.abort=forget;nativeAdd.call(options.signal,'abort',forget,{once:true});}
      }
    }
    return nativeAdd.call(this,type,fn,options);
  };
  EventTarget.prototype.removeEventListener=function(type,fn,options) {
    const set=listeners.get(this)?.get(type),capture=typeof options==='boolean'?options:!!options?.capture;
    for(const entry of set||[])if(entry.fn===fn&&entry.capture===capture){set.delete(entry);if(entry.cleanup)nativeRemove.call(this,type,entry.cleanup,capture);if(entry.abort)nativeRemove.call(entry.signal,'abort',entry.abort,false);}
    return nativeRemove.call(this,type,fn,options);
  };
  const state={targets:new Map()};
  function deepHit(x,y,root=document) {
    let el=root.elementFromPoint(x,y), next;
    while(el?.shadowRoot&&(next=el.shadowRoot.elementFromPoint(x,y))&&next!==el)el=next;
    return el;
  }
  function contains(el,hit) {
    while(hit){if(hit===el||el.contains(hit))return true;hit=hit.getRootNode()?.host||null;}return false;
  }
  function visible(el) {
    if(el.closest('[hidden],[inert]'))return false;
    for(let n=el;n;n=n.parentElement||n.getRootNode()?.host) {
      const s=getComputedStyle(n);
      if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;
    }
    return true;
  }
  function visibleRect(el,b) {
    let left=Math.max(0,b.x),top=Math.max(0,b.y),right=Math.min(innerWidth,b.right),bottom=Math.min(innerHeight,b.bottom);
    for(let parent=el.parentElement||el.getRootNode()?.host;parent;parent=parent.parentElement||parent.getRootNode()?.host) {
      const s=getComputedStyle(parent),clipX=/hidden|clip|scroll|auto/.test(s.overflowX),clipY=/hidden|clip|scroll|auto/.test(s.overflowY);
      if(!clipX&&!clipY)continue;
      const r=parent.getBoundingClientRect(),sx=parent.offsetWidth?r.width/parent.offsetWidth:1,sy=parent.offsetHeight?r.height/parent.offsetHeight:1;
      const x=r.x+parent.clientLeft*sx,y=r.y+parent.clientTop*sy;
      if(clipX){left=Math.max(left,x);right=Math.min(right,x+parent.clientWidth*sx);}
      if(clipY){top=Math.max(top,y);bottom=Math.min(bottom,y+parent.clientHeight*sy);}
    }
    return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top}:null;
  }
  function metadata(el, includeDisabled=false, pointMode='search', exactPoint=null) {
    if(!el?.isConnected||!visible(el))return null;
    const b=el.getBoundingClientRect(), style=getComputedStyle(el);
    if(b.width<3||b.height<3||b.right<=0||b.bottom<=0||b.x>=innerWidth||b.y>=innerHeight||style.pointerEvents==='none')return null;
    const disabled=el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||!!el.closest('[aria-disabled="true"]');
    if(disabled&&!includeDisabled)return null;
    const clipped=visibleRect(el,b);if(!clipped)return null;
    const left=clipped.x,top=clipped.y,right=left+clipped.width,bottom=top+clipped.height;
    let point;
    if(pointMode==='search') {
      const points=[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>({x:left+(right-left)*x,y:top+(bottom-top)*y}));
      point=points.find(p=>contains(el,deepHit(p.x,p.y)));
      if(!point)return null;
    } else if(pointMode==='exact') {
      if(!exactPoint||!Number.isFinite(exactPoint.x)||!Number.isFinite(exactPoint.y)||
        exactPoint.x<left||exactPoint.x>=right||exactPoint.y<top||exactPoint.y>=bottom||
        !contains(el,deepHit(exactPoint.x,exactPoint.y)))return null;
    } else if(pointMode!=='inspect')return null;
    const labelled=(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>el.getRootNode().getElementById?.(id)?.textContent||'').join(' ');
    const label=(el.getAttribute('aria-label')||labelled.trim()||el.getAttribute('title')||el.innerText||el.getAttribute('alt')||el.value||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,160);
    const role=el.getAttribute('role'), tag=el.tagName.toLowerCase();
    let kind=tag==='a'?'link':(['checkbox','radio'].includes(el.type)||['switch','checkbox','radio'].includes(role))?'toggle':'button';
    if(pointMode==='search') {
      if(!ids.has(el))ids.set(el,`d${++serial}`);
      state.targets.set(ids.get(el),el);
    }
    const key=ids.get(el);
    if(!key||state.targets.get(key)!==el)return null;
    return {key,label:label||el.id||`${kind} ${serial}`,kind,disabled,semantic:el.matches('button,input,summary,a[href],[role="button"],[role="menuitem"],[role="switch"]'),localBox:{x:b.x,y:b.y,width:b.width,height:b.height},visibleBox:clipped,...(pointMode==='search'?{point}:{}),tag};
  }
  state.collect=function({includeDisabled=false,includeLinks=true}={}) {
    state.targets.clear();
    const all=[];let visited=0;
    function walk(root){for(const el of root.querySelectorAll('*')){if(++visited>30000)return;all.push(el);if(el.shadowRoot)walk(el.shadowRoot);}}
    walk(document);
    const candidates=[];
    for(const el of all) {
      if(['HTML','BODY','CANVAS','IFRAME','SCRIPT','STYLE','OPTION'].includes(el.tagName))continue;
      if(!includeLinks&&el.matches('a[href]'))continue;
      const native=el.matches('button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],input[type="checkbox"],input[type="radio"],summary,a[href],[role="button"],[role="menuitem"],[role="switch"],[role="checkbox"],[role="radio"]');
      const map=listeners.get(el),hasListener=map&&[...map.values()].some(s=>s.size);
      const ownAction=typeof el.onclick==='function'||hasListener;
      const pointer=!native&&!ownAction&&getComputedStyle(el).cursor==='pointer';
      if(!native&&!ownAction&&!pointer)continue;
      if(pointer&&el.parentElement&&getComputedStyle(el.parentElement).cursor==='pointer')continue;
      const meta=metadata(el,includeDisabled);if(meta)candidates.push({...meta,confidence:native?1:ownAction?.96:.7,heuristic:!native&&!ownAction});
    }
    // Prefer an explicit semantic target over wrappers and its decorative children.
    return candidates.filter(c=>!candidates.some(other=>{
      if(c===other)return false;
      const el=state.targets.get(c.key),parent=state.targets.get(other.key);
      return parent.contains(el)&&other.semantic&&!c.semantic;
    })).slice(0,300);
  };
  state.describe=(key)=>metadata(state.targets.get(key),true);
  const retainedTarget=(key,expected)=>{
    const el=state.targets.get(key);
    return el&&ids.get(el)===key&&(!expected||el===expected)?el:null;
  };
  // Guard-only reads retain the original DOM identity and never search for,
  // register, or return another point. Normal detection keeps its search mode.
  state.inspectTarget=(key,expected)=>metadata(retainedTarget(key,expected),true,'inspect');
  state.checkPoint=(key,x,y,expected)=>metadata(retainedTarget(key,expected),true,'exact',{x,y});
  state.hitsTarget=(key,x,y)=>contains(state.targets.get(key),deepHit(x,y));
  state.deepHit=deepHit;
  Object.defineProperty(globalThis,'__buttonBrowserProbe',{value:state,configurable:false});
}
module.exports={installProbe};
