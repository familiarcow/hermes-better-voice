"""Phase-1 smoke test, in-process, against the real engine + routes. Usage: hermes-venv-python -I smoke.py <16k mono wav>"""
import io, sys, time, wave, json, os, signal, subprocess, importlib.util
sys.path.insert(0, os.path.expanduser('~/.hermes/hermes-agent'))
P = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('_better_voice_engine', P + '/engine.py')
eng_mod = importlib.util.module_from_spec(spec); sys.modules['_better_voice_engine'] = eng_mod; spec.loader.exec_module(eng_mod)
spec = importlib.util.spec_from_file_location('lw_api', P + '/dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec); sys.modules['lw_api'] = api; spec.loader.exec_module(api)
from fastapi import FastAPI
from starlette.testclient import TestClient
app = FastAPI(); app.include_router(api.router, prefix='/api/plugins/better-voice')
c = TestClient(app); B = '/api/plugins/better-voice'
w = wave.open(sys.argv[1]); pcm = w.readframes(w.getnframes()); w.close()
ok = True
def check(name, cond, extra=''):
    global ok; ok &= bool(cond); print(('PASS' if cond else 'FAIL'), name, extra)

print(c.get(B + '/health').json())

def run_take(tid, pace=True, kill_at=None):
    r = c.post(B + '/takes', json={'take_id': tid, 'client_id': 'smoke'}); assert r.status_code == 200, r.text
    off = 0; step = 8000; partials = []  # 250 ms
    t0 = time.monotonic()
    while off < len(pcm):
        chunk = pcm[off:off + step]
        r = c.post(B + f'/takes/{tid}/audio?offset={off}', files={'file': ('a.pcm', chunk)})
        assert r.status_code == 200, (r.status_code, r.text)
        off = r.json()['have']
        if r.json()['partial'] and (not partials or partials[-1] != r.json()['partial']): partials.append(r.json()['partial'])
        if kill_at is not None and off >= kill_at:
            subprocess.run(['pkill', '-f', 'better-voice/worker.py']); kill_at = None
        if pace:
            d = t0 + off / 32000 - time.monotonic()
            if d > 0: time.sleep(d)
    return partials

# 1. idempotent/retry + gap
tid = 'smoke-a'
c.post(B + '/takes', json={'take_id': tid, 'client_id': 'smoke'})
r = c.post(B + f'/takes/{tid}/audio?offset=0', files={'file': ('a', pcm[:16000])}); check('first chunk', r.json()['have'] == 16000)
r = c.post(B + f'/takes/{tid}/audio?offset=0', files={'file': ('a', pcm[:16000])}); check('retry is idempotent', r.json()['have'] == 16000)
r = c.post(B + f'/takes/{tid}/audio?offset=99999', files={'file': ('a', pcm[:100])}); check('gap -> 409', r.status_code == 409 and r.json()['have'] == 16000)
c.delete(B + f'/takes/{tid}')

# 2. two overlapping takes: B records while A is in turbo
a_p = run_take('smoke-1')
r = c.post(B + '/takes/smoke-1/end', json={'total_bytes': len(pcm)}); check('A end queued', r.json()['state'] in ('queued', 'finalizing'), r.json())
t_b = time.monotonic()
b_p = run_take('smoke-2')   # starts immediately; A is still in turbo
check('A had live partials', len(a_p) >= 3, f'{len(a_p)} updates')
check('B (overlapping) had live partials', len(b_p) >= 3, f'{len(b_p)} updates, last={b_p[-1] if b_p else None!r}')
r = c.post(B + '/takes/smoke-2/end', json={'total_bytes': len(pcm)})
res = {}
deadline = time.monotonic() + 120
while time.monotonic() < deadline and len(res) < 2:
    for tid in ('smoke-1', 'smoke-2'):
        j = c.get(B + f'/takes/{tid}').json()
        if j['state'] in ('done', 'error') and tid not in res: res[tid] = (time.monotonic(), j)
    time.sleep(0.3)
check('both takes finished', len(res) == 2)
check('A finished before B (FIFO order)', res['smoke-1'][0] <= res['smoke-2'][0])
for tid in ('smoke-1', 'smoke-2'): print(' ', tid, res[tid][1].get('source'), '|', res[tid][1].get('text'))
check('final source is turbo', all(v[1].get('source') == 'turbo' for v in res.values()))
for tid in ('smoke-1', 'smoke-2'): c.post(B + f'/takes/{tid}/ack')
check('ack removes take', c.get(B + '/takes/smoke-1').status_code == 404)

# 3. worker killed mid-take -> live stops, final still lands
b_p = run_take('smoke-3', kill_at=len(pcm) // 2)
c.post(B + '/takes/smoke-3/end', json={})
for _ in range(400):
    j = c.get(B + '/takes/smoke-3').json()
    if j['state'] in ('done', 'error'): break
    time.sleep(0.3)
check('worker kill: take still finished with turbo text', j['state'] == 'done' and j.get('source') == 'turbo' and j['text'], j)
c.post(B + '/takes/smoke-3/ack')

# 4. next take after the kill respawns the worker
p4 = run_take('smoke-4'); c.post(B + '/takes/smoke-4/end', json={})
check('worker respawned: live text again', len(p4) >= 3, f'{len(p4)} updates')
for _ in range(400):
    j = c.get(B + '/takes/smoke-4').json()
    if j['state'] in ('done', 'error'): break
    time.sleep(0.3)
c.post(B + '/takes/smoke-4/ack')

# 5. spool reload: a spooled-but-unacked take is re-queued on engine start
e = eng_mod.get()
e.spool_dir()
buf = os.path.join(e.spool_dir(), 'smoke-spool.wav')
with wave.open(buf, 'wb') as wf:
    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(pcm)
e._reload_spool()
for _ in range(400):
    t = e.get('smoke-spool')
    if t and t.state in ('done', 'error'): break
    time.sleep(0.3)
check('spool reload re-queues and transcribes', t and t.state == 'done' and t.text, t.text if t else None)
e.forget('smoke-spool')
check('no leftover spool files', not [f for f in os.listdir(e.spool_dir()) if f.startswith('smoke')])
print(c.get(B + '/health').json())
e.shutdown()
print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
