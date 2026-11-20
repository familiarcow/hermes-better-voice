"""better-voice: streaming-capable local STT provider. Importing performs no I/O."""


def register(ctx):
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().with_name('provider.py')
    spec = importlib.util.spec_from_file_location('_better_voice_provider', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    provider = mod.LiveWhisperProvider(ctx)
    ctx.register_transcription_provider(provider)
    ctx.on_unload(provider.close)
