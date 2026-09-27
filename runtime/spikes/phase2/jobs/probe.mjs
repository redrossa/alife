#!/usr/bin/env node
// Standalone engineering spike, not runtime code. No phase0 helpers/cleanup reused.
// Raw evidence is written outside the repository. Only exact, labelled container IDs are removed.
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CONTEXT = 'orbstack';
const IMAGE = 'sha256:4071ad814ce2464e271f2fb26f2beb0115c35495bc5635dcdc253cbdf7cbb64f';
const LABEL = 'sh.alife.phase2.jobs';
const runId = randomBytes(8).toString('hex');
const name = `alife-p2-jobs-${runId}`;
const directory = await mkdtemp(path.join(tmpdir(), 'alife-p2-jobs-'));
const evidence = { schema: 'alife.phase2.jobs/1', runId, started: new Date().toISOString(), context: CONTEXT, image: IMAGE, node: process.version, sourceSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), checks: [], jobs: [] };
const handles = new Set();
const active = new Map();
let container = null, socketPath, globalExpired = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cli(args) {
  return new Promise((resolve, reject) => execFile('docker', ['--context', CONTEXT, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    timeout: 15000, maxBuffer: 1 << 20, encoding: 'utf8',
  }, (err, stdout, stderr) => err ? reject(new Error(`docker ${args[0]} failed: ${stderr || err.message}`)) : resolve(stdout)));
}
async function journal(event) {
  const f = await open(path.join(directory, 'dispatch.jsonl'), 'a', 0o600);
  try { await f.writeFile(JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n'); await f.sync(); }
  finally { await f.close(); }
}
function check(id, ok, detail) {
  evidence.checks.push({ id, pass: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
  if (!ok) throw new Error(`check failed: ${id}`);
}
function api(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, method, path: route, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, res => {
      let size = 0; const chunks = [];
      res.on('data', c => { size += c.length; if (size > (1 << 20)) req.destroy(new Error('API body ceiling')); else chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`API ${route}: ${res.statusCode}: ${text}`));
        try { resolve(text ? JSON.parse(text) : null); } catch (e) { reject(e); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('API deadline')), 8000);
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end(payload);
  });
}
function attach(id) {
  // Incremental Docker framing: hold only 8 header bytes, never a whole frame.
  const cap = 4096, total = { stdout: 0, stderr: 0 }, tail = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let header = Buffer.alloc(8), headerN = 0, remaining = 0, stream, socket, ended = false, maxKept = 0;
  let resolveReady, rejectReady, resolveDone;
  const ready = new Promise((r,j) => { resolveReady = r; rejectReady = j; });
  const done = new Promise(r => { resolveDone = r; });
  const finish = reason => { if (!ended) { ended = true; clearTimeout(timer); resolveDone(reason); } };
  function data(chunk) {
    let pos = 0;
    while (pos < chunk.length) {
      if (!remaining) {
        const n = Math.min(8 - headerN, chunk.length - pos);
        chunk.copy(header, headerN, pos, pos + n); headerN += n; pos += n;
        if (headerN < 8) break;
        if (![1,2].includes(header[0]) || header[1] || header[2] || header[3]) { transportError(new Error('invalid frame')); return; }
        stream = header[0] === 1 ? 'stdout' : 'stderr'; remaining = header.readUInt32BE(4); headerN = 0;
        if (!remaining) continue;
      }
      const n = Math.min(remaining, chunk.length - pos);
      const part = chunk.subarray(pos, pos + n);
      total[stream] += n;
      tail[stream] = part.length >= cap ? Buffer.from(part.subarray(part.length - cap)) : Buffer.concat([tail[stream], part]).subarray(-cap);
      // Copy small slices to avoid retaining their larger backing allocation.
      tail[stream] = Buffer.from(tail[stream]);
      maxKept = Math.max(maxKept, tail.stdout.length + tail.stderr.length);
      pos += n; remaining -= n;
    }
  }
  const payload = Buffer.from('{"Detach":false,"Tty":false}');
  const req = http.request({ socketPath, method: 'POST', path: `/exec/${id}/start`, headers: {
    'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'Upgrade', Upgrade: 'tcp',
  } });
  function transportError(e) { rejectReady(e); socket?.destroy(); req.destroy(); finish(`error: ${e.message}`); }
  function connect(s, head) {
    socket = s; clearTimeout(timer); resolveReady();
    s.on('data', data); s.on('error', transportError);
    s.on('end', () => finish(remaining || headerN ? 'truncated-frame' : 'eof'));
    s.on('close', () => finish('closed'));
    if (head?.length) data(head);
  }
  req.on('upgrade', (res, sock, head) => { if (res.statusCode !== 101) return transportError(new Error(`upgrade ${res.statusCode}`)); connect(sock, head); });
  req.on('response', res => { if (res.statusCode !== 200) { res.resume(); return transportError(new Error(`start ${res.statusCode}`)); } connect(res); });
  req.on('error', transportError);
  const timer = setTimeout(() => transportError(new Error('start handshake deadline')), 8000);
  req.end(payload);
  const handle = { ready, done, total, tail, get maxKept() { return maxKept; }, get ended() { return ended; }, destroy() { socket?.destroy(); req.destroy(); finish('intentional-disconnect'); }, text(s='stdout') { return tail[s].toString('utf8'); } };
  handles.add(handle); return handle;
}
async function start(cmd, label) {
  if (globalExpired) throw new Error('spike total deadline');
  if (active.size >= 2) throw new Error('job admission bound');
  const { Id: id } = await api('POST', `/containers/${container}/exec`, { AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, User: '1000:1000', WorkingDir: '/world', Env: ['HOME=/world', 'LC_ALL=C.UTF-8'] });
  await journal({ kind: 'prepared', label, execId: id, container, cmd });
  const h = attach(id); active.set(id, h); await h.ready;
  return { id, h, label };
}
async function inspect(job) { return api('GET', `/exec/${job.id}/json`); }
async function finish(job, timeoutMs=12000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  do { state = await inspect(job); if (!state.Running && state.ExitCode !== null) break; await sleep(50); } while (Date.now() < deadline);
  if (state.Running || state.ExitCode === null) throw new Error(`job ${job.label} did not finish within probe deadline`);
  let timer;
  const streamEnd = await Promise.race([job.h.done, new Promise(r => { timer = setTimeout(() => r('drain-deadline'), 3000); })]);
  clearTimeout(timer); if (!job.h.ended) job.h.destroy();
  const result = { id: job.id, label: job.label, exitCode: state.ExitCode, streamEnd, total: job.h.total, kept: { stdout: job.h.tail.stdout.length, stderr: job.h.tail.stderr.length }, maxKept: job.h.maxKept, stdout: job.h.text(), stderr: job.h.text('stderr') };
  evidence.jobs.push(result); active.delete(job.id); handles.delete(job.h); await journal({ kind: 'observed', ...result });
  return result;
}
const py = code => ['python3', '-I', '-c', code];
const sh = command => ['/bin/sh', '-c', command];
async function control(code) { return cli(['exec', '--user', '1000:1000', container, 'python3', '-I', '-c', code]); }
const metrics = () => control("import json,pathlib; p=pathlib.Path('/sys/fs/cgroup'); print(json.dumps({n:(p/n).read_text() for n in ['memory.current','memory.max','pids.current','pids.max','cpu.max','cpu.stat']}))").then(JSON.parse);
async function cleanup() {
  for (const h of handles) h.destroy();
  // Setup failure can leave a container even if `docker create` did not return its ID.
  let info;
  try { info = JSON.parse(await cli(['inspect', container ?? name]))[0]; }
  catch (e) { if (/No such (object|container)/.test(e.message)) { evidence.cleanup = { absent: true }; return; } throw e; }
  if (info.Name !== `/${name}` || info.Config.Labels?.[LABEL] !== runId || !/^[a-f0-9]{64}$/.test(info.Id)) throw new Error('cleanup identity mismatch; refusing');
  await cli(['rm', '-f', info.Id]);
  evidence.cleanup = { removed: info.Id, name };
}
const watchdog = setTimeout(() => {
  globalExpired = true;
  // Probe-owned resource only. This is a test-harness deadline, not an agent action deadline.
  cleanup().catch(e => console.error(`deadline cleanup failed: ${e.message}`));
}, 120000);
try {
  const ctx = JSON.parse(await cli(['context', 'inspect', CONTEXT]))[0];
  const endpoint = ctx.Endpoints.docker.Host;
  if (!endpoint.startsWith('unix://')) throw new Error('local Docker socket required');
  socketPath = endpoint.slice(7);
  evidence.engine = await api('GET', '/version');
  const imageInfo = JSON.parse(await cli(['image', 'inspect', IMAGE]))[0];
  evidence.imageIdentity = { id: imageInfo.Id, os: imageInfo.Os, arch: imageInfo.Architecture };
  const flags = ['create', '--pull', 'never', '--name', name, '--label', `${LABEL}=${runId}`, '--user', '1000:1000', '--init', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--restart', 'no', '--log-driver', 'none', '--ipc', 'private', '--memory', '96m', '--memory-swap', '96m', '--cpus', '0.5', '--pids-limit', '64', '--ulimit', 'nofile=128:128', '--ulimit', 'msgqueue=0:0', '--shm-size', '4m', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--tmpfs', '/world:rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=700', '--env', 'HOME=/world', IMAGE, 'sleep', 'infinity'];
  evidence.flags = flags;
  container = (await cli(flags)).trim();
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('invalid container ID');
  await cli(['start', container]);
  evidence.container = container;
  evidence.baselineMetrics = await metrics();

  const once = await start(py("import time,pathlib; p=pathlib.Path('/world/once'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1'); print('started',flush=True); time.sleep(1.5); print('finished',flush=True)"), 'wait-and-inspect');
  await sleep(200);
  check('J1-wait-expiry-is-running', (await inspect(once)).Running, { id: once.id, waitMs: 200 });
  const onceResult = await finish(once);
  const count = (await control("from pathlib import Path; print(Path('/world/once').read_text())")).trim();
  check('J2-same-job-completes-once', onceResult.exitCode === 0 && count === '1' && onceResult.stdout.includes('finished'), { count, id: once.id });

  const before = await metrics();
  const busy = "import time; x=bytearray(12*1024*1024); print('allocated',flush=True); end=time.monotonic()+2.5\nwhile time.monotonic()<end: pass\ntime.sleep(1)";
  const a = await start(py(busy), 'concurrent-a'), b = await start(py(busy), 'concurrent-b');
  await sleep(700);
  const during = await metrics();
  let admission = false;
  try { await start(sh('echo forbidden >/world/third'), 'rejected-third'); } catch(e) { if (e.message === 'job admission bound') admission = true; else throw e; }
  check('J3-two-jobs-share-limits', (await inspect(a)).Running && (await inspect(b)).Running && Number(during['memory.current']) > Number(before['memory.current']) + 12*1024*1024 && during['memory.max'].trim() === String(96*1024*1024) && during['pids.max'].trim() === '64' && during['cpu.max'].trim() === '50000 100000', { before, during });
  const ar = await finish(a), br = await finish(b);
  const after = await metrics();
  const throttled = s => Number(s.match(/nr_throttled (\d+)/)?.[1]);
  check('J4-cpu-throttled-and-admission-bounded', admission && ar.exitCode === 0 && br.exitCode === 0 && throttled(after['cpu.stat']) > throttled(before['cpu.stat']) && (await control("from pathlib import Path; print(Path('/world/third').exists())")).trim() === 'False', { admission, after });

  const flood = await start(py("import os,time; print('waiting',flush=True); time.sleep(.5)\nfor i in range(2048): os.write(1,b'x'*4096)\nfor i in range(1024): os.write(2,b'y'*4096)\nprint('flood-finished',flush=True)"), 'late-output-flood');
  await sleep(100); check('J5-flood-job-survives-wait', (await inspect(flood)).Running, {});
  const fr = await finish(flood);
  check('J6-output-counted-not-accumulated', fr.exitCode === 0 && fr.total.stdout >= 8*1024*1024 && fr.total.stderr === 4*1024*1024 && fr.maxKept <= 8192 && fr.stdout.includes('flood-finished'), { total: fr.total, kept: fr.kept, maxKept: fr.maxKept });

  // Negative control: native Engine exec closes inherited output after the root exits.
  const writer = "import os,time,pathlib\npathlib.Path('/world/writer-pid').write_text(str(os.getpid()))\nfor i in range(250):\n try: os.write(1,b'z'*1024)\n except BrokenPipeError: pathlib.Path('/world/broken-pipe').write_text(str(i)); break\n pathlib.Path('/world/inherited-count').write_text(str(i+1)); time.sleep(.02)";
  const escapedWriter = await start(['/bin/sh', '-c', 'python3 -I -c "$1" & echo root-exited', 'sh', writer], 'inherited-pipe-negative-control');
  const er = await finish(escapedWriter);
  await sleep(1000);
  const inheritedFirst = JSON.parse(await control("import pathlib,json; print(json.dumps({n:(pathlib.Path('/world')/n).read_text() if (pathlib.Path('/world')/n).exists() else None for n in ['inherited-count','broken-pipe']}))"));
  await sleep(5000);
  const inherited = JSON.parse(await control("import pathlib,json; p=pathlib.Path('/world'); pid=(p/'writer-pid').read_text(); proc=pathlib.Path('/proc')/pid; print(json.dumps({'count':(p/'inherited-count').read_text(),'brokenPipe':(p/'broken-pipe').read_text() if (p/'broken-pipe').exists() else None,'alive':proc.exists(),'wchan':(proc/'wchan').read_text() if proc.exists() else None}))"));
  // This is an observation, not a requirement that every engine kills the writer.
  // Even surviving writers no longer have reliable captured output after root exit.
  check('J7-inherited-pipe-output-not-job-lifetime', er.exitCode === 0 && er.total.stdout < Number(inherited.count)*1024, { first: inheritedFirst, later: inherited, capturedBytes: er.total.stdout });

  const redirectedCode = "import os,time,pathlib\nfor i in range(80): os.write(1,b'r'*1024); pathlib.Path('/world/redirect-count').write_text(str(i+1)); time.sleep(.02)";
  const redirected = await start(['/bin/sh', '-c', 'python3 -I -c "$1" >/world/background.out 2>/world/background.err </dev/null & echo root-exited', 'sh', redirectedCode], 'redirected-background');
  const rr = await finish(redirected); await sleep(2300);
  const redirectState = JSON.parse(await control("import pathlib,json; p=pathlib.Path('/world'); print(json.dumps({'count':(p/'redirect-count').read_text(),'bytes':(p/'background.out').stat().st_size}))"));
  check('J8-redirected-background-survives-root-exit', rr.exitCode === 0 && redirectState.count === '80' && redirectState.bytes === 80*1024, redirectState);

  const disconnect = await start(py("import time,pathlib; time.sleep(1); pathlib.Path('/world/disconnected').write_text('completed'); time.sleep(.5)"), 'intentional-stream-disconnect');
  await sleep(100); disconnect.h.destroy(); await sleep(100);
  check('J9-disconnect-is-not-cancellation', (await inspect(disconnect)).Running, { id: disconnect.id });
  const dr = await finish(disconnect);
  check('J10-disconnected-job-not-replayed', dr.exitCode === 0 && (await control("from pathlib import Path; print(Path('/world/disconnected').read_text())")).trim() === 'completed', { exitCode: dr.exitCode });

  const cancelCode = "import os,subprocess,json,time\nc=subprocess.Popen(['sleep','30'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),'child':c.pid}),flush=True)\ntime.sleep(30)";
  const cancel = await start(py(cancelCode), 'agent-requested-group-cancel');
  let meta;
  for (let i=0;i<30;i++) { try { meta=JSON.parse(cancel.h.text()); break; } catch { await sleep(50); } }
  if (!meta || meta.pgid <= 1 || meta.child <= 1) throw new Error('missing cancellation identity');
  const childStart = (await control(`print(open('/proc/${meta.child}/stat').read().rsplit(')',1)[1].split()[19])`)).trim();
  await control(`import os,signal; os.killpg(${meta.pgid},signal.SIGTERM)`);
  const cr = await finish(cancel);
  const escaped = (await control(`from pathlib import Path; print(Path('/proc/${meta.child}').exists())`)).trim();
  check('J11-group-cancel-does-not-claim-all-descendants', cr.exitCode === 143 && escaped === 'True', { meta, exitCode: cr.exitCode, escaped });
  // Agent can explicitly inspect/kill a remaining process with a pidfd to avoid PID reuse.
  const killed = await control(`import os,signal; fd=os.pidfd_open(${meta.child}); start=open('/proc/${meta.child}/stat').read().rsplit(')',1)[1].split()[19]; assert start==${JSON.stringify(childStart)}; signal.pidfd_send_signal(fd,signal.SIGTERM); os.close(fd); print('signalled')`);
  await sleep(200);
  const gone = (await control(`from pathlib import Path; print(not Path('/proc/${meta.child}').exists())`)).trim();
  check('J12-specific-process-cancel-and-reaping', killed.trim()==='signalled' && gone==='True', { gone });
  const finalState = JSON.parse(await cli(['inspect', container]))[0].State;
  check('J13-world-remains-running', finalState.Running, { running: finalState.Running });
} catch (error) {
  evidence.error = error.stack ?? String(error); console.error(error.message); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { await cleanup(); } catch(e) { evidence.cleanupError=e.stack??String(e); process.exitCode=1; console.error(e.message); }
  evidence.finished = new Date().toISOString();
  const text=JSON.stringify(evidence,null,2)+'\n'; const file=path.join(directory,'results.json');
  await writeFile(file,text,{mode:0o600});
  console.log(JSON.stringify({evidence:file,sha256:createHash('sha256').update(text).digest('hex'),checks:evidence.checks.length,failed:evidence.checks.filter(c=>!c.pass).length,error:evidence.error??null,cleanup:evidence.cleanup??evidence.cleanupError},null,2));
}
