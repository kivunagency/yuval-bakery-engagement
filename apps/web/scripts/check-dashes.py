#!/usr/bin/env python3
"""Usage: check-dashes.py [path ...]  (default: whole repo)
Fail if any tracked text file under the given paths contains an em-dash (U+2014) or en-dash (U+2013).
Project rule: no em-dash or en-dash anywhere. Prints file:line for each hit."""
import pathlib, subprocess, sys

root = pathlib.Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
paths = sys.argv[1:] or ['.']
files = subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '--', *paths], cwd=root, text=True).split('\n')
skip_ext = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.pdf', '.zip'}
hits = 0
for rel in filter(None, files):
    p = root / rel
    if p.suffix.lower() in skip_ext or not p.is_file() or 'node_modules' in p.parts:
        continue
    try:
        text = p.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError):
        continue
    for n, line in enumerate(text.splitlines(), 1):
        if '\u2014' in line or '\u2013' in line:
            hits += 1
            print(f'{rel}:{n}')
print(f'em/en-dash hits: {hits}')
sys.exit(1 if hits else 0)
