/**
 * playerStore.ts
 *
 * Single source of truth for the vinyl player's state — playback, platter
 * behaviour, and the vinyl-DSP parameter set. Built with Zustand for a tiny
 * bundle and simple, type-safe access.
 *
 * The DSP parameters here are mirrored onto the AudioWorkletNode's
 * AudioParams by `useVinylDsp` whenever they change.
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type PlatterSpeed = 33 | 45 | 78;
export type PlaybackState = 'stopped' | 'cueing' | 'playing' | 'paused';
export type StylusPosition = 'up' | 'lowered' | 'inRunIn';

export interface TrackMeta {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
  /** local file URL / Blob URL */
  fileUrl: string;
}

export interface PlayerState {
  /** Ordered track list (metadata only; audio is local-file-backed). */
  queue: TrackMeta[];
  currentTrackIndex: number;
  /** Playback head, in seconds. */
  position: number;
  /** User-requested seek that the audio graph must apply. */
  seekRequest: { seconds: number; id: number } | null;
  state: PlaybackState;
  platterSpeed: PlatterSpeed;
  /** 0..1 — clean to worn */
  vinylCondition: number;
  /** 0..1 — surface-noise / crackle drive */
  crackleIntensity: number;
  /** 0..1 — wow/flutter depth */
  wowFlutterDepth: number;
  /** 0..1 — rumble level */
  rumbleLevel: number;
  /** 0..1 — extra surface hiss */
  surfaceNoise: number;
  outputGain: number;
  /** 0..1 — dry/wet mix of the vinyl DSP */
  wetDry: number;
  stylusPosition: StylusPosition;
  /** rad/s, for animation decay */
  platterVelocity: number;
  /** Master volume. */
  volume: number;
}

export interface PlayerActions {
  setQueue: (q: TrackMeta[]) => void;
  setCurrent: (idx: number) => void;
  setTrackDuration: (id: string, duration: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  cue: () => void;
  setPosition: (s: number) => void;
  seekTo: (s: number) => void;
  seekBy: (s: number) => void;
  setPlatterSpeed: (s: PlatterSpeed) => void;
  setCompositeWear: (v: number) => void;
  setVinylCondition: (v: number) => void;
  setCrackleIntensity: (v: number) => void;
  setWowFlutterDepth: (v: number) => void;
  setRumbleLevel: (v: number) => void;
  setSurfaceNoise: (v: number) => void;
  setOutputGain: (v: number) => void;
  setWetDry: (v: number) => void;
  setStylusPosition: (p: StylusPosition) => void;
  setPlatterVelocity: (v: number) => void;
  setVolume: (v: number) => void;
  next: () => void;
  previous: () => void;
}

const initialState: PlayerState = {
  queue: [],
  currentTrackIndex: 0,
  position: 0,
  seekRequest: null,
  state: 'stopped',
  platterSpeed: 33,
  vinylCondition: 0.25,
  crackleIntensity: 0.12,
  wowFlutterDepth: 0.18,
  rumbleLevel: 0.06,
  surfaceNoise: 0.1,
  outputGain: 1.0,
  wetDry: 0.7,
  stylusPosition: 'up',
  platterVelocity: 0,
  volume: 0.6,
};

export const usePlayerStore = create<PlayerState & { actions: PlayerActions }>()(
  devtools(
    (set) => ({
      ...initialState,
      actions: {
        setQueue: (q) => set({ queue: q, currentTrackIndex: 0, position: 0, seekRequest: null }),
        setCurrent: (idx) =>
          set({ currentTrackIndex: idx, position: 0, state: 'stopped', stylusPosition: 'up' }),
        setTrackDuration: (id, duration) =>
          set((s) => ({
            queue: s.queue.map((track) => (track.id === id ? { ...track, duration } : track)),
          })),
        play: () =>
          set((s) => (s.queue[s.currentTrackIndex] ? {
            state: 'playing',
            stylusPosition: 'lowered',
            platterVelocity: (s.platterSpeed / 33.33) * 5.0,
          } : { state: 'stopped', stylusPosition: 'up', platterVelocity: 0 })),
        pause: () =>
          set({ state: 'paused', stylusPosition: 'lowered', platterVelocity: 0 }),
        stop: () =>
          set({
            state: 'stopped',
            position: 0,
            stylusPosition: 'up',
            platterVelocity: 0,
          }),
        cue: () =>
          set((s) => (s.queue[s.currentTrackIndex]
            ? { state: 'cueing', stylusPosition: 'lowered' }
            : { state: 'stopped', stylusPosition: 'up', platterVelocity: 0 })),
        setPosition: (s) => set({ position: s }),
        seekTo: (s) =>
          set((st) => {
            const duration = st.queue[st.currentTrackIndex]?.duration;
            const seconds = Math.min(Math.max(0, s), duration ?? Number.MAX_SAFE_INTEGER);
            return { position: seconds, seekRequest: { seconds, id: (st.seekRequest?.id ?? 0) + 1 } };
          }),
        seekBy: (s) =>
          set((st) => {
            const duration = st.queue[st.currentTrackIndex]?.duration;
            const seconds = Math.min(Math.max(0, st.position + s), duration ?? Number.MAX_SAFE_INTEGER);
            return { position: seconds, seekRequest: { seconds, id: (st.seekRequest?.id ?? 0) + 1 } };
          }),
        setPlatterSpeed: (s) => set({ platterSpeed: s }),
        /** One-knob "record age": bundles every wear/character param coherently (iZotope-Year model). */
        setCompositeWear: (v) =>
          set({
            vinylCondition: Math.min(1, Math.max(0, v * 0.82)),
            crackleIntensity: Math.min(1, Math.max(0, v * 0.62 - 0.04)),
            wowFlutterDepth: Math.min(1, Math.max(0, v * 0.62)),
            rumbleLevel: Math.min(1, Math.max(0, v * 0.38 - 0.08)),
            surfaceNoise: Math.min(1, Math.max(0, v * 0.55 - 0.06)),
          }),
        setVinylCondition: (v) => set({ vinylCondition: v }),
        setCrackleIntensity: (v) => set({ crackleIntensity: v }),
        setWowFlutterDepth: (v) => set({ wowFlutterDepth: v }),
        setRumbleLevel: (v) => set({ rumbleLevel: v }),
        setSurfaceNoise: (v) => set({ surfaceNoise: v }),
        setOutputGain: (v) => set({ outputGain: v }),
        setWetDry: (v) => set({ wetDry: v }),
        setStylusPosition: (p) => set({ stylusPosition: p }),
        setPlatterVelocity: (v) => set({ platterVelocity: v }),
        setVolume: (v) => set({ volume: v }),
        next: () =>
          set((s) => {
            if (!s.queue.length) return { state: 'stopped', stylusPosition: 'up', platterVelocity: 0 };
            const idx = Math.min(s.currentTrackIndex + 1, s.queue.length - 1);
            return { currentTrackIndex: idx, position: 0, state: 'playing', stylusPosition: 'lowered' };
          }),
        previous: () =>
          set((s) => {
            if (!s.queue.length) return { state: 'stopped', stylusPosition: 'up', platterVelocity: 0 };
            const idx = Math.max(s.currentTrackIndex - 1, 0);
            return { currentTrackIndex: idx, position: 0, state: 'playing', stylusPosition: 'lowered' };
          }),
      },
    }),
  ),
);
