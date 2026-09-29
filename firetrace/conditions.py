"""Declarative checks; missing evidence is unknown, never a successful match."""
import math


def validate_condition(condition):
    if not isinstance(condition,dict) or condition.get('op') not in ('exists','equals','type','range','length'):
        raise ValueError('Invalid condition operator')
    path=condition.get('path','')
    if not isinstance(path,str) or len(path)>500: raise ValueError('Invalid condition path')
    if condition['op']=='type' and condition.get('value') not in ('null','boolean','number','string','array','object'):
        raise ValueError('Invalid condition type')
    if condition['op'] in ('range','length'):
        for k in ('min','max'):
            if k in condition and (type(condition[k]) not in (int,float) or not math.isfinite(condition[k])):
                raise ValueError('Invalid condition bound')
    return condition


def evaluate_condition(condition: dict, evidence) -> dict:
    validate_condition(condition)
    value=evidence
    try:
        for part in filter(None,condition.get('path','').split('.')):
            value=value[int(part)] if isinstance(value,list) else value[part]
    except (KeyError,IndexError,TypeError,ValueError): return {'state':'unknown','path':condition.get('path','')}
    op=condition['op']
    if op=='exists': matched=True
    elif op=='equals': matched=type(value) is type(condition.get('value')) and value==condition.get('value')
    elif op=='type':
        kind='null' if value is None else 'boolean' if isinstance(value,bool) else 'number' if isinstance(value,(int,float)) else 'string' if isinstance(value,str) else 'array' if isinstance(value,list) else 'object'
        matched=kind==condition.get('value')
    else:
        if op=='length': value=len(value) if isinstance(value,(str,list,dict)) else None
        matched=type(value) in (int,float) and condition.get('min',float('-inf'))<=value<=condition.get('max',float('inf'))
    return {'state':'matched' if matched else 'not_matched','path':condition.get('path','')}
