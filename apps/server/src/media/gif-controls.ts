import { mediaLimits, type GifFrameControl } from '@assetweave/contracts/media';

export class InvalidGif extends Error { constructor(message: string) { super(message); } }
export interface GifControls { width: number; height: number; frames: GifFrameControl[] }

/** Reads the GIF grammar, not decoder-synthesized timing. LZW pixels are validated separately by Sharp. */
export function gifControls(bytes: Buffer): GifControls {
  if (bytes.length < 14 || bytes.length > 32 * 1024 * 1024 ||
      (bytes.toString('ascii', 0, 6) !== 'GIF89a' && bytes.toString('ascii', 0, 6) !== 'GIF87a')) {
    throw new InvalidGif('Invalid GIF header or input bound.');
  }
  let position = 6;
  function requireBytes(count: number): void {
    if (position + count > bytes.length) throw new InvalidGif('Truncated GIF block.');
  }
  function byte(): number { requireBytes(1); return bytes[position++]!; }
  function word(): number { const low = byte(); return low | (byte() << 8); }
  function skip(count: number): void { requireBytes(count); position += count; }
  function blocks(): void {
    while (true) { const size = byte(); if (!size) break; skip(size); }
  }
  const width = word();
  const height = word();
  if (!width || !height || width > mediaLimits.maxDimension || height > mediaLimits.maxDimension ||
      width * height > mediaLimits.maxFramePixels) throw new InvalidGif('GIF dimensions exceed the decode bounds.');
  const packed = byte();
  skip(2); // background colour and pixel aspect ratio
  if (packed & 0x80) skip(3 * (1 << ((packed & 0x07) + 1)));
  const frames: GifFrameControl[] = [];
  let pending: GifFrameControl | null = null;
  while (position < bytes.length) {
    const marker = byte();
    if (marker === 0x3b) {
      if (position !== bytes.length || frames.length === 0) throw new InvalidGif('Invalid GIF trailer.');
      return { width, height, frames };
    }
    if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        if (byte() !== 4) throw new InvalidGif('Invalid GIF graphic control block.');
        const flags = byte();
        const delay = word();
        skip(1); // transparent colour index
        if (byte() !== 0) throw new InvalidGif('Invalid GIF graphic control terminator.');
        pending = { delayCentiseconds: delay, disposal: (flags >> 2) & 0x07 };
      } else if (label === 0x01 || label === 0xff) {
        // Plain Text and Application Extensions carry one fixed-size header and sub-blocks.
        const size = byte(); skip(size); blocks();
        if (label === 0x01) pending = null; // A plain-text graphic consumes its GCE.
      } else { blocks(); }
    } else if (marker === 0x2c) {
      const left = word(); const top = word(); const frameWidth = word(); const frameHeight = word();
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) {
        throw new InvalidGif('Invalid GIF frame rectangle.');
      }
      const flags = byte();
      if (flags & 0x80) skip(3 * (1 << ((flags & 0x07) + 1)));
      byte(); // LZW minimum code size; Sharp validates the compressed pixels.
      blocks();
      frames.push(pending ?? { delayCentiseconds: null, disposal: null });
      if (frames.length > mediaLimits.maxFrames || frames.length * width * height > mediaLimits.maxDecodedPixels) {
        throw new InvalidGif('GIF frame count or decoded pixel bound exceeded.');
      }
      pending = null;
    } else throw new InvalidGif('Unrecognized GIF block.');
  }
  throw new InvalidGif('Missing GIF trailer.');
}
