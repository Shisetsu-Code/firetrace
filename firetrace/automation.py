"""Thread-safe session coordinator and MCP-facing automation contract."""
import base64
import json
import os
import threading
import uuid
from pathlib import Path
from .session_executor import SessionExecutor
from .session_runtime import SessionRuntime
from .jobs import JobManager
from .branch_matrix import expand_matrix
from .sequences import validate_sequence, http_url
from .redact import sanitize


CAPABILITIES=['browser_sequence','parallel_branches','network_capture_window','network_filter',
 'network_get_response_body','dom_snapshot','interactive_elements','browser_click_element',
 'browser_inspect','iframe_list','iframe_open_direct','spin_until','request_replay',
 'request_replay_from_template','validate_response','session_context','state_checkpoint',
 'history_export','branch_matrix','artifact_get','job_cancel','job_result']


class AutomationManager:
    def __init__(self,profile_root=None,max_browsers=None):
        self.max_browsers=int(max_browsers or os.getenv('FIRETRACE_MAX_BROWSERS','4'))
        if not 1<=self.max_browsers<=32: raise ValueError('FIRETRACE_MAX_BROWSERS must be 1..32')
        self.profile_root=Path(profile_root or os.getenv('FIRETRACE_PROFILE_DIR') or Path(os.getenv('LOCALAPPDATA',str(Path.home()/'.local/share')))/'Firetrace'/'profiles')
        self.sessions={}; self.busy=set(); self.lock=threading.RLock(); self.jobs=JobManager(self); self.closed=False

    def status(self): return {'backend':'local-playwright-automation','connected':True,'capabilities':CAPABILITIES,**self.list_browsers()}

    def list_browsers(self):
        with self.lock:
            browsers=[v.snapshot() for v in self.sessions.values()]
            return {'browsers':browsers,'profiles':sorted(p.name for p in self.profile_root.glob('*') if p.is_dir() and not p.is_symlink()),
                    'active_count':sum(bool(b.get('open')) for b in browsers),'max_browsers':self.max_browsers,'busy_browser_ids':sorted(self.busy)}

    def reserve(self,ids):
        with self.lock:
            if self.closed: raise ValueError('agent_stopping')
            for key in ids:
                if key not in self.sessions: raise ValueError('Unknown browser_id; use browser_list')
                if key in self.busy: raise ValueError('session_busy')
                if not self.sessions[key].snapshot().get('open'): raise ValueError('Browser window closed; use browser_reopen')
            self.busy.update(ids)

    def release(self,ids):
        with self.lock: self.busy.difference_update(ids)

    def create(self,**options):
        with self.lock:
            if self.closed: raise ValueError('agent_stopping')
            if options.get('mode')=='persistent':
                for key,executor in self.sessions.items():
                    if executor.snapshot().get('profile')==options.get('profile'):
                        if executor.snapshot().get('open'): raise ValueError('Persistent profile is already open')
                        return self.execute('browser_reopen',{'browser_id':key,**({'headless':options['headless']} if 'headless' in options else {})})
            if self.list_browsers()['active_count']>=self.max_browsers: raise ValueError('Browser limit reached')
            # Retain at most 100 closed session IDs. Do not discard live state.
            if len(self.sessions)>=100: raise ValueError('session_history_limit; restart agent after saving work')
            key=uuid.uuid4().hex
            executor=SessionExecutor(lambda:SessionRuntime(key,options,self.profile_root))
            self.sessions[key]=executor
            return executor.snapshot()

    def _target(self,args,allow_create=False):
        key=args.get('browser_id')
        if key is not None:
            if key not in self.sessions: raise ValueError('Unknown browser_id; use browser_list')
            return key
        live=[k for k,v in self.sessions.items() if v.snapshot().get('open')]
        if len(live)==1: return live[0]
        if len(live)>1: raise ValueError('Multiple windows open; specify browser_id')
        if allow_create and not self.sessions: return self.create()['browser_id']
        raise ValueError('No open window; use browser_create or browser_reopen')

    def execute(self,action,args=None):
        args=dict(args or {})
        if action=='status': return self.status()
        if action=='browser_list': return self.list_browsers()
        if action=='browser_create': return self.create(**args)
        if action=='job_result': return self.jobs.get(args['job_id'])
        if action=='job_cancel': return self.jobs.cancel(args['job_id'])
        if action=='history_export':
            if args.get('format','json') not in ('json','markdown'): raise ValueError('format must be json or markdown')
            value=sanitize(self.jobs.get(args['job_id']))
            value['network_evidence']=[]
            def capture_ids(node):
                if isinstance(node,dict):
                    found={node['capture_id']} if isinstance(node.get('capture_id'),str) else set()
                    for item in node.values(): found.update(capture_ids(item))
                    return found
                if isinstance(node,list):
                    found=set()
                    for item in node: found.update(capture_ids(item))
                    return found
                return set()
            size=0
            for branch in value.get('branches',[]):
                for capture_id in capture_ids(branch):
                    try:
                        events=self.execute('network_events',{'browser_id':branch['browser_id'],'capture_id':capture_id})['events']
                        for event in events:
                            body=self.execute('network_get_response_body',{'browser_id':branch['browser_id'],'request_id':event['request_id']})
                            item={**event,'response':body}; size+=len(json.dumps(item).encode())
                            if size>400000:
                                value['network_evidence_truncated']=True; break
                            value['network_evidence'].append(item)
                    except ValueError:
                        value['network_evidence_unavailable']=True
            body=json.dumps(value,ensure_ascii=False,indent=2)
            if len(body.encode())>1024*1024:
                body=json.dumps({'job_id':args['job_id'],'status':value['status'],'evidence_truncated':True,'error':'export_too_large'})
            if args.get('format')=='markdown': body='# Firetrace evidence\n\n```json\n'+body+'\n```\n'
            return {'job_id':args['job_id'],'mime':'text/markdown' if args.get('format')=='markdown' else 'application/json',
                    'encoding':'base64','data':base64.b64encode(body.encode()).decode()}
        if action in ('parallel_branches','branch_matrix'):
            if action=='branch_matrix':
                paths=expand_matrix(args['nodes'],args.get('timeout_ms',120000))
                ids=args['browser_ids']
                if not isinstance(ids,list) or len(ids)!=len(set(ids)): raise ValueError('Unique browser_ids required')
                branches=[{'label':str(i),'browser_id':key,'steps':[{'action':'wait','args':{'ms':0}}]} for i,key in enumerate(ids)]
                return self.jobs.submit(branches,args.get('timeout_ms',120000),matrix=paths)
            branches=args['branches']
            if args.get('browser_ids'):
                if len(args['browser_ids'])!=len(branches): raise ValueError('One browser_id per branch required')
                if any('browser_id' in b for b in branches): raise ValueError('Use branch browser_id or browser_ids, not both')
                branches=[{**b,'browser_id':key} for b,key in zip(branches,args['browser_ids'])]
            return self.jobs.submit(branches,args.get('timeout_ms',120000))
        with self.lock: key=self._target(args,allow_create=action=='open')
        if action in ('browser_sequence','sequence','spin_until'):
            spin={k:args[k] for k in ('condition','max_iterations')} if action=='spin_until' else None
            return self.jobs.submit([{'label':args.get('label','sequence'),'browser_id':key,'steps':args['steps']}],args.get('timeout_ms',120000),spin=spin)
        if action=='iframe_open_direct':
            value=self.execute('_frame_url',{'browser_id':key,'frame_id':args['frame_id']})
            target=self.create(headless=args.get('headless',self.sessions[key].snapshot()['headless']))
            try: self.execute('open',{'browser_id':target['browser_id'],'url':http_url(value['url'])})
            except Exception:
                self.execute('browser_close',{'browser_id':target['browser_id']}); raise
            return {**target,'note':'Opened the frame URL; parent messages, memory and storage are not cloned.'}
        payload={k:v for k,v in args.items() if k!='browser_id'}
        if action in ('open','click','click_relative','wait','screenshot','browser_click_element','state_checkpoint','browser_inspect'):
            aliases={'browser_click_element':'click_element','state_checkpoint':'checkpoint','browser_inspect':'inspect'}
            validate_sequence([{'action':aliases.get(action,action),'args':payload}])
        with self.lock:
            if key in self.busy: raise ValueError('session_busy')
            if action=='browser_reopen' and not self.sessions[key].snapshot().get('open') and self.list_browsers()['active_count']>=self.max_browsers: raise ValueError('Browser limit reached')
            self.busy.add(key)
        try: return self.sessions[key].submit(action,payload).result(timeout=310)
        finally: self.release([key])

    def raw_screenshot(self,args): return self.execute('_raw_screenshot',args)

    def close(self):
        with self.lock: self.closed=True
        self.jobs.close()
        for executor in self.sessions.values(): executor.close()
