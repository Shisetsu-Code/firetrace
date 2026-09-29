from .sequences import validate_sequence
from .conditions import validate_condition


def expand_matrix(nodes,timeout_ms):
    if not isinstance(nodes,list) or not 1<=len(nodes)<=100: raise ValueError('matrix must contain 1..100 nodes')
    table={}
    for node in nodes:
        if not isinstance(node,dict) or not isinstance(node.get('label'),str) or not 1<=len(node['label'])<=120 or node['label'] in table:
            raise ValueError('Unique node labels required')
        if set(node)-{'label','parent','steps','setup_steps','precondition'}: raise ValueError('Unknown matrix node fields')
        clean={**node,'steps':validate_sequence(node.get('steps'),timeout_ms)}
        if node.get('setup_steps'): clean['setup_steps']=validate_sequence(node['setup_steps'],timeout_ms)
        if node.get('precondition'): validate_condition(node['precondition'])
        table[node['label']]=clean
    parents={n.get('parent') for n in nodes if n.get('parent')}
    if not parents.issubset(table): raise ValueError('Unknown matrix parent')
    paths={}
    for label in table:
        path=[]; current=label
        while current:
            if current in [n['label'] for n in path] or len(path)>=10: raise ValueError('Matrix cycle or depth exceeds 10')
            path.append(table[current]); current=table[current].get('parent')
        if label not in parents: paths[label]=list(reversed(path))
    return paths
