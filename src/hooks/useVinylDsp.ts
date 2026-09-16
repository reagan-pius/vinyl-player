/**
 * useVinylDsp.ts — bridge between React/Zustand player state and the
 * VinylProcessor AudioWorklet. The Store is the single source of truth for
 * playback *state*; this hook mirrors that state into the AudioContext graph
 * and reports playback position back to the store.
 *
 * Audio graph:  AudioBufferSource -> AudioWorkletNode(vinyl) -> GainNode -> Destination
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { usePlayerStore, type TrackMeta } from '../store/playerStore';

const WORKLET_URL = '/vinyl-processor.js';

/**
 * 33/45/78 → playback-rate multiplier. 33⅓ is the reference (unity); picking
 * 45 or 78 for a 33-cut record plays it sharp & fast, exactly like a real
 * deck. (33/33.333 = 0.99 would be an audible 18-cent detune, so 33 is pinned
 * to 1.0.)
 */
const speedRate = (ps: number) => (ps === 33 ? 1 : ps / 33.333);

function metaFromName(name: string) {
  const stripped = name.replace(/\.[^.]+$/, '');
  const parts = stripped.split(/[\s_-]+/).join(' ').split(' - ');
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: 'Unknown Artist', title: stripped };
}

export function useVinylDsp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferCache = useRef<Map<string, AudioBuffer>>(new Map());
  // decoded durations (buffer time), mirrored to track metadata when known
  const [durationMap, setDurationMap] = useState<Record<string, number>>({});

  const actions = usePlayerStore((s) => s.actions);
  const state = usePlayerStore((s) => s.state);
  const queue = usePlayerStore((s) => s.queue);
  const currentIdx = usePlayerStore((s) => s.currentTrackIndex);
  const seekRequest = usePlayerStore((s) => s.seekRequest);
  const [ctxState, setCtxState] = useState('init');
  const volume = usePlayerStore((s) => s.volume);
  const sourceStartRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);

  // ---- initialize AudioContext + worklet once ----
  useEffect(() => {
    let mounted = true;
    let ctx: AudioContext | null = null;
    (async () => {
      try {
        const Ac = window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new Ac();
        await ctx.audioWorklet.addModule(WORKLET_URL);
        const node = new AudioWorkletNode(ctx, 'vinyl-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          // Force stereo out. If the output were mono, `out[1]` would be
          // undefined and the DSP would throw every block -> silence.
          outputChannelCount: [2],
        });
        const gain = ctx.createGain();
        node.connect(gain);
        gain.connect(ctx.destination);

        if (!mounted) { void ctx.close(); return; } // StrictMode double-mount: drop the stale context
        ctxRef.current = ctx;
        workletRef.current = node;
        gainRef.current = gain;
        setReady(true);
      } catch (e) {
        if (mounted) setError((e as Error).message || String(e));
      }
    })();
    return () => { mounted = false; };
  }, []);

  // ---- audio-context diagnostics (so "no sound" is visible, not guesswork) ----
  useEffect(() => {
    const id = window.setInterval(() => {
      setCtxState(ctxRef.current ? ctxRef.current.state : 'no-context');
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // ---- output gain sync ----
  useEffect(() => {
    if (gainRef.current && ctxRef.current) {
      gainRef.current.gain.setValueAtTime(volume, ctxRef.current.currentTime);
    }
  }, [volume]);

  // ---- mirror the DSP control knobs onto the worklet's AudioParams ----
  const crackleIntensity = usePlayerStore((s) => s.crackleIntensity);
  const wowFlutterDepth = usePlayerStore((s) => s.wowFlutterDepth);
  const rumbleLevel = usePlayerStore((s) => s.rumbleLevel);
  const surfaceNoise = usePlayerStore((s) => s.surfaceNoise);
  const vinylCondition = usePlayerStore((s) => s.vinylCondition);
  const platterSpeed = usePlayerStore((s) => s.platterSpeed);
  const wetDry = usePlayerStore((s) => s.wetDry);
  const outputGain = usePlayerStore((s) => s.outputGain);

  useEffect(() => {
    const node = workletRef.current;
    const ctx = ctxRef.current;
    if (!node || !ctx) return;
    const t = ctx.currentTime;
    const set = (name: string, v: number) => {
      const p = node.parameters.get(name);
      if (p) p.setValueAtTime(v, t);
    };
    set('crackleIntensity', crackleIntensity);
    set('wowFlutterDepth', wowFlutterDepth);
    set('rumbleLevel', rumbleLevel);
    set('surfaceNoise', surfaceNoise);
    set('wearLevel', vinylCondition);
    set('speed', platterSpeed);
    set('wetDry', wetDry);
    set('outputGain', outputGain);
    // Deck gate: live while playing (or during the stylus-drop cue), silent
    // when paused/stopped — so the surface noise stops with the music.
    set('deckActive', state === 'playing' || state === 'cueing' ? 1 : 0);
  }, [
    ready, crackleIntensity, wowFlutterDepth, rumbleLevel, surfaceNoise,
    vinylCondition, platterSpeed, wetDry, outputGain, state,
  ]);

  // ---- live 33/45/78 changes repitch the already-spinning source ----
  useEffect(() => {
    const src = sourceRef.current;
    const ctx = ctxRef.current;
    if (!src || !ctx) return;
    const currentRate = src.playbackRate.value || 1;
    const currentPos = (ctx.currentTime - sourceStartRef.current) * currentRate + offsetRef.current;
    const clampedPos = Math.min(Math.max(0, currentPos), src.buffer?.duration ?? Number.MAX_SAFE_INTEGER);
    offsetRef.current = clampedPos;
    sourceStartRef.current = ctx.currentTime;
    actions.setPosition(clampedPos);
    src.playbackRate.setTargetAtTime(speedRate(platterSpeed), ctx.currentTime, 0.02);
  }, [platterSpeed, actions]);

  // ---- store state -> audio graph ----
  useEffect(() => {
    const ctx = ctxRef.current;
    const node = workletRef.current;
    if (!ctx || !node) return;
    const track = queue[currentIdx];
    if (!track) return;

    if (state === 'cueing') {
      // Stylus drops: let the surface noise run as a lead-in, then roll tape.
      if (ctx.state === 'suspended') void ctx.resume();
      const id = window.setTimeout(() => actions.play(), 700);
      return () => window.clearTimeout(id);
    }

    if (state === 'playing') {
      (async () => {
        let buf = bufferCache.current.get(track.id);
        if (!buf) {
          try {
            const res = await fetch(track.fileUrl);
            const arr = await res.arrayBuffer();
            buf = await ctx.decodeAudioData(arr);
            bufferCache.current.set(track.id, buf);
            const dur = buf.duration;
            setDurationMap((m) => (m[track.id] === dur ? m : { ...m, [track.id]: dur }));
            actions.setTrackDuration(track.id, dur);
          } catch {
            setError(`Could not decode: ${track.title}`);
            return;
          }
        }
        if (sourceRef.current) {
          sourceRef.current.onended = null;
          try { sourceRef.current.stop(); } catch {}
          sourceRef.current.disconnect();
        }
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(node); src.loop = false;
        // 33/45/78 realism: wrong speed = wrong pitch, like a real deck.
        src.playbackRate.value = speedRate(usePlayerStore.getState().platterSpeed);
        sourceRef.current = src;
        if (ctx.state === 'suspended') await ctx.resume();
        const startPos = usePlayerStore.getState().position;
        offsetRef.current = startPos;
        src.start(0, startPos);
        // sourceStart = wall-clock epoch of THIS run; buffer pos advances at
        // `rate` from `offset`. (The old `now - startPos` epoch double-counted
        // the offset once the rAF reporter added it back.)
        sourceStartRef.current = ctx.currentTime;
        src.onended = () => {
          const gs = usePlayerStore.getState();
          if (gs.state === 'playing') {
            const nxt = gs.currentTrackIndex + 1;
            if (nxt < gs.queue.length) actions.setCurrent(nxt);
            else actions.stop();
          }
        };
      })();
    } else if (state === 'paused') {
      // Pause = freeze at the exact point. The rAF reporter may not have fired
      // this frame, so derive the final position from the audio clock, write it
      // to the store, then stop the source. Resume restarts from `position`.
      // (The worklet's deck gate fades music AND noise to silence; the context
      // stays running — no suspend/resume dance.)
      const src = sourceRef.current;
      if (src) {
        const rate = src.playbackRate.value || 1;
        const pos = (ctx.currentTime - sourceStartRef.current) * rate + offsetRef.current;
        const clampedPos = Math.min(Math.max(0, pos), src.buffer?.duration ?? Number.MAX_SAFE_INTEGER);
        actions.setPosition(clampedPos);
        offsetRef.current = clampedPos;
        src.onended = null;
        try { src.stop(); } catch {}
        src.disconnect();
        sourceRef.current = null;
      }
    } else if (state === 'stopped') {
      if (sourceRef.current) {
        sourceRef.current.onended = null;
        try { sourceRef.current.stop(); } catch {}
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      actions.setPosition(0); offsetRef.current = 0;
    }
  // `position` is deliberately NOT a dependency: the rAF reporter writes it
    // every frame, which would restart the source ~60x/second (no audio).
    // Seeking is handled explicitly by `seek()`.
  }, [state, currentIdx, queue, actions]);

  // ---- user seek requests: scrub the active source, not just the UI ----
  useEffect(() => {
    if (!seekRequest) return;
    const ctx = ctxRef.current;
    const node = workletRef.current;
    const track = queue[currentIdx];
    const buf = track ? bufferCache.current.get(track.id) : null;
    const seconds = Math.min(Math.max(0, seekRequest.seconds), buf?.duration ?? Number.MAX_SAFE_INTEGER);

    offsetRef.current = seconds;
    if (!ctx || !node || !track || !buf || state !== 'playing') return;

    const oldSource = sourceRef.current;
    if (oldSource) {
      oldSource.onended = null;
      try { oldSource.stop(); } catch {}
      oldSource.disconnect();
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(node);
    src.loop = false;
    src.playbackRate.value = speedRate(usePlayerStore.getState().platterSpeed);
    sourceRef.current = src;
    src.start(0, seconds);
    sourceStartRef.current = ctx.currentTime;
    src.onended = () => {
      const gs = usePlayerStore.getState();
      if (gs.state === 'playing') {
        const nextIndex = gs.currentTrackIndex + 1;
        if (nextIndex < gs.queue.length) actions.setCurrent(nextIndex);
        else actions.stop();
      }
    };
  }, [seekRequest, state, queue, currentIdx, actions]);

  // ---- position reporting (rAF) while playing ----
  useEffect(() => {
    const ctx = ctxRef.current;
    if (state !== 'playing' || !ctx) return;
    let raf = 0;
    const tick = () => {
      const s = sourceRef.current;
      if (!s) return;
      const rate = s.playbackRate.value || 1;
      const elapsed = (ctx.currentTime - sourceStartRef.current) * rate + offsetRef.current;
      actions.setPosition(Math.min(Math.max(0, elapsed), s.buffer?.duration ?? Number.MAX_SAFE_INTEGER));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, actions]);

  // ---- public API ----
  const addLocalFiles = useCallback(async (files: File[]) => {
    const ctx = ctxRef.current;
    const newTracks: TrackMeta[] = [];
    for (const f of Array.from(files)) {
      const url = URL.createObjectURL(f);
      const { title, artist } = metaFromName(f.name);
      const id = `${f.name}-${f.lastModified}-${f.size}`;
      bufferCache.current.delete(id);
      const track: TrackMeta = { id, title, artist, fileUrl: url };
      if (ctx) {
        try {
          const buf = await ctx.decodeAudioData(await f.arrayBuffer());
          track.duration = buf.duration;
          bufferCache.current.set(id, buf);
          setDurationMap((m) => (m[id] === buf.duration ? m : { ...m, [id]: buf.duration }));
        } catch {
          setError(`Could not read duration: ${title}`);
        }
      }
      newTracks.push(track);
    }
    actions.setQueue(newTracks);
    actions.setCurrent(0);
  }, [actions]);

  const seek = useCallback((seconds: number) => {
    actions.setPosition(seconds);
    offsetRef.current = seconds;
    const ctx = ctxRef.current;
    const node = workletRef.current;
    const track = queue[currentIdx];
    const buf = track ? bufferCache.current.get(track.id) : null;
    if (!ctx || !node || !track || !buf || state !== 'playing') return;
    if (sourceRef.current) {
      sourceRef.current.onended = null;
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current.disconnect();
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(node);
    src.playbackRate.value = speedRate(platterSpeed);
    sourceRef.current = src;
    src.start(0, seconds);
    sourceStartRef.current = ctx.currentTime;
  }, [actions, state, queue, currentIdx, platterSpeed]);

  return { ready, error, addLocalFiles, seek, ctxState, getDuration: (id: string) => durationMap[id] };
}
