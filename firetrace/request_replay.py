"""Same-origin browser fetch; redirects and automatic retries disabled."""
import json
import time
import uuid
from urllib.parse import urlsplit
from .sequences import http_url
from .redact import safe_body, sanitize, safe_url, sensitive
from .network_capture import MAX_BODY


def origin(url):
    p=urlsplit(http_url(url)); return (p.scheme,p.hostname,p.port or (443 if p.scheme=='https' else 80))


class RequestReplay:
    def __init__(self,page,capture): self.page,self.capture=page,capture; self.references={}

    def session_context(self):
        current=origin(self.page.url); self.references={}; items=[]
        # Cookie values stay in Chromium; browser fetch injects them automatically.
        for cookie in self.page.context.cookies([self.page.url]):
            items.append({'kind':'cookie','name':cookie['name'],'domain':cookie['domain'],
                          'expires':cookie['expires'],'httpOnly':cookie['httpOnly'],'available':True})
        for record in list(self.capture.records.values())[-20:]:
            if origin(record['url'])!=current: continue
            for key,value in record['headers'].items():
                if sensitive(key) and key.lower() not in ('cookie','set-cookie'):
                    ref=uuid.uuid4().hex
                    self.references[ref]=(value,current,time.monotonic())
                    items.append({'kind':'header','name':key,'ref':ref,'available':True})
        return {'origin':safe_url(self.page.url).split('?',1)[0],'items':items,'note':'Cookie values are never exported; tokens absent from captured headers are not inferred.'}

    def _resolve(self,value,current):
        if isinstance(value,dict) and set(value)=={'$ref'}:
            item=self.references.get(value['$ref'])
            if not item or item[1]!=current or time.monotonic()-item[2]>=900: raise ValueError('secret_reference_missing_or_expired')
            return item[0]
        if isinstance(value,dict): return {k:self._resolve(v,current) for k,v in value.items()}
        if isinstance(value,list): return [self._resolve(v,current) for v in value]
        return value

    def replay(self,request_id,template=None):
        record=self.capture.original(request_id)
        current=origin(self.page.url)
        if origin(record['url'])!=current: raise ValueError('Replay requires the original request origin in the selected page')
        template=template or {}
        if set(template)-{'url','method','headers','body'}: raise ValueError('Unsupported template field')
        url=template.get('url',record['url'])
        if origin(url)!=current: raise ValueError('Cross-origin replay is not allowed')
        method=template.get('method',record['method']).upper()
        if method not in ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'): raise ValueError('Unsupported HTTP method')
        headers=self._resolve(template.get('headers',record['headers']),current)
        if not isinstance(headers,dict) or not all(isinstance(k,str) and isinstance(v,str) for k,v in headers.items()): raise ValueError('Invalid headers')
        headers={k:v for k,v in headers.items() if k.lower() not in ('cookie','host','content-length','origin','referer','connection','accept-encoding') and not k.lower().startswith(('sec-','proxy-'))}
        body=self._resolve(template.get('body',record.get('postData')),current)
        if isinstance(body,(dict,list)): body=json.dumps(body)
        if body is not None and (not isinstance(body,str) or len(body.encode())>MAX_BODY): raise ValueError('Invalid or oversized request body')
        if method in ('GET','HEAD') and body: raise ValueError('GET/HEAD cannot have a body')
        result=self.page.evaluate('''async a => {
          const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10000);
          try {
            const r=await fetch(a.url,{method:a.method,headers:a.headers,body:a.body||undefined,
              credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal});
            const headers=Object.fromEntries(r.headers); const reader=r.body?.getReader();
            const chunks=[]; let size=0, truncated=false;
            if(reader) while(true) {const {done,value}=await reader.read();if(done)break;
              size+=value.length;if(size>a.limit){truncated=true;await reader.cancel();break;} chunks.push(value);}
            const bytes=new Uint8Array(Math.min(size,a.limit));let offset=0;
            if(!truncated) for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
            return {status:r.status,headers,body:truncated?null:new TextDecoder().decode(bytes),truncated};
          } catch(e){return {error:'fetch_failed_or_redirect_blocked',uncertain:true};}
          finally{clearTimeout(timer);}
        }''',{'url':url,'method':method,'headers':headers,'body':body,'limit':MAX_BODY})
        if 'error' in result: return result
        return sanitize({'source_request_id':request_id,'status':result['status'],'url':safe_url(url),
                         'responseHeaders':result['headers'],'body':safe_body(result['body'],result['headers'].get('content-type','')),
                         'truncated':result['truncated'],'replayed':True})
