import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useVinylDsp } from '../hooks/useVinylDsp';
import { usePlayerStore } from '../store/playerStore';
import { Platter } from './Platter';
import { Tonearm } from './Tonearm';
import { Controls } from './Controls';
import { TrackLoader } from './TrackLoader';

function fmt(t: number) {
  if (!isFinite(t) || t < 0) t = 0;
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

/**
 * Turntable scene: viewport-locked console. Deck stage (platter + tonearm
 * + now-playing) on the left, control rack on the right. The page never
 * scrolls — only the queue inside the rack does.
 */
export function Turntable() {
  const { ready, error, addLocalFiles, ctxState } = useVinylDsp();
  const current = usePlayerStore((s) => s.queue[s.currentTrackIndex]);
  const queue = usePlayerStore((s) => s.queue);
  const currentTrackIndex = usePlayerStore((s) => s.currentTrackIndex);
  const state = usePlayerStore((s) => s.state);
  const position = usePlayerStore((s) => s.position);
  const actions = usePlayerStore((s) => s.actions);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  // keep the stylus cue in sync with playback for the ceremony
  useEffect(() => {
    if (state === 'playing') actions.setStylusPosition('lowered');
  }, [state, actions]);

  // drag-and-drop anywhere on the console
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) setDragOver(true);
  };
  const onDragOver = (e: DragEvent) => e.preventDefault();
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (e.dataTransfer?.files?.length) void addLocalFiles(Array.from(e.dataTransfer.files));
  };

  const dur = current?.duration;

  return (
    <div className={`deck-grid ${current ? 'has-record' : 'is-empty'} ${dragOver ? 'is-dragging' : ''}`}
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="deck-header">
        <div className="deck-brand">HALCYON <span>Hi-Fi</span></div>
        <div className="deck-tag">Resonance Console · Model 33⅓</div>
      </header>

      <div className="deck-stage">
        <div className="platter-area">
          <Platter />
          <Tonearm />
        </div>

        <div className="now-playing">
          {current ? (
            <>
              <div className="np-label">Now Playing</div>
              <div className="track-title">{current.title}</div>
              <div className="track-artist">
                {current.artist}{dur ? ` · ${fmt(position)} / ${fmt(dur)}` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="np-label">Quiet Deck</div>
              <div className="track-title">No record loaded</div>
              <div className="track-placeholder">Drop a record on the platter.</div>
            </>
          )}
        </div>
      </div>

      <div className="deck-side">
        <Controls />

        <section className="deck-panel">
          <div className="panel-title">Crate</div>
          <TrackLoader onFiles={addLocalFiles} ready={ready} />
          {queue.length > 0 && (
            <ul className="queue">
              {queue.map((t, i) => (
                <li key={t.id}>
                  <button className={`queue-row ${i === currentTrackIndex ? 'is-current' : ''}`}
                    onClick={() => actions.setCurrent(i)}>
                    <span className="q-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="q-title">
                      <span className="q-name">{t.title}</span>
                      <span className="q-artist">{t.artist}</span>
                    </span>
                    {t.duration ? <span className="q-dur">{fmt(t.duration)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="deck-footer">
        {error && <div className="error">{error}</div>}
        {!ready && !error && <div className="ready-badge">Initializing vinyl…</div>}
        {ready && ctxState !== 'running' && (
          <div className="audio-status" title="AudioContext state / worklet status">
            audio: <b>{ctxState}</b> · dsp: <b>ready</b>
          </div>
        )}
      </footer>
    </div>
  );
}
