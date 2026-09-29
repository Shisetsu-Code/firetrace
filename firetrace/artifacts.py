"""Bounded, expiring local evidence. No filesystem paths accepted from MCP."""
import base64
import time
import uuid
from collections import OrderedDict


class ArtifactStore:
    def __init__(self, browser_id, limit=20*1024*1024, ttl=900, clock=time.monotonic):
        self.browser_id, self.limit, self.ttl, self.clock = browser_id, limit, ttl, clock
        self.items = OrderedDict()

    def _purge(self):
        for key, item in list(self.items.items()):
            if self.clock()-item['created'] >= self.ttl: del self.items[key]

    def put(self, data: bytes, mime: str, job_id: str, step_id: str) -> str:
        self._purge()
        if len(data)>min(self.limit,1024*1024): raise ValueError('artifact_too_large')
        while self.items and sum(len(i['bytes']) for i in self.items.values())+len(data)>self.limit:
            self.items.popitem(last=False)
        key=uuid.uuid4().hex
        self.items[key]={'bytes':data,'mime':mime,'job_id':job_id,'step_id':step_id,'created':self.clock()}
        return key

    def get(self, artifact_id):
        self._purge()
        if artifact_id not in self.items: raise ValueError('artifact_missing_or_expired')
        item=self.items[artifact_id]
        return {'artifact_id':artifact_id,'browser_id':self.browser_id,'job_id':item['job_id'],
                'step_id':item['step_id'],'mime':item['mime'],'encoding':'base64',
                'data':base64.b64encode(item['bytes']).decode()}
