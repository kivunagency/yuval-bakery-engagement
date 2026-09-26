import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { visualPieces } from '@/lib/server/confirmation/bidi-runs';

// Renders the confirmation document (US-0c) to PDF bytes. Pure layout: the
// words come from content.ts. Generator choice (the orchestrator's brief: no
// headless browser on Netlify functions, Hebrew shaped correctly, real text):
// pdfkit 0.20 (pure JS, embeds a subset of the font as TrueType, text stays
// selectable) + bidi-js for UAX #9 line order (bidi-runs.ts). Font: IBM Plex
// Sans Hebrew, the site's font (OFL, assets/fonts/OFL.txt), complete WOFF with
// Hebrew, Latin, digits and ₪ in one file.
//
// Deterministic: the same content gives byte-identical output (CreationDate is
// the order's creation time, no random file id), so two requests racing to
// issue the same order store the same file and the same sha256.

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; muted?: boolean; small?: boolean }
  /** A line with a value on the far (left) side, e.g. an item and its price. */
  | { kind: 'row'; label: string; value: string; strong?: boolean }
  | { kind: 'rule' };

export type ConfirmationDocument = { title: string; createdAt: Date; blocks: Block[] };

const FONT_DIR = join(process.cwd(), 'assets', 'fonts');
let fonts: { regular: Buffer; bold: Buffer } | undefined;
function loadFonts() {
  fonts ??= {
    regular: readFileSync(join(FONT_DIR, 'IBMPlexSansHebrew-Regular.woff')),
    bold: readFileSync(join(FONT_DIR, 'IBMPlexSansHebrew-Bold.woff')),
  };
  return fonts;
}

const INK = '#16181D';
const INK_2 = '#555A63';
const ACCENT = '#A3123F';
const LINE = '#DDDED9';
const MARGIN = 48;
const RAW = { features: [] as never[] }; // one fontkit run per piece (see bidi-runs.ts)

export async function renderConfirmationPdf(content: ConfirmationDocument): Promise<Buffer> {
  const f = loadFonts();
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    font: f.regular as unknown as string,
    lang: 'he-IL',
    displayTitle: true,
    info: { Title: content.title, CreationDate: content.createdAt, Producer: 'YuvalBakery', Creator: 'YuvalBakery' },
  });
  doc.registerFont('regular', f.regular);
  doc.registerFont('bold', f.bold);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const right = doc.page.width - MARGIN;
  const left = MARGIN;
  const bottom = doc.page.height - MARGIN;
  let y = MARGIN;

  const width = (line: string) => visualPieces(line).reduce((w, p) => w + doc.widthOfString(p.text, RAW), 0);
  const ensure = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = MARGIN;
    }
  };
  /** One RTL line whose right edge (or left edge) sits at x. */
  const drawLine = (line: string, edge: number, align: 'right' | 'left') => {
    const pieces = visualPieces(line);
    const total = pieces.reduce((w, p) => w + doc.widthOfString(p.text, RAW), 0);
    let x = align === 'right' ? edge - total : edge;
    for (const p of pieces) {
      doc.text(p.text, x, y, { lineBreak: false, ...RAW });
      x += doc.widthOfString(p.text, RAW);
    }
    return total;
  };
  /** Greedy wrap on spaces, in logical order (UAX #9 reorders each line after wrapping). */
  const wrap = (text: string, max: number): string[] => {
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && width(candidate) > max) {
        lines.push(current);
        current = word;
      } else current = candidate;
    }
    if (current) lines.push(current);
    return lines;
  };
  const paragraph = (text: string, size: number, font: 'regular' | 'bold', color: string, after: number) => {
    doc.font(font).fontSize(size).fillColor(color);
    const lh = size * 1.45;
    for (const line of wrap(text, right - left)) {
      ensure(lh);
      drawLine(line, right, 'right');
      y += lh;
    }
    y += after;
  };

  for (const b of content.blocks) {
    switch (b.kind) {
      case 'title':
        paragraph(b.text, 22, 'bold', ACCENT, 2);
        break;
      case 'subtitle':
        paragraph(b.text, 14, 'bold', INK, 6);
        break;
      case 'heading':
        y += 8;
        ensure(40);
        paragraph(b.text, 13, 'bold', INK, 2);
        break;
      case 'text':
        paragraph(b.text, b.small ? 9 : 11, 'regular', b.muted ? INK_2 : INK, 3);
        break;
      case 'row': {
        const size = b.strong ? 12 : 11;
        const lh = size * 1.6;
        ensure(lh);
        doc.font(b.strong ? 'bold' : 'regular').fontSize(size).fillColor(INK);
        const valueWidth = drawLine(b.value, left, 'left');
        // A long label wraps inside the space the value leaves free.
        const lines = wrap(b.label, right - left - valueWidth - 24);
        lines.forEach((line, i) => {
          if (i > 0) {
            y += lh;
            ensure(lh);
          }
          drawLine(line, right, 'right');
        });
        y += lh;
        break;
      }
      case 'rule':
        ensure(12);
        y += 4;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(LINE).stroke();
        y += 8;
        break;
    }
  }

  doc.end();
  return done;
}
