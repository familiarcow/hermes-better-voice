"""better-voice backend routes (/api/plugins/better-voice/*). Local only; no network.

Audio arrives as s16le mono 16 kHz in a multipart `file`. Uploads are offset-addressed and idempotent, so the
desktop can safely retry. Order of takes is enforced by the client, never here.
"""
import asyncio
import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

MAX_CHUNK = 2 * 1024 * 1024
MAX_WAV = 40 * 1024 * 1024


def _engine():
    m = sys.modules.get('_better_voice_engine')
    if m is None:
        path = Path(__file__).resolve().parents[1] / 'engine.py'
        spec = importlib.util.spec_from_file_location('_better_voice_engine', path)
        m = importlib.util.module_from_spec(spec)
        sys.modules['_better_voice_engine'] = m
        spec.loader.exec_module(m)
    return m.get()


router = APIRouter()


def _bad(code, status=400, **extra):
    return JSONResponse({'error': code, **extra}, status_code=status)


async def _json(request):
    try:
        b = await request.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


async def _file_bytes(request, limit):
    n = request.headers.get('content-length')
    if n and n.isdigit() and int(n) > limit + 65536:
        return None
    form = await request.form()
    f = form.get('file')
    if f is None or not hasattr(f, 'read'):
        return None
    data = await f.read()
    return data if len(data) <= limit else None


def _safe_id(v):
    return isinstance(v, str) and 0 < len(v) <= 64 and all(c.isalnum() or c in '-_' for c in v)


@router.get('/health')
async def health():
    return _engine().health()


@router.post('/takes')
async def create_take(request: Request):
    b = await _json(request)
    tid = b.get('take_id')
    if not _safe_id(tid) or tid.startswith(('stock-', 'file-')):
        return _bad('bad_take_id')
    if b.get('sample_rate', 16000) != 16000:
        return _bad('sample_rate_must_be_16000')
    lang = b.get('language')
    t = _engine().create(tid, client_id=str(b.get('client_id') or '')[:64], language=lang if isinstance(lang, str) else None)
    return {'take_id': t.id, 'live': t.live, 'state': t.state}


@router.post('/takes/{take_id}/audio')
async def audio(take_id: str, request: Request, offset: int = 0):
    t = _engine().get(take_id)
    if t is None:
        return _bad('unknown_take', 404)
    if t.state != 'recording':
        return _bad('not_recording', 409, state=t.state, have=t.have())
    data = await _file_bytes(request, MAX_CHUNK)
    if data is None:
        return _bad('bad_audio')
    have = t.have()
    if offset > have:
        return _bad('gap', 409, have=have)
    chunk = data[have - offset:] if offset < have else data
    chunk = chunk[: len(chunk) // 2 * 2]
    if chunk:
        await asyncio.to_thread(t.add_audio, chunk)
    return {'have': t.have(), 'partial': t.partial, 'live': bool(t.live)}


@router.post('/takes/{take_id}/end')
async def end(take_id: str, request: Request):
    t = _engine().get(take_id)
    if t is None:
        return _bad('unknown_take', 404)
    b = await _json(request)
    total = b.get('total_bytes')
    if isinstance(total, int) and t.state == 'recording' and total > t.have():
        return _bad('missing_bytes', 409, have=t.have())
    await asyncio.to_thread(t.end)
    return t.info()


@router.get('/takes/{take_id}')
async def get_take(take_id: str):
    t = _engine().get(take_id)
    if t is None:
        return _bad('unknown_take', 404)
    return t.info()


@router.post('/takes/{take_id}/ack')
async def ack(take_id: str):
    _engine().forget(take_id)
    return {'ok': True}


@router.delete('/takes/{take_id}')
async def cancel(take_id: str):
    t = _engine().get(take_id)
    if t is None:
        return {'ok': True}
    await asyncio.to_thread(t.cancel)
    _engine().forget(take_id)
    return {'ok': True}


@router.post('/recover')
async def recover(request: Request, take_id: str = '', client_id: str = ''):
    """Whole-take recovery (e.g. after a gateway restart): upload the full audio as a WAV, get it queued."""
    import io
    import wave
    if not _safe_id(take_id) or take_id.startswith(('stock-', 'file-')):
        return _bad('bad_take_id')
    data = await _file_bytes(request, MAX_WAV)
    if data is None:
        return _bad('bad_audio')
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
                return _bad('wav_must_be_16k_mono_s16')
            pcm = w.readframes(w.getnframes())
    except Exception:
        return _bad('bad_wav')
    eng = _engine()
    t = eng.get(take_id)
    if t is not None and t.state in ('queued', 'finalizing', 'done'):
        return t.info()
    t = eng.create(take_id, client_id=client_id[:64])
    t.live = False
    t.pcm = bytearray(pcm)
    await asyncio.to_thread(t.end)
    return t.info()


@router.get('/takes')
async def list_takes(client_id: str = '', unacked: int = 1):
    """Orphan-recovery listing: [{take_id, state, text (done takes only), created}], oldest first, no audio.
    With client_id, only that client's takes are ever returned. Acked takes are already forgotten."""
    if client_id and not _safe_id(client_id):
        return _bad('bad_client_id')
    rows = _engine().list(client_id or None)
    if client_id:
        rows = [r for r in rows if r.get('client_id') == client_id]  # belt and braces; client_id stripped below
    return [{'take_id': r['take_id'], 'state': r['state'], 'text': r['text'] if r['state'] == 'done' else '',
             'created': r['created']} for r in rows if _safe_id(r.get('take_id'))]
