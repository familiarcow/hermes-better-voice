"""better_voice provider (v0.2): thin wrapper over the shared engine (engine.py).

Live preview comes from Moonshine via the engine; the final text is whisper large-v3-turbo through the
engine's FIFO queue. The Moonshine worker is freed at end-of-audio, so back-to-back takes keep their live
text. Any failure returns an error envelope (or the Moonshine text) so Hermes can fall back. No network.
"""
import importlib.util
import sys
from pathlib import Path

from agent.transcription_provider import TranscriptionProvider, TranscriptionStreamSession

FINALIZE_TIMEOUT_S = 180


def _engine():
    m = sys.modules.get('_better_voice_engine')
    if m is None:
        path = Path(__file__).resolve().with_name('engine.py')
        spec = importlib.util.spec_from_file_location('_better_voice_engine', path)
        m = importlib.util.module_from_spec(spec)
        sys.modules['_better_voice_engine'] = m
        spec.loader.exec_module(m)
    return m.get()


class _Session(TranscriptionStreamSession):
    def __init__(self, provider, take):
        self.p, self.take = provider, take

    def push_audio(self, chunk):
        self.take.add_audio(bytes(chunk))

    def partial_transcript(self):
        return self.take.partial

    def finalize(self):
        eng, t = _engine(), self.take
        try:
            t.end()
            t.done.wait(FINALIZE_TIMEOUT_S)
            if t.state == 'done':
                return {'success': True, 'transcript': t.text, 'provider': self.p.name}
            return {'success': False, 'transcript': '', 'provider': self.p.name, 'error': t.error or 'transcription_failed'}
        except Exception:
            return {'success': False, 'transcript': '', 'provider': self.p.name, 'error': 'transcription_failed'}
        finally:
            eng.forget(t.id)


class LiveWhisperProvider(TranscriptionProvider):
    def __init__(self, ctx):
        self.ctx = ctx
        self.closed = False

    @property
    def name(self):
        return 'better_voice'

    @property
    def display_name(self):
        return 'Better Voice (local streaming preview + turbo)'

    def _runtime(self):
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home()).resolve()
        rt = home / 'better-voice'
        if not rt.exists() and (home / 'live-whisper').exists():
            rt = home / 'live-whisper'  # pre-rename install
        return rt

    def is_available(self):
        """Final (whisper) transcription only needs faster-whisper; the Moonshine live preview is optional."""
        try:
            return not self.closed and importlib.util.find_spec('faster_whisper') is not None
        except Exception:
            return False

    @property
    def streaming_capable(self):
        """Live word-by-word text needs the Moonshine runtime from setup.py."""
        try:
            rt = self._runtime()
            return self.is_available() and (rt / 'venv' / 'bin' / 'python').exists() and (rt / 'worker.py').exists()
        except Exception:
            return False

    def transcribe(self, file_path, *, model=None, language=None, **extra):
        prompt = extra.get('prompt') if isinstance(extra.get('prompt'), str) else None
        try:
            t = _engine().transcribe_file(file_path, language=language, model=model, prompt=prompt)
            if t.state == 'done':
                return {'success': True, 'transcript': t.text, 'provider': self.name}
            return {'success': False, 'transcript': '', 'provider': self.name, 'error': t.error or 'transcription_failed'}
        except Exception:
            return {'success': False, 'transcript': '', 'provider': self.name, 'error': 'transcription_failed'}

    def open_stream_session(self, *, language=None, prompt=None):
        if self.closed:
            raise RuntimeError('closed')
        t = _engine().create(None, client_id='stock', language=language,
                             prompt=prompt if isinstance(prompt, str) else None)
        return _Session(self, t)

    def close(self):
        self.closed = True
        m = sys.modules.get('_better_voice_engine')
        if m is not None and getattr(m, 'ENGINE', None) is not None:
            m.ENGINE.shutdown()
