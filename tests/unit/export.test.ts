// @vitest-environment jsdom
import { unzipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildZip, downloadBlob, downloadMarkdown, downloadZip } from '../../src/fs/export.ts';

// Arrays, not Uint8Array identity: jsdom and fflate may come from different realms.
const arr = (u: Uint8Array) => Array.from(u);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const SAMPLES = [
  { path: 'pages/basic.md', text: '- a\n  - b\n' },
  { path: 'pages/bom.md', text: '﻿- with bom\n' },
  { path: 'pages/crlf.md', text: '- one\r\n- two\r\n' },
  { path: 'pages/ns%2Fchild.md', text: '- 中文 内容 😀\n' },
  { path: 'pages/empty.md', text: '' },
];

describe('buildZip', () => {
  it('round-trips bytes exactly, keeping BOM and CRLF', async () => {
    const out = unzipSync(await buildZip(SAMPLES));
    expect(Object.keys(out).sort()).toEqual(SAMPLES.map((s) => s.path).sort());
    for (const s of SAMPLES) expect(arr(out[s.path])).toEqual(arr(strToU8(s.text)));
    expect(Array.from(out['pages/bom.md'].slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('uses the async path above 200 files and still round-trips', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `p/${i}.md`, text: `- ${i}\n` }));
    const out = unzipSync(await buildZip(many));
    expect(Object.keys(out)).toHaveLength(201);
    expect(arr(out['p/200.md'])).toEqual(arr(strToU8('- 200\n')));
  });

  it('builds an empty zip', async () => {
    expect(Object.keys(unzipSync(await buildZip([])))).toEqual([]);
  });
});

describe('downloads', () => {
  function stubUrl() {
    const create = vi.fn(() => 'blob:mock');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    return { create, revoke, clicks };
  }

  it('downloadBlob clicks an anchor with download attr, then revokes the URL', () => {
    vi.useFakeTimers();
    const { create, revoke, clicks } = stubUrl();
    const blob = new Blob(['x']);
    downloadBlob('a.md', blob);
    expect(create).toHaveBeenCalledWith(blob);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('a.md');
    expect(clicks[0].getAttribute('href')).toBe('blob:mock');
    expect(document.querySelector('a')).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:mock');
  });

  it('downloadMarkdown uses the base name and preserves the BOM bytes', async () => {
    const { create, clicks } = stubUrl();
    downloadMarkdown('pages/bom.md', '﻿- x\r\n');
    expect(clicks[0].download).toBe('bom.md');
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0xef, 0xbb, 0xbf, 0x2d, 0x20, 0x78, 0x0d, 0x0a]);
  });

  it('downloadZip downloads a zip blob that unzips back', async () => {
    const { create, clicks } = stubUrl();
    await downloadZip('graph.zip', SAMPLES);
    expect(clicks[0].download).toBe('graph.zip');
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('application/zip');
    const out = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(arr(out['pages/crlf.md'])).toEqual(arr(strToU8('- one\r\n- two\r\n')));
  });
});
