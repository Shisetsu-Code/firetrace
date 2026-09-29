import uuid
from .redact import safe_url, sanitize


class DomInspector:
    def __init__(self,page):
        self.page=page; self.snapshot_id=None; self.handles={}; self.frames={}; self.generation=0
        page.on('framenavigated',lambda _:self.clear())

    def clear(self):
        self.generation+=1
        for handle in list(self.handles.values()):
            try: handle.dispose()
            except Exception: pass
        self.handles={}; self.frames={}; self.snapshot_id=None

    def frame_list(self):
        self.frames={uuid.uuid4().hex:frame for frame in self.page.frames}
        return {'frames':[{'frame_id':key,'url':safe_url(frame.url),'name':frame.name[:200],
                           'main':frame==self.page.main_frame,'depends_on_parent':frame.parent_frame is not None}
                          for key,frame in self.frames.items()]}

    def snapshot(self,_attempt=0):
        self.clear(); self.snapshot_id=uuid.uuid4().hex
        frames=self.frame_list()['frames']; elements=[]; frame_map=dict(self.frames); generation=self.generation
        for info in frames:
            frame=frame_map[info['frame_id']]
            try:
                handles=frame.locator('button,input,select,textarea,a[href],[role],[tabindex],canvas').element_handles()
                for handle in handles:
                    if len(elements)>=500: handle.dispose(); continue
                    data=handle.evaluate('''e => ({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),
                      text:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('alt')||'').slice(0,500),
                      type:e.getAttribute('type'),enabled:!e.disabled && e.getAttribute('aria-disabled')!=='true'})''')
                    box=handle.bounding_box()
                    visible=handle.is_visible()
                    key=uuid.uuid4().hex; self.handles[key]=handle
                    elements.append({'element_id':key,'frame_id':info['frame_id'],'bounding_box':box,
                                     'visible':visible,**data})
            except Exception: info['unavailable']=True
        if generation!=self.generation:
            if _attempt<2: return self.snapshot(_attempt+1)
            self.clear(); raise ValueError('Page is navigating; request a new snapshot after it settles')
        return sanitize({'snapshot_id':self.snapshot_id,'url':safe_url(self.page.url),'frames':frames,'elements':elements,'limit':500})

    def click_element(self,snapshot_id,element_id):
        if snapshot_id!=self.snapshot_id or element_id not in self.handles: raise ValueError('stale_element: take a new snapshot')
        handle=self.handles[element_id]
        if not handle.evaluate('e => e.isConnected') or not handle.is_visible() or not handle.is_enabled():
            raise ValueError('stale_or_unavailable_element')
        handle.click()
        return {'clicked':element_id,'snapshot_id':snapshot_id}

    def frame_url(self,frame_id):
        if frame_id not in self.frames or self.frames[frame_id].is_detached(): raise ValueError('stale_frame')
        return self.frames[frame_id].url

    def inspect(self,query):
        if query=='frames': return self.frame_list()
        if query=='document':
            return {'url':safe_url(self.page.url),'title':self.page.title()[:500],
                    'ready_state':self.page.evaluate('document.readyState'),
                    'viewport':self.page.viewport_size}
        if query=='storage_names':
            return self.page.evaluate('() => ({localStorage:Object.keys(localStorage),sessionStorage:Object.keys(sessionStorage)})')
        raise ValueError('Unsupported read-only query; arbitrary JavaScript is not accepted')
