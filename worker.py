"""better-voice worker: Moonshine streaming ASR over stdin/stdout. Run with the worker venv python.

Protocol (stdin, binary frames): 1 byte type + 4 byte big-endian length + payload.
  b'B' begin (empty)       b'A' audio (16 kHz mono s16le)       b'E' end (empty)
stdout (JSON lines): {"t":"ready"} | {"t":"partial","text":...} | {"t":"final","text":...} | {"t":"error","msg":...}
One session at a time. No network, no files written. Exits when stdin closes.
"""
import array
import json
import struct
import sys
import threading

import moonshine_voice as m
from moonshine_voice import transcriber as _tr

ROOT, ARCH = sys.argv[1], sys.argv[2]  # models root, 'small' | 'medium'
ARCHES = {'small': m.ModelArch.SMALL_STREAMING, 'medium': m.ModelArch.MEDIUM_STREAMING}
PATH = f'{ROOT}/download.moonshine.ai/model/{ARCH}-streaming-en/quantized_26_11_02'

out_lock = threading.Lock()


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()


class Listener(_tr.TranscriptEventListener):
    def __init__(self):
        self.lines = {}  # line id -> text, insertion ordered

    def _upd(self, e):
        self.lines[e.line.line_id] = e.line.text
        emit({'t': 'partial', 'text': ' '.join(v for v in self.lines.values() if v).strip()})

    def on_line_started(self, e): self._upd(e)
    def on_line_updated(self, e): self._upd(e)
    def on_line_text_changed(self, e): self._upd(e)
    def on_line_completed(self, e): self._upd(e)
    def on_error(self, e): emit({'t': 'error', 'msg': str(e)})

    def text(self):
        return ' '.join(v for v in self.lines.values() if v).strip()


def read_exact(f, n):
    buf = b''
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def main():
    transcriber = m.Transcriber(PATH, model_arch=ARCHES[ARCH], update_interval=0.2)
    emit({'t': 'ready'})
    stdin = sys.stdin.buffer
    stream = listener = None
    while True:
        head = read_exact(stdin, 5)
        if head is None:
            break
        kind, n = head[:1], struct.unpack('>I', head[1:])[0]
        payload = read_exact(stdin, n) if n else b''
        if payload is None:
            break
        try:
            if kind == b'B':
                if stream:
                    stream.stop()
                    stream.close()
                stream = transcriber.create_stream(update_interval=0.2)
                listener = Listener()
                stream.add_listener(listener)
                stream.start()
            elif kind == b'A' and stream:
                a = array.array('h')
                a.frombytes(payload[: len(payload) // 2 * 2])
                stream.add_audio([s / 32768.0 for s in a], 16000)
            elif kind == b'E' and stream:
                stream.stop()
                emit({'t': 'final', 'text': listener.text()})
                stream.close()
                stream = listener = None
        except Exception as ex:  # keep the worker alive; the provider falls back to the file path
            emit({'t': 'error', 'msg': repr(ex)})


if __name__ == '__main__':
    main()
