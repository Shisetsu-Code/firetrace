"""Bounded local jobs: reads never repeat browser actions."""
import threading
import time
import uuid
import json
from copy import deepcopy
from concurrent.futures import as_completed
from .sequences import validate_sequence
from .conditions import validate_condition
from .branch_matrix import expand_matrix


def bounded_result(value,limit=512000):
    if len(json.dumps(value,ensure_ascii=False).encode())<=limit: return value
    value=deepcopy(value); value['evidence_truncated']=True
    def trim(node):
        if isinstance(node,dict):
            for key,item in list(node.items()):
                if key=='result' and len(json.dumps(item,ensure_ascii=False).encode())>4000:
                    node[key]={'omitted':'job_evidence_budget','bytes':len(json.dumps(item).encode())}
                else: trim(item)
        elif isinstance(node,list):
            for item in node: trim(item)
    trim(value)
    if len(json.dumps(value,ensure_ascii=False).encode())>limit:
        return {'status':value.get('status','error'),'evidence_truncated':True,'error':'evidence_budget_exceeded'}
    return value


class JobManager:
    def __init__(self,manager): self.manager=manager; self.items={}; self.lock=threading.RLock()

    def _purge(self):
        for key,item in list(self.items.items()):
            if item['status'] not in ('running','queued') and time.monotonic()-item['_created']>=900: del self.items[key]

    def submit(self,branches,timeout_ms=120000,spin=None,matrix=None):
        if not isinstance(branches,list) or not 1<=len(branches)<=self.manager.max_browsers: raise ValueError('Invalid branch count')
        labels=set(); ids=set(); clean=[]
        for branch in branches:
            if not isinstance(branch,dict) or not isinstance(branch.get('label'),str) or not 1<=len(branch['label'])<=120: raise ValueError('Branch label required')
            label=branch['label']; browser_id=branch.get('browser_id')
            if label in labels or browser_id in ids: raise ValueError('Duplicate label or browser_id')
            labels.add(label); ids.add(browser_id)
            clean.append({**branch,'steps':validate_sequence(branch['steps'],timeout_ms)})
        if spin:
            if type(spin.get('max_iterations')) is not int or not 1<=spin['max_iterations']<=100: raise ValueError('max_iterations must be 1..100')
            validate_condition(spin.get('condition'))
        with self.lock:
            self._purge()
            if len(self.items)>=100: raise ValueError('job_capacity_reached; retained jobs expire after 15 minutes')
            self.manager.reserve(ids)
            key=uuid.uuid4().hex; cancel=threading.Event()
            self.items[key]={'job_id':key,'status':'running','branches':[],
                             'coverage':{'requested':len(matrix) if matrix else len(clean),'completed':0},
                             '_created':time.monotonic(),'_cancel':cancel,'_browser_ids':list(ids)}
        threading.Thread(target=self._run,args=(key,clean,timeout_ms,spin,matrix),daemon=True).start()
        return {'job_id':key,'status':'running','note':'Use command_result with job_id; do not resubmit the action.'}

    def _run(self,key,branches,timeout_ms,spin,matrix):
        deadline=time.monotonic()+timeout_ms/1000
        cancel=self.items[key]['_cancel']; results=[]
        try:
            if matrix:
                paths=list(matrix.items()); index=0
                while index<len(paths) and not cancel.is_set() and time.monotonic()<deadline:
                    wave=[]
                    for branch in branches:
                        if index>=len(paths): break
                        label,nodes=paths[index]; index+=1
                        args={'matrix':True,'nodes':nodes,'deadline':deadline,'cancel':cancel,'job_id':key}
                        future=self.manager.sessions[branch['browser_id']].submit('_job',args)
                        wave.append((label,branch['browser_id'],future))
                    self._collect(key,wave,results)
            else:
                wave=[]
                for branch in branches:
                    args={'steps':branch['steps'],'deadline':deadline,'cancel':cancel,'job_id':key}
                    if spin: args.update(spin= True,**spin)
                    future=self.manager.sessions[branch['browser_id']].submit('_job',args)
                    wave.append((branch['label'],branch['browser_id'],future))
                self._collect(key,wave,results)
            completed=sum(r['status']=='done' for r in results)
            requested=self.items[key]['coverage']['requested']
            status='cancelled' if cancel.is_set() else 'done' if completed==requested else 'partial' if completed else 'error'
            with self.lock:
                bounded=bounded_result({'status':status,'branches':results,'coverage':{'requested':requested,'completed':completed}})
                self.items[key].update(bounded)
        except Exception as exc:
            with self.lock: self.items[key].update(status='error',error=type(exc).__name__,branches=results)
        finally:
            self.manager.release(self.items[key]['_browser_ids'])

    def _collect(self,key,wave,results):
        targets={future:(label,browser_id) for label,browser_id,future in wave}
        for future in as_completed(targets,timeout=310):
            label,browser_id=targets[future]
            try: value=future.result(timeout=310)
            except Exception as exc: value={'status':'uncertain','error':type(exc).__name__,'steps':[]}
            results.append({'label':label,'browser_id':browser_id,**bounded_result(value,128000)})
            with self.lock:
                self.items[key]['branches']=list(results)
                self.items[key]['coverage']['completed']=sum(r['status']=='done' for r in results)

    def get(self,key):
        with self.lock:
            self._purge()
            if key not in self.items: raise ValueError('job_missing_expired_or_agent_restarted; do not repeat uncertain actions')
            result=deepcopy({k:v for k,v in self.items[key].items() if not k.startswith('_')})
            result['progress']={key:self.manager.sessions[key].progress() for key in self.items[key]['_browser_ids'] if key in self.manager.sessions}
            return result

    def cancel(self,key):
        with self.lock:
            self.get(key); self.items[key]['_cancel'].set()
        return {'job_id':key,'cancel_requested':True}

    def close(self):
        with self.lock:
            for item in self.items.values(): item['_cancel'].set()
