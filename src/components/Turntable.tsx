import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useVinylDsp } from '../hooks/useVinylDsp';
import { useMediaSession } from '../hooks/useMediaSession';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
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
  const { ready, error, clearError, addLocalFiles, ctxState, importProgress } = useVinylDsp();
  useMediaSession();
  useKeyboardShortcuts();

  const current = usePlayerStore((s) => s.queue[s.currentTrackIndex]);
  const queue = usePlayerStore((s) => s.queue);
  const currentTrackIndex = usePlayerStore((s) => s.currentTrackIndex);
  const state = usePlayerStore((s) => s.state);
  const position = usePlayerStore((s) => s.position);
  const actions = usePlayerStore((s) => s.actions);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const currentRowRef = useRef<HTMLButtonElement>(null);

  // keep the stylus cue in sync with playback for the ceremony
  useEffect(() => {
    if (state === 'playing') actions.setStylusPosition('lowered');
  }, [state, actions]);

  // a long crate must not hide the record that's playing
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentTrackIndex, queue.length]);

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
          <div className="panel-head">
            <div className="panel-title">Crate{queue.length ? ` · ${queue.length}` : ''}</div>
            {queue.length > 0 && (
              <button className="link-btn" onClick={actions.clearQueue} title="Unload every record">
                Eject all
              </button>
            )}
          </div>
          <TrackLoader onFiles={addLocalFiles} ready={ready} progress={importProgress} />
          {queue.length > 0 && (
            <ul className="queue">
              {queue.map((t, i) => {
                const isCurrent = i === currentTrackIndex;
                return (
                  <li key={t.id}>
                    <button
                      ref={isCurrent ? currentRowRef : undefined}
                      className={`queue-row ${isCurrent ? 'is-current' : ''}`}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => actions.playIndex(i)}>
                      <span className="q-num">{String(i + 1).padStart(2, '0')}</span>
                      <span className="q-title">
                        <span className="q-name">{t.title}</span>
                        <span className="q-artist">{t.artist}</span>
                      </span>
                      {t.duration ? <span className="q-dur">{fmt(t.duration)}</span> : null}
                    </button>
                    <button
                      className="q-remove"
                      onClick={() => actions.removeTrack(t.id)}
                      aria-label={`Remove ${t.title} from the crate`}
                      title="Remove from crate">
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <footer className="deck-footer">
        <p className="shortcut-hint">Space play/pause · ←/→ seek · N/P track · M mute</p>
        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button className="alert-close" onClick={clearError} aria-label="Dismiss error">×</button>
          </div>
        )}
        {!ready && !error && <div className="ready-badge" role="status">Initializing vinyl…</div>}
        {importProgress.active && (
          <div className="ready-badge" role="status">
            Reading {importProgress.done}/{importProgress.total}…
          </div>
        )}
        {ready && ctxState !== 'running' && (
          <div className="audio-status" title="AudioContext state / worklet status">
            audio: <b>{ctxState}</b> · dsp: <b>ready</b>
          </div>
        )}
      </footer>
    </div>
  );
}
