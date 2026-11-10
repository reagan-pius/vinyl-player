# Vinyl Player

A web music player with a spinning vinyl / turntable UI, where audio is processed in real time through an AudioWorklet DSP chain.

## Quick start

```bash
npm install
npm run dev
```

Then open **http://localhost:5173** and drop an audio file onto the deck (MP3 / WAV / AAC / FLAC / OGG).

```bash
npm run build     # strict tsc type-check + production bundle -> dist/
npm run preview   # serve the production build
nnpm run test:dsp  # run the vinyl DSP in Node (no browser needed)
npm run test:store # queue + DSP-knob logic, no browser needed
npm run test:metadata # tag reader (ID3/FLAC/OGG/MP4/WAV), no browser needed
npm run test:smoke # build + drive the real app in headless Chrome (needs Chrome)
npm test          # all of the above
```

## What it does

| Feature | Implementation |
|---|---|
| Spinning platter | Canvas-rendered vinyl, rotation driven by `usePlatterAnimation` (spring spin-up, coast-to-stop decay) |
| Tonearm + cueing | SVG arm that lowers the stylus when you press play (`stylusPosition` state) |
| Vinyl sound | `public/vinyl-processor.js` — a real `AudioWorkletProcessor` |
| Live controls | 33 / 45 / 78 RPM, vinyl condition, crackle, wow/flutter, rumble, hiss, warmth, gain, volume |
| Local playback | `AudioBufferSource` → worklet → gain → speakers |
| Seamless hand-off | The next track is decoded while the current one plays, so the boundary is a source swap, not a fetch-and-decode pause |
| Tags & cover art | `src/lib/metadata.ts` — ID3v2 (MP3), Vorbis comments + PICTURE (FLAC), Ogg Vorbis/Opus comments, `ilst` atoms (M4A), RIFF `INFO` (WAV); filename fallback |
| Keyboard & media keys | Space / ←→ / N / P / M, plus the Media Session API for OS controls |
| Persistence & offline | Volume, RPM and DSP knobs persist in `localStorage`; self-hosted fonts, manifest, network-first service worker |
| Verification | DSP harnesses + store/tag tests in Node, plus a headless-Chrome smoke test that imports, plays, auto-advances, pauses and ejects |

## Architecture

The store is the single source of truth for player state; the hook mirrors it into the audio graph and reports playback position back.

## Project layout

```text
app/          └── main.tsx
src/
│   ├── hooks/
│   │   └── useVinylDsp.ts
│   ├── lib/
│   │   └── metadata.ts
│   ├── store/
│   │   └── playerStore.ts
│   └── main.ts
public/
│   └── vinyl-processor.js
dist/         # Production build
```

## Vinyl DSP chain

Each stage mirrors a physical property of record playback:

1. **Wow & Flutter** — pitch modulation from rotational instability. Implemented as a variable-rate fractional resampler (ring buffer + LFO-modulated read pointer, two summed sine LFOs).
2. **Sub-bass rumble** — low-frequency filtered noise.
3. **Surface noise** — pink-ish filtered noise floor.
4. **Clicks & Pops** — Poisson-scheduled events firing into a 48-impulse bank, up to 4 simultaneous voices. Rate scales with crackle + wear.
5. **Saturation** — gentle soft-clip (`d / (1 + |d|)`) for analog warmth.
6. **Stereo width** — subtle mid-side narrowing that increases with wear.
7. **HF roll-off** — low-pass that closes further at higher RPM.

All of these are `AudioParam`s on the node, so the React knobs are real-time audio controls with no jank. The worklet uses a seeded PRNG (mulberry32) and allocates nothing inside `process()` — it never touches `Math.random()`.

## Scope & roadmap

This is **Phase 1**: the DSP + turntable proof of concept, playing local files.

Deliberately **not** here yet:

- **Spotify / YouTube playlist import.** Both platforms withhold raw PCM from their public APIs, so audio can't be routed through our DSP. The safe product path is Spotify/YouTube as a *metadata* source paired with decodable audio — that's Phase 2.
- Playlist import (Spotify/YouTube metadata), track matching, cross-track seamlessness.

## Engine notes

- The worklet lives in `public/` (not processed by Vite) so it can be loaded as a classic script: `ctx.audioWorklet.addModule('/vinyl-processor.js')`.
- Strict TypeScript (`verbatimModuleSyntax`, no unused locals) — `npm run build` type-checks before bundling.
- Browsers block audio until a user gesture; the graph resumes on first play.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- `@vitejs/plugin-react` uses Oxc
- `@vitejs/plugin-react-swc` uses SWC

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see the React documentation.

## License

Released under the MIT License © 2026 reagan-pius
