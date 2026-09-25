// Local stack only: a minimal SMTP server that accepts every message from
// Supabase Auth and writes it to MAIL_DIR as <time>-<n>.eml, with the envelope
// recipients in a first "X-Envelope-To:" line. Nothing is ever delivered.
// Tests read the confirmation link from these files (qa/helpers/mail.js), so
// the sign-up flow runs with email confirmation on, as on hosted Supabase.
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MAIL_DIR;
const port = Number(process.env.SMTP_PORT);
mkdirSync(dir, { recursive: true });
let seq = 0;

net
  .createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = [];
    let rcpt = [];
    const reply = (line) => socket.write(line + '\r\n');
    reply('220 localhost smtp-sink');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const name = `${Date.now()}-${String(seq++).padStart(4, '0')}.eml`;
            writeFileSync(join(dir, name), `X-Envelope-To: ${rcpt.join(', ')}\r\n${data.join('\r\n')}\r\n`);
            data = [];
            rcpt = [];
            reply('250 OK stored');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') reply('250-localhost\r\n250 8BITMIME');
        else if (cmd === 'HELO') reply('250 localhost');
        else if (cmd === 'MAIL') reply('250 OK');
        else if (cmd === 'RCPT') {
          const m = /<([^>]*)>/.exec(line);
          if (m) rcpt.push(m[1].toLowerCase());
          reply('250 OK');
        } else if (cmd === 'DATA') {
          inData = true;
          reply('354 end with <CRLF>.<CRLF>');
        } else if (cmd === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else if (cmd === 'RSET') {
          data = [];
          rcpt = [];
          reply('250 OK');
        } else reply('250 OK');
      }
    });
    socket.on('error', () => {});
  })
  .listen(port, '127.0.0.1');
