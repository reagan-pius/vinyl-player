/**
 * useMediaSession.ts — exposes playback to the OS: hardware media keys,
 * lock-screen / notification controls, and the "now playing" card.
 *
 * Handlers read the store imperatively so they never close over stale state.
 */
import { useEffect } from 'react';
import { usePlayerStore } from '../store/playerStore';

const ACTIONS = [
  'play', 'pause', 'stop', 'nexttrack', 'previoustrack',
  'seekto', 'seekbackward', 'seekforward',
] as const;

export function useMediaSession() {
  const current = usePlayerStore((s) => s.queue[s.currentTrackIndex]);
  const state = usePlayerStore((s) => s.state);
  const position = usePlayerStore((s) => s.position);
  const duration = current?.duration;

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!current) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album ?? '',
      artwork: current.coverUrl ? [{ src: current.coverUrl }] : [],
    });
    // `current` is a stable object per queue entry, so this only re-runs when
    // the record (or its metadata) actually changes.
  }, [current]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { session.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };

    set('play', () => {
      const s = usePlayerStore.getState();
      if (s.state === 'playing') return;
      if (s.state === 'paused') s.actions.play();
      else s.actions.cue();
    });
    set('pause', () => usePlayerStore.getState().actions.pause());
    set('stop', () => usePlayerStore.getState().actions.stop());
    set('nexttrack', () => usePlayerStore.getState().actions.next());
    set('previoustrack', () => usePlayerStore.getState().actions.previous());
    set('seekto', (details) => {
      if (details.seekTime != null) usePlayerStore.getState().actions.seekTo(details.seekTime);
    });
    set('seekbackward', (details) =>
      usePlayerStore.getState().actions.seekBy(-(details.seekOffset ?? 10)));
    set('seekforward', (details) =>
      usePlayerStore.getState().actions.seekBy(details.seekOffset ?? 10));

    return () => {
      for (const action of ACTIONS) set(action, null);
    };
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState =
      state === 'playing' ? 'playing' : state === 'cueing' || state === 'paused' ? 'paused' : 'none';
  }, [state]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!duration || !Number.isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(position, 0), duration),
        playbackRate: 1,
      });
    } catch { /* position must be <= duration; ignore odd values */ }
  }, [position, duration]);
}
