import { Readability } from '@mozilla/readability';
import { getBestImageUrlFromElement } from '../shared/imageSources.js';

const MESSAGE_TYPE = 'HTML_MARKDOWN_EXPORT';
const FETCH_IMAGES_MESSAGE_TYPE = 'HTML_MARKDOWN_FETCH_IMAGES';
const PRECISE_CONTENT_SELECTORS = [
  '.Post-RichTextContainer',
  '.RichContent-inner',
  '.RichText.ztext',
  '[itemprop="articleBody"]',
  '.contents',
  '.markdown-body',
  '.article-content',
  '.post-content',
  '.entry-content',
  '.entry .entry-content',
  '.post .entry-content',
  '.hentry',
  '.site-main article',
  'article'
];

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === FETCH_IMAGES_MESSAGE_TYPE) {
      fetchImagesInPage(message.assets || [])
        .then((images) => {
          sendResponse({ ok: true, images });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });

      return true;
    }

    if (message?.type !== MESSAGE_TYPE) {
      return false;
    }

    extractReadableArticleAfterLazyLoad()
      .then((article) => {
        sendResponse({
          ok: true,
          article
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });

    return true;
  });
}

async function fetchImagesInPage(assets) {
  const results = [];

  for (const asset of assets) {
    try {
      const response = await fetch(asset.sourceUrl, {
        credentials: 'include',
        cache: 'force-cache',
        referrer: location.href
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      results.push({
        ...asset,
        data: Array.from(new Uint8Array(await response.arrayBuffer())),
        dataKind: 'uint8-array',
        contentType: response.headers.get('content-type') || ''
      });
    } catch (error) {
      results.push({
        ...asset,
        failed: true,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}

async function extractReadableArticleAfterLazyLoad() {
  await triggerLazyLoadImages();
  return extractReadableArticle();
}

async function triggerLazyLoadImages() {
  const originalX = window.scrollX;
  const originalY = window.scrollY;
  const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const viewportHeight = Math.max(window.innerHeight || 800, 600);
  const step = Math.max(viewportHeight * 0.9, 500);
  const maxSteps = 30;

  for (let y = 0, count = 0; y < pageHeight && count < maxSteps; y += step, count += 1) {
    window.scrollTo(originalX, y);
    await wait(80);
  }

  window.scrollTo(originalX, originalY);
  await wait(150);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractReadableArticle(sourceDocument = document, sourceLocation = location) {
  const start = performance.now();
  const clonedDocument = sourceDocument.cloneNode(true);
  materializeHiddenImages(clonedDocument);
  preserveResolvedImageSources(clonedDocument, sourceDocument);
  cleanupNoise(clonedDocument);

  const reader = new Readability(clonedDocument, {
    keepClasses: false
  });
  let article = reader.parse();

  if (!article?.content) {
    const fallback = findBestContentElement(sourceDocument);
    if (!fallback) {
      throw new Error('未能提取到正文内容');
    }

    const clonedFallback = fallback.cloneNode(true);
    materializeHiddenImagesInElement(clonedFallback, sourceDocument);
    cleanupNoise(clonedFallback);
    article = {
      title: sourceDocument.title || 'article',
      content: clonedFallback.innerHTML,
      textContent: clonedFallback.textContent || '',
      byline: '',
      excerpt: '',
      siteName: sourceLocation.hostname
    };
  }

  const selectedContent = selectBestArticleContent(article.content, sourceDocument);
  const title = pickArticleTitle(article.title, selectedContent, sourceDocument);

  return {
    title,
    content: selectedContent,
    textContent: article.textContent || '',
    byline: article.byline || '',
    excerpt: article.excerpt || '',
    siteName: article.siteName || sourceLocation.hostname,
    baseUrl: sourceDocument.baseURI || sourceLocation.href,
    pageUrl: sourceLocation.href,
    readabilityMs: performance.now() - start
  };
}

function pickArticleTitle(readabilityTitle, articleHtml, sourceDocument) {
  const template = sourceDocument.createElement('template');
  template.innerHTML = articleHtml || '';

  const candidates = [
    template.content.querySelector('h1')?.textContent,
    sourceDocument.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    sourceDocument.querySelector('meta[name="twitter:title"]')?.getAttribute('content'),
    readabilityTitle,
    sourceDocument.title
  ];

  for (const candidate of candidates) {
    const title = cleanTitle(candidate);
    if (title && !isGeneratedId(title)) {
      return title;
    }
  }

  return 'article';
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s*[-_|]\s*(知乎|Bambu Lab Wiki|CSDN博客|博客园|掘金|简书).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGeneratedId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function preserveResolvedImageSources(clonedDocument, sourceDocument) {
  const originalImages = Array.from(sourceDocument.images);
  const clonedImages = Array.from(clonedDocument.images);

  clonedImages.forEach((clonedImg, index) => {
    if (clonedImg.getAttribute('data-md-original-src')) return;

    const originalImg = originalImages[index];
    const sourceUrl = getBestImageUrlFromElement(originalImg || clonedImg, sourceDocument.baseURI);
    if (!sourceUrl) return;

    clonedImg.setAttribute('data-md-original-src', sourceUrl);
    clonedImg.setAttribute('src', sourceUrl);
    clonedImg.removeAttribute('srcset');
  });
}

function materializeHiddenImages(rootDocument) {
  rootDocument.querySelectorAll('noscript').forEach((noscript) => {
    const html = noscript.innerHTML || noscript.textContent || '';
    if (!/<img|<picture/i.test(html)) return;

    const template = rootDocument.createElement('template');
    template.innerHTML = html;
    const hiddenImages = Array.from(template.content.querySelectorAll('img'));
    if (!hiddenImages.length) return;

    const parent = noscript.parentElement;
    const parentAlreadyHasImage = parent?.querySelector?.('img');

    for (const hiddenImage of hiddenImages) {
      const sourceUrl = getBestImageUrlFromElement(hiddenImage, rootDocument.baseURI);
      if (!sourceUrl) continue;

      if (parentAlreadyHasImage) {
        parentAlreadyHasImage.setAttribute('data-md-original-src', sourceUrl);
      } else {
        const img = rootDocument.createElement('img');
        img.setAttribute('src', sourceUrl);
        img.setAttribute('data-md-original-src', sourceUrl);
        img.setAttribute('alt', hiddenImage.getAttribute('alt') || '');
        noscript.before(img);
      }
    }
  });

  rootDocument.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (!/\.(?:avif|webp|png|jpe?g|gif|bmp|svg)(?:[?#].*)?$/i.test(href)) return;

    const image = link.querySelector('img');
    if (image) {
      image.setAttribute('data-md-original-src', new URL(href, rootDocument.baseURI).href);
      return;
    }

    const text = (link.textContent || '').trim();
    if (text && text.length > 80) return;

    const img = rootDocument.createElement('img');
    img.setAttribute('src', new URL(href, rootDocument.baseURI).href);
    img.setAttribute('data-md-original-src', new URL(href, rootDocument.baseURI).href);
    img.setAttribute('alt', text);
    link.replaceWith(img);
  });
}

function materializeHiddenImagesInElement(root, sourceDocument) {
  root.querySelectorAll('noscript').forEach((noscript) => {
    const html = noscript.innerHTML || noscript.textContent || '';
    if (!/<img|<picture/i.test(html)) return;

    const template = sourceDocument.createElement('template');
    template.innerHTML = html;
    const hiddenImages = Array.from(template.content.querySelectorAll('img'));

    for (const hiddenImage of hiddenImages) {
      const sourceUrl = getBestImageUrlFromElement(hiddenImage, sourceDocument.baseURI);
      if (!sourceUrl) continue;

      const img = sourceDocument.createElement('img');
      img.setAttribute('src', sourceUrl);
      img.setAttribute('data-md-original-src', sourceUrl);
      img.setAttribute('alt', hiddenImage.getAttribute('alt') || '');
      noscript.before(img);
    }
  });

  root.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (!/\.(?:avif|webp|png|jpe?g|gif|bmp|svg)(?:[?#].*)?$/i.test(href)) return;

    const fullUrl = new URL(href, sourceDocument.baseURI).href;
    const image = link.querySelector('img');
    if (image) {
      image.setAttribute('src', fullUrl);
      image.setAttribute('data-md-original-src', fullUrl);
      image.removeAttribute('srcset');
      return;
    }

    const text = (link.textContent || '').trim();
    if (text && text.length > 80) return;

    const img = sourceDocument.createElement('img');
    img.setAttribute('src', fullUrl);
    img.setAttribute('data-md-original-src', fullUrl);
    img.setAttribute('alt', text);
    link.replaceWith(img);
  });
}

export function selectBestArticleContent(readabilityContent, sourceDocument = document) {
  const readabilityStats = getContentStatsFromHtml(readabilityContent, sourceDocument);
  const candidate = findBestContentElement(sourceDocument);

  if (!candidate) {
    return readabilityContent;
  }

  const candidateStats = getContentStats(candidate);
  const hasUsefulTableGain = candidateStats.tables > readabilityStats.tables;
  const hasUsefulHeadingGain = candidateStats.headings >= readabilityStats.headings + 1;
  const hasEnoughText = candidateStats.textLength >= Math.max(120, readabilityStats.textLength * 0.55);
  const isPreciseContent = candidate.matches(PRECISE_CONTENT_SELECTORS.join(','));

  if (hasEnoughText && (isPreciseContent || hasUsefulTableGain || hasUsefulHeadingGain)) {
    const cloned = candidate.cloneNode(true);
    materializeHiddenImagesInElement(cloned, sourceDocument);
    cleanupNoise(cloned);
    return cloned.innerHTML;
  }

  const template = sourceDocument.createElement('template');
  template.innerHTML = readabilityContent;
  cleanupNoise(template.content);
  return template.innerHTML;
}

export function findBestContentElement(sourceDocument = document) {
  const broadSelectors = [
    'main article',
    'main'
  ];

  const preferred = pickBestCandidate(PRECISE_CONTENT_SELECTORS, sourceDocument);
  if (preferred) {
    return preferred;
  }

  return pickBestCandidate(broadSelectors, sourceDocument);
}

function pickBestCandidate(selectors, sourceDocument) {
  const candidates = selectors.flatMap((selector) => Array.from(sourceDocument.querySelectorAll(selector)));
  let best = null;
  let bestScore = 0;

  for (const element of candidates) {
    const stats = getContentStats(element);
    const score = stats.textLength + stats.headings * 250 + stats.tables * 500 + stats.images * 80;
    if (stats.textLength >= 120 && score > bestScore) {
      best = element;
      bestScore = score;
    }
  }

  return best;
}

function getContentStatsFromHtml(html, sourceDocument = document) {
  const template = sourceDocument.createElement('template');
  template.innerHTML = html || '';
  return getContentStats(template.content);
}

function getContentStats(root) {
  const textLength = (root.textContent || '').replace(/\s+/g, '').length;
  return {
    textLength,
    headings: root.querySelectorAll?.('h1,h2,h3,h4,h5,h6').length || 0,
    tables: root.querySelectorAll?.('table').length || 0,
    images: root.querySelectorAll?.('img').length || 0
  };
}

function cleanupNoise(root) {
  root
    .querySelectorAll(
      [
        'script',
        'style',
        'noscript',
        'iframe',
        'nav',
        'aside',
        'form',
        'button',
        '[role="complementary"]',
        '[aria-label*="目录"]',
        '[aria-label*="推荐"]',
        '[class*="Sidebar"]',
        '[class*="side-bar"]',
        '[class*="Recommend"]',
        '[class*="recommend"]',
        '[class*="Related"]',
        '[class*="related"]',
        '[class*="Comments"]',
        '[class*="Comment"]',
        '[class*="comment"]',
        '[class*="Ad"]',
        '[class*="advert" i]',
        '[class*="adsby" i]',
        '[class*="adthrive" i]',
        '[class*="mediavine" i]',
        '[class*="sponsor" i]',
        '[class*="promo" i]',
        '[class*="affiliate" i]',
        '[id*="advert" i]',
        '[id*="adsby" i]',
        '[id*="adthrive" i]',
        '[id*="mediavine" i]',
        '[id*="sponsor" i]',
        '[data-ad]',
        '[data-ad-client]',
        'ins.adsbygoogle',
        '[data-za-detail-view-path-module="RecommendItem"]',
        '.toc-anchor',
        '.page-col-sd',
        '.page-edit-shortcuts',
        '.comments-container',
        '.v-navigation-drawer',
        '.Catalog',
        '.ez-toc-container',
        '#ez-toc-container',
        '.toc',
        '.table-of-contents',
        '.post-navigation',
        '.nav-links',
        '.previous-post',
        '.next-post',
        '.related-posts',
        '.yarpp-related',
        '.Post-SideActions',
        '.Post-Sub',
        '.Post-Topics',
        '.Post-NormalSub',
        '.Post-Author',
        '.AuthorInfo',
        '.Recommendations-Main',
        '.TopstoryItem'
      ].join(',')
    )
    .forEach((node) => node.remove());

  removeLikelyNoiseByText(root);
  removeTinyNonContentImages(root);
  truncateAtPostNavigation(root);
}

function removeLikelyNoiseByText(root) {
  const patterns = [
    /推荐阅读/,
    /还没有评论/,
    /发表第一个评论/,
    /关于作者/,
    /广告/,
    /立即购买/,
    /相关推荐/,
    /热门内容/,
    /sponsored/i,
    /advertisement/i,
    /affiliate disclosure/i
  ];

  root.querySelectorAll('section,div,footer').forEach((node) => {
    const text = (node.textContent || '').replace(/\s+/g, '');
    const hasContentSignals = Boolean(node.querySelector('h1,h2,h3,h4,h5,h6,table,img,pre,blockquote'));
    if (!hasContentSignals && text && text.length < 500 && patterns.some((pattern) => pattern.test(text))) {
      node.remove();
    }
  });
}

function removeTinyNonContentImages(root) {
  root.querySelectorAll('img').forEach((img) => {
    const width = Number(img.getAttribute('width') || img.naturalWidth || 0);
    const height = Number(img.getAttribute('height') || img.naturalHeight || 0);
    const className = img.className || '';
    const alt = img.getAttribute('alt') || '';

    if (/avatar|logo|badge|icon|ad/i.test(`${className} ${alt}`)) {
      img.remove();
      return;
    }

    if (width > 0 && height > 0 && Math.max(width, height) <= 96) {
      img.remove();
    }
  });
}

function truncateAtPostNavigation(root) {
  const markers = [/^previous post$/i, /^next post$/i, /^related posts?$/i, /^recommended posts?$/i, /^you may also like$/i];

  for (const node of Array.from(root.querySelectorAll('h2,h3,h4,p,div,span'))) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!markers.some((pattern) => pattern.test(text))) continue;

    let current = node;
    while (current && current.parentNode && current.parentNode !== root) {
      current = current.parentNode;
    }

    if (!current || !current.parentNode) {
      continue;
    }

    let sibling = current;
    while (sibling) {
      const next = sibling.nextSibling;
      sibling.remove();
      sibling = next;
    }
    break;
  }
}
