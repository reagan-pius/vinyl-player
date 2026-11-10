/**
 * useVinylDsp.ts — bridge between React/Zustand player state and the
 * VinylProcessor AudioWorklet. The Store is the single source of truth for
 * playback *state*; this hook mirrors that state into the AudioContext graph
 * and reports playback position back to the store.
 *
 * Audio graph:  AudioBufferSource -> AudioWorkletNode(vinyl) -> GainNode -> Destination
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { readTags } from '../lib/metadata';
import { usePlayerStore, type TrackMeta } from '../store/playerStore';

const WORKLET_URL = '/vinyl-processor.js';
/** Decoded tracks kept in RAM. One hour of stereo float32 is ~1.4 GB. */
const BUFFER_CACHE_MAX = 3;

/**
 * 33/45/78 → playback-rate multiplier. 33⅓ is the reference (unity); picking
 * 45 or 78 for a 33-cut record plays it sharp & fast, exactly like a real
 * deck. (33/33.333 = 0.99 would be an audible 18-cent detune, so 33 is pinned
 * to 1.0.)
 */
const speedRate = (ps: number) => (ps === 33 ? 1 : ps / 33.333);

function metaFromName(name: string) {
  const stripped = name
    .replace(/\.[^.]+$/, '')
    .replace(/^\s*\d{1,3}[\s._-]+/, '') // leading track number
    .replace(/_+/g, ' ')
    .trim();
  const parts = stripped.split(' - ');
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: 'Unknown Artist', title: stripped || name };
}

function decodeMessage(title: string) {
  return `Couldn’t decode “${title}”. Your browser may not support that codec — try MP3, WAV, M4A or OGG.`;
}

/** Read duration from the container header without decoding the whole file. */
function probeDuration(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    let timer = 0;

    const finish = (value?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      resolve(value);
    };

    timer = window.setTimeout(() => finish(undefined), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () =>
      finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined);
    audio.onerror = () => finish(undefined);
    audio.src = url;
  });
}

export function useVinylDsp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctxState, setCtxState] = useState('init');
  const [importProgress, setImportProgress] = useState({ active: false, done: 0, total: 0 });

  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferCache = useRef<Map<string, AudioBuffer>>(new Map());
  const sourceStartRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);
  /** Generation counter: invalidates in-flight async starts after a state change. */
  const genRef = useRef(0);

  const state = usePlayerStore((s) => s.state);
  const queue = usePlayerStore((s) => s.queue);
  const currentIdx = usePlayerStore((s) => s.currentTrackIndex);
  const seekRequest = usePlayerStore((s) => s.seekRequest);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);

  const crackleIntensity = usePlayerStore((s) => s.crackleIntensity);
  const wowFlutterDepth = usePlayerStore((s) => s.wowFlutterDepth);
  const rumbleLevel = usePlayerStore((s) => s.rumbleLevel);
  const surfaceNoise = usePlayerStore((s) => s.surfaceNoise);
  const vinylCondition = usePlayerStore((s) => s.vinylCondition);
  const platterSpeed = usePlayerStore((s) => s.platterSpeed);
  const wetDry = usePlayerStore((s) => s.wetDry);
  const outputGain = usePlayerStore((s) => s.outputGain);

  const stopSource = useCallback(() => {
    const src = sourceRef.current;
    if (!src) return;
    src.onended = null;
    try { src.stop(); } catch { /* already ended */ }
    src.disconnect();
    sourceRef.current = null;
  }, []);

  /** LRU read: re-inserting keeps the playing track most-recent. */
  const cacheGet = useCallback((id: string) => {
    const map = bufferCache.current;
    const hit = map.get(id);
    if (hit) {
      map.delete(id);
      map.set(id, hit);
    }
    return hit;
  }, []);

  const cacheSet = useCallback((id: string, buffer: AudioBuffer) => {
    const map = bufferCache.current;
    map.delete(id);
    map.set(id, buffer);
    while (map.size > BUFFER_CACHE_MAX) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }, []);

  /** Decode on demand (not on import) so a big crate doesn't eat gigabytes. */
  const loadBuffer = useCallback(
    async (track: TrackMeta) => {
      const cached = cacheGet(track.id);
      if (cached) return cached;
      const ctx = ctxRef.current;
      if (!ctx) throw new Error('AudioContext not ready');
      const res = await fetch(track.fileUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      cacheSet(track.id, buffer);
      usePlayerStore.getState().actions.setTrackDuration(track.id, buffer.duration);
      return buffer;
    },
    [cacheGet, cacheSet],
  );

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
    return () => {
      mounted = false;
      if (ctx && ctxRef.current === ctx) {
        stopSource();
        workletRef.current = null;
        gainRef.current = null;
        ctxRef.current = null;
        void ctx.close();
      }
    };
  }, [stopSource]);

  // ---- audio-context diagnostics (so "no sound" is visible, not guesswork) ----
  useEffect(() => {
    const id = window.setInterval(() => {
      setCtxState(ctxRef.current ? ctxRef.current.state : 'no-context');
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // ---- output gain sync (ramped, so dragging the slider doesn't click) ----
  useEffect(() => {
    const gain = gainRef.current;
    const ctx = ctxRef.current;
    if (!gain || !ctx) return;
    gain.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.015);
  }, [volume, muted, ready]);

  // ---- mirror the DSP control knobs onto the worklet's AudioParams ----
  useEffect(() => {
    const node = workletRef.current;
    const ctx = ctxRef.current;
    if (!node || !ctx) return;
    const t = ctx.currentTime;
    const set = (name: string, value: number, smooth = true) => {
      const param = node.parameters.get(name);
      if (!param) return;
      if (smooth) param.setTargetAtTime(value, t, 0.012);
      else param.setValueAtTime(value, t);
    };
    set('crackleIntensity', crackleIntensity);
    set('wowFlutterDepth', wowFlutterDepth);
    set('rumbleLevel', rumbleLevel);
    set('surfaceNoise', surfaceNoise);
    set('wearLevel', vinylCondition);
    set('speed', platterSpeed, false);
    set('wetDry', wetDry);
    set('outputGain', outputGain);
    // Deck gate: live while playing (or during the stylus-drop cue), silent
    // when paused/stopped — so the surface noise stops with the music. The
    // worklet smooths this itself.
    set('deckActive', state === 'playing' || state === 'cueing' ? 1 : 0, false);
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
    usePlayerStore.getState().actions.setPosition(clampedPos);
    src.playbackRate.setTargetAtTime(speedRate(platterSpeed), ctx.currentTime, 0.02);
  }, [platterSpeed]);

  // ---- drop decoded buffers for tracks that left the crate ----
  useEffect(() => {
    const ids = new Set(queue.map((t) => t.id));
    for (const key of [...bufferCache.current.keys()]) {
      if (!ids.has(key)) bufferCache.current.delete(key);
    }
  }, [queue]);

  // ---- store state -> audio graph ----
  useEffect(() => {
    // Any new run invalidates an async start that is still awaiting a decode.
    const gen = ++genRef.current;
    const ctx = ctxRef.current;
    const node = workletRef.current;
    if (!ctx || !node) return;
    const track = queue[currentIdx];
    const actions = usePlayerStore.getState().actions;

    if (state === 'cueing') {
      // Stylus drops: let the surface noise run as a lead-in, then roll tape.
      if (ctx.state === 'suspended') void ctx.resume();
      stopSource();
      offsetRef.current = 0;
      const id = window.setTimeout(() => usePlayerStore.getState().actions.play(), 700);
      return () => window.clearTimeout(id);
    }

    if (state === 'playing') {
      if (!track) { actions.stop(); return; }
      void (async () => {
        let buffer: AudioBuffer;
        try {
          buffer = await loadBuffer(track);
        } catch {
          if (gen !== genRef.current) return;
          setError(decodeMessage(track.title));
          usePlayerStore.getState().actions.stop();
          return;
        }
        if (gen !== genRef.current) return;

        stopSource();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(node);
        src.loop = false;
        // 33/45/78 realism: wrong speed = wrong pitch, like a real deck.
        src.playbackRate.value = speedRate(usePlayerStore.getState().platterSpeed);
        sourceRef.current = src;
        if (ctx.state === 'suspended') await ctx.resume();
        if (gen !== genRef.current) {
          try { src.stop(); } catch { /* not started */ }
          src.disconnect();
          if (sourceRef.current === src) sourceRef.current = null;
          return;
        }

        const startPos = Math.min(
          usePlayerStore.getState().position,
          Math.max(0, buffer.duration - 0.02),
        );
        offsetRef.current = startPos;
        src.start(0, startPos);
        // sourceStart = wall-clock epoch of THIS run; buffer pos advances at
        // `rate` from `offset`.
        sourceStartRef.current = ctx.currentTime;
        src.onended = () => {
          // Detach BEFORE advancing: the position reporter reads sourceRef, and
          // a tick landing between the hand-off and the next source's start
          // would write this (old) track's duration into `position` — making
          // the next track begin at its own end and stop instantly.
          if (sourceRef.current === src) sourceRef.current = null;
          const gs = usePlayerStore.getState();
          if (gs.state === 'playing') gs.actions.advance();
        };
      })();
      return;
    }

    if (state === 'paused') {
      // Pause = freeze at the exact point. The rAF reporter may not have fired
      // this frame, so derive the final position from the audio clock, write it
      // to the store, then stop the source. Resume restarts from `position`.
      const src = sourceRef.current;
      if (src) {
        const rate = src.playbackRate.value || 1;
        const pos = (ctx.currentTime - sourceStartRef.current) * rate + offsetRef.current;
        const clampedPos = Math.min(Math.max(0, pos), src.buffer?.duration ?? Number.MAX_SAFE_INTEGER);
        actions.setPosition(clampedPos);
        offsetRef.current = clampedPos;
        stopSource();
      }
      return;
    }

    // stopped
    stopSource();
    actions.setPosition(0);
    offsetRef.current = 0;
  // `position` is deliberately NOT a dependency: the reporter writes it, and
  // including it would restart the source ~4x/second (audible stutter).
  // Seeking is handled explicitly by the seekRequest effect below.
  }, [state, currentIdx, queue, loadBuffer, stopSource]);

  // ---- user seek requests: scrub the active source, not just the UI ----
  useEffect(() => {
    if (!seekRequest) return;
    const ctx = ctxRef.current;
    const node = workletRef.current;
    const track = queue[currentIdx];
    const buffer = track ? cacheGet(track.id) : undefined;
    const seconds = Math.min(
      Math.max(0, seekRequest.seconds),
      buffer?.duration ?? Number.MAX_SAFE_INTEGER,
    );

    offsetRef.current = seconds;
    if (!ctx || !node || !track || !buffer || state !== 'playing') return;

    genRef.current++; // a pending decode start must not fight the seek
    stopSource();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(node);
    src.loop = false;
    src.playbackRate.value = speedRate(usePlayerStore.getState().platterSpeed);
    sourceRef.current = src;
    src.start(0, seconds);
    sourceStartRef.current = ctx.currentTime;
    src.onended = () => {
      if (sourceRef.current === src) sourceRef.current = null;
      const gs = usePlayerStore.getState();
      if (gs.state === 'playing') gs.actions.advance();
    };
  }, [seekRequest, state, currentIdx, queue, cacheGet, stopSource]);

  // ---- position reporting (rAF, throttled to ~4 Hz) ----
  useEffect(() => {
    const ctx = ctxRef.current;
    if (state !== 'playing' || !ctx) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const src = sourceRef.current;
      if (src && now - last > 250) {
        last = now;
        const rate = src.playbackRate.value || 1;
        const elapsed = (ctx.currentTime - sourceStartRef.current) * rate + offsetRef.current;
        usePlayerStore.getState().actions.setPosition(
          Math.min(Math.max(0, elapsed), src.buffer?.duration ?? Number.MAX_SAFE_INTEGER),
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  // ---- public API ----
  const addLocalFiles = useCallback(async (files: File[]) => {
    const list = files.filter(
      (f) => f.type.startsWith('audio/') || /\.(mp3|wav|aac|m4a|flac|ogg|oga|opus|aiff?)$/i.test(f.name),
    );
    if (!list.length) {
      setError('Those files aren’t audio — drop MP3, WAV, M4A, FLAC or OGG.');
      return;
    }

    setError(null);
    setImportProgress({ active: true, done: 0, total: list.length });

    const tracks: TrackMeta[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const fileUrl = URL.createObjectURL(file);
        const tags = await readTags(file);
        const fallback = metaFromName(file.name);
        tracks.push({
          id: `${file.name}-${file.lastModified}-${file.size}`,
          title: tags.title || fallback.title,
          artist: tags.artist || fallback.artist,
          album: tags.album,
          coverUrl: tags.coverUrl,
          duration: await probeDuration(fileUrl),
          fileUrl,
        });
        setImportProgress({ active: true, done: i + 1, total: list.length });
      }
      usePlayerStore.getState().actions.addTracks(tracks);
    } finally {
      setImportProgress({ active: false, done: 0, total: 0 });
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { ready, error, clearError, addLocalFiles, ctxState, importProgress };
}
