"""Phase-3 hardening test (in-process, real engine + routes). Usage: hermes-venv-python -I hardening.py <16k mono wav>"""
import io, sys, time, wave, os, importlib.util, threading
sys.path.insert(0, os.path.expanduser('~/.hermes/hermes-agent'))
P = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m
eng_mod = load('_better_voice_engine', P + '/engine.py'); api = load('lw_api', P + '/dashboard/plugin_api.py')
from fastapi import FastAPI
from starlette.testclient import TestClient
app = FastAPI(); app.include_router(api.router, prefix='/x'); c = TestClient(app); B = '/x'
w = wave.open(sys.argv[1]); pcm = w.readframes(w.getnframes()); w.close()
ok = True
def check(n, cond, extra=''):
    global ok; ok &= bool(cond); print(('PASS' if cond else 'FAIL'), n, extra)
def stream(tid, data, pace=0.0):
    c.post(B + '/takes', json={'take_id': tid, 'client_id': 'h'}); off = 0; parts = 0
    while off < len(data):
        r = c.post(B + f'/takes/{tid}/audio?offset={off}', files={'file': ('a', data[off:off + 8000])}); off = r.json()['have']
        if r.json()['partial']: parts += 1
        if pace: time.sleep(pace)
    return parts
def wait(tid, n=900):
    for _ in range(n):
        j = c.get(B + f'/takes/{tid}').json()
        if j.get('state') in ('done', 'error'): return j
        time.sleep(0.3)
    return j

# 1. three overlapping takes (pool max 2): all finish, FIFO, none lost
for i in (1, 2, 3):
    stream(f'h{i}', pcm, pace=0.02); c.post(B + f'/takes/h{i}/end', json={})
r = [wait(f'h{i}') for i in (1, 2, 3)]
check('3 overlapping takes all finished', all(x['state'] == 'done' and x['text'] for x in r), [x.get('source') for x in r])
for i in (1, 2, 3): c.post(B + f'/takes/h{i}/ack')

# 2. incomplete upload: end with total_bytes larger than received -> 409 missing_bytes, take still recording
c.post(B + '/takes', json={'take_id': 'h-miss', 'client_id': 'h'}); c.post(B + '/takes/h-miss/audio?offset=0', files={'file': ('a', pcm[:32000])})
r = c.post(B + '/takes/h-miss/end', json={'total_bytes': 64000}); check('end with missing bytes -> 409', r.status_code == 409, r.json())
c.post(B + '/takes/h-miss/audio?offset=32000', files={'file': ('a', pcm[32000:64000])})
r = c.post(B + '/takes/h-miss/end', json={'total_bytes': 64000}); check('after resend, end accepted', r.status_code == 200 and r.json()['state'] in ('queued', 'finalizing'))
j = wait('h-miss'); check('completed after retry', j['state'] == 'done'); c.post(B + '/takes/h-miss/ack')

# 3. gateway restart simulation: engine forgotten -> unknown_take -> /recover with the whole WAV
buf = io.BytesIO()
with wave.open(buf, 'wb') as wf: wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(pcm)
check('unknown take -> 404', c.get(B + '/takes/h-gone').status_code == 404)
r = c.post(B + '/recover?take_id=h-gone&client_id=h', files={'file': ('t.wav', buf.getvalue())}); check('recover accepted', r.status_code == 200, r.json())
j = wait('h-gone'); check('recovered take transcribed', j['state'] == 'done' and j['text'], j.get('text'))
r2 = c.post(B + '/recover?take_id=h-gone&client_id=h', files={'file': ('t.wav', buf.getvalue())}); check('recover is idempotent', r2.status_code == 200)
c.post(B + '/takes/h-gone/ack')
bad = c.post(B + '/recover?take_id=h-bad', files={'file': ('t.wav', b'notawav')}); check('bad wav rejected', bad.status_code == 400)

# 4. long take (~2 min): finishes, memory sane
long_pcm = pcm * 15
t0 = time.monotonic(); stream('h-long', long_pcm); c.post(B + '/takes/h-long/end', json={}); j = wait('h-long', 1500)
check('2-minute take finished', j['state'] == 'done' and len(j['text']) > 200, f"{time.monotonic()-t0:.0f}s, {len(j.get('text',''))} chars")
c.post(B + '/takes/h-long/ack')

# 5. client disappears mid-take (no end): sweeper detaches the worker, audio kept
c.post(B + '/takes', json={'take_id': 'h-abandon', 'client_id': 'h'}); c.post(B + '/takes/h-abandon/audio?offset=0', files={'file': ('a', pcm[:64000])})
e = eng_mod.get(); t = e.get('h-abandon'); time.sleep(1); check('abandoned take holds a worker (live)', t.worker is not None or t.live)
t.last_io -= 25; time.sleep(6)
check('idle take detached its worker', t.worker is None)
c.delete(B + '/takes/h-abandon')

# 6. per-take turbo cap: a wedged decode times out, the queue moves on, later takes fail fast as 'busy'
check('result TTL is 6 h', eng_mod.RESULT_TTL_S == 21600, eng_mod.RESULT_TTL_S)
real_decode = e.turbo._decode_locked
release = threading.Event()
def slow_decode(take, path):
    release.wait(30)  # stands in for a hung faster-whisper call
    return 'late text that must be ignored'
saved = (eng_mod.TURBO_CAP_MIN_S, eng_mod.TURBO_CAP_MULT, eng_mod.TURBO_CAP_PAD_S, eng_mod.WEDGED_SLOT_TIMEOUT_S)
eng_mod.TURBO_CAP_MIN_S, eng_mod.TURBO_CAP_MULT, eng_mod.TURBO_CAP_PAD_S, eng_mod.WEDGED_SLOT_TIMEOUT_S = 1, 0, 0, 1
e.turbo._decode_locked = slow_decode
def direct_take(tid, partial=''):
    t = e.create(tid, client_id='h'); t.live = False; t.pcm = bytearray(pcm[:32000]); t.partial = partial; t.end(); return t
t0 = time.monotonic(); direct_take('h-wedge'); j = wait('h-wedge', 40)
check('wedged decode -> error timeout within the cap', j['state'] == 'error' and j.get('error') == 'timeout', f"{j} {time.monotonic()-t0:.1f}s")
check('health reports turbo wedged', c.get(B + '/health').json().get('turbo') == 'wedged')
t0 = time.monotonic(); direct_take('h-busy', partial='preview words here'); j = wait('h-busy', 40); dt = time.monotonic() - t0
check('while wedged, next take falls back fast (busy, preview text)', j['state'] == 'done' and j.get('source') == 'preview'
      and j.get('error') == 'busy' and j['text'] == 'preview words here' and dt < 6, f'{j} {dt:.1f}s')
release.set(); time.sleep(0.5)
check('stuck thread finished -> no longer wedged', c.get(B + '/health').json().get('turbo') != 'wedged')
check('late result of a timed-out take is ignored', c.get(B + '/takes/h-wedge').json().get('state') == 'error')
e.turbo._decode_locked = real_decode
eng_mod.TURBO_CAP_MIN_S, eng_mod.TURBO_CAP_MULT, eng_mod.TURBO_CAP_PAD_S, eng_mod.WEDGED_SLOT_TIMEOUT_S = saved
direct_take('h-after'); j = wait('h-after')
check('turbo works again after the wedge clears', j['state'] == 'done' and j.get('source') == 'turbo' and j['text'], j.get('text'))
for tid in ('h-wedge', 'h-busy', 'h-after'): c.post(B + f'/takes/{tid}/ack')

# 7. orphan listing: done text only, only for the matching client_id, never audio
ta = e.create('h-mine', client_id='h-client-a'); ta.text, ta.state = 'my words', 'done'
tq = e.create('h-mine-q', client_id='h-client-a'); tq.state = 'queued'; tq.text = 'not yet'
tb = e.create('h-theirs', client_id='h-client-b'); tb.text, tb.state = 'their words', 'done'
r = c.get(B + '/takes?client_id=h-client-a'); rows = r.json()
check('list ok', r.status_code == 200, rows)
check('list only returns this client', {x['take_id'] for x in rows} == {'h-mine', 'h-mine-q'}, rows)
check('list has done text + created, no text for unfinished', any(x['take_id'] == 'h-mine' and x['text'] == 'my words' and isinstance(x['created'], float) for x in rows)
      and all(x['text'] == '' for x in rows if x['take_id'] == 'h-mine-q'), rows)
check('list never leaks audio or client ids', all(set(x) == {'take_id', 'state', 'text', 'created'} for x in rows), rows)
check('bad client_id rejected', c.get(B + '/takes?client_id=../x').status_code == 400)
for tid in ('h-mine', 'h-mine-q', 'h-theirs'): c.delete(B + f'/takes/{tid}')

# 7b. app quit mid-recording: no /end ever arrives -> after AUTO_END_S the gateway finalizes it so restore can find it
c.post(B + '/takes', json={'take_id': 'h-quit', 'client_id': 'hq'}); c.post(B + '/takes/h-quit/audio?offset=0', files={'file': ('a', pcm[:96000])})
eq = eng_mod.get(); tq = eq.get('h-quit'); tq.last_io -= eng_mod.AUTO_END_S + 5
jq = wait('h-quit', 300)
check('abandoned recording auto-finalized and transcribed', jq['state'] == 'done' and bool(jq['text']), jq.get('text'))
lst = c.get(B + '/takes?client_id=hq').json(); rows = lst if isinstance(lst, list) else lst.get('takes', [])
check('restore list returns it', any(x['take_id'] == 'h-quit' and x.get('text') for x in rows), lst)
c.post(B + '/takes/h-quit/ack')

# 8. cancel releases everything; health sane
print(c.get(B + '/health').json())
check('no stray takes left', not [x for x in e.list() if x['take_id'].startswith('h')], e.list())
e.shutdown(); print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
