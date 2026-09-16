import { usePlayerStore } from '../store/playerStore';

/** Scrollable queue. Click = cue that record (arm drops, lead-in, play). */
export function TrackList({ getDuration }: { getDuration: (id: string) => number | undefined }) {
  const queue = usePlayerStore((s) => s.queue);
  const current = usePlayerStore((s) => s.currentTrackIndex);
  const { setCurrent, cue } = usePlayerStore((s) => s.actions);

  if (!queue.length) return null;

  const fmt = (s?: number) =>
    s == null ? '—:—' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <section className="deck-panel">
      <div className="panel-title">Queue · {queue.length}</div>
      <ol className="queue">
        {queue.map((t, i) => (
          <li key={t.id}>
            <button
              className={`queue-row ${i === current ? 'is-current' : ''}`}
              onClick={() => { if (i !== current) setCurrent(i); cue(); }}
            >
              <span className="q-num">{i === current ? '▸' : String(i + 1).padStart(2, '0')}</span>
              <span className="q-title">
                <span className="q-name">{t.title}</span>
                <span className="q-artist">{t.artist}</span>
              </span>
              <span className="q-dur">{fmt(getDuration(t.id))}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}