import { extensionFromContentType } from './imageSources.js';

export async function downloadImages(assets, options = {}) {
  const concurrency = options.concurrency || 6;
  const fetcher = options.fetcher || fetch;
  const pageUrl = options.pageUrl || '';
  const results = new Array(assets.length);
  let cursor = 0;

  async function worker() {
    while (cursor < assets.length) {
      const currentIndex = cursor;
      cursor += 1;
      const asset = assets[currentIndex];

      try {
        const response = await fetcher(asset.sourceUrl, {
          credentials: 'include',
          cache: 'force-cache',
          referrer: pageUrl || undefined
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const ext = extensionFromContentType(contentType) || asset.ext || 'bin';
        const filename = `image${asset.index}.${ext}`;
        const data = await response.arrayBuffer();

        results[currentIndex] = {
          ...asset,
          ext,
          filename,
          localPath: `./assets/${filename}`,
          zipPath: `assets/${filename}`,
          contentType,
          data
        };
      } catch (error) {
        results[currentIndex] = {
          ...asset,
          failed: true,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }

  const workerCount = Math.min(concurrency, assets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
