import 'server-only';
import sharp from 'sharp';
import { CUSTOM_CAKE_LIMITS } from '@/lib/shared/contracts/custom-cake';

// SEC-010: an uploaded inspiration photo is untrusted. The stored file is
// never the upload: it is a new JPEG drawn by sharp from the decoded pixels,
// so EXIF/GPS and anything appended to the file (polyglot) are gone, and the
// original is deleted. Pure functions on buffers; Storage I/O is in photos.ts.

export type SniffedType = 'jpeg' | 'png' | 'webp';

/** Magic bytes only. The declared Content-Type and the file name are ignored. */
export function sniffImageType(buf: Uint8Array): SniffedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return 'png';
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Longest side of the stored image, and the decode ceiling against decompression bombs. */
export const MAX_DIMENSION = 2560;
export const MAX_INPUT_PIXELS = 40_000_000;

export type ReencodeResult = { ok: true; jpeg: Buffer } | { ok: false; reason: 'too_large' | 'not_an_image' | 'type_mismatch' };

export async function reencodePhoto(input: Buffer): Promise<ReencodeResult> {
  if (input.length > CUSTOM_CAKE_LIMITS.photoBytes) return { ok: false, reason: 'too_large' };
  const sniffed = sniffImageType(input);
  if (!sniffed) return { ok: false, reason: 'not_an_image' };
  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false });
    const meta = await image.metadata();
    // The decoder must agree with the magic bytes (a PNG header on a file
    // libvips reads as something else is refused, not guessed).
    if (meta.format !== sniffed) return { ok: false, reason: 'type_mismatch' };
    const jpeg = await image
      .rotate() // apply the EXIF orientation to the pixels, before the metadata is dropped
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // PNG/WebP transparency onto white
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer(); // sharp writes no EXIF/XMP/ICC unless asked (keepMetadata/withMetadata)
    return { ok: true, jpeg };
  } catch {
    return { ok: false, reason: 'not_an_image' };
  }
}
