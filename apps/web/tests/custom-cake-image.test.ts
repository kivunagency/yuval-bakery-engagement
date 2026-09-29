import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_DIMENSION, reencodePhoto, sniffImageType } from '@/lib/server/custom-cake/image';

// SEC-010 / SEC-021 upload cases that need no Storage: the re-encode step
// alone decides what bytes are ever stored.

const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#c86432' } });

async function jpegWithGps(): Promise<Buffer> {
  return solid(64, 48)
    .withExif({ IFD0: { Make: 'QA-PHONE', ImageDescription: 'home kitchen' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1' } })
    .jpeg()
    .toBuffer();
}

describe('sniffImageType', () => {
  it('reads magic bytes, not names or declared types', async () => {
    expect(sniffImageType(await solid(2, 2).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffImageType(await solid(2, 2).png().toBuffer())).toBe('png');
    expect(sniffImageType(await solid(2, 2).webp().toBuffer())).toBe('webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('reencodePhoto', () => {
  it('drops EXIF and GPS', async () => {
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await reencodePhoto(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const meta = await sharp(out.jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.jpeg.includes(Buffer.from('QA-PHONE'))).toBe(false);
  });

  it('neutralises a polyglot: bytes appended after the image are not in the output', async () => {
    const payload = Buffer.from('<html><script>alert(1)</script></html>');
    const out = await reencodePhoto(Buffer.concat([await solid(16, 16).jpeg().toBuffer(), payload]));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.jpeg.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('refuses SVG, HTML and a PNG header on garbage', async () => {
    expect(await reencodePhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toEqual({ ok: false, reason: 'not_an_image' });
    expect(await reencodePhoto(Buffer.from('<!doctype html><p>hi</p>'))).toEqual({ ok: false, reason: 'not_an_image' });
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png')]);
    expect((await reencodePhoto(fakePng)).ok).toBe(false);
  });

  it('refuses a file over 10MB before decoding it', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(await reencodePhoto(big)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a decompression bomb (pixel count over the decode ceiling)', async () => {
    // 8000 x 8000 = 64M pixels of one colour: a few KB as PNG.
    const bomb = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(await reencodePhoto(bomb)).toEqual({ ok: false, reason: 'not_an_image' });
  });

  it('caps the longest side and keeps PNG and WebP working', async () => {
    const wide = await solid(4000, 1000).png().toBuffer();
    const out = await reencodePhoto(wide);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const meta = await sharp(out.jpeg).metadata();
      expect(meta.width).toBe(MAX_DIMENSION);
      expect(meta.height).toBe(640);
    }
    expect((await reencodePhoto(await solid(20, 20).webp().toBuffer())).ok).toBe(true);
  });
});
