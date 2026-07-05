import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { extensionFromUrl, getBestImageUrlFromElement } from './imageSources.js';

export function createHtmlDocument(html, documentFactory) {
  if (documentFactory) {
    return documentFactory(html);
  }

  return new DOMParser().parseFromString(html, 'text/html');
}

export function collectArticleImages(articleHtml, baseUrl, options = {}) {
  const doc = createHtmlDocument(articleHtml, options.documentFactory);
  materializeImageUrlsFromRawHtml(doc, articleHtml, baseUrl);
  const images = Array.from(doc.querySelectorAll('img'));
  const assets = [];
  const seenByUrl = new Map();

  for (const img of images) {
    const sourceUrl = getBestImageUrlFromElement(img, baseUrl);
    if (!sourceUrl) {
      img.removeAttribute('src');
      img.removeAttribute('srcset');
      continue;
    }

    let asset = seenByUrl.get(sourceUrl);
    if (!asset) {
      const index = assets.length + 1;
      const ext = extensionFromUrl(sourceUrl) || 'bin';
      asset = {
        id: `image-${index}`,
        index,
        sourceUrl,
        ext,
        filename: `image${index}.${ext}`,
        localPath: `./assets/image${index}.${ext}`
      };
      seenByUrl.set(sourceUrl, asset);
      assets.push(asset);
    }

    img.setAttribute('data-md-image-id', asset.id);
  }

  return {
    html: doc.body.innerHTML,
    assets
  };
}

function materializeImageUrlsFromRawHtml(doc, articleHtml, baseUrl) {
  const existingUrls = new Set(
    Array.from(doc.querySelectorAll('img'))
      .map((img) => getBestImageUrlFromElement(img, baseUrl))
      .filter(Boolean)
  );

  const rawUrls = extractImageUrlsFromRawHtml(articleHtml, baseUrl).filter((url) => !existingUrls.has(url));

  for (const url of rawUrls) {
    const img = doc.createElement('img');
    img.setAttribute('src', url);
    img.setAttribute('data-md-original-src', url);
    img.setAttribute('alt', '');
    img.setAttribute('data-md-recovered-image', 'true');
    doc.body.append(img);
    existingUrls.add(url);
  }
}

function extractImageUrlsFromRawHtml(articleHtml, baseUrl) {
  const html = decodeHtmlEntities(String(articleHtml || '').replace(/\\\//g, '/'));
  const urls = new Set();
  const attrPattern =
    /\b(?:src|srcset|data-src|data-srcset|data-lazy-src|data-lazy-srcset|data-original|data-orig-file|data-large-file|href)=["']([^"']+)["']/gi;
  const directImagePattern =
    /https?:\/\/[^\s"'<>]+(?:wp-content\/uploads\/|\/uploads\/|\/images\/)[^\s"'<>]+/gi;

  for (const match of html.matchAll(attrPattern)) {
    addImageCandidate(match[1], baseUrl, urls);
  }

  for (const match of html.matchAll(directImagePattern)) {
    addImageCandidate(match[0], baseUrl, urls);
  }

  return Array.from(urls).filter((url) => !isLikelyAdImageUrl(url));
}

function addImageCandidate(value, baseUrl, urls) {
  for (const part of String(value || '').split(',')) {
    const candidate = part.trim().split(/\s+/)[0];
    if (!candidate || candidate.startsWith('data:') || candidate.startsWith('blob:')) continue;

    const url = normalizeImageCandidateUrl(candidate, baseUrl);
    if (url) {
      urls.add(url);
    }
  }
}

function normalizeImageCandidateUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const clean = url.href.replace(/[),.;]+$/g, '');
    if (!isImageLikeUrl(clean)) return '';
    return clean;
  } catch {
    return '';
  }
}

function isImageLikeUrl(url) {
  return (
    /\.(?:avif|webp|png|jpe?g|gif|bmp|svg)(?:[?#].*)?$/i.test(url) ||
    /\/(?:wp-content\/uploads|uploads|images)\//i.test(url)
  );
}

function isLikelyAdImageUrl(url) {
  return /(?:doubleclick|googlesyndication|googleads|adsystem|adservice|adthrive|mediavine|carbonads|\/ads?\/|sponsor|affiliate)/i.test(
    url
  );
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function renderMarkdown(articleHtml, assets, options = {}) {
  const doc = createHtmlDocument(articleHtml, options.documentFactory);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

  doc.querySelectorAll('.toc-anchor').forEach((node) => node.remove());
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const asset = assetsById.get(img.getAttribute('data-md-image-id'));
    if (!asset || asset.failed) {
      continue;
    }

    img.setAttribute('src', asset.localPath);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('data-md-original-src');
    img.removeAttribute('data-md-image-id');
  }

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
  });
  turndown.use(gfm);
  addMarkdownTableRule(turndown);

  turndown.remove(['script', 'style', 'noscript', 'iframe']);

  let markdown = turndown.turndown(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  markdown = replaceRemoteImageLinks(markdown, assets);
  return markdown;
}

function replaceRemoteImageLinks(markdown, assets) {
  let output = markdown;

  for (const asset of assets) {
    if (asset.failed || !asset.localPath) continue;

    const escapedUrl = escapeRegExp(asset.sourceUrl);
    output = output.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${escapedUrl}\\)`, 'g'), `![$1](${asset.localPath})`);
    output = output.replace(new RegExp(`\\[([^\\]]*)\\]\\(${escapedUrl}\\)`, 'g'), `![$1](${asset.localPath})`);
    output = output.replace(new RegExp(escapedUrl, 'g'), asset.localPath);
  }

  return output;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addMarkdownTableRule(turndown) {
  turndown.addRule('completeMarkdownTables', {
    filter: 'table',
    replacement(_content, node) {
      const rows = Array.from(node.querySelectorAll('tr'))
        .map((row) => Array.from(row.children).filter((cell) => /^(td|th)$/i.test(cell.nodeName)))
        .filter((cells) => cells.length > 0);

      if (!rows.length) {
        return '';
      }

      const columnCount = Math.max(...rows.map((row) => row.length));
      const header = normalizeRow(rows[0], columnCount, turndown);
      const body = rows.slice(1).map((row) => normalizeRow(row, columnCount, turndown));
      const separator = Array.from({ length: columnCount }, () => '---');
      const markdownRows = [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`);

      return `\n\n${markdownRows.join('\n')}\n\n`;
    }
  });
}

function normalizeRow(cells, columnCount, turndown) {
  const row = cells.map((cell) => normalizeTableCell(cell, turndown));
  while (row.length < columnCount) {
    row.push('');
  }
  return row;
}

function normalizeTableCell(cell, turndown) {
  const markdown = turndown
    .turndown(cell.innerHTML)
    .replace(/\n{2,}/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();

  return markdown || ' ';
}
