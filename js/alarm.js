let ctx = null;
let timer = null;
let mode = null;
let volume = 1;

/** Scales the chime loudness, 0 (silent) to 1 (full). Takes effect on the next chime. */
export function setAlarmVolume(next) {
  volume = Math.min(1, Math.max(0, next));
}

/** Browsers only allow audio after a user gesture; call this on the first interaction. */
export function unlockAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(freq, start, dur, { type = 'sine', peak = 0.3, endFreq = null } = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq) osc.frequency.linearRampToValueAtTime(endFreq, start + dur);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

export function playChime() {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const peak = Math.max(0.0005, 0.3 * volume);
  tone(880, t0, 0.35, { peak });
  tone(660, t0 + 0.4, 0.45, { peak });
}

function playSiren() {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  tone(600, t0, 1.0, { type: 'sawtooth', peak: 0.15, endFreq: 1200 });
  tone(1200, t0 + 1.0, 1.0, { type: 'sawtooth', peak: 0.15, endFreq: 600 });
}

/** mode: null (silent), 'breach' (repeating chime) or 'sos' (repeating siren). */
export function setAlarmMode(next) {
  if (next === mode) return;
  mode = next;
  clearInterval(timer);
  timer = null;
  if (!next) return;
  const run = next === 'sos' ? playSiren : playChime;
  run();
  timer = setInterval(run, next === 'sos' ? 2000 : 4000);
}
