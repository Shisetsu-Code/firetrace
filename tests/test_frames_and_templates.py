import json
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import pytest
from test_automation_integration import engine,finish


@pytest.fixture
def demo():
    class Handler(BaseHTTPRequestHandler):
        hits=[]
        def log_message(self,*a): pass
        def do_GET(self):
            if self.path=='/':
                body=b'''<title>Demo</title><iframe src="/frame"></iframe><canvas width="100" height="50"></canvas>
                <button id="replace" onclick="this.outerHTML='<button>new</button>'">replace</button>
                <button id="fetch" onclick="fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':'private-token'},body:JSON.stringify({mode:'a',password:'private-password'})})">request</button>'''
            elif self.path=='/frame': body=b'<button aria-label="inside">inside</button>'
            elif self.path=='/redirect':
                self.send_response(302);self.send_header('Location','http://localhost:1/leak');self.end_headers();return
            else: body=b'{}'
            self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_POST(self):
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            self.hits.append({'body':body,'key':self.headers.get('X-Api-Key')})
            response=json.dumps({'ok':True,'access_token':'private-token'}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
    httpd=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
    yield f'http://127.0.0.1:{httpd.server_address[1]}',Handler.hits
    httpd.shutdown();thread.join(2)


def test_frames_stale_nodes_templates_and_redaction(engine,demo):
    url,hits=demo
    b=engine.execute('browser_create',{'headless':True})['browser_id']
    call=lambda action,**args:engine.execute(action,{'browser_id':b,**args})
    call('open',url=url)
    snapshot=call('dom_snapshot')
    assert any(e['tag']=='canvas' and e['bounding_box'] for e in snapshot['elements'])
    inside=next(e for e in snapshot['elements'] if e['text']=='inside')
    call('browser_click_element',snapshot_id=snapshot['snapshot_id'],element_id=inside['element_id'])
    replace=next(e for e in snapshot['elements'] if e['text']=='replace')
    call('browser_click_element',snapshot_id=snapshot['snapshot_id'],element_id=replace['element_id'])
    with pytest.raises(ValueError,match='stale'):call('browser_click_element',snapshot_id=snapshot['snapshot_id'],element_id=replace['element_id'])
    frames=call('iframe_list')['frames']; iframe=next(f for f in frames if not f['main'])
    opened=call('iframe_open_direct',frame_id=iframe['frame_id'],headless=True)
    assert opened['browser_id']!=b
    engine.execute('browser_close',{'browser_id':opened['browser_id']})
    snapshot=call('dom_snapshot'); fetch=next(e for e in snapshot['elements'] if e['text']=='request')
    call('network_capture_window',operation='start',filters={'path':['/api']})
    call('browser_click_element',snapshot_id=snapshot['snapshot_id'],element_id=fetch['element_id'])
    call('wait',ms=100)
    call('network_capture_window',operation='stop')
    events=call('network_events')['events']; rid=events[0]['request_id']
    assert 'private-' not in str(events)
    assert 'private-' not in str(call('network_get_response_body',request_id=rid))
    context=call('session_context'); ref=next(i['ref'] for i in context['items'] if i.get('kind')=='header')
    assert 'private-' not in str(context)
    result=call('request_replay_from_template',request_id=rid,template={'headers':{'Content-Type':'application/json','X-Api-Key':{'$ref':ref}},'body':{'mode':'b'}})
    assert result['status']==200
    assert hits[-1]['key']=='private-token'
    assert json.loads(hits[-1]['body'])['mode']=='b'
    assert 'private-' not in str(result)
    result=call('request_replay_from_template',request_id=rid,template={'url':url+'/redirect','method':'GET','body':None})
    assert result['error']=='fetch_failed_or_redirect_blocked'
    assert result['uncertain']


def test_iteration_limit_and_timeout_do_not_claim_completion(engine,demo):
    url,_=demo; b=engine.execute('browser_create',{'headless':True})['browser_id']
    engine.execute('open',{'browser_id':b,'url':url})
    job=engine.execute('spin_until',{'browser_id':b,'max_iterations':2,'steps':[{'action':'inspect','args':{'query':'document'}}],
                                   'condition':{'path':'steps.0.result.title','op':'equals','value':'never'}})
    result=finish(engine,job)
    assert result['coverage']['completed']==0
    assert result['branches'][0]['termination']=='iteration_limit'
    job=engine.execute('browser_sequence',{'browser_id':b,'timeout_ms':20,'steps':[{'action':'wait','args':{'ms':1000}},{'action':'screenshot'}]})
    result=finish(engine,job)
    assert result['coverage']['completed']==0
    assert len(result['branches'][0]['steps'])<=1
