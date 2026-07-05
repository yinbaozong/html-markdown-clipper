const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFileName(value, fallback = 'article', maxLength = 80) {
  const normalized = String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/[^\p{L}\p{N}\s._-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  if (!normalized || RESERVED_WINDOWS_NAMES.test(normalized)) {
    return fallback;
  }

  return normalized;
}

export function withExtension(fileName, extension) {
  const cleanExtension = String(extension || '').replace(/^\./, '');
  return cleanExtension ? `${fileName}.${cleanExtension}` : fileName;
}
