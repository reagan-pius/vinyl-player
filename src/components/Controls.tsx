import { usePlayerStore, type PlatterSpeed } from '../store/playerStore';
import { IconPlay, IconPause, IconStop, IconPrev, IconNext } from './icons';

function fmt(t: number) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function Knob({
  label, value, min, max, step, onVal, unit = '', format,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onVal: (v: number) => void; unit?: string; format?: (v: number) => string;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  const show = format ? format(value) : value.toFixed(step === 1 ? 0 : 2) + unit;
  return (
    <div className="knob">
      <div className="knob-top">
        <span className="knob-label">{label}</span>
        <span className="knob-val">{show}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step ?? 0.01}
        value={value} style={{ ['--fill' as string]: `${fill}%` }}
        onChange={(e) => onVal(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Controls() {
  const state = usePlayerStore((s) => s.state);
  const speed = usePlayerStore((s) => s.platterSpeed);
  const cond = usePlayerStore((s) => s.vinylCondition);
  const crackle = usePlayerStore((s) => s.crackleIntensity);
  const wfd = usePlayerStore((s) => s.wowFlutterDepth);
  const rumble = usePlayerStore((s) => s.rumbleLevel);
  const surf = usePlayerStore((s) => s.surfaceNoise);
  const wet = usePlayerStore((s) => s.wetDry);
  const gain = usePlayerStore((s) => s.outputGain);
  const vol = usePlayerStore((s) => s.volume);
  const pos = usePlayerStore((s) => s.position);
  const current = usePlayerStore((s) => s.queue[s.currentTrackIndex]);
  const dur = current?.duration;
  const a = usePlayerStore((s) => s.actions);
  const playing = state === 'playing';
  const hasTrack = Boolean(current);

  const wear = Math.min(1, (cond + crackle + wfd + rumble + surf) / 5);
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;

  return (
    <div className="deck">
      <section className="deck-panel transport-panel">
        <div className="panel-title">Playback</div>
        <div className="transport-row">
          <button className="t-btn" onClick={a.previous} disabled={!hasTrack} aria-label="Previous track"><IconPrev /></button>
          <button className="t-btn" onClick={a.stop} aria-label="Stop"><IconStop /></button>
          <button className="t-btn t-play" onClick={playing ? a.pause : (state === 'stopped' ? a.cue : a.play)}
            disabled={!hasTrack} aria-label={playing ? 'Pause' : hasTrack ? 'Play' : 'Load music before playing'}
            title={hasTrack ? undefined : 'Load music before playing'}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button className="t-btn" onClick={a.next} disabled={!hasTrack} aria-label="Next track"><IconNext /></button>
        </div>
        <input className="seek" type="range" min={0} max={Math.max(dur ?? 0, 0.1)} step={0.1} value={Math.min(pos, dur ?? pos)}
          disabled={!dur} style={{ ['--fill' as string]: `${pct}%` }}
          onChange={(e) => a.seekTo(parseFloat(e.target.value))} aria-label="Seek" />
        <div className="time-row">
          <span>{fmt(pos)}</span>
          <span>{dur ? fmt(dur) : '--:--'}</span>
        </div>
        <div className="speed-row compact">
          {([33, 45, 78] as PlatterSpeed[]).map((s) => (
            <button key={s} className="speed-btn" data-active={speed === s} onClick={() => a.setPlatterSpeed(s)}
              aria-pressed={speed === s}>{s}</button>
          ))}
        </div>
        <Knob label="Volume" value={vol} min={0} max={1} onVal={a.setVolume} />
      </section>

      <section className="deck-panel">
        <div className="panel-title">Record Character</div>
        <Knob label="Record Wear" value={wear} min={0} max={1} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onVal={(v) => a.setCompositeWear(v)} />
        <Knob label="Vinyl Mix" value={wet} min={0} max={1}
          format={(v) => `${Math.round(v * 100)}% vinyl`}
          onVal={a.setWetDry} />
      </section>

      <details className="deck-panel advanced-panel">
        <summary>Surface Details</summary>
        <div className="advanced-grid">
          <Knob label="Crackle" value={crackle} min={0} max={1} onVal={a.setCrackleIntensity} />
          <Knob label="Flutter" value={wfd} min={0} max={1} onVal={a.setWowFlutterDepth} />
          <Knob label="Hiss" value={surf} min={0} max={1} onVal={a.setSurfaceNoise} />
          <Knob label="Rumble" value={rumble} min={0} max={1} onVal={a.setRumbleLevel} />
          <Knob label="Condition" value={cond} min={0} max={1} onVal={a.setVinylCondition} />
          <Knob label="Gain" value={gain} min={0} max={2} step={0.01} onVal={a.setOutputGain} />
        </div>
      </details>
    </div>
  );
}
