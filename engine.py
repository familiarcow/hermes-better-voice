"""better-voice engine: one shared singleton for the stock provider path AND the plugin REST routes.

Loaded once per process via sys.modules['_better_voice_engine'] (see get_engine() in provider.py /
dashboard/plugin_api.py). No network. Local only.

- Take: audio buffer + state machine (recording -> queued -> finalizing -> done / error / cancelled).
- WorkerPool: up to 2 Moonshine worker processes (worker.py, one stream each). A worker is released as soon
  as Moonshine's end-of-audio flush returns (<= ~1 s), NOT after the slow turbo pass.
- Turbo: one FIFO thread running faster-whisper (large-v3-turbo by default) via the vendored vendor/local_stt.py.
- Every ended take is spooled to $HERMES_HOME/better-voice/spool/<id>.wav (0600) BEFORE it is queued, and
  unacked spool files are re-queued on engine start.
"""
import copy
import importlib.util
import json
import logging
import os
import queue
import struct
import subprocess
import threading
import time
import uuid
import wave
from pathlib import Path

VERSION = '0.2.0'
MAX_TAKE_BYTES = 600 * 32000          # 600 s of 16 kHz s16le
LIVE_IDLE_S = 20                      # recording take with no audio this long -> detach worker
AUTO_END_S = 60                       # ...and after this long with no audio (client quit/slept) -> end + transcribe, so restore can find it
RESULT_TTL_S = 21600                  # unacked finished results kept this long (6 h: orphan recovery window)
SPOOL_TTL_S = 86400
START_TIMEOUT_S = 20.0
TURBO_SLOT_TIMEOUT_S = 180
# Per-take decode cap: max(TURBO_CAP_MIN_S, TURBO_CAP_MULT * audio_seconds + TURBO_CAP_PAD_S).
# Module constants so tests can shrink them instead of waiting minutes.
TURBO_CAP_MIN_S = 120
TURBO_CAP_MULT = 3
TURBO_CAP_PAD_S = 60
WEDGED_SLOT_TIMEOUT_S = 2             # slot wait while an earlier decode is wedged (fail fast to 'busy')


def _home():
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()).resolve()


def _rt():
    # runtime dir (venv, models, spool). Pre-rename installs used 'live-whisper': keep using it if that is all that exists.
    new, old = _home() / 'better-voice', _home() / 'live-whisper'
    return old if (old.exists() and not new.exists()) else new


def _preview_arch():
    try:
        from hermes_cli.config import load_config_readonly
        # stt.live_whisper = the config key used before the v0.6 rename; still honoured so existing installs keep working.
        s = (load_config_readonly().get('stt') or {}).get('better_voice') or (load_config_readonly().get('stt') or {}).get('live_whisper') or {}
        a = s.get('preview_model', 'small')
        return a if a in ('small', 'medium', 'none') else 'small'
    except Exception:
        return 'small'


_LOCAL = None
_LOCAL_LOCK = threading.Lock()


def _local():
    """Vendored offline faster-whisper loader (vendor/local_stt.py, MIT, from smart-dictation), cached once per process."""
    global _LOCAL
    with _LOCAL_LOCK:
        if _LOCAL is None:
            path = Path(__file__).resolve().parent / 'vendor' / 'local_stt.py'
            spec = importlib.util.spec_from_file_location('_better_voice_local_stt', path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _LOCAL = mod
        return _LOCAL


_log = logging.getLogger('better_voice')


class Worker:
    """One persistent Moonshine process; serves one take at a time."""

    def __init__(self, arch):
        self.arch = arch
        self.proc = None
        self.take = None          # take currently using (or reserving) this worker
        self.ready = threading.Event()
        self.final_ev = threading.Event()
        self.final_text = ''
        self.wlock = threading.Lock()
        self.dead = False

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        rt = _rt()
        py, script, models = rt / 'venv' / 'bin' / 'python', rt / 'worker.py', rt / 'models'
        if not (py.exists() and script.exists() and models.exists()):
            raise RuntimeError('worker runtime missing')
        self.proc = subprocess.Popen(
            [str(py), '-I', str(script), str(models), self.arch],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
        if not self.ready.wait(START_TIMEOUT_S):
            self.kill()
            raise RuntimeError('worker start timeout')

    def _reader(self, proc):
        try:
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if proc is not self.proc:
                    return
                t = msg.get('t')
                if t == 'ready':
                    self.ready.set()
                elif t == 'partial':
                    tk = self.take
                    if tk is not None:
                        tk.partial = msg.get('text', '')
                elif t == 'final':
                    self.final_text = msg.get('text', '')
                    self.final_ev.set()
        finally:
            if proc is self.proc:
                self.dead = True
                self.ready.clear()
                tk = self.take
                if tk is not None:
                    tk.live = False
                self.final_ev.set()

    def send(self, kind, payload=b''):
        with self.wlock:
            self.proc.stdin.write(kind + struct.pack('>I', len(payload)) + payload)

    def begin(self, take):
        self.final_ev.clear()
        self.final_text = ''
        self.take = take
        self.send(b'B')

    def flush(self):
        """End-of-audio: ask Moonshine for its final text. Returns it ('' on failure)."""
        try:
            self.send(b'E')
            self.final_ev.wait(3)
            return self.final_text or ''
        except Exception:
            return ''

    def kill(self):
        proc, self.proc = self.proc, None
        self.ready.clear()
        self.dead = True
        if proc is not None and proc.poll() is None:
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


class Pool:
    MAX = 2

    def __init__(self):
        self.workers = []
        self.lock = threading.Lock()

    def acquire(self, take):
        """Reserve a ready worker for `take` (spawning one if allowed). Returns a started Worker or None."""
        arch = _preview_arch()
        spawn = None
        with self.lock:
            self.workers = [w for w in self.workers if not (w.dead and w.take is None)]
            for w in self.workers:
                if w.take is None and w.alive() and w.ready.is_set() and w.arch == arch:
                    w.take = take
                    return w
            if len(self.workers) < self.MAX:
                spawn = Worker(arch)
                spawn.take = take
                self.workers.append(spawn)
        if spawn is None:
            return None
        try:
            spawn.start()
            return spawn
        except Exception:
            self.drop(spawn)
            raise

    def release(self, w):
        w.take = None

    def drop(self, w):
        w.kill()
        w.take = None
        with self.lock:
            if w in self.workers:
                self.workers.remove(w)

    def reap(self, idle_keep=1):
        with self.lock:
            idle = [w for w in self.workers if w.take is None]
        for w in idle[idle_keep:]:
            self.drop(w)

    def shutdown(self):
        with self.lock:
            ws, self.workers = self.workers, []
        for w in ws:
            w.kill()

    def status(self):
        with self.lock:
            ws = list(self.workers)
        if not ws:
            return 'cold'
        return 'warm' if any(w.alive() and w.ready.is_set() for w in ws) else 'dead'


class Take:
    def __init__(self, engine, take_id, client_id='', language=None, prompt=None, model=None, ext_path=None):
        self.e = engine
        self.id = take_id
        self.client_id = client_id
        self.language, self.prompt, self.model = language, prompt, model
        self.ext_path = ext_path          # stock transcribe(file) path: decode this file, never delete it
        self.pcm = bytearray()
        self.state = 'recording'
        self.partial = ''
        self.moon = ''
        self.text = ''
        self.source = ''
        self.error = ''
        self.live = True
        self.worker = None
        self.attaching = False
        self.next_attach = 0.0
        self.created = self.last_io = time.monotonic()
        self.wall = time.time()
        self.done = threading.Event()
        self.lock = threading.RLock()

    # ---- recording ----
    def have(self):
        return len(self.pcm)

    def add_audio(self, chunk):
        with self.lock:
            if self.state != 'recording':
                return
            self.last_io = time.monotonic()
            self.pcm += chunk[: max(0, MAX_TAKE_BYTES - len(self.pcm))]
            w = self.worker
            if w is not None and self.live:
                try:
                    w.send(b'A', bytes(chunk))
                except Exception:
                    self.live = False
                    self.worker = None
            elif w is None and self.live and not self.attaching and time.monotonic() >= self.next_attach:
                self.attaching = True
                self.next_attach = time.monotonic() + 0.5
                threading.Thread(target=self._attach, daemon=True).start()

    def _attach(self):
        w = None
        try:
            if _preview_arch() == 'none':
                self.live = False  # live preview disabled in config: final (whisper) text only
                return
            w = self.e.pool.acquire(self)
            if w is None:
                return
            with self.lock:
                if self.state != 'recording':
                    self.e.pool.release(w)
                    return
                w.begin(self)
                if self.pcm:
                    w.send(b'A', bytes(self.pcm))  # replay what was buffered before a worker was free
                self.worker = w
                w = None
        except Exception:
            self.live = False  # no preview; the turbo final still works
        finally:
            if w is not None:
                self.e.pool.release(w)
            self.attaching = False

    def detach(self):
        """Idle/disconnected: free the worker, keep the audio."""
        with self.lock:
            w, self.worker = self.worker, None
        if w is not None:
            self.live = False
            self.e.pool.drop(w)

    # ---- ending ----
    def end(self):
        with self.lock:
            if self.state != 'recording':
                return
            self.state = 'queued'
            w, self.worker = self.worker, None
        if w is not None:
            threading.Thread(target=self._flush, args=(w,), daemon=True).start()
        if not self.pcm and not self.ext_path:
            self.text, self.source, self.state = '', 'turbo', 'done'
            self.done.set()
            return
        if not self.ext_path:
            try:
                self.e.spool(self)
            except Exception:
                pass  # spool is a recovery aid; the in-memory PCM is still decoded
        self.e.turbo.put(self)

    def _flush(self, w):
        moon = w.flush()
        self.moon = moon or self.partial
        if moon:
            self.partial = moon
        if w.dead:
            self.e.pool.drop(w)
        else:
            self.e.pool.release(w)

    def cancel(self):
        with self.lock:
            was = self.state
            self.state = 'cancelled'
            w, self.worker = self.worker, None
        if w is not None:
            self.e.pool.drop(w)  # mid-stream worker: restart cleanly rather than reuse
        self.e.unspool(self)
        self.done.set()
        return was

    def info(self):
        d = {'take_id': self.id, 'state': self.state, 'partial': self.partial, 'live': bool(self.live and self.state == 'recording')}
        if self.state in ('done', 'error'):
            d.update(text=self.text, source=self.source)
            if self.error:
                d['error'] = self.error
        if self.state == 'queued':
            d['position'] = self.e.turbo.q.qsize()
        return d


class Turbo:
    def __init__(self, engine):
        self.e = engine
        self.q = queue.Queue()
        self.t = None
        self.lock = threading.Lock()
        self.ran = False
        self.stuck = []           # decode threads that blew their per-take cap and are still running

    def put(self, take):
        with self.lock:
            if self.t is None or not self.t.is_alive():
                self.t = threading.Thread(target=self._run, daemon=True, name='better-voice-turbo')
                self.t.start()
        self.q.put(take)

    def wedged(self):
        with self.lock:
            self.stuck = [t for t in self.stuck if t.is_alive()]
            return bool(self.stuck)

    @staticmethod
    def cap_seconds(take):
        if take.ext_path is not None:
            try:
                secs = max(0, os.path.getsize(take.ext_path) - 44) / 32000  # rough; any codec is fine for a cap
            except OSError:
                secs = 0
        else:
            secs = len(take.pcm) / 32000
        return max(TURBO_CAP_MIN_S, TURBO_CAP_MULT * secs + TURBO_CAP_PAD_S)

    def _decode_locked(self, take, path):
        """The actual faster-whisper pass. Caller holds local.SLOT."""
        from hermes_cli.config import load_config_readonly
        local = _local()
        root = copy.deepcopy(load_config_readonly())
        root.setdefault('stt', {})['provider'] = 'local'
        stt = root['stt']
        mine = stt.get('better_voice') or stt.get('live_whisper') or {}
        # final model: per-take override > stt.better_voice.final_model > large-v3-turbo (stt.local.model is ignored: Hermes defaults it to 'base')
        final = take.model or mine.get('final_model') or 'large-v3-turbo'
        cfg = local.settings(root, model=final, language=take.language, prompt=take.prompt,
                             prompt_present=isinstance(take.prompt, str))
        if cfg is None:
            raise RuntimeError('stt_unavailable')
        self.ran = True
        return local.decode_local(path, owner_home=_home(), settings=cfg, max_seconds=600)

    def _decode(self, take):
        """Decode one take with a hard per-take wall-clock cap.

        The decode runs in its own thread and the turbo FIFO thread only join()s it for cap_seconds(take).
        Honest limitation: Python cannot kill a thread, so a wedged decode keeps running (and keeps holding
        the vendored single-slot SLOT) until it returns on its own, if ever. We cope with that by:
          - giving up on THIS take ('timeout') and moving on with the queue;
          - remembering the thread in self.stuck -> health() reports turbo 'wedged';
          - while wedged, later takes wait only WEDGED_SLOT_TIMEOUT_S for the slot and then fail as 'busy'
            (falling back to the Moonshine preview text when there is one) instead of 180 s each;
          - the stuck thread releases the slot in its own finally, so if it ever finishes, turbo recovers.
        """
        import tempfile
        local = _local()
        path, tmp = take.ext_path, None
        if path is None:
            path = str(_rt() / 'spool' / f'{take.id}.wav')
            if not os.path.exists(path):  # spool failed earlier: decode from memory
                fd, tmp = tempfile.mkstemp(suffix='.wav')
                os.close(fd)
                _write_wav(tmp, bytes(take.pcm))
                path = tmp

        def cleanup():
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

        wait = WEDGED_SLOT_TIMEOUT_S if self.wedged() else TURBO_SLOT_TIMEOUT_S
        if not local.SLOT.acquire(timeout=wait):
            cleanup()
            raise RuntimeError('busy')
        box = {}

        def work():
            # SLOT is a plain threading.Lock, so releasing it from this thread is legal.
            try:
                box['text'] = self._decode_locked(take, path)
            except BaseException as ex:  # noqa: BLE001 - surfaced to the FIFO thread via box
                box['err'] = ex
            finally:
                local.SLOT.release()
                cleanup()

        th = threading.Thread(target=work, daemon=True, name=f'better-voice-decode-{take.id}')
        try:
            th.start()
        except Exception:
            local.SLOT.release()
            cleanup()
            raise
        th.join(self.cap_seconds(take))
        if th.is_alive():
            with self.lock:
                self.stuck.append(th)
            raise TimeoutError('timeout')
        if 'err' in box:
            raise box['err']
        return box.get('text', '')

    def _run(self):
        while True:
            take = self.q.get()
            if take.state == 'cancelled':
                continue
            take.state = 'finalizing'
            try:
                text = self._decode(take)
                if take.state == 'cancelled':
                    continue
                take.text = text
                take.source = 'turbo'
                take.state = 'done'
            except Exception as ex:
                if take.state == 'cancelled':
                    continue
                _log.warning('final transcription of take %s (model=%r) failed (%r); falling back to the live preview text', take.id, take.model, ex, exc_info=True)
                err = 'timeout' if isinstance(ex, TimeoutError) else (str(ex) or 'transcription_failed')
                fallback = (take.moon or take.partial or '').strip()
                if fallback and take.ext_path is None:
                    take.text, take.source, take.state = fallback, 'preview', 'done'
                    if err in ('timeout', 'busy'):
                        take.error = err  # done with preview text, but say why turbo did not run
                else:
                    take.error = err
                    take.state = 'error'
            finally:
                take.done.set()


def _write_wav(path, pcm):
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm)


class Engine:
    def __init__(self):
        self.pool = Pool()
        self.turbo = Turbo(self)
        self.takes = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        threading.Thread(target=self._sweeper, daemon=True, name='better-voice-sweep').start()
        try:
            self._reload_spool()
        except Exception:
            pass

    # ---- spool ----
    def spool_dir(self):
        d = _rt() / 'spool'
        d.mkdir(parents=True, exist_ok=True)
        return d

    def spool(self, take):
        p = self.spool_dir() / f'{take.id}.wav'
        fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as f:
            pass
        _write_wav(str(p), bytes(take.pcm))
        meta = self.spool_dir() / f'{take.id}.json'
        mfd = os.open(str(meta), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(mfd, 'w') as f:
            json.dump({'client_id': take.client_id, 'language': take.language, 'wall': take.wall}, f)

    def unspool(self, take):
        for ext in ('wav', 'json'):
            try:
                os.unlink(self.spool_dir() / f'{take.id}.{ext}')
            except OSError:
                pass

    def _reload_spool(self):
        d = self.spool_dir()
        now = time.time()
        for wav in sorted(d.glob('*.wav')):
            try:
                if now - wav.stat().st_mtime > SPOOL_TTL_S:
                    wav.unlink()
                    continue
                tid = wav.stem
                meta = {}
                mp = d / f'{tid}.json'
                if mp.exists():
                    meta = json.loads(mp.read_text())
                with wave.open(str(wav)) as w:
                    pcm = w.readframes(w.getnframes())
                t = Take(self, tid, client_id=meta.get('client_id', 'recovered'), language=meta.get('language'))
                t.pcm = bytearray(pcm)
                t.live = False
                if isinstance(meta.get('wall'), (int, float)):
                    t.wall = float(meta['wall'])  # keep the original creation time for ordered restore
                t.state = 'queued'
                self.takes[tid] = t
                self.turbo.put(t)
            except Exception:
                continue

    # ---- takes ----
    def create(self, take_id=None, client_id='', language=None, prompt=None):
        tid = take_id or f'stock-{uuid.uuid4().hex[:12]}'
        with self.lock:
            t = self.takes.get(tid)
            if t is None:
                t = Take(self, tid, client_id=client_id, language=language, prompt=prompt)
                self.takes[tid] = t
        return t

    def get(self, take_id):
        with self.lock:
            return self.takes.get(take_id)

    def forget(self, take_id):
        with self.lock:
            t = self.takes.pop(take_id, None)
        if t is not None:
            self.unspool(t)
        return t

    def list(self, client_id=None):
        with self.lock:
            ts = list(self.takes.values())
        out = []
        for t in ts:
            if client_id and t.client_id != client_id:
                continue
            # metadata + final text only; never audio
            out.append({'take_id': t.id, 'client_id': t.client_id, 'state': t.state,
                        'text': t.text if t.state == 'done' else '', 'created': t.wall})
        out.sort(key=lambda d: d['created'])
        return out

    def transcribe_file(self, path, language=None, model=None, prompt=None, timeout=300):
        """Stock provider.transcribe(file): runs through the same turbo FIFO, so paths never 'busy'-fail each other."""
        t = Take(self, f'file-{uuid.uuid4().hex[:12]}', language=language, prompt=prompt, model=model, ext_path=str(path))
        t.state = 'recording'
        t.end()
        t.done.wait(timeout)
        return t

    def health(self):
        turbo = 'wedged' if self.turbo.wedged() else ('loaded' if self.turbo.ran else 'cold')
        return {'ok': True, 'version': VERSION, 'worker': self.pool.status(),
                'turbo': turbo, 'queue': self.turbo.q.qsize()}

    # ---- housekeeping ----
    def _sweeper(self):
        while not self.stop.wait(5):
            try:
                now = time.monotonic()
                with self.lock:
                    ts = list(self.takes.values())
                for t in ts:
                    if t.state == 'recording':
                        idle = now - t.last_io
                        if idle > AUTO_END_S:
                            t.end()
                        elif idle > LIVE_IDLE_S and t.worker is not None:
                            t.detach()
                    elif t.state in ('done', 'error', 'cancelled') and now - t.created > RESULT_TTL_S:
                        self.forget(t.id)
                self.pool.reap(idle_keep=1)
            except Exception:
                pass

    def shutdown(self):
        self.pool.shutdown()


ENGINE = None
_ENGINE_LOCK = threading.Lock()


def get():
    global ENGINE
    with _ENGINE_LOCK:
        if ENGINE is None:
            ENGINE = Engine()
        return ENGINE
