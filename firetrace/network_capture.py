"""Owner-thread network recorder, bounded metadata and local replay originals."""
import json
import time
import uuid
from collections import OrderedDict
from urllib.parse import urlsplit
from .redact import sanitize, safe_url, safe_body, redact_headers

MAX_BODY=1024*1024


def validate_filters(filters):
    if not isinstance(filters,dict) or set(filters)-{'method','domain','path','resource_type','content_type'}:
        raise ValueError('Invalid network filters')
    result={}
    for key, values in filters.items():
        values=[values] if isinstance(values,str) else values
        if not isinstance(values,list) or len(values)>20 or not all(isinstance(v,str) and 0<len(v)<=500 for v in values):
            raise ValueError('Filter values must be nonempty strings')
        result[key]=values
    return result


class CaptureManager:
    def __init__(self, context, browser_id, clock=time.monotonic):
        self.context,self.browser_id,self.clock=context,browser_id,clock
        self.records=OrderedDict(); self.captures=OrderedDict(); self.pending={}
        self.active_id=None; self.defaults={}; self.bytes=0
        self.handlers={'request':self._request,'requestfinished':self._finished,'requestfailed':self._failed}
        for event,handler in self.handlers.items(): context.on(event,handler)

    def _purge(self):
        for key,record in list(self.records.items()):
            if self.clock()-record['_created']>=900:
                self.bytes-=record['_size']; del self.records[key]
        for key,capture in list(self.captures.items()):
            if key!=self.active_id and self.clock()-capture['_created']>=900: del self.captures[key]
        for request,key in list(self.pending.items()):
            if key not in self.records: del self.pending[request]
        if self.active_id and self.clock()-self.captures[self.active_id]['_created']>=900:
            self.stop(self.active_id)

    def configure(self, filters):
        if self.active_id: raise ValueError('Stop active capture before changing filters')
        self.defaults=validate_filters(filters); return {'filters':self.defaults}

    def start(self, filters=None):
        self._purge()
        if self.active_id: raise ValueError('capture_already_active')
        key=uuid.uuid4().hex
        self.captures[key]={'capture_id':key,'browser_id':self.browser_id,'filters':validate_filters(self.defaults if filters is None else filters),
                            'request_ids':[],'discarded':0,'status':'active','_created':self.clock()}
        while len(self.captures)>100: self.captures.popitem(last=False)
        self.active_id=key
        return self.status(key)

    def stop(self, capture_id=None):
        capture_id=capture_id or self.active_id
        if capture_id not in self.captures: raise ValueError('capture_missing_or_expired')
        self.captures[capture_id]['status']='stopped'
        if capture_id==self.active_id: self.active_id=None
        return self.status(capture_id)

    def status(self,capture_id):
        if capture_id not in self.captures: raise ValueError('capture_missing_or_expired')
        return {k:v for k,v in self.captures[capture_id].items() if not k.startswith('_')}

    def _matches(self, record, filters, content=False):
        p=urlsplit(record['url'])
        for key,values in filters.items():
            if not values: continue
            if key=='content_type':
                if content and not any(v.lower() in record.get('content_type','').lower() for v in values): return False
            elif key=='method' and record['method'].upper() not in [v.upper() for v in values]: return False
            elif key=='domain' and (p.hostname or '').lower() not in [v.lower() for v in values]: return False
            elif key=='path' and not any(p.path.startswith(v) for v in values): return False
            elif key=='resource_type' and record['resource_type'] not in values: return False
        return True

    def _request(self,request):
        try:
            self._purge()
            if not self.active_id: return
            capture=self.captures[self.active_id]
            record={'request_id':uuid.uuid4().hex,'browser_id':self.browser_id,'capture_id':self.active_id,
                    'url':request.url,'method':request.method,'resource_type':request.resource_type,
                    'state':'pending','status':None,'headers':request.headers,'postData':request.post_data,
                    'responseHeaders':{},'content_type':'','responseBody':None,'body_status':'pending',
                    '_created':self.clock()}
            if not self._matches(record,capture['filters']): return
            size=len(json.dumps(record,default=str).encode())
            if len(capture['request_ids'])>=200 or size>MAX_BODY or len(self.pending)>=200:
                capture['discarded']+=1; return
            while self.records and (self.bytes+size>20*MAX_BODY or len(self.records)>=1000):
                _,old=self.records.popitem(last=False); self.bytes-=old['_size']
            record['_size']=size; self.records[record['request_id']]=record; self.bytes+=size
            capture['request_ids'].append(record['request_id']); self.pending[request]=record['request_id']
        except Exception:
            if self.active_id: self.captures[self.active_id]['discarded']+=1

    def _finished(self,request):
        key=self.pending.pop(request,None)
        if key not in self.records: return
        record=self.records[key]
        try:
            response=request.response()
            if response is None: record.update(state='failed',body_status='unavailable'); return
            headers=response.headers
            record.update(state='finished',status=response.status,responseHeaders=headers,content_type=headers.get('content-type',''))
            filters=self.captures.get(record['capture_id'],{}).get('filters',{})
            if not self._matches(record,filters,True):
                self.bytes-=record['_size']; del self.records[key]
                capture=self.captures.get(record['capture_id'])
                if capture: capture['request_ids'].remove(key)
                return
            # Do not materialize unbounded/chunked/compressed bodies in Python.
            length=headers.get('content-length','')
            if not length.isdigit() or headers.get('content-encoding','identity') not in ('','identity'):
                record['body_status']='unavailable_unbounded'; return
            if int(length)>MAX_BODY: record['body_status']='too_large'; return
            if not any(t in record['content_type'].lower() for t in ('json','text/','x-www-form-urlencoded')):
                record['body_status']='binary_omitted'; return
            body=response.body()
            if len(body)>MAX_BODY: record['body_status']='too_large'; return
            if self.bytes+len(body)>20*MAX_BODY: record['body_status']='budget_exhausted'; return
            record['responseBody']=body.decode('utf-8',errors='replace'); record['body_status']='available'
            self.bytes+=len(body); record['_size']+=len(body)
        except Exception:
            record.update(state='failed',body_status='unavailable')

    def _failed(self,request):
        key=self.pending.pop(request,None)
        if key in self.records: self.records[key].update(state='failed',body_status='unavailable')

    def original(self,request_id):
        self._purge()
        if request_id not in self.records: raise ValueError('request_missing_or_expired')
        return self.records[request_id]

    def evidence(self,record):
        result={k:v for k,v in record.items() if not k.startswith('_') and k!='responseBody'}
        result['url']=safe_url(result['url'])
        result['headers']=redact_headers(result['headers'])
        result['responseHeaders']=redact_headers(result['responseHeaders'])
        result['postData']=safe_body(result['postData'],record['headers'].get('content-type',''))
        return sanitize(result)

    def events(self,capture_id=None):
        self._purge()
        return {'events':[self.evidence(r) for r in self.records.values() if not capture_id or r['capture_id']==capture_id]}

    def get_response_body(self,request_id):
        record=self.original(request_id)
        return {'request_id':request_id,'body_status':record['body_status'],'status':record['status'],
                'content_type':record['content_type'],'body':safe_body(record['responseBody'],record['content_type'])}

    def close(self):
        for event,handler in self.handlers.items(): self.context.remove_listener(event,handler)
        self.pending.clear()
