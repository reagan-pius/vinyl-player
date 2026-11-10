#!/usr/bin/env node
/**
 * Tag-reader tests for src/lib/metadata.ts.
 *
 * Builds tiny synthetic files for every supported container and asserts the
 * parser pulls the right fields out of real byte layouts:
 *
 *   ID3v2.3 (MP3) · ID3v2.4 syncsafe sizes · FLAC Vorbis + PICTURE ·
 *   OGG Vorbis comment · OpusTags · MP4/M4A ilst · RIFF LIST/INFO (WAV)
 *
 * parseTags is pure, so this runs on plain Node with type stripping.
 *
 *   npm run test:metadata
 */
import assert from 'node:assert/strict';
import { parseTags } from '../src/lib/metadata.ts';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${error.message.split('\n')[0]}`);
  }
}

// ------------------------------------------------------------------ fixtures

const ART = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(48, 7)]);

const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

function id3Frame(id, payload, major) {
  const size = major === 4 ? syncsafe(payload.length) : u32be(payload.length);
  return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.alloc(2), payload]);
}

function id3File(frames, major) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, 0]), syncsafe(body.length), body]);
}

const textFrame = (id, text, major = 3, utf8 = false) =>
  id3Frame(id, Buffer.concat([Buffer.from([utf8 ? 3 : 0]), Buffer.from(text, utf8 ? 'utf8' : 'latin1')]), major);

function vorbisBlock(entries) {
  const vendor = Buffer.from('vinyl-player', 'utf8');
  const parts = [u32le(vendor.length), vendor, u32le(entries.length)];
  for (const [key, value] of entries) {
    const entry = Buffer.from(`${key}=${value}`, 'utf8');
    parts.push(u32le(entry.length), entry);
  }
  return Buffer.concat(parts);
}

function flacBlock(type, payload, last = false) {
  const header = Buffer.from([(last ? 0x80 : 0) | type, 0, 0, 0]);
  header[1] = (payload.length >> 16) & 0xff;
  header[2] = (payload.length >> 8) & 0xff;
  header[3] = payload.length & 0xff;
  return Buffer.concat([header, payload]);
}

function flacPictureBlock() {
  const mime = Buffer.from('image/png', 'latin1');
  return Buffer.concat([
    u32be(3), u32be(mime.length), mime, u32be(0),
    u32be(512), u32be(512), u32be(24), u32be(0),
    u32be(ART.length), ART,
  ]);
}

function oggPage(packet) {
  const segments = [];
  let remaining = packet.length;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining);
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header[4] = 0;
  header[5] = 0x02;
  header.writeUInt32LE(1, 14); // serial
  header.writeUInt32LE(0, 18); // page sequence
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), packet]);
}

const atom = (type, payload) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
const dataAtom = (payload, type = 1) =>
  atom('data', Buffer.concat([Buffer.from([0, 0, 0, type]), Buffer.alloc(4), payload]));

function mp4File() {
  const items = Buffer.concat([
    atom('\u00a9nam', dataAtom(Buffer.from('Blue in Green', 'utf8'))),
    atom('\u00a9ART', dataAtom(Buffer.from('Miles Davis', 'utf8'))),
    atom('\u00a9alb', dataAtom(Buffer.from('Kind of Blue', 'utf8'))),
    atom('covr', dataAtom(ART, 14)),
  ]);
  const meta = atom('meta', Buffer.concat([Buffer.alloc(4), atom('ilst', items)]));
  const moov = atom('moov', atom('udta', meta));
  return Buffer.concat([atom('ftyp', Buffer.from('M4A isomM4A ', 'latin1')), moov]);
}

/** RIFF chunks are `id` then `size` — the opposite order from MP4 atoms. */
const riffChunk = (id, payload) => {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

function wavFile() {
  const info = (id, text) => {
    const value = Buffer.from(`${text}\0`, 'latin1');
    const pad = value.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(id, 'latin1'), u32le(value.length), value, pad]);
  };
  const list = riffChunk('LIST', Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    info('INAM', 'Take Five'),
    info('IART', 'Dave Brubeck'),
    info('IPRD', 'Time Out'),
  ]));
  const header = Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(list.length + 4), Buffer.from('WAVE', 'latin1')]);
  return Buffer.concat([header, list]);
}

// --------------------------------------------------------------------- tests

console.log('--- ID3v2.3 (MP3) ---');
const id3v23 = id3File([
  textFrame('TIT2', 'So What'),
  textFrame('TPE1', 'Miles Davis'),
  textFrame('TALB', 'Kind of Blue'),
  id3Frame('APIC', Buffer.concat([
    Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3]), Buffer.from('\0', 'latin1'), ART,
  ]), 3),
], 3);

check('reads title / artist / album', () => {
  const tags = parseTags(new Uint8Array(id3v23));
  assert.equal(tags.title, 'So What');
  assert.equal(tags.artist, 'Miles Davis');
  assert.equal(tags.album, 'Kind of Blue');
});
check('extracts embedded cover art', () => {
  const { picture } = parseTags(new Uint8Array(id3v23));
  assert.ok(picture, 'no picture parsed');
  assert.equal(picture.mime, 'image/png');
  assert.equal(picture.bytes.length, ART.length);
});

console.log('--- ID3v2.4 (syncsafe frame sizes) ---');
const id3v24 = id3File([
  textFrame('TIT2', 'Naima', 4, true),
  textFrame('TPE1', 'John Coltrane', 4, true),
], 4);
check('reads UTF-8 frames with syncsafe sizes', () => {
  const tags = parseTags(new Uint8Array(id3v24));
  assert.equal(tags.title, 'Naima');
  assert.equal(tags.artist, 'John Coltrane');
});

console.log('--- FLAC (Vorbis comments + PICTURE) ---');
const flac = Buffer.concat([
  Buffer.from('fLaC', 'latin1'),
  flacBlock(4, vorbisBlock([['TITLE', 'Flamenco Sketches'], ['ARTIST', 'Miles Davis'], ['ALBUM', 'Kind of Blue']])),
  flacBlock(6, flacPictureBlock(), true),
]);
check('reads Vorbis comments', () => {
  const tags = parseTags(new Uint8Array(flac));
  assert.equal(tags.title, 'Flamenco Sketches');
  assert.equal(tags.artist, 'Miles Davis');
  assert.equal(tags.album, 'Kind of Blue');
});
check('reads the FLAC picture block', () => {
  const { picture } = parseTags(new Uint8Array(flac));
  assert.ok(picture, 'no picture parsed');
  assert.equal(picture.mime, 'image/png');
  assert.equal(picture.bytes.length, ART.length);
});

console.log('--- OGG Vorbis / Opus ---');
const oggVorbis = oggPage(Buffer.concat([
  Buffer.from([3]), Buffer.from('vorbis', 'latin1'),
  vorbisBlock([['TITLE', 'Ogg Song'], ['ARTIST', 'Ogg Artist'], ['ALBUM', 'Ogg Album']]),
]));
check('reads an OGG Vorbis comment header', () => {
  const tags = parseTags(new Uint8Array(oggVorbis));
  assert.equal(tags.title, 'Ogg Song');
  assert.equal(tags.artist, 'Ogg Artist');
  assert.equal(tags.album, 'Ogg Album');
});

const opus = oggPage(Buffer.concat([
  Buffer.from('OpusTags', 'latin1'),
  vorbisBlock([['TITLE', 'Opus Song'], ['ARTIST', 'Opus Artist']]),
]));
check('reads an OpusTags header', () => {
  const tags = parseTags(new Uint8Array(opus));
  assert.equal(tags.title, 'Opus Song');
  assert.equal(tags.artist, 'Opus Artist');
});
check('reads a base64 METADATA_BLOCK_PICTURE', () => {
  const withArt = oggPage(Buffer.concat([
    Buffer.from('OpusTags', 'latin1'),
    vorbisBlock([
      ['TITLE', 'Opus Song'],
      ['METADATA_BLOCK_PICTURE', flacPictureBlock().toString('base64')],
    ]),
  ]));
  const { picture } = parseTags(new Uint8Array(withArt));
  assert.ok(picture, 'no picture parsed');
  assert.equal(picture.bytes.length, ART.length);
});

console.log('--- MP4 / M4A ---');
check('reads ilst atoms', () => {
  const tags = parseTags(new Uint8Array(mp4File()));
  assert.equal(tags.title, 'Blue in Green');
  assert.equal(tags.artist, 'Miles Davis');
  assert.equal(tags.album, 'Kind of Blue');
});
check('reads the covr atom as PNG', () => {
  const { picture } = parseTags(new Uint8Array(mp4File()));
  assert.ok(picture, 'no picture parsed');
  assert.equal(picture.mime, 'image/png');
});

console.log('--- WAV (RIFF LIST/INFO) ---');
check('reads INAM / IART / IPRD', () => {
  const tags = parseTags(new Uint8Array(wavFile()));
  assert.equal(tags.title, 'Take Five');
  assert.equal(tags.artist, 'Dave Brubeck');
  assert.equal(tags.album, 'Time Out');
});

console.log('--- robustness ---');
check('unknown container returns {}', () => {
  assert.deepEqual(parseTags(new Uint8Array(Buffer.from('not audio at all'))), {});
});
check('truncated ID3 header returns {} without throwing', () => {
  assert.deepEqual(parseTags(new Uint8Array(Buffer.from('ID3'))), {});
});
check('truncated FLAC block returns {} without throwing', () => {
  assert.deepEqual(parseTags(new Uint8Array(Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.from([0x84])]))), {});
});
check('empty input returns {}', () => {
  assert.deepEqual(parseTags(new Uint8Array(0)), {});
});

console.log();
if (failures) {
  console.log(`=== ${failures} CHECK(S) FAILED ===`);
  process.exit(1);
}
console.log('=== ALL METADATA CHECKS PASS ===');
