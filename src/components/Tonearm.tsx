import { usePlayerStore } from '../store/playerStore';

/**
 * SVG tonearm on the square 400x400 stage: machined plinth, bearing base
 * with anti-skate scale marks, polished-metal tube with counterweight,
 * headshell + cartridge, and a bright stylus tip. The arm swings about the
 * pivot via `stylusPosition` (up -> lowered -> inRunIn); the motor-hum tremor
 * while playing is a CSS animation, so it costs no React renders.
 */
export function Tonearm() {
  const pos = usePlayerStore((s) => s.stylusPosition);
  const state = usePlayerStore((s) => s.state);

  const drop = pos === 'up' ? -26 : pos === 'lowered' ? 0 : 2;
  const resting = state === 'playing' ? -6 : 0;
  const angle = 16 + drop + resting;

  return (
    <svg className="tonearm" viewBox="0 0 400 400" aria-hidden="true">
      <defs>
        <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d6d2e0" />
          <stop offset="0.5" stopColor="#a9a4ba" />
          <stop offset="1" stopColor="#7d7890" />
        </linearGradient>
      </defs>

      {/* bearing base + plinth */}
      <circle cx="78" cy="88" r="30" fill="#17141f" stroke="#2b2738" strokeWidth="2" />
      <circle cx="78" cy="88" r="14" fill="#211d2c" stroke="#3a3550" strokeWidth="1" />
      {/* anti-skate scale marks */}
      {[...Array(5)].map((_, i) => {
        const a = (0.42 + i * 0.22) * (Math.PI / 180) * 28;
        return <line key={i}
          x1={78 + Math.cos(a) * 21} y1={88 + Math.sin(a) * 21}
          x2={78 + Math.cos(a) * 26} y2={88 + Math.sin(a) * 26}
          stroke="#3f3a54" strokeWidth="1.5" />;
      })}

      <g transform={`rotate(${angle} 78 88)`}>
        <g className={`arm-inner ${state === 'playing' ? 'is-live' : ''}`}>
          {/* counterweight behind the pivot */}
          <circle cx="40" cy="57" r="11" fill="#2e2a3c" stroke="#453f58" strokeWidth="2" />
          {/* polished arm tube */}
          <line x1="78" y1="88" x2="252" y2="227" stroke="url(#metal)" strokeWidth="6.5" strokeLinecap="round" />
          {/* headshell + cartridge */}
          <rect x="240" y="221" width="34" height="14" rx="6" fill="#23202e" stroke="#3d3850" strokeWidth="1.5" />
          <rect x="246" y="224" width="20" height="8" rx="3" fill="#45405a" />
          {/* finger lift */}
          <line x1="268" y1="218" x2="274" y2="210" stroke="#8b86a0" strokeWidth="2" strokeLinecap="round" />
          {/* stylus tip */}
          <circle cx="262" cy="236" r="3" fill="#f5f0e6" opacity="0.95" />
        </g>
        {/* cue lever */}
        <line x1="88" y1="64" x2="99" y2="72" stroke="#8b86a0" strokeWidth="3" strokeLinecap="round"
          opacity={pos === 'up' ? 0.45 : 1} />
      </g>
      {/* pivot cap */}
      <circle cx="78" cy="88" r="4" fill="#c9c4d6" />
    </svg>
  );
}
