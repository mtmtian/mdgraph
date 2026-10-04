import { strToU8, zip, zipSync } from 'fflate';

export interface ExportFile {
  path: string;
  text: string;
}

/** Above this many files the async (worker-backed) zip is used to avoid blocking the UI. */
const SYNC_ZIP_LIMIT = 200;

/**
 * Build a zip with paths preserved. Text is encoded as UTF-8 as-is; a leading
 * U+FEFF is kept (the export layer never adds or removes a BOM).
 */
export function buildZip(files: ExportFile[]): Promise<Uint8Array> {
  const data: Record<string, Uint8Array> = {};
  for (const f of files) data[f.path] = strToU8(f.text);
  if (files.length <= SYNC_ZIP_LIMIT) {
    return Promise.resolve(zipSync(data));
  }
  return new Promise((resolve, reject) => {
    zip(data, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  // Firefox only honours click() on anchors that are attached to the document.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a later task so the download has started before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMarkdown(path: string, text: string): void {
  const name = path.split('/').pop() || path;
  downloadBlob(name, new Blob([strToU8(text).slice()], { type: 'text/markdown;charset=utf-8' }));
}

export async function downloadZip(filename: string, files: ExportFile[]): Promise<void> {
  const bytes = await buildZip(files);
  downloadBlob(filename, new Blob([bytes.slice()], { type: 'application/zip' }));
}
