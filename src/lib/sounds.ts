/**
 * UI sound effects using the Web Audio API.
 * No external files needed — generates tones programmatically.
 */

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  return audioCtx
}

function playTone(frequency: number, duration: number, type: OscillatorType = 'sine', volume: number = 0.15) {
  try {
    const ctx = getAudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = type
    osc.frequency.setValueAtTime(frequency, ctx.currentTime)
    gain.gain.setValueAtTime(volume, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + duration)
  } catch {
    // Audio not available — fail silently
  }
}

function playChord(notes: Array<{ freq: number; delay?: number }>, duration: number, type: OscillatorType = 'sine') {
  for (const note of notes) {
    setTimeout(() => playTone(note.freq, duration, type), (note.delay ?? 0) * 1000)
  }
}

/** Short ascending chime — for success actions (save, complete) */
export function playSuccess() {
  playChord([
    { freq: 523, delay: 0 },     // C5
    { freq: 659, delay: 0.08 },  // E5
    { freq: 784, delay: 0.16 },  // G5
  ], 0.3, 'sine')
}

/** Single click tone — for general actions (button press, toggle) */
export function playClick() {
  playTone(800, 0.08, 'square', 0.08)
}

/** Timer start — ascending double beep */
export function playTimerStart() {
  playChord([
    { freq: 440, delay: 0 },
    { freq: 660, delay: 0.1 },
  ], 0.15, 'sine')
}

/** Timer pause — descending tone */
export function playTimerPause() {
  playChord([
    { freq: 660, delay: 0 },
    { freq: 440, delay: 0.1 },
  ], 0.15, 'sine')
}

/** Task done — triumphant chord */
export function playTaskDone() {
  playChord([
    { freq: 523, delay: 0 },     // C5
    { freq: 659, delay: 0.1 },   // E5
    { freq: 784, delay: 0.2 },   // G5
    { freq: 1047, delay: 0.3 },  // C6
  ], 0.4, 'sine')
}

/** Error / warning — low buzz */
export function playError() {
  playTone(200, 0.2, 'sawtooth', 0.1)
}

/** Delete / destructive — descending chromatic */
export function playDelete() {
  playChord([
    { freq: 440, delay: 0 },
    { freq: 415, delay: 0.05 },
    { freq: 392, delay: 0.1 },
    { freq: 349, delay: 0.15 },
  ], 0.15, 'triangle')
}

/** Notification reminder ping */
export function playNotification() {
  playChord([
    { freq: 880, delay: 0 },
    { freq: 1100, delay: 0.15 },
  ], 0.2, 'sine')
}
