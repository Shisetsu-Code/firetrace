import json
import time
import pytest
from test_local_browser_integration import server


@pytest.fixture
def engine(tmp_path,monkeypatch):
    from firetrace.automation import AutomationManager
    monkeypatch.setenv('FIRETRACE_HEADLESS','1')
    manager=AutomationManager(profile_root=tmp_path/'profiles',max_browsers=3)
    yield manager
    manager.close()


def finish(engine,job):
    for _ in range(400):
        result=engine.execute('job_result',{'job_id':job['job_id']})
        if result['status'] not in ('queued','running'): return result
        time.sleep(.025)
    raise AssertionError('Job did not finish')


def test_sequences_dom_capture_and_replay(engine,server):
    browser=engine.execute('browser_create',{'headless':True})['browser_id']
    call=lambda action,**args:engine.execute(action,{'browser_id':browser,**args})
    call('open',url=f'http://127.0.0.1:{server}/')
    snap=call('dom_snapshot'); button=next(e for e in snap['elements'] if e['tag']=='button')
    steps=[{'action':'capture_start','args':{'filters':{'method':['POST'],'path':['/game.web/'],'content_type':['json']}}},
           {'action':'click_element','args':{'snapshot_id':snap['snapshot_id'],'element_id':button['element_id']}},
           {'action':'wait','args':{'ms':100}}, {'action':'screenshot'}, {'action':'capture_stop'}]
    job=call('browser_sequence',steps=steps)
    result=finish(engine,job)
    assert result['status']=='done',result
    branch=result['branches'][0]
    assert len(branch['steps'])==5
    artifact=branch['steps'][3]['result']['artifact_id']
    assert call('artifact_get',artifact_id=artifact)['mime']=='image/jpeg'
    events=call('network_events')['events']
    assert len(events)==1,events
    request_id=events[0]['request_id']
    assert json.loads(call('network_get_response_body',request_id=request_id)['body'])['feature']=='TEST'
    assert call('request_replay',request_id=request_id)['status']==200
    with pytest.raises(ValueError,match='origin'):
        call('request_replay_from_template',request_id=request_id,template={'url':'https://example.com/leak'})
    assert call('validate_response',request_id=request_id,checks=[{'path':'body.feature','op':'equals','value':'TEST'}])['valid']
    assert 'test' not in str(call('session_context')['items'])
    history=engine.execute('history_export',{'job_id':job['job_id'],'format':'json'})
    assert history['mime']=='application/json'
    import base64
    exported=json.loads(base64.b64decode(history['data']))
    assert exported['network_evidence'][0]['request_id']==request_id
    call('open',url=f'http://127.0.0.1:{server}/')
    with pytest.raises(ValueError,match='stale'): call('browser_click_element',snapshot_id=snap['snapshot_id'],element_id=button['element_id'])


def test_parallel_reservation_cancellation_and_failed_validation(engine,server):
    ids=[engine.execute('browser_create',{'headless':True})['browser_id'] for _ in range(2)]
    branches=[{'label':str(i),'browser_id':b,'steps':[{'action':'wait','args':{'ms':700}}]} for i,b in enumerate(ids)]
    start=time.monotonic(); job=engine.execute('parallel_branches',{'branches':branches})
    with pytest.raises(ValueError,match='session_busy'): engine.execute('wait',{'browser_id':ids[0],'ms':0})
    result=finish(engine,job)
    assert result['status']=='done',result
    intervals=[branch['steps'][0] for branch in result['branches']]
    assert max(s['started_at'] for s in intervals)<min(s['finished_at'] for s in intervals)
    bad=[branches[0],{'label':'bad','browser_id':ids[1],'steps':[{'action':'shell'}]}]
    with pytest.raises(ValueError): engine.execute('parallel_branches',{'branches':bad})
    with pytest.raises(ValueError): engine.execute('parallel_branches',{'branches':[branches[0],branches[0]]})
    job=engine.execute('browser_sequence',{'browser_id':ids[0],'steps':[{'action':'wait','args':{'ms':5000}}]})
    engine.execute('job_cancel',{'job_id':job['job_id']})
    assert finish(engine,job)['status']=='cancelled'


def test_spin_and_branch_matrix_are_bounded(engine,server):
    b=engine.execute('browser_create',{'headless':True})['browser_id']
    engine.execute('open',{'browser_id':b,'url':f'http://127.0.0.1:{server}/'})
    job=engine.execute('spin_until',{'browser_id':b,'steps':[{'action':'inspect','args':{'query':'document'}}],
                                    'condition':{'path':'steps.0.result.ready_state','op':'equals','value':'complete'},'max_iterations':3})
    assert finish(engine,job)['branches'][0]['termination']=='matched'
    job=engine.execute('branch_matrix',{'browser_ids':[b],'nodes':[
        {'label':'root','steps':[{'action':'wait','args':{'ms':0}}]},
        {'label':'a','parent':'root','setup_steps':[{'action':'open','args':{'url':f'http://127.0.0.1:{server}/'}}],
         'precondition':{'path':'ready_state','op':'exists'},'steps':[{'action':'screenshot'}]},
        {'label':'b','parent':'root','steps':[{'action':'wait','args':{'ms':0}}]}]})
    result=finish(engine,job)
    assert result['coverage']['completed']==2,result
    with pytest.raises(ValueError): engine.execute('branch_matrix',{'browser_ids':[b],'nodes':[{'label':'a','parent':'a','steps':[{'action':'wait'}]}]})
