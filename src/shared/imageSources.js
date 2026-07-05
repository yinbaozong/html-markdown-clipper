const LAZY_IMAGE_ATTRIBUTES = [
  'data-md-original-src',
  'data-original',
  'data-src',
  'data-srcset',
  'data-actualsrc',
  'data-lazy-src',
  'data-lazy-srcset',
  'data-url',
  'data-original-src',
  'data-orig-file',
  'data-large-file',
  'data-medium-file',
  'data-full-url'
];

const MIME_EXTENSION_MAP = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['image/svg+xml', 'svg'],
  ['image/bmp', 'bmp']
]);

export function getBestImageUrlFromElement(img, baseUrl) {
  if (!img) return '';

  const candidates = [
    img.currentSrc,
    pickLargestPictureSourceCandidate(img),
    pickLargestSrcsetCandidate(img.getAttribute?.('srcset')),
    img.getAttribute?.('src')
  ];

  for (const attr of LAZY_IMAGE_ATTRIBUTES) {
    const value = img.getAttribute?.(attr);
    candidates.push(attr.includes('srcset') ? pickLargestSrcsetCandidate(value) : value);
  }

  const picked = candidates.find((candidate) => candidate && !isPlaceholderImage(candidate));
  return normalizeUrl(picked, baseUrl);
}

function pickLargestPictureSourceCandidate(img) {
  const picture = img?.closest?.('picture');
  if (!picture) return '';

  const sources = Array.from(picture.querySelectorAll('source'));
  const candidates = sources
    .map((source) => {
      return (
        pickLargestSrcsetCandidate(source.getAttribute('srcset')) ||
        pickLargestSrcsetCandidate(source.getAttribute('data-srcset')) ||
        pickLargestSrcsetCandidate(source.getAttribute('data-lazy-srcset'))
      );
    })
    .filter(Boolean);

  return candidates[0] || '';
}

export function pickLargestSrcsetCandidate(srcset) {
  if (!srcset) return '';

  const candidates = String(srcset)
    .split(',')
    .map((part) => {
      const [url, descriptor = '1x'] = part.trim().split(/\s+/);
      const score = descriptor.endsWith('w')
        ? Number.parseFloat(descriptor)
        : Number.parseFloat(descriptor) * 1000;
      return { url, score: Number.isFinite(score) ? score : 0 };
    })
    .filter((candidate) => candidate.url);

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || '';
}

export function normalizeUrl(value, baseUrl) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return trimmed;
  }

  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return '';
  }
}

export function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    const ext = match?.[1]?.toLowerCase();
    return ext === 'jpeg' ? 'jpg' : ext || '';
  } catch {
    return '';
  }
}

export function extensionFromContentType(contentType) {
  const cleanType = String(contentType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSION_MAP.get(cleanType) || '';
}

export function isPlaceholderImage(value) {
  const src = String(value || '').trim();
  return !src || src === '#' || src === 'about:blank' || /^data:image\/(?:gif|svg\+xml)/i.test(src);
}
