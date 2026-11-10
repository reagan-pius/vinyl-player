/**
 * metadata.ts — best-effort tag reader for local audio files.
 *
 * Pulls title / artist / album / embedded cover art straight out of the file
 * header, so a correctly tagged album doesn't show up as "Unknown Artist".
 *
 * Containers: ID3v2.2/2.3/2.4 (MP3), Vorbis comments + PICTURE (FLAC),
 * Vorbis/Opus comments (OGG), `ilst` atoms (MP4/M4A), and RIFF `LIST/INFO`
 * (WAV). Anything it can't parse returns `{}` and the caller falls back to
 * parsing the filename.
 *
 * `parseTags` is pure (bytes in, tags out) so it can be tested in Node;
 * `readTags` is the browser wrapper that turns embedded art into a Blob URL.
 * No dependencies: this only reads bytes the browser already handed us.
 */

export interface TagPicture {
  bytes: Uint8Array;
  mime: string;
}

export interface ParsedTags {
  title?: string;
  artist?: string;
  album?: string;
  picture?: TagPicture;
}

export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
}

/** Tag headers live at the front of the file; 1 MiB covers typical cover art. */
const HEAD_BYTES = 1024 * 1024;

/** Parse tags from the first bytes of a file. Never throws. */
export function parseTags(bytes: Uint8Array): ParsedTags {
  try {
    if (ascii(bytes, 0, 3) === 'ID3') return readId3(bytes);
    if (ascii(bytes, 0, 4) === 'fLaC') return readFlac(bytes);
    if (ascii(bytes, 0, 4) === 'OggS') return readOgg(bytes);
    if (ascii(bytes, 0, 4) === 'RIFF') return readRiff(bytes);
    if (ascii(bytes, 4, 4) === 'ftyp') return readMp4(bytes);
  } catch {
    // A malformed header must never break importing the file itself.
  }
  return {};
}

/** Read tags from a File, converting embedded art into a Blob URL. */
export async function readTags(file: File): Promise<TrackTags> {
  try {
    const slice = file.slice(0, Math.min(file.size, HEAD_BYTES));
    const { picture, ...tags } = parseTags(new Uint8Array(await slice.arrayBuffer()));
    return picture ? { ...tags, coverUrl: blobUrl(picture.bytes, picture.mime) } : tags;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- primitives

function ascii(b: Uint8Array, at: number, len: number): string {
  if (at < 0 || at + len > b.length) return '';
  let out = '';
  for (let i = 0; i < len; i++) out += String.fromCharCode(b[at + i]);
  return out;
}

const u32be = (b: Uint8Array, at: number) =>
  at + 4 <= b.length
    ? ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
    : 0;

const u32le = (b: Uint8Array, at: number) =>
  at + 4 <= b.length
    ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
    : 0;

/** ID3v2 sizes are 28-bit "syncsafe" integers (one bit of padding per byte). */
const syncsafe = (b: Uint8Array, at: number) =>
  at + 4 <= b.length
    ? ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f)
    : 0;

function blobUrl(bytes: Uint8Array, type: string): string {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: type || 'image/jpeg' }));
}

function base64ToBytes(input: string): Uint8Array | undefined {
  try {
    const binary = atob(input.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function decode(encoding: number, bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const body = bytes.subarray(0, end);
  try {
    if (encoding === 1 || encoding === 2) {
      let label = encoding === 2 ? 'utf-16be' : 'utf-16le';
      let start = 0;
      if (encoding === 1 && body.length >= 2) {
        if (body[0] === 0xff && body[1] === 0xfe) start = 2;
        else if (body[0] === 0xfe && body[1] === 0xff) {
          label = 'utf-16be';
          start = 2;
        }
      }
      return new TextDecoder(label).decode(body.subarray(start)).replace(/\0/g, '').trim();
    }
    if (encoding === 3) return new TextDecoder('utf-8').decode(body).replace(/\0/g, '').trim();
    return new TextDecoder('iso-8859-1').decode(body).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------- ID3v2

function readId3(b: Uint8Array): ParsedTags {
  const major = b[3];
  const flags = b[5];
  const end = Math.min(b.length, 10 + syncsafe(b, 6));
  let pos = 10;

  if (flags & 0x40) {
    // Extended header: v2.4 stores a syncsafe size that includes itself.
    const extSize = major >= 4 ? syncsafe(b, pos) : u32be(b, pos);
    pos += major >= 4 ? extSize : extSize + 4;
  }

  const tags: ParsedTags = {};
  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;

  while (pos + headerLen <= end) {
    const id = ascii(b, pos, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    const size =
      major === 2
        ? (b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5]
        : major >= 4
          ? syncsafe(b, pos + 4)
          : u32be(b, pos + 4);
    if (size <= 0) break;

    const start = pos + headerLen;
    const frame = b.subarray(start, Math.min(start + size, end));
    if (frame.length > 1) {
      if (id === 'TIT2' || id === 'TT2') tags.title = decode(frame[0], frame.subarray(1)) || tags.title;
      else if (id === 'TPE1' || id === 'TP1') tags.artist = decode(frame[0], frame.subarray(1)) || tags.artist;
      else if (id === 'TALB' || id === 'TAL') tags.album = decode(frame[0], frame.subarray(1)) || tags.album;
      else if ((id === 'APIC' || id === 'PIC') && !tags.picture) {
        tags.picture = apic(frame, id === 'PIC');
      }
    }
    pos = start + size;
  }

  return tags;
}

function apic(frame: Uint8Array, v22: boolean): TagPicture | undefined {
  const encoding = frame[0];
  let p = 1;
  let mime = 'image/jpeg';

  if (v22) {
    mime = `image/${ascii(frame, 1, 3).toLowerCase() || 'jpeg'}`;
    p = 4;
  } else {
    const mimeStart = p;
    while (p < frame.length && frame[p] !== 0) p++;
    mime = new TextDecoder('iso-8859-1').decode(frame.subarray(mimeStart, p)) || mime;
    p++;
  }

  p++; // picture type

  if (encoding === 1 || encoding === 2) {
    while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < frame.length && frame[p] !== 0) p++;
    p++;
  }

  const data = frame.subarray(p);
  if (data.length <= 32) return undefined;
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return { bytes: copy, mime };
}

// ---------------------------------------------------------------- FLAC / Ogg

function readFlac(b: Uint8Array): ParsedTags {
  const tags: ParsedTags = {};
  let pos = 4;

  while (pos + 4 <= b.length) {
    const header = b[pos];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    const start = pos + 4;
    if (start + size > b.length) break;

    if (type === 4) {
      const vorbis = readVorbis(b, start, size);
      tags.title ??= vorbis.title;
      tags.artist ??= vorbis.artist;
      tags.album ??= vorbis.album;
      tags.picture ??= vorbis.picture;
    } else if (type === 6 && !tags.picture) {
      tags.picture = parseFlacPicture(b.subarray(start, start + size));
    }

    if (isLast) break;
    pos = start + size;
  }

  return tags;
}

/**
 * Ogg pages carry packets in a segment table. The comment header is always in
 * the first few pages, so this walks pages until it finds a `\x03vorbis` or
 * `OpusTags` packet and then stops.
 */
function readOgg(b: Uint8Array): ParsedTags {
  let pos = 0;
  let pages = 0;

  while (pos + 27 <= b.length && pages++ < 64) {
    if (ascii(b, pos, 4) !== 'OggS') break;
    const segmentCount = b[pos + 26];
    const tableStart = pos + 27;
    const dataStart = tableStart + segmentCount;
    if (dataStart > b.length) break;

    let cursor = dataStart;
    let packetStart = dataStart;
    for (let i = 0; i < segmentCount; i++) {
      cursor += b[tableStart + i];
      if (b[tableStart + i] === 255) continue; // packet continues

      const packetLength = cursor - packetStart;
      if (packetLength > 0) {
        if (ascii(b, packetStart, 8) === 'OpusTags') {
          return readVorbis(b, packetStart + 8, packetLength - 8);
        }
        if (b[packetStart] === 0x03 && ascii(b, packetStart + 1, 6) === 'vorbis') {
          return readVorbis(b, packetStart + 7, packetLength - 7);
        }
      }
      packetStart = cursor;
    }
    pos = Math.max(cursor, dataStart);
  }

  return {};
}

/** Vorbis comment block, shared by FLAC and Ogg (little-endian lengths). */
function readVorbis(b: Uint8Array, at: number, size: number): ParsedTags {
  const end = Math.min(at + size, b.length);
  let p = at;
  const vendorLength = u32le(b, p);
  p += 4 + vendorLength;
  const count = u32le(b, p);
  p += 4;

  const tags: ParsedTags = {};
  let pictureBlock: string | undefined;

  for (let i = 0; i < count && p + 4 <= end; i++) {
    const length = u32le(b, p);
    p += 4;
    if (p + length > end) break;
    const entry = new TextDecoder('utf-8').decode(b.subarray(p, p + length));
    p += length;

    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1).trim();
    if (!value) continue;

    if (key === 'TITLE') tags.title ??= value;
    else if (key === 'ARTIST') tags.artist ??= value;
    else if (key === 'ALBUM') tags.album ??= value;
    else if (key === 'METADATA_BLOCK_PICTURE' && !pictureBlock) pictureBlock = value;
  }

  if (pictureBlock && !tags.picture) {
    const block = base64ToBytes(pictureBlock);
    if (block) tags.picture = parseFlacPicture(block);
  }

  return tags;
}

function parseFlacPicture(b: Uint8Array): TagPicture | undefined {
  let p = 4; // picture type
  const mimeLength = u32be(b, p);
  p += 4;
  const mime = ascii(b, p, mimeLength) || 'image/jpeg';
  p += mimeLength;
  const descriptionLength = u32be(b, p);
  p += 4 + descriptionLength + 16; // width, height, depth, colours
  const dataLength = u32be(b, p);
  p += 4;
  if (dataLength <= 32 || p + dataLength > b.length) return undefined;
  const copy = new Uint8Array(dataLength);
  copy.set(b.subarray(p, p + dataLength));
  return { bytes: copy, mime };
}

// -------------------------------------------------------------------- MP4/M4A

function readMp4(b: Uint8Array): ParsedTags {
  const tags: ParsedTags = {};
  walkAtoms(b, 0, b.length, tags, 0);
  return tags;
}

function walkAtoms(b: Uint8Array, start: number, end: number, tags: ParsedTags, depth: number): void {
  if (depth > 6) return;
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1 && p + 16 <= end) {
      size = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12);
      header = 16;
    }
    if (size < header || p + size > end) return;

    const bodyStart = p + header;
    const bodyEnd = p + size;
    if (type === 'moov' || type === 'udta' || type === 'trak' || type === 'mdia') {
      walkAtoms(b, bodyStart, bodyEnd, tags, depth + 1);
    } else if (type === 'meta') {
      walkAtoms(b, bodyStart + 4, bodyEnd, tags, depth + 1); // 4-byte version/flags
    } else if (type === 'ilst') {
      readIlst(b, bodyStart, bodyEnd, tags);
    }
    p = bodyEnd;
  }
}

function readIlst(b: Uint8Array, start: number, end: number, tags: ParsedTags): void {
  let p = start;
  while (p + 8 <= end) {
    const size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    if (size < 8 || p + size > end) return;
    const bodyStart = p + 8;
    const bodyEnd = p + size;

    if (ascii(b, bodyStart + 4, 4) === 'data' && bodyStart + 16 <= bodyEnd) {
      const dataType = u32be(b, bodyStart + 8);
      const payload = b.subarray(bodyStart + 16, bodyEnd);
      if (type === '\u00a9nam') tags.title ||= new TextDecoder('utf-8').decode(payload).trim();
      else if (type === '\u00a9ART') tags.artist ||= new TextDecoder('utf-8').decode(payload).trim();
      else if (type === '\u00a9alb') tags.album ||= new TextDecoder('utf-8').decode(payload).trim();
      else if (type === 'covr' && !tags.picture && payload.length > 32) {
        const copy = new Uint8Array(payload.length);
        copy.set(payload);
        tags.picture = { bytes: copy, mime: dataType === 14 ? 'image/png' : 'image/jpeg' };
      }
    }
    p = bodyEnd;
  }
}

// ------------------------------------------------------------------------- WAV

/** RIFF `LIST/INFO` chunk: INAM title, IART artist, IPRD album. */
function readRiff(b: Uint8Array): ParsedTags {
  const tags: ParsedTags = {};
  let pos = 12;

  while (pos + 8 <= b.length) {
    const id = ascii(b, pos, 4);
    const size = u32le(b, pos + 4);
    const start = pos + 8;
    if (start + size > b.length) break;

    if (id === 'LIST' && ascii(b, start, 4) === 'INFO') {
      let p = start + 4;
      const end = start + size;
      while (p + 8 <= end) {
        const field = ascii(b, p, 4);
        const fieldSize = u32le(b, p + 4);
        const valueStart = p + 8;
        if (valueStart + fieldSize > end) break;
        const value = new TextDecoder('utf-8')
          .decode(b.subarray(valueStart, valueStart + fieldSize))
          .replace(/\0[\s\S]*$/, '')
          .trim();
        if (value) {
          if (field === 'INAM') tags.title ??= value;
          else if (field === 'IART') tags.artist ??= value;
          else if (field === 'IPRD') tags.album ??= value;
        }
        p = valueStart + fieldSize + (fieldSize % 2);
      }
    }
    pos = start + size + (size % 2);
  }

  return tags;
}
