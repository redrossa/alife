#!/usr/bin/env python3
"""Standalone bounded POSIX mqueue experiment; never imports production runtime."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

IMAGE = 'sha256:4071ad814ce2464e271f2fb26f2beb0115c35495bc5635dcdc253cbdf7cbb64f'
LABEL = 'sh.alife.phase2.mqueue'
RUN = secrets.token_hex(8)
ENV = {k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ}
OUT = Path(tempfile.mkdtemp(prefix='alife-phase2-mqueue-'))
START = time.monotonic()
SOURCE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
EVENTS = []
KNOWN = {}
CHECKS = []

# O_NONBLOCK prevents mq_send from waiting when a queue is full.
PAYLOAD = r'''
import ctypes as c, errno, json, os, resource, sys
lib = c.CDLL(None, use_errno=True)
class Attr(c.Structure):
    _fields_ = [('flags',c.c_long),('maxmsg',c.c_long),('msgsize',c.c_long),('curmsgs',c.c_long),('reserved',c.c_long*4)]
lib.mq_open.restype=c.c_int
lib.mq_send.argtypes=[c.c_int,c.c_char_p,c.c_size_t,c.c_uint]
lib.mq_close.argtypes=[c.c_int]
lib.mq_unlink.argtypes=[c.c_char_p]
def create(name,maxmsg=4,msgsize=128):
    a=Attr(0,maxmsg,msgsize,0)
    c.set_errno(0)
    fd=lib.mq_open(name.encode(), os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NONBLOCK, 0o600, c.byref(a))
    e=c.get_errno()
    if fd >= 0: lib.mq_close(fd)
    return {'name':name,'ok':fd>=0,'errno':e,'error':errno.errorcode.get(e)}
mode=sys.argv[1]
r={'mode':mode,'uid':os.getuid(),'real_uid':os.getresuid()[0],'limit':resource.getrlimit(resource.RLIMIT_MSGQUEUE),'queues':sorted(os.listdir('/dev/mqueue'))}
if mode == 'create': r['create']=create(sys.argv[2])
if mode == 'fill':
    fd=lib.mq_open(sys.argv[2].encode(),os.O_RDWR|os.O_NONBLOCK)
    assert fd>=0
    sends=[]
    for i in range(5):
        c.set_errno(0); rc=lib.mq_send(fd,b'x'*128,128,0)
        sends.append({'ok':rc==0,'errno':c.get_errno()})
    lib.mq_close(fd); r['sends']=sends
if mode == 'exhaust':
    r['attempts']=[]
    for i in range(16):
        result=create('/bounded-'+str(i)); r['attempts'].append(result)
        if not result['ok']: break
if mode == 'clear':
    r['unlinks']=[{'name':n,'rc':lib.mq_unlink(('/'+n).encode())} for n in os.listdir('/dev/mqueue')]
if mode == 'disabled':
    r['create']=create('/disabled')
    r['minimal_create']=create('/minimal',1,1)
    r['minimal_attributes']={'maxmsg':1,'msgsize':1}
    fd=None
    try:
        fd=os.open('/dev/mqueue/zero-file',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        r['ordinary_open']={'ok':True,'errno':0,'error':None}
    except OSError as e:
        r['ordinary_open']={'ok':False,'errno':e.errno,'error':errno.errorcode.get(e.errno)}
    finally:
        if fd is not None: os.close(fd)
    try:
        resource.setrlimit(resource.RLIMIT_MSGQUEUE,(8192,8192)); r['raise']='succeeded'
    except (ValueError,OSError) as e: r['raise']=type(e).__name__+': '+str(e)
    r['after_raise']=create('/after-raise')
    r['mount']=[line.strip() for line in open('/proc/self/mountinfo') if ' /dev/mqueue ' in line]
    r['mount_access_w']=os.access('/dev/mqueue',os.W_OK)
    r['final_limit']=resource.getrlimit(resource.RLIMIT_MSGQUEUE)
    r['final_queues']=sorted(os.listdir('/dev/mqueue'))
print(json.dumps(r))
'''

def docker(args, cleanup=False):
    remaining = (115 if cleanup else 95) - (time.monotonic()-START)
    if remaining <= 0:
        raise TimeoutError('total execution budget exhausted')
    argv = ['docker', '--context', 'orbstack', *args]
    # Redirect to OS-temp files, cap size via polling, and never print raw output.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        p = subprocess.Popen(argv, env=ENV, stdout=stdout, stderr=stderr)
        deadline = time.monotonic()+min(12,remaining)
        failure = None
        while p.poll() is None:
            if time.monotonic()>deadline or os.fstat(stdout.fileno()).st_size+os.fstat(stderr.fileno()).st_size>131072:
                failure='time/output cap'; p.kill(); break
            time.sleep(.03)
        p.wait(timeout=2)
        stdout.seek(0); stderr.seek(0)
        out=stdout.read(131072).decode(errors='replace'); err=stderr.read(131072).decode(errors='replace')
    EVENTS.append({'args':args,'returncode':p.returncode,'stdout':out,'stderr':err,'cap':failure})
    if failure or p.returncode: raise RuntimeError('Docker command failed; see evidence event '+str(len(EVENTS)))
    return out.strip()

def identity(name, cleanup=False):
    value=docker(['inspect','--format','{{json .Id}} {{json (index .Config.Labels "'+LABEL+'")}}',name],cleanup)
    parts=value.split()
    assert len(parts)==2
    cid,label=(json.loads(x) for x in parts)
    assert len(cid)==64 and all(x in '0123456789abcdef' for x in cid) and label==RUN
    if KNOWN[name] is not None: assert cid==KNOWN[name]
    KNOWN[name]=cid
    return cid

def create(suffix,budget):
    name='alife-p2-mq-'+RUN+'-'+suffix
    KNOWN[name]=None # Track exact intended name even if create times out.
    cid=docker(['create','--name',name,'--label',LABEL+'='+RUN,'--pull','never',
        '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--read-only','--network','none','--log-driver','none','--restart','no',
        '--ipc','private','--pids-limit','64','--cpus','0.5','--memory','64m','--memory-swap','64m',
        '--ulimit','msgqueue='+str(budget)+':'+str(budget),
        '--entrypoint','python3',IMAGE,'-c','import time; time.sleep(180)'])
    assert len(cid)==64 and all(x in '0123456789abcdef' for x in cid)
    KNOWN[name]=cid
    identity(name)
    docker(['inspect','--format','{{json .HostConfig}}',cid])
    docker(['start',cid])
    return name,cid

def run(cid,*args):
    return json.loads(docker(['exec','--user','1000:1000',cid,'python3','-c',PAYLOAD,*args]))

def check(name,data,passed):
    CHECKS.append({'name':name,'passed':bool(passed),'observed':data})

def remove(name):
    cid=identity(name,True)
    docker(['rm','--force',cid],True)
    del KNOWN[name]

error=None
try:
    docker(['version','--format','{{json .Server.Version}}'])
    image=json.loads(docker(['image','inspect','--format','{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}',IMAGE]))
    assert image=={'id':IMAGE,'os':'linux','architecture':'arm64'}
    an,a=create('a',8192); bn,b=create('b',8192)
    first=run(a,'create','/same-name'); check('fresh creation',first,first['create']['ok'])
    fill=run(a,'fill','/same-name'); check('message capacity',fill,[x['ok'] for x in fill['sends']]==[True]*4+[False] and fill['sends'][-1]['errno']==11)
    second=run(b,'create','/same-name'); check('private queue names',second,second['queues']==[] and second['create']['ok'])
    full=run(a,'exhaust'); check('bounded allocation exhaustion',full,not full['attempts'][-1]['ok'])
    blocked=run(b,'create','/peer-probe')
    cleared=run(a,'clear')
    retry=run(b,'create','/peer-probe')
    check('shared real UID interference',{'before':blocked,'release':cleared,'after':retry},not blocked['create']['ok'] and retry['create']['ok'])
    before=run(b,'list'); identity(bn); docker(['stop','--time','1',b]); docker(['start',b]); after=run(b,'list')
    check('stop/start clears queues',{'before':before,'after':after},bool(before['queues']) and after['queues']==[])
    remove(an); remove(bn)
    dn,d=create('zero',0)
    disabled=run(d,'disabled')
    check('zero budget denies create and limit raise',disabled,
        all(not disabled[key]['ok'] for key in ('create','minimal_create','ordinary_open','after_raise'))
        and disabled['queues']==[] and disabled['final_queues']==[]
        and disabled['final_limit']==[0,0] and disabled['raise']!='succeeded')
except Exception as exc:
    error=type(exc).__name__+': '+str(exc)
finally:
    cleanup_errors=[]
    for name in list(KNOWN):
        try: remove(name)
        except Exception as exc: cleanup_errors.append({'name':name,'error':str(exc)})
    remaining_labelled=None
    try:
        remaining_labelled=docker(['ps','--all','--quiet','--no-trunc','--filter','label='+LABEL+'='+RUN],True).splitlines()
    except Exception as exc:
        cleanup_errors.append({'verification_error':str(exc)})
    evidence={'source_sha256':SOURCE_SHA256,'remaining_labelled':remaining_labelled,'run':RUN,'image':IMAGE,'context':'orbstack','elapsed_seconds':time.monotonic()-START,'checks':CHECKS,'events':EVENTS,'error':error,'cleanup_errors':cleanup_errors,'remaining_known':KNOWN}
    path=OUT/'evidence.json'
    path.write_text(json.dumps(evidence,indent=2)+'\n')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    print(json.dumps({'evidence':str(path),'sha256':digest,'checks':len(CHECKS),'error':error,'cleanup_errors':cleanup_errors,'remaining_known':KNOWN,'remaining_labelled':remaining_labelled}))
    if error or cleanup_errors or KNOWN or remaining_labelled or not all(c['passed'] for c in CHECKS):
        raise SystemExit(1)
