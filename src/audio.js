// Shared audio helper for the Mayday alarm.
//
// This deliberately uses a plain HTML5 <audio> element rather than
// the Web Audio API (oscillators/AudioContext), which is what earlier
// versions of this used. That distinction turns out to matter a
// great deal on iOS specifically: Safari silently mutes ALL Web Audio
// API output whenever the device's physical ringer/mute switch is set
// to silent — regardless of how carefully an AudioContext was
// unlocked, resumed, or kept warm. A plain <audio> element is
// specifically exempt from that restriction and plays audibly even
// with the switch set to silent. This is a well-documented iOS quirk,
// confirmed independently across multiple sources, and is almost
// certainly the actual reason the alarm wasn't audible even after
// fixing the AudioContext gesture/suspend handling in an earlier
// version of this file.
//
// The siren itself is generated as a short WAV file at runtime (not
// an external asset) and exposed as an object URL for the <audio>
// element's src — a two-tone pattern, looped continuously while the
// alarm is meant to be sounding.
//
// Autoplay restrictions still apply to <audio> elements too, just not
// the ringer-switch one — a browser will still only let audio START
// playing the first time from inside a genuine user gesture. That's
// what unlockAudioContext (called from PinGate on unlock, and on every
// tap thereafter) is for: it "primes" this same element early so it
// can be played later programmatically, including from a remote
// Mayday trigger, without needing another gesture at that moment.
let sharedAudioEl = null;
let sirenObjectUrl = null;

function generateSirenWavUrl() {
  if (sirenObjectUrl) return sirenObjectUrl;
  const sampleRate = 8000;
  const beepPattern = [
    { freq: 880, start: 0.0, dur: 0.18 },
    { freq: 660, start: 0.2, dur: 0.18 },
    { freq: 880, start: 0.4, dur: 0.18 },
    { freq: 660, start: 0.6, dur: 0.18 },
    { freq: 880, start: 0.8, dur: 0.18 },
    { freq: 660, start: 1.0, dur: 0.18 },
    { freq: 880, start: 1.2, dur: 0.18 },
    { freq: 660, start: 1.4, dur: 0.18 },
  ];
  const duration = 1.6;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  const fadeSamples = Math.floor(0.01 * sampleRate);

  beepPattern.forEach(({ freq, start, dur }) => {
    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.floor((start + dur) * sampleRate);
    for (let i = startSample; i < endSample && i < numSamples; i++) {
      const t = (i - startSample) / sampleRate;
      let amp = 0.5;
      if (i - startSample < fadeSamples) amp *= (i - startSample) / fadeSamples;
      if (endSample - i < fadeSamples) amp *= (endSample - i) / fadeSamples;
      samples[i] += Math.sign(Math.sin(2 * Math.PI * freq * t)) * amp;
    }
  });

  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    offset += 2;
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  sirenObjectUrl = URL.createObjectURL(blob);
  return sirenObjectUrl;
}

function getAudioEl() {
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio(generateSirenWavUrl());
    sharedAudioEl.loop = true;
    sharedAudioEl.preload = "auto";
  }
  return sharedAudioEl;
}

// Call from inside a real click/tap handler, as early as possible.
// Plays briefly then immediately pauses and rewinds — the standard
// "unlock" pattern for autoplay policies, priming the element so it
// can be started later programmatically without another gesture.
// Muted to silence during this priming play specifically: this runs
// on every tap anywhere in the app (see setupAudioResumeListeners),
// including totally unrelated ones like checking off a PAR box, and
// without muting it here that produced an audible "chirp" on every
// single tap rather than only during a genuine Mayday.
export function unlockAudioContext() {
  try {
    const el = getAudioEl();
    const originalVolume = el.volume;
    el.volume = 0;
    const restore = () => { el.pause(); el.currentTime = 0; el.volume = originalVolume; };
    const p = el.play();
    if (p && p.then) p.then(restore).catch(restore);
    else restore();
  } catch { /* unsupported — nothing to do */ }
}

export function playMaydayTone() {
  try {
    const el = getAudioEl();
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* still blocked by autoplay policy — nothing more to try at this point */ });
  } catch { /* unsupported or blocked */ }
}

export function stopMaydayTone() {
  try {
    if (sharedAudioEl) { sharedAudioEl.pause(); sharedAudioEl.currentTime = 0; }
  } catch { /* ignore */ }
}

// Call once, on app mount, to wire up opportunistic re-priming
// attempts — iOS can still require re-priming after the tab has been
// backgrounded for a while, so every tap and every return to
// visibility gets used as another chance.
export function setupAudioResumeListeners() {
  const resume = () => unlockAudioContext();
  const onVisible = () => { if (document.visibilityState === "visible") resume(); };
  window.addEventListener("pointerdown", resume);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("pointerdown", resume);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
