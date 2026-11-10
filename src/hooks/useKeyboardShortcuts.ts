/**
 * useKeyboardShortcuts.ts — desktop player conventions:
 *   Space play/pause · ←/→ seek 5 s · N/P next/previous · M mute
 *
 * Ignored while a form control has focus so sliders keep their native keys.
 */
import { useEffect } from 'react';
import { usePlayerStore } from '../store/playerStore';

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Held keys would toggle mute/playback dozens of times; arrows may repeat.
      if (event.repeat && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          // Let Space activate a focused button natively instead of double-firing.
          target.tagName === 'BUTTON' ||
          target.tagName === 'A' ||
          target.isContentEditable)
      ) {
        return;
      }

      const store = usePlayerStore.getState();
      const actions = store.actions;

      switch (event.key) {
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          if (store.state === 'playing') actions.pause();
          else if (store.state === 'paused') actions.play();
          else actions.cue();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          actions.seekBy(-5);
          break;
        case 'ArrowRight':
          event.preventDefault();
          actions.seekBy(5);
          break;
        case 'n':
        case 'N':
          actions.next();
          break;
        case 'p':
        case 'P':
          actions.previous();
          break;
        case 'm':
        case 'M':
          actions.toggleMute();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
