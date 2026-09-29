import pytest


def test_sequence_prevalidates_every_step_and_deadline():
    from firetrace.sequences import validate_sequence
    assert len(validate_sequence([{'action':'wait','args':{'ms':0}}], 120000)) == 1
    for steps, timeout in [([{'action':'click','args':{'x':1,'y':2}}, {'action':'shell'}], 120000),
                           ([{'action':'wait'}]*21,120000), ([{'action':'wait'}],300001),
                           ([{'action':'open','args':{'url':'file:///private'}}],1000),
                           ([{'action':'click','args':{'x':-1,'y':0}}],1000)]:
        with pytest.raises(ValueError): validate_sequence(steps, timeout)


def test_artifact_scope_expiry_and_capacity():
    from firetrace.artifacts import ArtifactStore
    now=[0]
    store=ArtifactStore('browser-a', limit=10, ttl=5, clock=lambda:now[0])
    first=store.put(b'123456','text/plain','job','step')
    second=store.put(b'123456','text/plain','job','step2')
    with pytest.raises(ValueError, match='expired'): store.get(first)
    assert store.get(second)['data']=='MTIzNDU2'
    now[0]=6
    with pytest.raises(ValueError, match='expired'): store.get(second)


def test_conditions_distinguish_absent_null_and_limits():
    from firetrace.conditions import evaluate_condition
    assert evaluate_condition({'path':'a','op':'exists'}, {'a':None})['state']=='matched'
    assert evaluate_condition({'path':'b','op':'equals','value':None}, {'a':None})['state']=='unknown'
    assert evaluate_condition({'path':'n','op':'range','min':2,'max':4}, {'n':3})['state']=='matched'
    with pytest.raises(ValueError): evaluate_condition({'path':'n','op':'eval','value':'delete x'}, {})


def test_capture_redacts_nested_secrets_and_urls():
    from firetrace.redact import sanitize, safe_url
    value=sanitize({'url':'https://demo.test/a?token=SECRET&mode=demo','nested':{'access_token':'SECRET','ok':True}})
    assert 'SECRET' not in str(value)
    assert 'demo' in value['url']
    assert safe_url('https://user:SECRET@demo.test/a') == 'https://demo.test/a'


def test_job_result_is_bounded_without_hiding_evidence_loss():
    from firetrace.jobs import bounded_result
    result=bounded_result({'status':'done','steps':[{'result':{'text':'x'*600000}}]})
    assert len(str(result))<520000
    assert result['evidence_truncated'] is True


def test_capture_filters_and_body_limits():
    from firetrace.network_capture import CaptureManager,MAX_BODY
    class Context:
        def on(self,*a): pass
        def remove_listener(self,*a): pass
    class Request:
        url='https://demo.test/api'; method='GET'; resource_type='fetch'; headers={}; post_data=None
        def response(self):
            class Response:
                status=200; headers={'content-type':'application/json','content-length':str(MAX_BODY+1)}
                def body(self): raise AssertionError('Oversized body must not be read')
            return Response()
    clock=[0]; manager=CaptureManager(Context(),'a',clock=lambda:clock[0])
    capture=manager.start({'domain':['demo.test'],'path':['/api'],'method':['GET']})
    for _ in range(201):
        request=Request();manager._request(request);manager._finished(request)
    assert len(manager.events()['events'])==200
    assert manager.status(capture['capture_id'])['discarded']==1
    key=manager.events()['events'][0]['request_id']
    assert manager.get_response_body(key)['body_status']=='too_large'
    manager.stop(); clock[0]=901
    with pytest.raises(ValueError,match='expired'): manager.get_response_body(key)


def test_response_headers_are_charged_to_capture_budget():
    from firetrace.network_capture import CaptureManager,MAX_BODY
    class Context:
        def on(self,*a): pass
        def remove_listener(self,*a): pass
    class Request:
        url='https://demo.test/api'; method='GET'; resource_type='fetch'; headers={}; post_data=None
        def response(self):
            class Response:
                status=200; headers={'content-type':'application/json','content-length':'2','x-large':'x'*100000}
                def body(self): return b'{}'
            return Response()
    manager=CaptureManager(Context(),'a'); manager.start()
    req=Request();manager._request(req); before=manager.bytes;manager._finished(req)
    assert manager.bytes>before+100000
    assert manager.bytes<=20*MAX_BODY
