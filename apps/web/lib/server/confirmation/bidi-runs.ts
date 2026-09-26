import 'server-only';
import bidiFactory from 'bidi-js';

// Right-to-left lines for the confirmation PDF (US-0c). pdfkit has no bidi
// algorithm, so each line is laid out here with UAX #9 (bidi-js), the same
// algorithm the browser applies to the order page:
//   1. embedding levels for the line in an RTL paragraph (isolates such as
//      isolate()/isolatedDate() are honoured, as on the screen);
//   2. brackets mirrored at odd levels, then the reorder segments applied,
//      giving the visual order, left to right;
//   3. the visual string cut into runs of one direction.
// pdfkit hands each run to fontkit, and fontkit reverses a run whose script
// is Hebrew (it lays it out right to left itself). So a Hebrew run is given
// to it back in reading order and comes out visual; every other run is drawn
// as is. The text in the file stays real, selectable text, not an image.
// Nothing here changes content: the characters are the logical string's.

const bidi = bidiFactory();
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
// Directional marks and isolates steer the algorithm but have no glyph in the font.
const BIDI_CONTROL = /[‎‏؜‪-‮⁦-⁩]/;

export type Piece = { text: string };

/** The line as pieces to draw left to right, each ready for pdfkit. */
export function visualPieces(line: string): Piece[] {
  if (!line) return [];
  const levelsResult = bidi.getEmbeddingLevels(line, 'rtl');
  const levels = levelsResult.levels;
  const mirrored = bidi.getMirroredCharactersMap(line, levels);
  const order = Array.from(line, (_, i) => i);
  // Array.from on a string iterates code points; our content is BMP-only
  // (Hebrew, Latin, digits, punctuation, ₪), so index i is the UTF-16 index.
  for (const [start, end] of bidi.getReorderSegments(line, levelsResult)) {
    const part = order.slice(start, end + 1).reverse();
    order.splice(start, part.length, ...part);
  }

  const runs: { rtl: boolean; chars: string[] }[] = [];
  for (const i of order) {
    const ch = mirrored.get(i) ?? line[i]!;
    if (BIDI_CONTROL.test(ch)) continue;
    const rtl = (levels[i]! & 1) === 1;
    const last = runs[runs.length - 1];
    if (last && last.rtl === rtl) last.chars.push(ch);
    else runs.push({ rtl, chars: [ch] });
  }
  return runs.map((r) => {
    const visual = r.chars.join('');
    return { text: HEBREW.test(visual) ? [...r.chars].reverse().join('') : visual };
  });
}

/** The visual string of a line (what a reader sees, left to right), for tests. */
export function visualString(line: string): string {
  return visualPieces(line)
    .map((p) => (HEBREW.test(p.text) ? [...p.text].reverse().join('') : p.text))
    .join('');
}
