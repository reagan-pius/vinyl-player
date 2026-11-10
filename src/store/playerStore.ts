/**
 * playerStore.ts
 *
 * Single source of truth for the vinyl player's state — playback, platter
 * behaviour, and the vinyl-DSP parameter set. Built with Zustand for a tiny
 * bundle and simple, type-safe access.
 *
 * The DSP parameters here are mirrored onto the AudioWorkletNode's
 * AudioParams by `useVinylDsp` whenever they change. User settings (volume,
 * RPM, DSP knobs) are persisted; the queue is not — its file URLs are
 * session-scoped object URLs.
 */
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { appendTracks, clampSeek, compositeWear } from './logic';

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
  /** 0..1 — the single "record age" knob; the params below derive from it. */
  recordAge: number;
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
  muted: boolean;
}

export interface PlayerActions {
  addTracks: (tracks: TrackMeta[]) => void;
  removeTrack: (id: string) => void;
  clearQueue: () => void;
  playIndex: (idx: number) => void;
  setTrackDuration: (id: string, duration: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  cue: () => void;
  /** End-of-track hand-off: keeps the deck running into the next track. */
  advance: () => void;
  next: () => void;
  previous: () => void;
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
  toggleMute: () => void;
}

const initialState: PlayerState = {
  queue: [],
  currentTrackIndex: 0,
  position: 0,
  seekRequest: null,
  state: 'stopped',
  platterSpeed: 33,
  recordAge: 0.35,
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
  muted: false,
};

const spinVelocity = (speed: PlatterSpeed) => (speed / 33.33) * 5.0;
const bumpSeek = (seekRequest: { id: number } | null, seconds: number) => ({
  position: seconds,
  seekRequest: { seconds, id: (seekRequest?.id ?? 0) + 1 },
});

/**
 * Import creates one object URL per file (and one per cover); release them when
 * a record leaves the crate so a long session doesn't pin every file in memory.
 */
function releaseTrack(track: TrackMeta) {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  for (const url of [track.fileUrl, track.coverUrl]) {
    if (url && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch { /* already released */ }
    }
  }
}

export const usePlayerStore = create<PlayerState & { actions: PlayerActions }>()(
  persist(
    devtools(
      (set, get) => ({
        ...initialState,
        actions: {
          addTracks: (tracks) =>
            set((s) => {
              const queue = appendTracks(s.queue, tracks);
              if (queue === s.queue) return {};
              // First record in an empty crate becomes the selected one, but
              // the deck stays stopped until the user drops the needle.
              return s.queue.length
                ? { queue }
                : { queue, currentTrackIndex: 0, position: 0, seekRequest: null };
            }),

          removeTrack: (id) => {
            const removed = get().queue.find((t) => t.id === id);
            if (!removed) return;
            releaseTrack(removed);
            set((s) => {
              const removedAt = s.queue.findIndex((t) => t.id === id);
              if (removedAt < 0) return {};
              const queue = s.queue.filter((t) => t.id !== id);
              if (!queue.length) {
                return {
                  queue,
                  currentTrackIndex: 0,
                  position: 0,
                  seekRequest: null,
                  state: 'stopped',
                  stylusPosition: 'up',
                  platterVelocity: 0,
                };
              }
              if (removedAt === s.currentTrackIndex) {
                return {
                  queue,
                  currentTrackIndex: Math.min(removedAt, queue.length - 1),
                  position: 0,
                  seekRequest: null,
                  state: 'stopped',
                  stylusPosition: 'up',
                  platterVelocity: 0,
                };
              }
              return {
                queue,
                currentTrackIndex:
                  removedAt < s.currentTrackIndex ? s.currentTrackIndex - 1 : s.currentTrackIndex,
              };
            });
          },

          clearQueue: () => {
            for (const track of get().queue) releaseTrack(track);
            set({
              queue: [],
              currentTrackIndex: 0,
              position: 0,
              seekRequest: null,
              state: 'stopped',
              stylusPosition: 'up',
              platterVelocity: 0,
            });
          },

          /** Crate click: select the record, drop the stylus, play. */
          playIndex: (idx) =>
            set((s) => {
              if (!s.queue[idx]) return {};
              return {
                currentTrackIndex: idx,
                position: 0,
                seekRequest: null,
                state: 'cueing',
                stylusPosition: 'lowered',
                platterVelocity: spinVelocity(s.platterSpeed),
              };
            }),

          setTrackDuration: (id, duration) =>
            set((s) => ({
              queue: s.queue.map((track) => (track.id === id ? { ...track, duration } : track)),
            })),

          play: () =>
            set((s) => {
              const track = s.queue[s.currentTrackIndex];
              if (!track) return { state: 'stopped', stylusPosition: 'up', platterVelocity: 0 };
              const atEnd = track.duration != null && s.position >= track.duration - 0.05;
              return {
                state: 'playing',
                stylusPosition: 'lowered',
                platterVelocity: spinVelocity(s.platterSpeed),
                ...(atEnd ? bumpSeek(s.seekRequest, 0) : {}),
              };
            }),

          pause: () => set({ state: 'paused', stylusPosition: 'lowered', platterVelocity: 0 }),

          stop: () =>
            set({
              state: 'stopped',
              position: 0,
              seekRequest: null,
              stylusPosition: 'up',
              platterVelocity: 0,
            }),

          cue: () =>
            set((s) =>
              s.queue[s.currentTrackIndex]
                ? {
                    state: 'cueing',
                    stylusPosition: 'lowered',
                    platterVelocity: spinVelocity(s.platterSpeed),
                  }
                : { state: 'stopped', stylusPosition: 'up', platterVelocity: 0 },
            ),

          /**
           * Called when a track ends. Keeps `state: 'playing'` so the audio
           * graph rolls straight into the next track — setting 'stopped' here
           * (via the old `setCurrent`) is what silenced every queue after one
           * track.
           */
          advance: () =>
            set((s) => {
              const nextIndex = s.currentTrackIndex + 1;
              if (nextIndex < s.queue.length) {
                return {
                  currentTrackIndex: nextIndex,
                  position: 0,
                  seekRequest: null,
                  state: 'playing',
                  stylusPosition: 'lowered',
                  platterVelocity: spinVelocity(s.platterSpeed),
                };
              }
              return {
                state: 'stopped',
                position: 0,
                seekRequest: null,
                stylusPosition: 'up',
                platterVelocity: 0,
              };
            }),

          next: () => {
            const s = get();
            if (!s.queue.length) {
              set({ state: 'stopped', stylusPosition: 'up', platterVelocity: 0 });
              return;
            }
            const nextIndex = s.currentTrackIndex + 1;
            if (nextIndex >= s.queue.length) {
              set({
                state: 'stopped',
                position: 0,
                seekRequest: null,
                stylusPosition: 'up',
                platterVelocity: 0,
              });
              return;
            }
            set({
              currentTrackIndex: nextIndex,
              position: 0,
              seekRequest: null,
              state: 'playing',
              stylusPosition: 'lowered',
              platterVelocity: spinVelocity(s.platterSpeed),
            });
          },

          /** Convention: restart the record if we're more than 3 s in. */
          previous: () => {
            const s = get();
            if (!s.queue.length) {
              set({ state: 'stopped', stylusPosition: 'up', platterVelocity: 0 });
              return;
            }
            if (s.position > 3) {
              set(bumpSeek(s.seekRequest, 0));
              return;
            }
            set({
              currentTrackIndex: Math.max(0, s.currentTrackIndex - 1),
              position: 0,
              seekRequest: null,
              state: 'playing',
              stylusPosition: 'lowered',
              platterVelocity: spinVelocity(s.platterSpeed),
            });
          },

          setPosition: (p) =>
            set((s) => (Math.abs(s.position - p) < 1e-4 ? {} : { position: p })),

          seekTo: (seconds) =>
            set((s) => bumpSeek(s.seekRequest, clampSeek(seconds, s.queue[s.currentTrackIndex]?.duration))),

          seekBy: (delta) =>
            set((s) =>
              bumpSeek(
                s.seekRequest,
                clampSeek(s.position + delta, s.queue[s.currentTrackIndex]?.duration),
              ),
            ),

          setPlatterSpeed: (s) => set({ platterSpeed: s }),

          /** One-knob "record age": bundles every wear/character param coherently. */
          setCompositeWear: (v) => set(compositeWear(v)),

          setVinylCondition: (v) => set({ vinylCondition: v }),
          setCrackleIntensity: (v) => set({ crackleIntensity: v }),
          setWowFlutterDepth: (v) => set({ wowFlutterDepth: v }),
          setRumbleLevel: (v) => set({ rumbleLevel: v }),
          setSurfaceNoise: (v) => set({ surfaceNoise: v }),
          setOutputGain: (v) => set({ outputGain: v }),
          setWetDry: (v) => set({ wetDry: v }),
          setStylusPosition: (p) => set({ stylusPosition: p }),
          setPlatterVelocity: (v) => set({ platterVelocity: v }),

          setVolume: (v) => set({ volume: v, muted: false }),
          toggleMute: () => set((s) => ({ muted: !s.muted })),
        },
      }),
      { name: 'vinyl-player' },
    ),
    {
      name: 'vinyl-player-settings',
      version: 1,
      // Only the knobs survive a reload — queue entries are object URLs that
      // die with the tab.
      partialize: (s) => ({
        volume: s.volume,
        muted: s.muted,
        platterSpeed: s.platterSpeed,
        recordAge: s.recordAge,
        vinylCondition: s.vinylCondition,
        crackleIntensity: s.crackleIntensity,
        wowFlutterDepth: s.wowFlutterDepth,
        rumbleLevel: s.rumbleLevel,
        surfaceNoise: s.surfaceNoise,
        outputGain: s.outputGain,
        wetDry: s.wetDry,
      }),
    },
  ),
);
