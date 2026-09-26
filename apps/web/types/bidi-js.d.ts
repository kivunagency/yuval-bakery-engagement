// Minimal types for bidi-js 1.0.3 (UAX #9), the parts lib/server/confirmation uses.
declare module 'bidi-js' {
  type EmbeddingLevels = { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] };
  type Bidi = {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    getReorderSegments(text: string, levels: EmbeddingLevels, start?: number, end?: number): [number, number][];
    getMirroredCharactersMap(text: string, levels: Uint8Array, start?: number, end?: number): Map<number, string>;
  };
  export default function bidiFactory(): Bidi;
}
