/**
 * logic.ts — pure queue / DSP helpers.
 *
 * Kept free of React and zustand so `scripts/test-store.mjs` can import this
 * file directly and assert the behaviour the UI depends on.
 */
import type { TrackMeta } from './playerStore';

export interface WearParams {
  /** The knob value itself, stored verbatim so the UI shows what was set. */
  recordAge: number;
  vinylCondition: number;
  crackleIntensity: number;
  wowFlutterDepth: number;
  rumbleLevel: number;
  surfaceNoise: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One-knob "record age" → the individual wear/character params
 * (iZotope-Year model).
 *
 * `recordAge` is returned alongside the derived params on purpose: the knob
 * reads it back directly. Deriving the knob value by averaging the five
 * params made it snap back to ~56% at the top of the range, so the control
 * could never reach 100%.
 */
export function compositeWear(v: number): WearParams {
  const a = clamp01(v);
  return {
    recordAge: a,
    vinylCondition: clamp01(a * 0.82),
    crackleIntensity: clamp01(a * 0.62 - 0.04),
    wowFlutterDepth: clamp01(a * 0.62),
    rumbleLevel: clamp01(a * 0.38 - 0.08),
    surfaceNoise: clamp01(a * 0.55 - 0.06),
  };
}

/**
 * Append incoming tracks to the crate: existing order is preserved and
 * duplicates (same file name + modified time + size) are ignored. Loading a
 * second folder must not wipe the first.
 */
export function appendTracks(existing: TrackMeta[], incoming: TrackMeta[]): TrackMeta[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((t) => t.id));
  const added: TrackMeta[] = [];
  for (const track of incoming) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    added.push(track);
  }
  return added.length ? [...existing, ...added] : existing;
}

/** Clamp a seek target into [0, duration]. */
export function clampSeek(seconds: number, duration?: number): number {
  const max = duration != null && Number.isFinite(duration) ? duration : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(0, seconds), max);
}
