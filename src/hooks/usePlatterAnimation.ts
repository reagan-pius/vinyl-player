import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/playerStore';

const RPM_TO_RAD = (rpm: number) => (rpm * 2 * Math.PI) / 60;

/**
 * Drives a turntable platter rotation via requestAnimationFrame.
 *   - 'playing' -> spring toward the RPM-derived target velocity (snappy spin-up)
 *   - 'paused'/'cueing' -> exponential coast-to-stop (realistic decay)
 *   - 'stopped' -> snaps to zero
 *
 * `onAngle` is held in a ref so passing a new inline callback each render
 * does NOT remount the RAF loop.
 */
export function usePlatterAnimation(onAngle: (angle: number) => void) {
  const state = usePlayerStore((s) => s.state);
  const rpm = usePlayerStore((s) => s.platterSpeed);
  const cbRef = useRef(onAngle);
  useEffect(() => { cbRef.current = onAngle; }); // keep latest without rebinding rAF

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let angle = 0;
    let v = 0; // rad/s

    const step = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;

      if (state === 'playing') {
        const target = RPM_TO_RAD(rpm) * 0.5; // visually scaled
        v += (target - v) * 0.18;             // spring to speed
      } else {
        v *= Math.pow(0.993, dt * 60);        // coast decay
      }
      if (state === 'stopped') v = 0;

      angle = (angle + v * dt) % (Math.PI * 2);
      cbRef.current(angle);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state, rpm]); // stable: only rebind on playback-state / RPM change
}
