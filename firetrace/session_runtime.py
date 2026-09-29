"""Browser operations owned exclusively by a SessionExecutor thread."""
import json
import threading
import time
import uuid
from .browser_sessions import BrowserSessions
from .artifacts import ArtifactStore
from .network_capture import CaptureManager
from .dom_inspector import DomInspector
from .request_replay import RequestReplay
from .conditions import evaluate_condition
from .sequences import run_sequence, http_url, validate_sequence
from .redact import sanitize, safe_url


class SessionRuntime:
    def __init__(self,browser_id,options,profile_root):
        self.id=browser_id; self.progress=[]
        self.backend=BrowserSessions(profile_root=profile_root,max_browsers=1)
        try:
            self.local_id=self.backend.create(**options)['browser_id']; self.backend.select(self.local_id)
            self.artifacts=ArtifactStore(browser_id); self._bind()
        except BaseException:
            self.backend.close(); raise

    def _bind(self):
        self.capture=CaptureManager(self.backend.context,self.id)
        self.dom=DomInspector(self.backend.page)
        self.replay=RequestReplay(self.backend.page,self.capture)

    def status(self):
        record=self.backend.list_browsers()['browsers'][0]
        return {**record,'browser_id':self.id,'urls':[safe_url(url) for url in record['urls']]}

    def poll(self):
        if self.capture.active_id:
            try: self.backend.page.wait_for_timeout(5)
            except Exception:
                self.capture.stop(self.capture.active_id)

    def execute(self,action,args):
        if action=='browser_close':
            self.capture.close(); self.dom.clear()
            self.backend.close_browser(self.local_id)
            return self.status()
        if action=='browser_reopen':
            was_open=self.status()['open']
            self.backend.reopen(self.local_id,headless=args.get('headless'))
            self.backend.select(self.local_id)
            if not was_open: self._bind()
            return self.status()
        if action=='status': return self.status()
        self.backend.select(self.local_id)
        self.backend.page.set_default_timeout(10000)
        self.backend.page.set_default_navigation_timeout(60000)
        if action=='_raw_screenshot': return self.backend.screenshot(args.get('quality',65))
        if action=='_job':
            self.progress=[]
            if args.get('matrix'): return self._matrix(args)
            if args.get('spin'): return self._spin(args)
            return run_sequence(self,args['steps'],args['deadline'],args['cancel'],args['job_id'])
        aliases={'browser_click_element':'click_element','interactive_elements':'dom_snapshot','browser_inspect':'inspect','state_checkpoint':'checkpoint'}
        return self.perform(aliases.get(action,action),args)

    def perform(self,action,args,job_id='',step_id='',deadline=None,cancel_event=None):
        if action=='open':
            http_url(args['url'])
            self.backend.page.goto(args['url'],wait_until='domcontentloaded')
            return {'url':safe_url(self.backend.page.url)}
        if action=='click': return self.backend.click(args['x'],args['y'])
        if action=='click_relative': return self.backend.click_relative(args['rx'],args['ry'])
        if action=='click_element': return self.dom.click_element(args['snapshot_id'],args['element_id'])
        if action=='wait':
            until=time.monotonic()+args.get('ms',1000)/1000
            while time.monotonic()<until:
                if cancel_event and cancel_event.is_set(): break
                if deadline and time.monotonic()>=deadline: break
                self.backend.page.wait_for_timeout(min(50,max(1,int((until-time.monotonic())*1000))))
            return {'waited_ms':args.get('ms',1000)}
        if action=='screenshot':
            data=self.backend.screenshot(args.get('quality',65))
            key=self.artifacts.put(data,'image/jpeg',job_id,step_id)
            return {'artifact_id':key,'browser_id':self.id,'mime':'image/jpeg','bytes':len(data)}
        if action=='artifact_get': return self.artifacts.get(args['artifact_id'])
        if action=='capture_start': return self.capture.start(args.get('filters'))
        if action=='capture_stop': return self.capture.stop(args.get('capture_id'))
        if action=='network_capture_window':
            operation=args.get('operation')
            if operation=='start': return self.capture.start(args.get('filters'))
            if operation=='stop': return self.capture.stop(args.get('capture_id'))
            if operation=='status': return self.capture.status(args['capture_id'])
            raise ValueError('operation must be start, stop or status')
        if action=='network_filter': return self.capture.configure(args['filters'])
        if action=='network_events': return self.capture.events(args.get('capture_id'))
        if action=='network_clear':
            if self.capture.active_id: raise ValueError('Stop active capture before clearing')
            self.capture.records.clear(); self.capture.pending.clear(); self.capture.bytes=0
            return {'cleared':True}
        if action=='network_get_response_body': return self.capture.get_response_body(args['request_id'])
        if action=='trigger_and_capture':
            # Compatibility path uses bounded recorder instead of unsanitized legacy body output.
            cap=self.capture.start()
            try:
                self.backend.click_relative(args['rx'],args['ry'])
                self.perform('wait',{'ms':args.get('wait_ms',2500)})
            finally: self.capture.stop(cap['capture_id'])
            events=self.capture.events(cap['capture_id'])['events']
            captures=[]
            for event in events:
                if args.get('url_contains','') in event['url']:
                    captures.append({**event,'responseBody':self.capture.get_response_body(event['request_id'])['body']})
            return {'captures':captures}
        if action=='dom_snapshot': return self.dom.snapshot()
        if action=='iframe_list': return self.dom.frame_list()
        if action=='_frame_url': return {'url':http_url(self.dom.frame_url(args['frame_id']))}
        if action=='inspect': return self.dom.inspect(args['query'])
        if action=='session_context': return self.replay.session_context()
        if action=='request_replay': return self.replay.replay(args['request_id'])
        if action=='request_replay_from_template': return self.replay.replay(args['request_id'],args['template'])
        if action=='validate_response':
            item=self.capture.get_response_body(args['request_id'])
            body=item['body']
            try: body=json.loads(body) if body is not None else None
            except ValueError: pass
            checks=[evaluate_condition(c,{'status':item['status'],'body':body}) for c in args['checks']]
            return {'request_id':args['request_id'],'valid':bool(checks) and all(c['state']=='matched' for c in checks),'checks':checks}
        if action=='checkpoint':
            shot=self.perform('screenshot',{},job_id,step_id)
            return {'checkpoint_id':uuid.uuid4().hex,'label':args['label'],'browser_id':self.id,
                    'observed_at':time.time(),'document':self.dom.inspect('document'),'screenshot':shot,
                    'capture_id':self.capture.active_id,'request_ids':[r['request_id'] for r in self.capture.events()['events']]}
        if action=='status': return self.status()
        raise ValueError('Unknown browser action: '+action)

    def _spin(self,args):
        iterations=[]; termination='iteration_limit'
        for i in range(args['max_iterations']):
            result=run_sequence(self,args['steps'],args['deadline'],args['cancel'],args['job_id'],f'{i+1}.')
            iterations.append(result)
            if result['status']!='done': termination=result['status']; break
            state=evaluate_condition(args['condition'],result)['state']
            if state=='matched': termination='matched'; break
            if state=='unknown': termination='error'; break
        return {'status':'done' if termination=='matched' else 'cancelled' if termination=='cancelled' else 'error',
                'termination':termination,'iterations':iterations,'steps':self.progress}

    def _matrix(self,args):
        results=[]
        for node in args['nodes']:
            setup=node.get('setup_steps',[])
            if setup:
                preparation=run_sequence(self,setup,args['deadline'],args['cancel'],args['job_id'],'setup.')
                if preparation['status']!='done': return preparation
            condition=node.get('precondition')
            if condition and evaluate_condition(condition,self.dom.inspect('document'))['state']!='matched':
                return {'status':'error','error':'precondition_not_matched','steps':results}
            result=run_sequence(self,node['steps'],args['deadline'],args['cancel'],args['job_id'],node['label']+'.')
            results.extend(result['steps'])
            if result['status']!='done': return {**result,'steps':results}
        return {'status':'done','steps':results}

    def close(self):
        self.capture.close(); self.dom.clear(); self.backend.close()
