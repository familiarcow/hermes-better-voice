/**
 * better-voice (desktop half) v1.0.0 — local dictation that never loses speech.
 *
 *  - Settings → Plugins → Better Voice (or ⌘K → "Better Voice: settings"): hold-to-talk trigger, hold delay, beeps,
 *    insert style, live preview, hide the voice-mode button, auto-send after a take lands, include attachments.
 *  - Enter while a take is recording/transcribing queues the send until the last take for that composer lands
 *    (Escape or the toast's Cancel unqueues). Sends go to the take's own chat only: by clicking that composer's own
 *    Send button (text + attachments, the app clears the draft) when it is visible, idle and enabled, else through
 *    host.composer.submit (text only; attachments stay in the composer).
 *  - Hold-to-talk trigger (default SPACE): Space = empty composer 250 ms / with text 350 ms (adjustable); another key
 *    (right ⌥/⌘/⌃, F-keys…) or a mouse button (middle/back/forward) = hold for the hold delay, release to stop. The
 *    trigger only fires in a composer (keys: the focused editor; mouse: over the input box).
 *    Hold the mic button = push-to-talk; tap mic = toggle.
 *  - ONE plugin recorder for every take: you can start a new take while earlier ones are still transcribing.
 *  - Streams 16 kHz audio to the gateway's better-voice backend (/api/plugins/better-voice): live words while you
 *    talk, accurate whisper-turbo text when you stop. Finished takes are inserted into the composer IN ORDER.
 *  - × on a "Transcribing" row cancels it (keeps the live preview text if any); stuck takes auto-cancel.
 *  - Results that finished while the app was closed are offered via ⌘K → "Better Voice: restore recent dictations".
 *  - Only sends a message when you press Enter during a take, or with auto-send on. Replaces hold-to-talk +
 *    voice-hud (remove those; they would conflict).
 *  - If the backend is unreachable, this plugin stops intercepting and the stock mic works as usual.
 * Local only: audio goes to your own gateway, nothing else. Plain ESM, no eval, scoped timers/listeners.
 */
import {
  atom,
  Button,
  host,
  ListRow,
  PALETTE_AREA,
  pluginSettingsHref,
  SegmentedControl,
  SETTINGS_PLUGINS_AREA,
  ToggleRow,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'better-voice'

// First-run value for 'Hide the stock voice-conversation button'. Default off: this plugin never hides stock UI unless the user asks.
const HIDE_VOICE_BUTTON_ON_FIRST_RUN = false

const DEFAULTS = {
  hideVoiceModeButton: false,
  autoSend: false,
  autoSendDelaySec: 3, // 0-10; 0 = immediately
  holdDelayMs: 250, // 150 | 250 | 400; with text in the composer: + 100
  beeps: true,
  beepSound: 'softsub', // see BEEP_SOUNDS; beeps:false = off
  insertStyle: 'inline', // 'inline' | 'block'
  livePreview: true,
  trigger: { kind: 'key', code: 'Space' }, // or { kind: 'mouse', button: MouseEvent.button }
  sendAttachments: true // click the composer's own Send button so attachments go too
}
const HOLD_CHOICES = [150, 250, 400]

// Start/stop sounds, synthesized with Web Audio (no audio files). Each voice: oscillator `type`, pitch f0 -> f1
// (exponential sweep over `sweep` s), peak `vol`, `atk` attack, `dur` total length, `sat` = tanh saturation
// amount (adds harmonics so low 808-style tones are audible on laptop speakers). Start rises/hits, stop is lower.
const BEEP_SOUNDS = {
  softsub: { label: 'Soft sub', start: { type: 'sine', f0: 65.4, f1: 65.4, sweep: 0.01, vol: 0.2, atk: 0.02, dur: 0.24, sat: 1.5, at: 0 }, stop: { type: 'sine', f0: 49, f1: 49, sweep: 0.01, vol: 0.2, atk: 0.02, dur: 0.26, sat: 1.5, at: 0 } },
  marimba: { label: 'Marimba', start: [{ type: 'sine', f0: 523, f1: 523, sweep: 0.01, vol: 0.09, atk: 0.002, dur: 0.16, sat: 0, at: 0 }, { type: 'sine', f0: 659, f1: 659, sweep: 0.01, vol: 0.09, atk: 0.002, dur: 0.2, sat: 0, at: 0.08 }], stop: [{ type: 'sine', f0: 659, f1: 659, sweep: 0.01, vol: 0.09, atk: 0.002, dur: 0.16, sat: 0, at: 0 }, { type: 'sine', f0: 523, f1: 523, sweep: 0.01, vol: 0.09, atk: 0.002, dur: 0.2, sat: 0, at: 0.08 }] },
}
const DELAY_CHOICES = [0, 1, 2, 3, 5, 10]

// ── hold-to-talk trigger: only keys/buttons that never type text ──
const MOD_CODES = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']
const OTHER_CODES = ['Space', 'Insert', 'Pause', 'ScrollLock']
const FKEY_RE = /^F([1-9]|1\d|2[0-4])$/
const validKeyCode = c => typeof c === 'string' && (OTHER_CODES.includes(c) || MOD_CODES.includes(c) || FKEY_RE.test(c))
// 0 = primary (clicks), 2 = secondary (context menu): never triggers
const validButton = b => Number.isInteger(b) && b >= 1 && b <= 15 && b !== 2
const SPACE_TRIGGER = { kind: 'key', code: 'Space' }
const sanitizeTrigger = t => {
  if (t && t.kind === 'mouse' && validButton(Number(t.button))) return { kind: 'mouse', button: Number(t.button) }
  if (t && t.kind === 'key' && validKeyCode(t.code)) return { kind: 'key', code: t.code }
  return { ...SPACE_TRIGGER }
}
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '')
const KEY_NAMES = {
  Space: 'Space',
  ControlLeft: 'Left Control',
  ControlRight: 'Right Control',
  AltLeft: IS_MAC ? 'Left Option' : 'Left Alt',
  AltRight: IS_MAC ? 'Right Option' : 'Right Alt',
  MetaLeft: IS_MAC ? 'Left Command' : 'Left Meta',
  MetaRight: IS_MAC ? 'Right Command' : 'Right Meta',
  ScrollLock: 'Scroll Lock'
}
const BUTTON_NAMES = { 1: 'Middle mouse button', 3: 'Back mouse button', 4: 'Forward mouse button' }
const triggerLabel = t =>
  t.kind === 'mouse' ? BUTTON_NAMES[t.button] || `Mouse button ${t.button}` : KEY_NAMES[t.code] || t.code
const sameTrigger = (a, b) => a.kind === b.kind && a.code === b.code && a.button === b.button
// the event's own modifier flag is set while a modifier trigger is down; any OTHER modifier = a shortcut, not a hold
const otherMods = (e, code) => {
  const own = MOD_CODES.includes(code) ? code.replace(/(Left|Right)$/, '') : ''
  return (
    (e.ctrlKey && own !== 'Control') || (e.altKey && own !== 'Alt') || (e.metaKey && own !== 'Meta') || e.shiftKey
  )
}

const sanitize = raw => {
  const r = raw && typeof raw === 'object' ? raw : {}
  const bool = (k, d) => (typeof r[k] === 'boolean' ? r[k] : d)
  const delay = Number(r.autoSendDelaySec)
  return {
    hideVoiceModeButton: bool('hideVoiceModeButton', DEFAULTS.hideVoiceModeButton),
    autoSend: bool('autoSend', DEFAULTS.autoSend),
    autoSendDelaySec: Number.isFinite(delay) ? Math.max(0, Math.min(10, Math.round(delay))) : DEFAULTS.autoSendDelaySec,
    holdDelayMs: HOLD_CHOICES.includes(Number(r.holdDelayMs)) ? Number(r.holdDelayMs) : DEFAULTS.holdDelayMs,
    beeps: bool('beeps', DEFAULTS.beeps),
    beepSound: Object.prototype.hasOwnProperty.call(BEEP_SOUNDS, r.beepSound) ? r.beepSound : DEFAULTS.beepSound,
    insertStyle: r.insertStyle === 'block' ? 'block' : 'inline',
    livePreview: bool('livePreview', DEFAULTS.livePreview),
    trigger: sanitizeTrigger(r.trigger),
    sendAttachments: bool('sendAttachments', DEFAULTS.sendAttachments)
  }
}
const SEND_RETRY_MS = 10_000
const PENDING = new Set(['recording', 'processing', 'ready', 'inserting'])
const MIN_TAKE_S = 0.35
const WARM_MS = 30_000
const PREROLL_SAMPLES = 8000 // 500 ms @ 16 kHz
const SEND_EVERY_MS = 250
const GIVE_UP_MS = 10 * 60_000
const COMPOSER = '[data-composer-target]' // chat surface (app/chat/index.tsx:759)
// The chat's input form is found through OUR OWN bar: the composer.top slot renders inside the composer's form
// (ComposerPrimitive.Root, app/chat/composer/index.tsx:1345-1527, slot at :1497). No app markup selectors.
const LW_BAR = '[data-lw-bar]'
const composerFormOf = el => {
  const f = el instanceof Element ? el.closest('form') : null
  return f && f.querySelector(LW_BAR) && f.closest(COMPOSER) ? f : null
}
// the stock Send button's aria-label when idle (controls.tsx:105,188 → i18n/en.ts:3365 composer.send). When the
// agent is busy it reads Stop / Queue message / Steer… / Redirect… instead, so those are never clicked.
const SEND_LABELS = new Set(['Send'])
const START_VOICE_LABEL = 'Start voice conversation'
const ABORT_MIN_MS = 90_000 // auto-cancel a take stuck in 'processing' after max(90 s, 3 × audio + 60 s)
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const randomId = () => `desk-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const MIC_RE = /^(voice|stop|transcribing) dictation$/i
const isMic = el => el instanceof HTMLButtonElement && MIC_RE.test((el.getAttribute('aria-label') || '').trim())
const targetOf = el => el?.closest?.(COMPOSER)?.dataset?.composerTarget || 'main'
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// ── shared store (one source of truth for the gestures, the queue, and every composer's bar) ──
const S = { healthy: false, recording: null, takes: [], failed: [], tick: 0 }
const subs = new Set()
const notify = () => {
  S.tick++
  subs.forEach(f => f(S.tick))
}
let seqN = 0
const rootEl = () => document.documentElement

export default {
  id: ID,
  name: 'Better Voice',
  register(ctx) {
    const api = (path, opts) => ctx.rest(path, opts)
    // Everything is 'info': the app auto-dismisses info toasts (~5 s) but keeps warning/error until clicked.
    const toast = (message, _kind, extra) => {
      try {
        host.notify({ kind: 'info', message, durationMs: 8000, ...(extra || {}) })
      } catch {
        /* toast unavailable */
      }
    }
    const root = rootEl()
    let disposed = false

    // persistent client id (survives app restarts) so results that finished while we were gone can be found again
    let CLIENT = ''
    try {
      CLIENT = String(ctx.storage.get('clientId', '') || '')
    } catch {
      CLIENT = ''
    }
    if (!SAFE_ID.test(CLIENT)) {
      CLIENT = randomId()
      try {
        ctx.storage.set('clientId', CLIENT)
      } catch {
        /* storage unavailable: per-launch id, recovery just finds nothing */
      }
    }
    const ownIds = new Set() // take ids created/handled by this session (never offered as "from last session")

    // ── settings (ctx.storage 'settings'; applied live through the prefs atom) ──
    let saved = null
    try {
      saved = ctx.storage.get('settings', null)
    } catch {
      saved = null
    }
    const firstRun = !saved || typeof saved !== 'object'
    const prefs = atom(sanitize(firstRun ? { ...DEFAULTS, hideVoiceModeButton: HIDE_VOICE_BUTTON_ON_FIRST_RUN } : saved))
    if (firstRun) {
      try {
        ctx.storage.set('settings', prefs.get())
      } catch {
        /* storage unavailable: settings last for this launch only */
      }
    }
    const P = () => prefs.get()

    // ── styles ──
    const style = document.createElement('style')
    style.dataset.plugin = ID
    style.textContent = `
      html[data-lw="recording"] button[data-lw-mic]{
        color:#ef4444 !important;
        background-image:radial-gradient(circle at center,rgba(239,68,68,.28) 0,rgba(239,68,68,.28) calc(14% + var(--lw-level,0) * 70%),transparent calc(14% + var(--lw-level,0) * 70% + 1px)) !important;
        overflow:hidden !important;
        box-shadow:none !important;
        transition:background-image 70ms linear;
      }
      .lw-ic{background-image:radial-gradient(circle at center,rgba(239,68,68,.55) 0,rgba(239,68,68,.55) calc(15% + var(--lw-level,0) * 70%),transparent calc(15% + var(--lw-level,0) * 70% + 1px));overflow:hidden}
      @media (prefers-reduced-motion:reduce){
        html[data-lw="recording"] button[data-lw-mic]{transition:none}
      }
      @keyframes lw-dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
      @keyframes lw-spin{to{transform:rotate(360deg)}}
      .lw-dots::after{content:'';animation:lw-dots 1.2s steps(1,end) infinite;display:inline-block;width:1.2em;text-align:left}
      .lw-spin{animation:lw-spin .9s linear infinite}
      html[data-lw-hide-voice] span:has(> button[aria-label="${START_VOICE_LABEL}"]){display:none !important}
      html[data-lw-hide-voice] button[aria-label="${START_VOICE_LABEL}"]{display:none !important}
      .lw-rows{container-type:inline-size}
      .lw-meta{display:flex;align-items:flex-start;gap:.5rem;flex-shrink:0;margin-left:auto}
      @container (max-width:40rem){
        .lw-row{flex-wrap:wrap}
        .lw-txt{order:5;flex:1 1 100%;margin-top:.125rem}
      }
      .lw-tag{border-radius:9999px;padding:0 .4rem;font-size:.625rem;line-height:1rem;font-weight:600;background:color-mix(in srgb,currentColor 14%,transparent)}
    `
    document.head.appendChild(style)
    const applyHideVoice = () => root.toggleAttribute('data-lw-hide-voice', !!P().hideVoiceModeButton)
    applyHideVoice()

    // tag the real mic button(s) so CSS never touches look-alike buttons (e.g. the scroll rail)
    let levelStale = false // set when tagging changed: the meter re-reads its element list on its next frame
    const tagMics = () => {
      for (const b of document.querySelectorAll('button[aria-label]')) {
        const on = isMic(b)
        if (on !== b.hasAttribute('data-lw-mic')) {
          on ? b.setAttribute('data-lw-mic', '') : b.removeAttribute('data-lw-mic')
          levelStale = true
        }
      }
    }
    tagMics()
    ctx.setInterval(tagMics, 400)

    // ── beeps ──
    let beepCtx = null
    const satCurve = amt => {
      const n = 256
      const c = new Float32Array(n)
      for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * (1 + amt)) / Math.tanh(1 + amt)
      return c
    }
    // role: 'start' | 'stop'; force = play even when beeps are off (settings preview)
    const beep = (role, force = false, sound = P().beepSound) => {
      if (!force && !P().beeps) return
      try {
        const spec = (BEEP_SOUNDS[sound] || BEEP_SOUNDS.softsub)[role]
        beepCtx = beepCtx || new AudioContext()
        if (beepCtx.state === 'suspended') beepCtx.resume()
        for (const v of Array.isArray(spec) ? spec : [spec]) {
          const t0 = beepCtx.currentTime + (v.at || 0)
          const o = beepCtx.createOscillator()
          const g = beepCtx.createGain()
          o.type = v.type
          o.frequency.setValueAtTime(v.f0, t0)
          o.frequency.exponentialRampToValueAtTime(Math.max(1, v.f1), t0 + v.sweep)
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.linearRampToValueAtTime(v.vol, t0 + v.atk)
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur)
          let node = o
          if (v.sat) {
            const w = beepCtx.createWaveShaper()
            w.curve = satCurve(v.sat)
            o.connect(w)
            node = w
          }
          node.connect(g).connect(beepCtx.destination)
          o.start(t0)
          o.stop(t0 + v.dur + 0.02)
        }
      } catch {
        /* silent */
      }
    }

    // ── microphone: one stream, warm for WARM_MS after the last take ──
    let mic = null // { stream, ac, an, proc, ring: Int16Array[], ringN }
    let micOpening = null
    let warmTimer = 0
    let raf = 0
    let level = 0

    const closeMic = () => {
      clearTimeout(warmTimer)
      cancelAnimationFrame(raf)
      raf = 0
      const m = mic
      mic = null
      micOpening = null
      if (!m) return
      try {
        m.proc.onaudioprocess = null
        m.proc.disconnect()
        m.stream.getTracks().forEach(t => t.stop())
        m.ac.close().catch(() => {})
      } catch {
        /* already closed */
      }
    }

    const toInt16 = (f32, inRate) => {
      // 16 kHz context normally; linear decimation if the browser ignored the requested rate.
      let src = f32
      if (inRate !== 16000) {
        const ratio = inRate / 16000
        const n = Math.floor(f32.length / ratio)
        src = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const p = i * ratio
          const j = Math.floor(p)
          const frac = p - j
          src[i] = f32[j] * (1 - frac) + (f32[j + 1] ?? f32[j]) * frac
        }
      }
      const out = new Int16Array(src.length)
      for (let i = 0; i < src.length; i++) {
        const v = Math.max(-1, Math.min(1, src[i]))
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
      return out
    }

    const onAudio = e => {
      const m = mic
      if (!m) return
      const pcm = toInt16(e.inputBuffer.getChannelData(0), m.ac.sampleRate)
      // pre-roll ring (last ~500 ms) so a hold threshold never clips the first word
      m.ring.push(pcm)
      m.ringN += pcm.length
      while (m.ringN - m.ring[0].length >= PREROLL_SAMPLES) m.ringN -= m.ring.shift().length
      const t = S.recording
      if (t) append(t, pcm)
    }

    const ensureMic = () => {
      if (mic) {
        clearTimeout(warmTimer)
        return Promise.resolve(mic)
      }
      if (micOpening) return micOpening
      micOpening = (async () => {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone_unavailable')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        })
        let ac
        try {
          ac = new AudioContext({ sampleRate: 16000 })
        } catch {
          ac = new AudioContext()
        }
        if (ac.state === 'suspended') await ac.resume().catch(() => {})
        const src = ac.createMediaStreamSource(stream)
        const an = ac.createAnalyser()
        an.fftSize = 512
        const proc = ac.createScriptProcessor(2048, 1, 1)
        const mute = ac.createGain()
        mute.gain.value = 0
        src.connect(an)
        src.connect(proc)
        proc.connect(mute)
        mute.connect(ac.destination)
        const m = { stream, ac, an, proc, ring: [], ringN: 0 }
        mic = m
        proc.onaudioprocess = onAudio
        stream.getAudioTracks().forEach(t => {
          t.onended = () => {
            if (mic === m) {
              if (S.recording) stopTake('device')
              closeMic()
            }
          }
        })
        return m
      })()
      micOpening.catch(() => {
        micOpening = null
      })
      return micOpening
    }

    const scheduleWarmClose = () => {
      clearTimeout(warmTimer)
      warmTimer = setTimeout(() => {
        if (!S.recording) closeMic()
      }, WARM_MS)
    }

    // The level lives ONLY on the elements that draw it (tagged mic buttons + the bar's .lw-ic icon), never on
    // <html>: an inherited custom property on the root re-styles the whole document every frame.
    const LEVEL_SEL = 'button[data-lw-mic], .lw-ic'
    const METER_MS = 33 // ~30 fps
    let levelEls = []
    let levelAt = 0 // last list refresh
    const refreshLevelEls = () => {
      levelEls = [...document.querySelectorAll(LEVEL_SEL)]
      levelAt = performance.now()
    }
    const clearLevel = () => {
      const all = new Set([...levelEls, ...document.querySelectorAll('[style*="--lw-level"]')])
      for (const el of all) el.style.removeProperty('--lw-level')
      levelEls = []
      level = 0
    }
    root.style.removeProperty('--lw-level') // left on <html> by v0.6.x before a hot reload

    const startMeter = () => {
      const buf = new Float32Array(512)
      let last = 0
      let shown = ''
      refreshLevelEls()
      const tick = now => {
        const m = mic
        if (!m || !S.recording || disposed) {
          raf = 0
          clearLevel()
          return
        }
        raf = requestAnimationFrame(tick)
        if (now - last < METER_MS) return
        last = now
        m.an.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        const target = Math.min(1, Math.pow(rms * 9, 0.7))
        level = target > level ? target : level * 0.85 + target * 0.15
        // new bar rows / re-tagged mics join within 250 ms; fresh elements get the current value at once
        let fresh = false
        if (levelStale || now - levelAt > 250) {
          levelStale = false
          refreshLevelEls()
          fresh = true
        }
        const v = level.toFixed(2)
        if (v === shown && !fresh) return
        shown = v
        for (const el of levelEls) if (el.isConnected) el.style.setProperty('--lw-level', v)
      }
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    }

    // ── takes ──
    const append = (t, pcm) => {
      if (t.n + pcm.length > t.pcm.length) {
        const bigger = new Int16Array(Math.max(t.pcm.length * 2, t.n + pcm.length))
        bigger.set(t.pcm.subarray(0, t.n))
        t.pcm = bigger
      }
      t.pcm.set(pcm, t.n)
      t.n += pcm.length
    }

    const newTake = target => {
      let addr = null
      try {
        addr = host.state.focusedSessionId.get() ?? null
      } catch {
        addr = null
      }
      let stored = null // durable id: a tile's composer target is `tile:<stored id>` (sdk/composer.ts:52)
      try {
        stored = host.state.focusedStoredSessionId.get() ?? null
      } catch {
        stored = null
      }
      const id = `lw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      ownIds.add(id)
      return {
        id,
        seq: ++seqN,
        target,
        addr,
        stored,
        t0: Date.now(),
        pcm: new Int16Array(16000 * 30),
        n: 0,
        sent: 0,
        created: false,
        stopped: false,
        stopAt: 0,
        aborted: false, // set once by abort(); every pump/poll loop exits on it and ignores late results
        state: 'recording', // recording | processing | ready | inserting | inserted | failed | empty
        partial: '',
        text: '',
        tries: 0,
        failSince: 0
      }
    }

    let ticker = 0
    let starting = null // pending start (mic opening)
    let stopWanted = false

    const startTake = async (target, hold) => {
      if (!S.healthy || S.recording || starting) return false
      starting = true
      stopWanted = false
      let m
      try {
        m = await ensureMic()
      } catch {
        starting = null
        toast('Microphone unavailable for dictation', 'warning')
        return false
      }
      starting = null
      if (S.recording) return false
      const t = newTake(target)
      t.hold = hold
      cancelCountdown(sendKey(t.target, t.addr), '') // a new take for this chat restarts auto-send when it lands
      beep('start')
      // pre-roll first, then live audio flows in through onAudio
      for (const c of m.ring) append(t, c)
      S.recording = t
      S.takes.push(t)
      root.dataset.lw = 'recording'
      startMeter()
      clearInterval(ticker)
      ticker = setInterval(notify, 250)
      notify()
      pump(t)
      if (stopWanted) stopTake('release')
      return true
    }

    const stopTake = why => {
      if (starting && !S.recording) {
        stopWanted = true
        return
      }
      const t = S.recording
      if (!t) return
      S.recording = null
      t.stopped = true
      t.stopAt = Date.now()
      clearInterval(ticker)
      delete root.dataset.lw
      cancelAnimationFrame(raf)
      raf = 0
      clearLevel()
      beep('stop')
      scheduleWarmClose()
      if (t.n / 16000 < MIN_TAKE_S) {
        // accidental tap/hold: drop it
        t.state = 'inserted'
        t.outcome = 'dropped'
        api(`/takes/${t.id}`, { method: 'DELETE' }).catch(() => {})
        S.takes = S.takes.filter(x => x !== t)
        settleSends()
      } else {
        t.state = 'processing'
      }
      notify()
    }

    // ── network: audio pump (retry-safe, offset addressed) ──
    const copyBytes = (t, from, to) => {
      const u8 = new Uint8Array(t.pcm.buffer, 0, t.n * 2)
      return u8.slice(from, to).buffer
    }

    // best-effort server-side cancel; also used when an in-flight request lands after an abort
    const dropRemote = t => {
      api(`/takes/${t.id}`, { method: 'DELETE' }).catch(() => {})
    }

    const pump = async t => {
      let backoff = 500
      while (!disposed && !t.aborted && t.state !== 'inserted') {
        try {
          if (!t.created) {
            await api('/takes', { method: 'POST', body: { take_id: t.id, client_id: CLIENT, sample_rate: 16000 } })
            t.created = true
            if (t.aborted) return dropRemote(t) // the create may have landed after abort's DELETE
          }
          const end = t.n * 2
          if (t.sent < end) {
            const bytes = copyBytes(t, t.sent, end)
            const r = await api(`/takes/${t.id}/audio?offset=${t.sent}`, {
              method: 'POST',
              upload: { filename: 'a.pcm', contentType: 'application/octet-stream', bytes }
            })
            if (t.aborted) return dropRemote(t)
            t.sent += bytes.byteLength
            if (r && typeof r.partial === 'string' && r.partial) t.partial = r.partial
            backoff = 500
            t.failSince = 0
            notify()
          }
          if (t.stopped && t.sent >= t.n * 2) {
            if (t.state !== 'processing') return
            await api(`/takes/${t.id}/end`, { method: 'POST', body: { total_bytes: t.n * 2 } })
            if (t.aborted) return dropRemote(t)
            return poll(t)
          }
          if (!t.stopped) await sleep(SEND_EVERY_MS)
        } catch (e) {
          if (t.aborted || disposed) return
          const msg = String(e?.message || e)
          if (/not_recording/.test(msg)) return poll(t)
          if (/unknown_take|404/.test(msg)) {
            t.created = false
            t.sent = 0
          } else if (/gap|409|missing_bytes/.test(msg)) {
            t.sent = 0
          }
          t.failSince = t.failSince || Date.now()
          if (Date.now() - t.failSince > GIVE_UP_MS) return giveUp(t)
          await sleep(backoff)
          backoff = Math.min(8000, backoff * 2)
        }
      }
    }

    const wav = t => {
      const data = new Uint8Array(t.pcm.buffer, 0, t.n * 2)
      const h = new DataView(new ArrayBuffer(44))
      const w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)))
      w(0, 'RIFF')
      h.setUint32(4, 36 + data.length, true)
      w(8, 'WAVEfmt ')
      h.setUint32(16, 16, true)
      h.setUint16(20, 1, true)
      h.setUint16(22, 1, true)
      h.setUint32(24, 16000, true)
      h.setUint32(28, 32000, true)
      h.setUint16(32, 2, true)
      h.setUint16(34, 16, true)
      w(36, 'data')
      h.setUint32(40, data.length, true)
      const out = new Uint8Array(44 + data.length)
      out.set(new Uint8Array(h.buffer), 0)
      out.set(data, 44)
      return out.buffer
    }

    const recover = t =>
      api(`/recover?take_id=${encodeURIComponent(t.id)}&client_id=${encodeURIComponent(CLIENT)}`, {
        method: 'POST',
        upload: { filename: 'take.wav', contentType: 'audio/wav', bytes: wav(t) },
        timeoutMs: 60_000
      })

    const giveUp = t => {
      if (t.aborted || t.state === 'inserted' || disposed) return
      if (t.partial && t.partial.trim()) {
        t.text = t.partial.trim()
        t.state = 'ready'
        toast('Gateway unreachable: inserted the live preview text for one dictation', 'warning')
      } else {
        t.state = 'failed'
        S.failed.push(t)
        toast('A dictation could not be transcribed. Use ⌘K → "Better Voice: retry failed dictations".', 'warning')
      }
      notify()
      drain()
    }

    // Cancel a 'processing' take: user cancel discards it; a timeout keeps the live preview text. Idempotent.
    const UNDO_MS = 8000
    const abort = (t, why) => {
      if (disposed || t.aborted || t.state !== 'processing') return
      t.aborted = true
      if (why === 'user') {
        // soft cancel: hide the row, keep the gateway take alive for UNDO_MS so Undo can restore it
        t.state = 'cancelled'
        t.undoable = true
        t.dropTimer = setTimeout(() => {
          t.undoable = false
          dropRemote(t)
        }, UNDO_MS)
        toast('Dictation discarded', 'info', {
          action: {
            label: 'Undo',
            onClick: () => {
              if (disposed || !t.undoable) return
              t.undoable = false
              clearTimeout(t.dropTimer)
              t.aborted = false
              t.state = 'processing'
              t.stopAt = Date.now()
              if (!S.takes.includes(t)) S.takes.push(t)
              notify()
              if (t.sent < t.n * 2) pump(t)
              else poll(t)
            }
          }
        })
        notify()
        drain()
        return
      }
      const p = (t.partial || '').trim()
      let outcome
      if (p) {
        t.text = p
        t.state = 'ready'
        outcome = 'inserted the live preview text'
      } else {
        t.text = ''
        t.state = 'empty'
        outcome = 'dictation discarded'
      }
      dropRemote(t)
      toast(`Transcription timed out; ${outcome}`)
      notify()
      drain()
    }

    const overdue = t => {
      if (t.state !== 'processing' || !t.stopAt) return false
      const limit = Math.max(ABORT_MIN_MS, (3 * t.n) / 16 + 60_000) // 3 × audio ms + 60 s
      return Date.now() - t.stopAt > limit
    }

    const poll = async t => {
      let fails = 0
      while (!disposed && !t.aborted) {
        await sleep(700)
        if (disposed || t.aborted) return
        if (overdue(t)) return abort(t, 'timeout')
        try {
          const r = await api(`/takes/${t.id}`)
          if (disposed || t.aborted || t.state !== 'processing') return // aborted meanwhile: ignore late results
          fails = 0
          t.failSince = 0
          if (r?.partial) t.partial = r.partial
          if (r?.state === 'done') {
            t.text = String(r.text || '').trim()
            t.state = t.text ? 'ready' : 'empty'
            notify()
            return drain()
          }
          if (r?.state === 'error') {
            t.state = 'failed'
            S.failed.push(t)
            toast(`Transcription failed (${r.error || 'error'}). Use ⌘K → "Better Voice: retry failed dictations".`, 'warning')
            notify()
            return drain()
          }
          notify()
        } catch (e) {
          if (disposed || t.aborted) return
          const msg = String(e?.message || e)
          if (/unknown_take|404/.test(msg)) {
            try {
              await recover(t)
              if (t.aborted) return dropRemote(t) // recovery re-created it after the abort's DELETE
              continue
            } catch {
              /* fall through to backoff */
            }
          }
          t.failSince = t.failSince || Date.now()
          if (Date.now() - t.failSince > GIVE_UP_MS) return giveUp(t)
          await sleep(Math.min(8000, 500 * 2 ** Math.min(fails++, 4)))
        }
      }
    }

    // ── sending: Enter-while-transcribing queue + auto-send. Always addressed to the take's own chat. ──
    const focusedSid = () => {
      try {
        return host.state.focusedSessionId.get() ?? null
      } catch {
        return null
      }
    }
    const sendKey = (target, addr) => `${target}|${addr ?? ''}`
    // a take without a session id came from the fresh-draft composer: address it as 'new' (fail-closed), never 'active'
    const sidOf = addr => addr ?? 'new'
    const pendingFor = (target, addr) =>
      S.takes.filter(t => t.target === target && (t.addr ?? null) === (addr ?? null) && PENDING.has(t.state))
    const queues = new Map() // sendKey -> { key, target, addr, carrier }
    const countdowns = new Map() // sendKey -> { key, target, addr, left, stop }
    const sending = new Set() // sendKeys with a submit in flight
    let justInserted = [] // takes inserted into a composer during the current drain pass

    // ── the composer's own Send button (submits text + attachments and clears the draft through the app's path).
    // Only for the ONE visible surface that owns this take's chat, only when idle, enabled and labelled Send.
    const isShown = el => !el.closest('[data-pane-hidden]') && el.getClientRects().length > 0
    const surfaceShowsChat = (target, addr, stored) => {
      try {
        if (target === 'main') return (host.state.activeSessionId.get() ?? null) === (addr ?? null) // sdk/index.ts:562
        if (typeof target === 'string' && target.startsWith('tile:')) return !!stored && target === `tile:${stored}`
      } catch {
        /* state unavailable */
      }
      return false
    }
    // → HTMLButtonElement | 'wait' (right surface, no usable Send button yet) | 'none' (use submit())
    const findSendButton = (target, addr, stored) => {
      if (!target || !surfaceShowsChat(target, addr, stored)) return 'none'
      try {
        if (addr && host.state.busyBySession.get()?.[addr]) return 'none' // busy: Send would steer/queue (sdk/index.ts:573)
      } catch {
        /* unknown: the label check below still guards */
      }
      const surfaces = [...document.querySelectorAll(COMPOSER)].filter(
        s => s.dataset.composerTarget === target && isShown(s)
      )
      if (surfaces.length !== 1) return 'none' // ambiguous or not on screen: never guess a pane
      const s = surfaces[0]
      const forms = new Set(
        [...s.querySelectorAll(LW_BAR)].map(composerFormOf).filter(f => f && f.closest(COMPOSER) === s)
      )
      if (forms.size !== 1) return 'none'
      const [form] = forms
      // the Send/Stop button is the form's only submit button (controls.tsx:187-193)
      const btns = [...form.querySelectorAll('button[type="submit"]')].filter(isShown)
      if (btns.length !== 1) return 'wait'
      const b = btns[0]
      if (!SEND_LABELS.has((b.getAttribute('aria-label') || '').trim())) return 'wait' // Stop / Queue / Steer …
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'wait'
      return b
    }
    const BUTTON_WAIT_MS = 1500 // the button's enabled gate lags the editor by a render (composer/index.tsx:1374-1393)

    const sendNow = async (target, addr, stored) => {
      const key = sendKey(target, addr)
      if (sending.has(key)) return
      sending.add(key)
      const sid = sidOf(addr)
      const deadline = Date.now() + SEND_RETRY_MS
      const viaButton = P().sendAttachments
      const buttonDeadline = Date.now() + BUTTON_WAIT_MS
      try {
        while (!disposed) {
          if (pendingFor(target, addr).length) return // a new take for this chat started: it decides again when it lands
          let btn = 'none'
          if (viaButton) {
            btn = findSendButton(target, addr, stored)
            if (btn instanceof HTMLButtonElement) {
              // the button exists only with a payload (controls.tsx:97,174: empty + idle shows the voice button),
              // so this also sends "attachments only"; submitDraft reads the live editor DOM (use-composer-submit.ts:482-499)
              btn.click()
              return
            }
          }
          let text = null
          try {
            text = await host.composer.getDraft(sid)
          } catch {
            text = null
          }
          if (disposed) return
          if (typeof text === 'string' && !text.trim()) return // never send an empty draft
          if (btn === 'wait' && Date.now() < buttonDeadline) {
            await sleep(250)
            continue
          }
          if (typeof text === 'string') {
            let ok = false
            try {
              ok = host.composer.submit(sid, text) === true
            } catch {
              ok = false
            }
            if (ok) {
              // submit() sends the text but leaves the draft in place (attachments too): clear the text as Enter would
              try {
                await host.composer.setDraft(sid, '')
              } catch {
                /* draft stays; the message was still sent */
              }
              return
            }
          }
          if (Date.now() > deadline) return toast('Could not send; text left in composer')
          await sleep(500)
        }
      } finally {
        sending.delete(key)
      }
    }

    const queueToastId = key => `lw-q-${key}`
    const unqueue = (key, msg) => {
      if (!queues.delete(key)) return
      if (msg) toast(msg, 'info', { id: queueToastId(key), durationMs: 4000 })
      notify()
    }
    const DEAD = new Set(['cancelled', 'failed', 'empty'])
    const settleSends = () => {
      for (const [key, q] of [...queues]) {
        const c = q.carrier
        if (c.outcome === 'dropped' || DEAD.has(c.state)) {
          unqueue(key, 'Send cancelled')
          continue
        }
        if (pendingFor(q.target, q.addr).length) continue // later takes for this composer still landing
        if (c.outcome !== 'inserted') {
          unqueue(key, 'Send cancelled')
          continue
        }
        queues.delete(key)
        toast('Sending dictated message', 'info', { id: queueToastId(key), durationMs: 2000 })
        notify()
        sendNow(q.target, q.addr, c.stored)
      }
    }

    const cdToastId = key => `lw-send-${key}`
    // msg: replacement toast text; null = let the countdown toast expire on its own (≤ 1.6 s)
    const cancelCountdown = (key, msg) => {
      const cd = countdowns.get(key)
      if (!cd) return false
      countdowns.delete(key)
      cd.stop?.()
      notify()
      if (msg) toast(msg, 'info', { id: cdToastId(key), durationMs: 3000 })
      return true
    }
    const cancelAllCountdowns = msg => {
      for (const key of [...countdowns.keys()]) cancelCountdown(key, msg)
    }
    const startCountdown = (target, addr, stored) => {
      const key = sendKey(target, addr)
      const old = countdowns.get(key)
      if (old) old.stop?.()
      const cd = { key, target, addr, stored, left: P().autoSendDelaySec, stop: null, tick: Date.now() }
      countdowns.set(key, cd)
      const cancelAction = {
        label: 'Cancel',
        onClick: () => cancelCountdown(key, 'Auto-send cancelled; text left in composer')
      }
      notify()
      const step = () => {
        cd.stop = null
        if (disposed || countdowns.get(key) !== cd) return
        if (cd.left <= 0) {
          if (S.recording || starting) {
            // recording in another chat: hold the send until the user stops
            toast('Queued send: sends when you stop recording', 'info', { id: cdToastId(key), durationMs: 1600, action: cancelAction })
            cd.stop = ctx.setTimeout(step, 500)
            return
          }
          countdowns.delete(key)
          notify() // drop the ring row
          if (pendingFor(target, addr).length) return
          sendNow(target, addr, stored)
          return
        }
        cd.left-- // the dictation bar shows the countdown ring; no toast
        cd.tick = Date.now()
        notify()
        cd.stop = ctx.setTimeout(step, 1000)
      }
      step()
    }

    // after each drain pass: fire queued sends whose last take landed, then arm auto-send
    const afterInserts = () => {
      const list = justInserted
      justInserted = []
      settleSends()
      if (!P().autoSend || disposed) return
      const seen = new Set()
      for (const t of list) {
        if (t.restored) continue // restored dictations are never auto-sent
        const key = sendKey(t.target, t.addr)
        if (seen.has(key) || queues.has(key) || sending.has(key)) continue
        seen.add(key)
        if (pendingFor(t.target, t.addr).length) continue // not the last take for this composer
        startCountdown(t.target, t.addr, t.stored)
      }
    }

    // Enter (no modifiers) while a take for this composer is pending → queue the send; Escape unqueues
    const consume = e => {
      e.preventDefault()
      e.stopImmediatePropagation()
      // onKeyDown won't see this key: do its "any other key disarms a not-yet-started key hold" part here
      if (hold && hold.kind === 'key' && !hold.started) {
        clearTimeout(hold.timer)
        hold = null
      }
    }
    const onSendKeys = e => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      if (e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target
      if (!(el instanceof HTMLElement) || !el.isContentEditable || !el.closest(COMPOSER)) return
      const target = targetOf(el)
      const addr = focusedSid()
      const key = sendKey(target, addr)
      if (e.key === 'Escape') {
        if (queues.has(key)) {
          consume(e)
          unqueue(key, 'Queued send cancelled')
        } else if (countdowns.has(key)) {
          consume(e)
          cancelCountdown(key, 'Auto-send cancelled; text left in composer')
        }
        return
      }
      if (queues.has(key)) return consume(e) // already queued: Enter again does nothing extra
      const pend = pendingFor(target, addr)
      if (!pend.length) {
        cancelCountdown(key, null) // the user is sending by hand: the auto-send countdown is moot
        return
      }
      consume(e)
      const carrier = pend.reduce((a, b) => (b.seq > a.seq ? b : a))
      queues.set(key, { key, target, addr, carrier })
      notify()
    }

    // typing during an auto-send countdown restarts it (cheap: one map lookup per input event)
    const onComposerInput = e => {
      if (!countdowns.size) return
      const el = e.target
      if (!(el instanceof HTMLElement) || !el.closest(COMPOSER)) return
      const cd = countdowns.get(sendKey(targetOf(el), focusedSid()))
      if (cd) cd.left = P().autoSendDelaySec
    }

    // ── ordered insertion ──
    let draining = false
    let drainTimer = 0
    const insert = async t => {
      let ok = false
      try {
        ok = await host.composer.insertText(t.addr, t.text, { mode: P().insertStyle })
      } catch {
        ok = false
      }
      if (ok) {
        t.state = 'inserted'
        t.outcome = 'inserted'
        justInserted.push(t)
        api(`/takes/${t.id}/ack`, { method: 'POST' }).catch(() => {})
        return true
      }
      if (++t.tries > 300) {
        try {
          await ctx.os.writeClipboard(t.text)
        } catch {
          /* clipboard unavailable */
        }
        toast('Dictation copied to clipboard (its chat was not open)', 'warning')
        t.state = 'inserted'
        t.outcome = 'dropped' // not in the composer: a queued send must not fire
        api(`/takes/${t.id}/ack`, { method: 'POST' }).catch(() => {}) // delivered: don't offer it again on restore
        return true
      }
      return false
    }

    let drainPending = false
    const drain = async () => {
      if (disposed) return
      if (draining) {
        drainPending = true // a take became ready mid-drain (e.g. abort): run once more when this pass ends
        return
      }
      drainPending = false
      draining = true
      let again = false
      try {
        const groups = new Map()
        for (const t of [...S.takes].sort((a, b) => a.seq - b.seq)) {
          if (t.state === 'inserted') continue
          const k = String(t.addr)
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k).push(t)
        }
        for (const list of groups.values()) {
          for (const t of list) {
            if (t.state === 'ready') {
              if (!(await insert(t))) {
                again = true
                break
              }
            } else if (t.state === 'failed' || t.state === 'empty' || t.state === 'cancelled') {
              if (t.state === 'empty') api(`/takes/${t.id}/ack`, { method: 'POST' }).catch(() => {})
              t.state = 'inserted'
              t.outcome = 'dropped'
            } else break // recording / processing: later takes wait for this one
          }
        }
        S.takes = S.takes.filter(t => t.state !== 'inserted')
      } finally {
        draining = false
        afterInserts()
        notify()
      }
      if (drainPending && !disposed) {
        drainPending = false
        return drain()
      }
      if (again) {
        clearTimeout(drainTimer)
        drainTimer = setTimeout(drain, 2000)
      }
    }

    // ── orphan recovery: results that finished after the app (or this plugin) went away ──
    let orphansChecked = false
    const restoring = new Set() // ids queued for insertion by the restore command (no double restore)
    const fetchOrphans = async () => {
      const list = await api(`/takes?client_id=${encodeURIComponent(CLIENT)}`)
      return (Array.isArray(list) ? list : [])
        .filter(
          x =>
            x &&
            x.state === 'done' &&
            typeof x.take_id === 'string' &&
            SAFE_ID.test(x.take_id) &&
            !ownIds.has(x.take_id) &&
            !restoring.has(x.take_id) &&
            String(x.text || '').trim()
        )
        .sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0))
    }
    const announceOrphans = async () => {
      let list = []
      try {
        list = await fetchOrphans()
      } catch {
        return // older backend / offline: nothing to offer
      }
      if (disposed || !list.length) return
      const n = list.length
      toast(`${n} finished dictation${n === 1 ? '' : 's'} from your last session. ⌘K → "Better Voice: restore recent dictations"`)
    }
    const restoreRecent = async () => {
      let list = []
      try {
        list = await fetchOrphans()
      } catch {
        return toast('Could not reach the dictation backend', 'warning')
      }
      if (disposed) return
      if (!list.length) return toast('No recent dictations to restore')
      let addr = null
      try {
        addr = host.state.focusedSessionId.get() ?? null
      } catch {
        addr = null
      }
      for (const x of list) {
        restoring.add(x.take_id)
        ownIds.add(x.take_id)
        // same ordered-insert path as live takes: queued after anything already pending for this chat
        S.takes.push({
          id: x.take_id,
          seq: ++seqN,
          target: null,
          addr,
          t0: Date.now(),
          n: 0,
          stopped: true,
          stopAt: 0,
          aborted: false,
          restored: true,
          state: 'ready',
          partial: '',
          text: String(x.text).trim(),
          tries: 0,
          failSince: 0
        })
      }
      toast(`Restoring ${list.length} dictation${list.length === 1 ? '' : 's'}`)
      notify()
      drain()
    }
    ctx.register({
      id: 'restore',
      area: PALETTE_AREA,
      data: {
        id: 'better-voice.restore',
        label: 'Better Voice: restore recent dictations',
        keywords: ['dictation', 'voice', 'restore', 'recover', 'whisper'],
        run: restoreRecent
      }
    })

    // ── health / fallback ──
    let healthFails = 0
    const checkHealth = async () => {
      try {
        const r = await api('/health')
        S.healthy = !!r?.ok
        healthFails = S.healthy ? 0 : healthFails + 1
        if (S.healthy && !orphansChecked) {
          orphansChecked = true
          announceOrphans()
        }
      } catch {
        healthFails++
        if (healthFails >= 2) S.healthy = false
      }
      notify()
    }
    checkHealth()
    ctx.setInterval(() => {
      if (document.visibilityState === 'visible') checkHealth()
    }, 60_000)

    // ── gestures ──
    // One hold gesture at a time. It remembers the key/button that armed it, so changing the trigger in settings
    // mid-hold never strands a recording: the original key/button still releases it.
    let hold = null // { kind: 'key', code } | { kind: 'mouse', button } + { target, timer, started }
    let micG = null // { target, at, wasRecording }
    let capturing = false // the settings page is listening for a new trigger: gestures stand down
    let swallow = null // { button, until }: eat the mouseup/auxclick of a captured or released trigger button

    const releaseHold = () => {
      if (!hold) return
      clearTimeout(hold.timer)
      const { started } = hold
      hold = null
      if (started) stopTake('release')
    }
    const disarmHold = () => {
      if (hold && !hold.started) {
        clearTimeout(hold.timer)
        hold = null
      }
    }
    const armHold = (spec, target, delay, onStart) => {
      ensureMic().catch(() => {}) // warm the mic during arming so the first word is not clipped
      hold = { ...spec, target, started: false, timer: 0 }
      const mine = hold
      hold.timer = setTimeout(() => {
        if (hold !== mine || disposed) return
        mine.started = true
        onStart?.()
        startTake(target, true)
      }, delay)
    }
    const eat = e => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }

    const onKeyDown = e => {
      if (!S.healthy || capturing) return
      if (hold && hold.kind === 'key' && !hold.started && e.code !== hold.code) {
        disarmHold() // any other key first = typing / a shortcut, not a hold
        return
      }
      const trig = P().trigger
      const code = hold && hold.kind === 'key' ? hold.code : trig.kind === 'key' ? trig.code : null
      if (!code || e.code !== code || otherMods(e, code) || e.isComposing) return
      if (hold) {
        if (hold.kind === 'key') eat(e) // auto-repeat while held
        return
      }
      let el = e.target
      let redirected = false
      if (!(el instanceof HTMLElement)) return
      if (!(el.isContentEditable && el.closest(COMPOSER))) {
        // Focus is on the chat/page, not a text field: the app would forward the keystroke into the composer as typed
        // text (and auto-repeat floods it with spaces). Take the key ourselves: focus the composer and start the hold.
        // Never steal it from real controls (buttons, links, inputs, other editors).
        if (el.isContentEditable || el.closest('input, textarea, select, button, a[href], [role="button"], [role="textbox"], [contenteditable="true"], dialog, [role="dialog"]')) return
        const box = document.querySelector(`${COMPOSER} [contenteditable="true"]`)
        if (!(box instanceof HTMLElement) || !box.closest(COMPOSER)) return
        if (e.repeat) {
          if (S.recording || hold) eat(e)
          return
        }
        if (S.recording) return
        box.focus()
        el = box
        redirected = true
      }
      if (e.repeat || S.recording) return
      const target = targetOf(el)
      if (code !== 'Space') {
        // a non-typing key: no text conflict, so plain hold-for-delay; its own action is suppressed
        eat(e)
        armHold({ kind: 'key', code }, target, P().holdDelayMs)
        return
      }
      if (redirected) {
        eat(e) // the space never reaches the composer, so there is nothing to undo
        armHold({ kind: 'key', code }, target, P().holdDelayMs)
        return
      }
      const nonEmpty = (el.textContent || '').trim() !== ''
      const sel = window.getSelection()
      if (nonEmpty && !(sel && sel.isCollapsed)) return
      if (!nonEmpty) eat(e)
      const before = el.textContent || ''
      armHold({ kind: 'key', code }, target, P().holdDelayMs + (nonEmpty ? 100 : 0), () => {
        if (nonEmpty) {
          const now = el.textContent || ''
          const typedSpace = now.length === before.length + 1 && /[ \u00a0]$/.test(now)
          if (document.activeElement === el && typedSpace) document.execCommand('delete')
        }
      })
    }

    const onKeyUp = e => {
      if (!hold || hold.kind !== 'key' || e.code !== hold.code) return
      eat(e)
      releaseHold()
    }

    // mouse trigger: press over a composer's input box. mousedown's default is what starts middle-click autoscroll
    // and back/forward history (lib/middle-click.ts:32-41, preview-pane.tsx:1443-1452), so it is cancelled there;
    // mouseup + auxclick are eaten too (Linux middle-paste, link middle-click).
    const onMouseDown = e => {
      if (capturing) return
      if (hold && hold.kind === 'mouse') {
        if (e.button === hold.button) eat(e)
        return
      }
      const trig = P().trigger
      if (trig.kind !== 'mouse' || e.button !== trig.button || !S.healthy) return
      const box = composerFormOf(e.target)
      if (!box) return
      eat(e)
      if (hold || S.recording) return
      armHold({ kind: 'mouse', button: e.button }, targetOf(box), P().holdDelayMs)
    }
    const onMouseUp = e => {
      if (hold && hold.kind === 'mouse' && e.button === hold.button) {
        eat(e)
        swallow = { button: e.button, until: Date.now() + 1000 }
        releaseHold()
        return
      }
      if (swallow && e.button === swallow.button && Date.now() < swallow.until) eat(e)
    }
    const onAuxClick = e => {
      if (swallow && e.button === swallow.button && Date.now() < swallow.until) eat(e)
    }

    const micBtn = e => {
      const b = e.target instanceof Element ? e.target.closest('button') : null
      return b && isMic(b) ? b : null
    }

    const onPointerDown = e => {
      if (!S.healthy || e.button !== 0) return
      const btn = micBtn(e)
      if (!btn) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const target = targetOf(btn)
      micG = { target, at: Date.now(), wasRecording: !!S.recording }
      if (!micG.wasRecording) {
        ensureMic().catch(() => {})
        startTake(target, false)
      }
    }

    const onPointerUp = () => {
      if (!micG) return
      const g = micG
      micG = null
      const held = Date.now() - g.at >= P().holdDelayMs
      if (g.wasRecording || held) stopTake('release')
      // quick tap while idle: stays recording (toggle mode); the next tap stops it
    }

    const onClick = e => {
      if (!S.healthy) return
      const btn = micBtn(e)
      if (!btn) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.detail === 0) {
        // keyboard activation (Enter/Space on the focused button): plain toggle
        if (S.recording) stopTake('release')
        else startTake(targetOf(btn), false)
      }
    }

    const onBlur = () => {
      releaseHold()
      if (micG) onPointerUp()
    }

    const opts = { capture: true }
    ctx.addEventListener(window, 'keydown', onSendKeys, opts) // before onKeyDown; they handle disjoint keys
    ctx.addEventListener(window, 'input', onComposerInput, opts)
    ctx.addEventListener(window, 'keydown', onKeyDown, opts)
    ctx.addEventListener(window, 'keyup', onKeyUp, opts)
    ctx.addEventListener(window, 'pointerdown', onPointerDown, opts)
    ctx.addEventListener(window, 'pointerup', onPointerUp, opts)
    ctx.addEventListener(window, 'pointercancel', onPointerUp, opts)
    ctx.addEventListener(window, 'click', onClick, opts)
    ctx.addEventListener(window, 'mousedown', onMouseDown, opts)
    ctx.addEventListener(window, 'mouseup', onMouseUp, opts)
    ctx.addEventListener(window, 'auxclick', onAuxClick, opts)
    ctx.addEventListener(window, 'blur', onBlur)
    ctx.addEventListener(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') releaseHold()
    })

    // ── ⌘K: retry failed dictations ──
    const retryFailed = async () => {
      const list = S.failed.splice(0)
      if (!list.length) return toast('No failed dictations')
      for (const t of list) {
        t.state = 'processing'
        t.failSince = 0
        t.stopAt = Date.now() // fresh auto-abort window for the retry
        t.aborted = false
        S.takes.push(t)
        try {
          await recover(t)
        } catch {
          /* poll will keep retrying */
        }
        poll(t)
      }
      notify()
    }
    ctx.register({
      id: 'retry',
      area: PALETTE_AREA,
      data: {
        id: 'better-voice.retry',
        label: 'Better Voice: retry failed dictations',
        keywords: ['dictation', 'voice', 'retry', 'whisper'],
        run: retryFailed
      }
    })

    // ── the bar (top of every composer; shows only for its own composer) ──
    function MicIcon() {
      return jsxs('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        children: [
          jsx('rect', { key: 'r', x: 9, y: 2, width: 6, height: 12, rx: 3 }),
          jsx('path', { key: 'p', d: 'M5 11a7 7 0 0 0 14 0M12 18v4' })
        ]
      })
    }
    function SpinIcon() {
      return jsx('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5,
        strokeLinecap: 'round', className: 'lw-spin', 'aria-hidden': 'true',
        children: jsx('path', { d: 'M12 3a9 9 0 1 0 9 9' })
      })
    }
    function XIcon() {
      return jsx('svg', {
        viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5,
        strokeLinecap: 'round', 'aria-hidden': 'true',
        children: jsx('path', { d: 'M6 6l12 12M18 6L6 18' })
      })
    }
    function VoiceBar() {
      const [, set] = useState(0)
      const ref = useRef(null)
      const [target, setTarget] = useState(null)
      useEffect(() => {
        subs.add(set)
        setTarget(ref.current?.closest?.(COMPOSER)?.dataset?.composerTarget ?? null)
        return () => subs.delete(set)
      }, [])
      const rows = target ? S.takes.filter(t => t.target === target && (t.state === 'recording' || t.state === 'processing')).sort((x, y) => x.seq - y.seq) : []
      const hasRec = rows.some(t => t.state === 'recording')
      useEffect(() => {
        if (hasRec) levelStale = true // a .lw-ic icon just mounted: the meter picks it up on its next frame
      }, [hasRec])
      // "Queued send" goes on the latest pending row of each chat with a queued send in this composer
      const willSend = new Set()
      for (const q of queues.values()) {
        if (q.target !== target) continue
        const mine = rows.filter(t => (t.addr ?? null) === (q.addr ?? null))
        if (mine.length) willSend.add(mine[mine.length - 1].id)
      }
      const preview = P().livePreview
      const sendTag = t =>
        willSend.has(t.id) ? jsx('span', { key: 'q', className: 'lw-tag mt-0.5 shrink-0 text-primary', children: 'Queued send' }) : null
      const bar = rows.length
        ? jsx('div', {
            className: 'lw-rows flex flex-col gap-1.5',
            children: rows.map(t => {
              const rec = t.state === 'recording'
              return jsxs('div', {
                key: t.id,
                role: 'status',
                'aria-live': 'polite',
                className: 'lw-row flex items-start gap-2 rounded-xl border border-border/55 bg-muted/55 px-2.5 py-1.5 text-xs text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] backdrop-blur-sm',
                children: [
                  jsx('div', {
                    key: 'i',
                    className: 'flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary' + (rec ? ' lw-ic' : ''),
                    children: rec ? jsx(MicIcon, {}) : jsx(SpinIcon, {})
                  }),
                  rec ? jsx('span', { key: 't', className: 'mt-0.5 shrink-0 font-mono text-[0.6875rem]', children: fmt((Date.now() - t.t0) / 1000) }) : null,
                  jsx('span', {
                    key: 'x',
                    className: (rec ? 'font-medium text-foreground/85' : 'text-foreground/60') + ' lw-txt mt-0.5 min-w-0 flex-1 whitespace-normal break-words',
                    children: (preview && t.partial) || (rec ? 'Dictating' : '')
                  }),
                  jsx('span', {
                    key: 'm',
                    className: 'lw-meta',
                    children: [
                  sendTag(t),
                  rec ? null : jsx('span', { key: 'p', className: 'lw-dots mt-0.5 shrink-0 font-medium', children: 'Transcribing' }),
                  rec
                    ? null
                    : jsx('button', {
                        key: 'c',
                        type: 'button',
                        'aria-label': 'Cancel transcription',
                        title: 'Cancel transcription',
                        className:
                          'pointer-events-auto -mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        style: { pointerEvents: 'auto' },
                        onPointerDown: e => e.stopPropagation(),
                        onMouseDown: e => e.stopPropagation(),
                        onClick: e => {
                          e.preventDefault()
                          e.stopPropagation()
                          abort(t, 'user')
                        },
                        children: jsx(XIcon, {})
                      })
                    ]
                  })
                ]
              })
            })
          })
        : null
      const sendRows = target
        ? [...countdowns.values()].filter(cd => cd.target === target).map(cd => {
            const remain = Math.max(0, Math.min(1, (cd.left + 1 - (Date.now() - cd.tick) / 1000) / Math.max(1, P().autoSendDelaySec)))
            return jsxs('div', {
              key: 'send-' + cd.key,
              role: 'status',
              'aria-live': 'polite',
              className: 'lw-row flex items-center gap-2 rounded-xl border border-border/55 bg-muted/55 px-2.5 py-1.5 text-xs text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] backdrop-blur-sm',
              children: [
                jsxs('svg', {
                  key: 'r',
                  viewBox: '0 0 20 20',
                  className: 'size-5 shrink-0 -rotate-90',
                  'aria-hidden': 'true',
                  children: [
                    jsx('circle', { key: 'b', cx: 10, cy: 10, r: 7.5, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, className: 'text-border' }),
                    jsx('circle', { key: 'f', cx: 10, cy: 10, r: 7.5, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', className: 'text-primary', strokeDasharray: 47.12, strokeDashoffset: 47.12 * (1 - remain) })
                  ]
                }),
                jsx('span', { key: 't', className: 'min-w-0 flex-1 font-medium text-foreground/85', children: 'Auto-sending' }),
                jsx('span', { key: 'h', className: 'shrink-0 text-[0.6875rem] text-muted-foreground/70', children: 'record again to keep going' }),
                jsx('button', {
                  key: 'c',
                  type: 'button',
                  'aria-label': 'Cancel auto-send',
                  title: 'Cancel auto-send',
                  className: 'pointer-events-auto -mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
                  style: { pointerEvents: 'auto' },
                  onPointerDown: e => e.stopPropagation(),
                  onMouseDown: e => e.stopPropagation(),
                  onClick: e => {
                    e.preventDefault()
                    e.stopPropagation()
                    cancelCountdown(cd.key, 'Auto-send cancelled; text left in composer')
                  },
                  children: jsx(XIcon, {})
                })
              ]
            })
          })
        : []
      return jsx('div', { ref, 'data-lw-bar': '', style: { display: 'contents' }, children: [bar, ...sendRows] })
    }
    let sendRaf = 0
    const sendLoop = () => {
      sendRaf = requestAnimationFrame(sendLoop)
      if (countdowns.size) notify()
    }
    sendRaf = requestAnimationFrame(sendLoop)
    ctx.onDispose?.(() => cancelAnimationFrame(sendRaf))
    ctx.register({ id: 'bar', area: 'composer.top', order: 0, render: () => jsx(VoiceBar, {}) })

    // ── settings page: Settings → Plugins → Better Voice ──
    const update = patch => {
      const prev = P()
      const next = sanitize({ ...prev, ...patch })
      prefs.set(next)
      try {
        ctx.storage.set('settings', next)
      } catch {
        /* storage unavailable: applies until restart */
      }
      applyHideVoice()
      // a not-yet-started hold of the old trigger is dropped; a started one still ends on its own key/button
      if (!sameTrigger(prev.trigger, next.trigger)) disarmHold()
      if (prev.autoSend && !next.autoSend) cancelAllCountdowns('Auto-send turned off; text left in composer')
      if (next.autoSendDelaySec < prev.autoSendDelaySec)
        for (const cd of countdowns.values()) cd.left = Math.min(cd.left, next.autoSendDelaySec)
      notify() // re-render rows (live preview)
    }
    const seg = (value, choices, unit, onPick) =>
      jsx(SegmentedControl, {
        value: String(value),
        options: choices.map(n => ({ id: String(n), label: `${n}${unit}` })),
        onChange: v => onPick(Number(v))
      })
    // capture mode: the next non-typing key or non-primary mouse button becomes the trigger; Esc cancels
    const rejectReason = code =>
      /^(Shift|CapsLock)/.test(code)
        ? 'Shift and Caps Lock are used while typing; pick another key.'
        : 'That key types or edits text; pick a modifier (e.g. right ⌥/⌘), an F-key, or a mouse button.'
    function TriggerPicker() {
      const p = useValue(prefs)
      const [listening, setListening] = useState(false)
      const [note, setNote] = useState('')
      useEffect(() => {
        if (!listening) return undefined
        capturing = true
        disarmHold()
        const done = () => setListening(false)
        const take = trig => {
          setNote('')
          update({ trigger: trig })
          done()
        }
        const onKey = e => {
          eat(e)
          if (e.repeat) return
          if (e.code === 'Escape') {
            setNote('')
            return done()
          }
          if (validKeyCode(e.code)) take({ kind: 'key', code: e.code })
          else setNote(rejectReason(e.code))
        }
        const onDown = e => {
          if (e.button === 0) return // primary clicks keep working (Cancel, Reset, leaving the page)
          eat(e)
          if (validButton(e.button)) {
            swallow = { button: e.button, until: Date.now() + 1500 } // no back/forward or paste on release
            take({ kind: 'mouse', button: e.button })
          } else setNote('The right mouse button opens menus; pick another button.')
        }
        const onMenu = e => eat(e)
        const offs = [
          ctx.addEventListener(window, 'keydown', onKey, { capture: true }),
          ctx.addEventListener(window, 'keyup', eat, { capture: true }),
          ctx.addEventListener(window, 'mousedown', onDown, { capture: true }),
          ctx.addEventListener(window, 'contextmenu', onMenu, { capture: true })
        ]
        return () => {
          capturing = false
          offs.forEach(off => {
            try {
              off?.()
            } catch {
              /* already removed */
            }
          })
        }
      }, [listening])
      const isDefault = sameTrigger(p.trigger, SPACE_TRIGGER)
      return jsxs('div', {
        className: 'flex flex-col items-end gap-1',
        children: [
          jsxs('div', {
            key: 'b',
            className: 'flex items-center gap-1.5',
            children: [
              jsx(Button, {
                key: 'pick',
                type: 'button',
                size: 'sm',
                variant: 'outline',
                'aria-live': 'polite',
                onClick: () => {
                  setNote('')
                  setListening(v => !v)
                },
                children: listening ? 'Press a key or mouse button… (Esc cancels)' : triggerLabel(p.trigger)
              }),
              isDefault && !listening
                ? null
                : jsx(Button, {
                    key: 'reset',
                    type: 'button',
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => {
                      setNote('')
                      if (listening) return setListening(false)
                      update({ trigger: { ...SPACE_TRIGGER } })
                    },
                    children: listening ? 'Cancel' : 'Reset to Space'
                  })
            ]
          }),
          note ? jsx('span', { key: 'n', className: 'text-xs text-destructive', children: note }) : null
        ]
      })
    }

    function SettingsPage() {
      const p = useValue(prefs)
      const spaceTrig = sameTrigger(p.trigger, SPACE_TRIGGER)
      return jsxs('div', {
        children: [
          jsx(ListRow, {
            key: 'trigger',
            title: 'Hold-to-talk trigger',
            description:
              'Hold this in a composer to dictate; release to stop. Click, then press a key (right ⌥/⌘/⌃, F-keys) or a ' +
              'mouse button (middle, back, forward). Letters, digits, Enter, Tab, Backspace and Esc are not allowed.',
            action: jsx(TriggerPicker, {})
          }),
          jsx(ListRow, {
            key: 'hold',
            title: 'Hold delay',
            description: spaceTrig
              ? 'How long to hold Space or the mic before recording starts (+100 ms when the composer has text).'
              : `How long to hold ${triggerLabel(p.trigger)} or the mic before recording starts.`,
            action: seg(p.holdDelayMs, HOLD_CHOICES, ' ms', n => update({ holdDelayMs: n }))
          }),
          jsx(ListRow, {
            key: 'beepSound',
            title: 'Start/stop sound',
            description: 'A short tone when a take starts and stops. Clicking an option previews it.',
            action: jsx(SegmentedControl, {
              value: p.beeps ? p.beepSound : 'off',
              options: [
                { id: 'off', label: 'Off' },
                ...Object.keys(BEEP_SOUNDS).map(id => ({ id, label: BEEP_SOUNDS[id].label }))
              ],
              onChange: v => {
                if (v === 'off') return update({ beeps: false })
                update({ beeps: true, beepSound: v })
                beep('start', true, v)
                setTimeout(() => beep('stop', true, v), 600)
              }
            })
          }),
          jsx(ListRow, {
            key: 'style',
            title: 'Insert style',
            description: 'Inline continues the current line; Block puts each take in its own paragraph.',
            action: jsx(SegmentedControl, {
              value: p.insertStyle,
              options: [
                { id: 'inline', label: 'Inline' },
                { id: 'block', label: 'Block' }
              ],
              onChange: v => update({ insertStyle: v })
            })
          }),
          jsx(ToggleRow, {
            key: 'preview',
            label: 'Live preview',
            description: 'Show words in the dictation row while you speak; off shows only the timer and "Transcribing".',
            checked: p.livePreview,
            onChange: on => update({ livePreview: on })
          }),
          jsx(ToggleRow, {
            key: 'hide',
            label: 'Hide voice-conversation button',
            description: 'Hide the composer\'s "Start voice conversation" button so it is not confused with dictation.',
            checked: p.hideVoiceModeButton,
            onChange: on => update({ hideVoiceModeButton: on })
          }),
          jsx(ToggleRow, {
            key: 'auto',
            label: 'Auto-send after transcribing',
            description: 'Once your dictation is transcribed, the message sends by itself after the delay below. A countdown ring shows in the dictation bar; record again or click ✕ to stop it.',
            checked: p.autoSend,
            onChange: on => update({ autoSend: on })
          }),
          jsx(ListRow, {
            key: 'delay',
            title: 'Auto-send delay',
            description: 'Seconds after transcribing finishes before it sends. Typing restarts the countdown, Escape cancels. 0 = send immediately.',
            action: seg(p.autoSendDelaySec, DELAY_CHOICES, ' s', n => update({ autoSendDelaySec: n }))
          }),
          jsx(ToggleRow, {
            key: 'attach',
            label: 'Include attachments when sending',
            description:
              'Auto-send and queued sends press the chat\'s own Send button, so attached files go too. Off (or when ' +
              'that button is not available, e.g. the agent is busy) sends the text only and leaves attachments.',
            checked: p.sendAttachments,
            onChange: on => update({ sendAttachments: on })
          }),
          jsx(ListRow, {
            key: 'enter',
            title: 'Enter while transcribing',
            description: 'Always on: Enter during a take sends once it lands; Escape or the toast\'s Cancel unqueues.'
          })
        ]
      })
    }
    // the settings registry is keyed by the plugin id the host assigned (ctx.source = 'plugin:<id>')
    const PLUGIN_ID = String(ctx.source || '').replace(/^plugin:/, '') || ID
    const settingsPage = { id: 'settings', title: 'Better Voice', icon: 'mic', render: () => jsx(SettingsPage, {}) }
    let hasSettingsPage = false
    try {
      if (typeof ctx.registerSettingsPage === 'function') {
        ctx.registerSettingsPage(settingsPage)
        hasSettingsPage = true
      } else if (SETTINGS_PLUGINS_AREA) {
        // older hosts: the same page spelled out as a contribution
        ctx.register({
          area: SETTINGS_PLUGINS_AREA,
          id: settingsPage.id,
          title: settingsPage.title,
          render: settingsPage.render,
          data: { icon: settingsPage.icon }
        })
        hasSettingsPage = true
      }
    } catch {
      hasSettingsPage = false // settings keep their saved/default values; the page just isn't shown
    }
    ctx.register({
      id: 'open-settings',
      area: PALETTE_AREA,
      data: {
        id: 'better-voice.settings',
        label: 'Better Voice: settings',
        keywords: ['dictation', 'voice', 'settings', 'preferences', 'whisper', 'auto-send'],
        run: () => {
          if (!hasSettingsPage || typeof pluginSettingsHref !== 'function') {
            return toast('Better Voice settings need a newer Hermes (Settings → Plugins)')
          }
          host.navigate(pluginSettingsHref(PLUGIN_ID))
        }
      }
    })

    ctx.onDispose(() => {
      disposed = true
      root.removeAttribute('data-lw-hide-voice')
      try {
        cancelAllCountdowns(null) // ctx timers are cleared by the host too; this just drops our references
      } catch {
        countdowns.clear()
      }
      queues.clear()
      justInserted = []
      clearTimeout(drainTimer)
      clearInterval(ticker)
      if (hold) clearTimeout(hold.timer)
      hold = null
      micG = null
      capturing = false
      swallow = null
      closeMic()
      clearLevel()
      delete root.dataset.lw
      root.style.removeProperty('--lw-level')
      style.remove()
      document.querySelectorAll('[data-lw-mic]').forEach(b => b.removeAttribute('data-lw-mic'))
      subs.clear()
      restoring.clear()
      S.recording = null
      S.takes = []
      S.failed = []
    })
  }
}
