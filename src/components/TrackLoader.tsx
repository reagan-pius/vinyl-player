import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';

export interface TrackLoaderProps {
  /** Accept dropped / selected audio files and add them to the queue. */
  onFiles: (files: File[]) => Promise<void>;
  ready: boolean;
}

export function TrackLoader({ onFiles, ready }: TrackLoaderProps) {
  const [over, setOver] = useState(false);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|aac|flac|ogg|m4a)$/i.test(f.name));
    if (arr.length) await onFiles(arr);
  }, [onFiles]);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault(); setOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <label
      className={`track-loader ${over ? 'over' : ''} ${ready ? 'ready' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        type="file" accept="audio/*" multiple hidden
        onChange={(e) => handleFiles(e.target.files ?? [])}
      />
      <span className="hint">
        {over ? 'Release to load' : ready
          ? 'Drop an audio file or click to browse'
          : 'Loading the turntable…'}
      </span>
      <span className="sub">MP3, WAV, AAC, FLAC, OGG</span>
    </label>
  );
}
