import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';

export interface TrackLoaderProps {
  /** Accept dropped / selected audio files and add them to the queue. */
  onFiles: (files: File[]) => Promise<void>;
  ready: boolean;
  progress: { active: boolean; done: number; total: number };
}

export function TrackLoader({ onFiles, ready, progress }: TrackLoaderProps) {
  const [over, setOver] = useState(false);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(
      (f) => f.type.startsWith('audio/') || /\.(mp3|wav|aac|m4a|flac|ogg|oga|opus|aiff?)$/i.test(f.name),
    );
    if (arr.length) await onFiles(arr);
  }, [onFiles]);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const hint = over
    ? 'Release to load'
    : progress.active
      ? `Reading ${progress.done}/${progress.total}…`
      : ready
        ? 'Drop audio files or press Enter to browse'
        : 'Loading the turntable…';

  return (
    <label
      className={`track-loader ${over ? 'over' : ''} ${ready ? 'ready' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {/* Visually hidden, NOT `hidden`: a hidden input can't take focus, which
          made loading music impossible without a mouse. */}
      <input
        type="file"
        className="sr-only"
        accept="audio/*"
        multiple
        onChange={(e) => {
          const files = e.target.files;
          if (files) void handleFiles(files);
          e.target.value = '';
        }}
      />
      <span className="hint" aria-live="polite">{hint}</span>
      <span className="sub">MP3, WAV, AAC, M4A, FLAC, OGG</span>
    </label>
  );
}
