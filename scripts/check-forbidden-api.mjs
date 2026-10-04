#!/usr/bin/env node
// Fails when src/ references Chromium-only APIs or remote resources.
// Firefox is the only target (PLAN.md §0.1) and the runtime must never hit the network (§0.2).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = ['src', 'index.html'];
const FORBIDDEN = [
  { re: /showDirectoryPicker|showOpenFilePicker|showSaveFilePicker/, why: 'File System Access API is Chromium-only' },
  { re: /FileSystemHandle\.requestPermission|queryPermission\(/, why: 'Chromium-only permission API' },
  { re: /navigator\.storage\.getDirectory/, why: 'OPFS not used (decision Q4-A)' },
  { re: /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"`)]+\.(?:js|css|woff2?|ttf|otf|png|svg|json)\b/, why: 'remote asset URL' },
  { re: /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/, why: 'CDN / web font' },
  { re: /\bfetch\(|new XMLHttpRequest|navigator\.sendBeacon|new WebSocket\(|new EventSource\(/, why: 'runtime network call' },
  { re: /\b(?:src|href)\s*=\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/, why: 'remote src/href in markup' },
  { re: /@import\s+url\(\s*['"]?https?:/, why: 'remote CSS import' },
];

const files = [];
function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) for (const c of readdirSync(p)) walk(join(p, c));
  else if (/\.(tsx?|jsx?|css|html)$/.test(p)) files.push(p);
}
for (const s of SCAN) walk(join(ROOT, s));

let bad = 0;
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) {
        bad++;
        console.error(`${relative(ROOT, f)}:${i + 1}: ${why}\n    ${line.trim()}`);
      }
    }
  });
}
if (bad) {
  console.error(`\n${bad} forbidden reference(s). See PLAN.md §0.`);
  process.exit(1);
}
console.log(`check:api ok (${files.length} files scanned)`);
