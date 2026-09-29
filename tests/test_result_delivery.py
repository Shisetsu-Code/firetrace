import threading
from unittest.mock import Mock
import pytest
from firetrace.cloudflare_agent import CloudflareFiretraceAgent


def test_result_retained_after_send_failure_and_command_never_reexecutes():
    agent=CloudflareFiretraceAgent.__new__(CloudflareFiretraceAgent)
    agent.worker=Mock(); agent.worker.execute.return_value={'data':{'job_id':'a'*32}}
    agent.agent_id='test'; agent.send_state=Mock()
    class Socket:
        calls=0
        def send(self,raw):
            self.calls+=1
            if self.calls==2: raise ConnectionError('cut after action')
    command={'id':'command-1','action':'browser_sequence','args':{}}
    with pytest.raises(ConnectionError): agent.handle_command(Socket(),command)
    second=Mock()
    agent.handle_command(second,command)
    assert agent.worker.execute.call_count==1
    agent.replay_results(second)
    assert 'job_id' in second.send.call_args.args[0]
    agent.ack_result('command-1')
    assert not agent._pending_results
