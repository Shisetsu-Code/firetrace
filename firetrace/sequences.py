"""Validate the complete plan before the first browser side effect."""
import math
import time
from urllib.parse import urlsplit
from .redact import sanitize


def http_url(value):
    try:
        p=urlsplit(value)
        if p.scheme not in ('http','https') or not p.hostname or p.username or p.password: raise ValueError()
        _=p.port
    except (TypeError,ValueError): raise ValueError('HTTP(S) URL without embedded credentials required') from None
    return value


def number(value, low, high):
    if type(value) not in (int,float) or not math.isfinite(value) or not low<=value<=high:
        raise ValueError('Numeric argument out of bounds')


def validate_sequence(steps, timeout_ms=120000):
    if type(timeout_ms) is not int or not 1<=timeout_ms<=300000: raise ValueError('timeout_ms must be 1..300000')
    if not isinstance(steps,list) or not 1<=len(steps)<=20: raise ValueError('steps must contain 1..20 actions')
    allowed={'open','click','click_relative','click_element','wait','screenshot','capture_start','capture_stop','capture_read','checkpoint','dom_snapshot','inspect','status'}
    clean=[]
    for step in steps:
        if not isinstance(step,dict) or step.get('action') not in allowed: raise ValueError('Unsupported sequence action')
        action=step['action']; args=step.get('args',{})
        if not isinstance(args,dict): raise ValueError('Step args must be an object')
        keys={'open':{'url'},'click':{'x','y'},'click_relative':{'rx','ry'},'click_element':{'snapshot_id','element_id'},
              'wait':{'ms'},'screenshot':{'quality'},'capture_start':{'filters'},'capture_stop':{'capture_id'},
              'capture_read':{'capture_id','request_id'},'checkpoint':{'label'},'dom_snapshot':set(),'inspect':{'query'},'status':set()}[action]
        if set(args)-keys: raise ValueError('Unknown step arguments')
        if action=='open': http_url(args.get('url'))
        if action in ('click','click_relative'):
            for key in ('x','y') if action=='click' else ('rx','ry'):
                number(args.get(key),0,100000 if action=='click' else 1)
        if action=='wait': number(args.get('ms',1000),0,10000)
        if action=='screenshot': number(args.get('quality',65),20,90)
        if action=='click_element':
            if not all(isinstance(args.get(k),str) and 1<=len(args[k])<=128 for k in ('snapshot_id','element_id')):
                raise ValueError('snapshot_id and element_id required')
        if action=='capture_start':
            from .network_capture import validate_filters
            validate_filters(args.get('filters',{}))
        if action=='capture_stop' and 'capture_id' in args and not isinstance(args['capture_id'],str): raise ValueError('Invalid capture_id')
        if action=='capture_read' and any(not isinstance(v,str) for v in args.values()): raise ValueError('Invalid capture reference')
        if action=='checkpoint' and (not isinstance(args.get('label'),str) or not 1<=len(args['label'])<=120): raise ValueError('Checkpoint label required')
        if action=='inspect' and args.get('query') not in ('document','frames','storage_names'): raise ValueError('Unsupported read-only query')
        clean.append({'action':action,'args':dict(args)})
    return clean


def run_sequence(runtime, steps, deadline, cancel_event, job_id='', prefix=''):
    results=[]; state='done'; error=None
    active_before=runtime.capture.active_id
    try:
        for i, step in enumerate(steps):
            if cancel_event.is_set(): state='cancelled'; break
            if time.monotonic()>=deadline: state='timeout'; break
            step_id=f'{prefix}{i+1}'
            remaining=max(1,int((deadline-time.monotonic())*1000))
            runtime.backend.page.set_default_timeout(min(10000,remaining))
            runtime.backend.page.set_default_navigation_timeout(min(60000,remaining))
            started_at=time.time()
            runtime.progress_callback({'current_step':i+1,'completed_steps':len(results),'step_id':step_id,'action':step['action']})
            result=runtime.perform(step['action'],step['args'],job_id=job_id,step_id=step_id,deadline=deadline,cancel_event=cancel_event)
            results.append({'step_id':step_id,'action':step['action'],'status':'done','result':result,'started_at':started_at,'finished_at':time.time()})
            runtime.progress=list(results)
            runtime.progress_callback({'current_step':i+1,'completed_steps':len(results),'step_id':step_id,'action':step['action']})
            if cancel_event.is_set(): state='cancelled'; break
            if time.monotonic()>=deadline: state='timeout'; break
    except Exception as exc:
        state='error'; error=type(exc).__name__
        results.append({'step_id':f'{prefix}{len(results)+1}','status':'error','error':error})
    finally:
        if runtime.capture.active_id and runtime.capture.active_id!=active_before:
            runtime.capture.stop(runtime.capture.active_id)
    return sanitize({'job_id':job_id,'status':state,'steps':results,'error':error})
