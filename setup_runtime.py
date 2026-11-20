#!/usr/bin/env python3
"""Better Voice one-time setup. Run it yourself; the plugin never downloads anything on its own.

    python3 setup_runtime.py                 # live preview: Moonshine small + final model: large-v3-turbo
    python3 setup_runtime.py --live medium   # more accurate live text, more CPU
    python3 setup_runtime.py --live none     # no live words, final transcription only (smallest install)
    python3 setup_runtime.py --final small.en  # lighter final model for low-RAM machines
    python3 setup_runtime.py --check         # show what is installed, download nothing

What it does (all under $HERMES_HOME, default ~/.hermes):
  1. Moonshine live preview (skipped with --live none): creates better-voice/venv, installs the pinned
     `moonshine-voice` package from PyPI, downloads the English streaming model (~100-300 MB).
  2. Final model: downloads the faster-whisper model into the Hugging Face cache (large-v3-turbo is ~1.6 GB).
Needs internet for those downloads only. Re-running is safe; finished downloads are reused.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

MOONSHINE_PIN = 'moonshine-voice==0.1.6'
HUB_PIN = 'huggingface_hub>=0.24'
FINAL_MODELS = {
    'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    'small.en': 'Systran/faster-whisper-small.en',
    'base.en': 'Systran/faster-whisper-base.en',
}
HERE = Path(__file__).resolve().parent
HOME = Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes')
RT = HOME / 'better-voice'
if not RT.exists() and (HOME / 'live-whisper').exists():
    RT = HOME / 'live-whisper'  # pre-rename install keeps working


MIN_PY = (3, 10)  # moonshine-voice needs 3.10+


def _py_ok(exe):
    try:
        out = subprocess.run([str(exe), '-c', 'import sys;print(sys.version_info[0], sys.version_info[1])'],
                             capture_output=True, text=True, timeout=20).stdout.split()
        return (int(out[0]), int(out[1])) >= MIN_PY
    except Exception:
        return False


def find_python():
    """A Python >= 3.10 for the Moonshine venv (macOS's built-in python3 is 3.9 and is too old)."""
    cands = [sys.executable] + [shutil.which(f'python3.{m}') for m in range(14, 9, -1)] + [shutil.which('python3')]
    for c in cands:
        if c and _py_ok(c):
            return c
    sys.exit('Setup needs Python 3.10 or newer to install the live-preview model, and none was found.\n'
             'Install one (for example `brew install python@3.12`) and re-run, or use `--live none` to skip live preview.')


def run(*cmd):
    print('  $', ' '.join(str(c) for c in cmd))
    env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV')}  # keep the venv self-contained
    subprocess.run([str(c) for c in cmd], check=True, env=env)


def have_final(repo):
    hub = Path(os.environ.get('HF_HOME') or Path.home() / '.cache' / 'huggingface') / 'hub'
    snaps = hub / ('models--' + repo.replace('/', '--')) / 'snapshots'
    return snaps.is_dir() and any((s / 'model.bin').exists() for s in snaps.iterdir())


def have_live(arch):
    d = RT / 'models' / 'download.moonshine.ai' / 'model' / f'{arch}-streaming-en'
    return d.is_dir() and any(d.rglob('encoder.ort'))


def check():
    py = RT / 'venv' / 'bin' / 'python'
    print(f'runtime dir: {RT}')
    print(f'  moonshine venv:      {"yes" if py.exists() else "no"}')
    print(f'  worker.py:           {"yes" if (RT / "worker.py").exists() else "no"}')
    for a in ('small', 'medium'):
        print(f'  live model {a:<7}:    {"yes" if have_live(a) else "no"}')
    for name, repo in FINAL_MODELS.items():
        print(f'  final model {name:<14}: {"yes" if have_final(repo) else "no"}')


def setup_live(arch):
    RT.mkdir(parents=True, exist_ok=True)
    py = RT / 'venv' / 'bin' / 'python'
    if py.exists() and not _py_ok(py):
        print('The existing Moonshine virtualenv uses a Python that is too old; recreating it...')
        shutil.rmtree(RT / 'venv')
    if not py.exists():
        print('Creating the Moonshine virtualenv...')
        run(find_python(), '-m', 'venv', RT / 'venv')
    print('Installing', MOONSHINE_PIN)
    run(py, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', MOONSHINE_PIN, 'requests', 'tqdm', 'filelock')  # the last three are needed by Moonshine's model downloader
    link = RT / 'worker.py'
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(HERE / 'worker.py')  # follows plugin updates
    print(f'Downloading the Moonshine {arch} streaming model...')
    code = ('import sys,pathlib,moonshine_voice as m;'
            'a={"small":m.ModelArch.SMALL_STREAMING,"medium":m.ModelArch.MEDIUM_STREAMING}[sys.argv[2]];'
            'print(m.get_model_for_language("en",a,cache_root=pathlib.Path(sys.argv[1]))[0])')
    run(py, '-I', '-c', code, RT / 'models', arch)


def setup_final(name):
    repo = FINAL_MODELS[name]
    if have_final(repo):
        print(f'Final model {name} already present.')
        return
    print(f'Downloading final model {name} ({repo})...')
    tmp = HOME / 'better-voice-setup-venv'
    py = tmp / 'bin' / 'python'
    if not py.exists():
        run(find_python(), '-m', 'venv', tmp)
    run(py, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', HUB_PIN)
    run(py, '-I', '-c', 'import sys;from huggingface_hub import snapshot_download as s;s(sys.argv[1])', repo)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--live', choices=['small', 'medium', 'none'], default='small')
    ap.add_argument('--final', choices=list(FINAL_MODELS), default='large-v3-turbo')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    if a.check:
        return check()
    try:
        if a.live != 'none':
            setup_live(a.live)
        setup_final(a.final)
    except subprocess.CalledProcessError as ex:
        sys.exit(f'\nSetup step failed ({ex}). This usually means no internet or a blocked download. Fix that and re-run; finished steps are reused.')
    print('\nDone. Now enable it in Hermes:')
    print('  hermes plugins enable better-voice')
    print('  hermes config set stt.provider better_voice')
    print('  hermes config set stt.streaming', 'false' if a.live == 'none' else 'true')
    if a.live == 'medium':
        print('  hermes config set stt.better_voice.preview_model medium')
    if a.live == 'none':
        print('  hermes config set stt.better_voice.preview_model none')
    if a.final != 'large-v3-turbo':
        print(f'  hermes config set stt.better_voice.final_model {a.final}')
    print('Then install the desktop half (see README) and reload desktop plugins.')


if __name__ == '__main__':
    main()
