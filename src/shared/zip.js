import JSZip from 'jszip';
import { sanitizeFileName, withExtension } from './fileNames.js';

export async function createMarkdownZip(payload, options = {}) {
  const zip = new JSZip();
  const safeTitle = sanitizeFileName(payload.title, 'article', 10);
  const markdownName = withExtension(safeTitle, 'md');

  zip.file(markdownName, payload.markdown);

  for (const image of payload.images) {
    if (image.failed || !image.data) continue;
    zip.file(image.zipPath || `assets/${image.filename}`, image.data, {
      binary: true,
      compression: 'STORE'
    });
  }

  const type = options.type || 'blob';
  const zipData = await zip.generateAsync({
    type,
    compression: 'STORE'
  });

  return {
    fileName: withExtension(safeTitle, 'zip'),
    markdownName,
    zipData
  };
}
