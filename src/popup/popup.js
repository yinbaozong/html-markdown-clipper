import './popup.css';
import { collectArticleImages, renderMarkdown } from '../shared/markdown.js';
import { downloadImages } from '../shared/downloadImages.js';
import { createMarkdownZip } from '../shared/zip.js';
import { durationSince, formatMs, now } from '../shared/performance.js';

const MESSAGE_TYPE = 'HTML_MARKDOWN_EXPORT';
const FETCH_IMAGES_MESSAGE_TYPE = 'HTML_MARKDOWN_FETCH_IMAGES';
const IMAGE_CONCURRENCY = 6;

const sniffBtn = document.querySelector('#sniffBtn');
const downloadBtn = document.querySelector('#downloadBtn');
const statusPill = document.querySelector('#statusPill');
const imageCount = document.querySelector('#imageCount');
const parseMs = document.querySelector('#parseMs');
const imageMs = document.querySelector('#imageMs');
const zipMs = document.querySelector('#zipMs');
const message = document.querySelector('#message');

let pendingExport = null;
let pendingTabId = null;

sniffBtn.addEventListener('click', () => {
  sniffArticle().catch((error) => {
    setStatus('失败', 'error');
    setMessage(error instanceof Error ? error.message : String(error));
    sniffBtn.disabled = false;
  });
});

downloadBtn.addEventListener('click', () => {
  runExport().catch((error) => {
    setStatus('失败', 'error');
    setMessage(error instanceof Error ? error.message : String(error));
    downloadBtn.disabled = false;
    sniffBtn.disabled = false;
  });
});

async function sniffArticle() {
  sniffBtn.disabled = true;
  downloadBtn.disabled = true;
  pendingExport = null;
  setStatus('嗅探中', 'busy');
  setMessage('正在提取正文...');
  resetMetrics();

  const tab = await getActiveTab();
  pendingTabId = tab.id;
  const response = await requestArticle(tab.id);
  if (!response.ok) {
    throw new Error(response.error || '正文提取失败');
  }

  const article = response.article;
  const prepared = collectArticleImages(article.content, article.baseUrl);
  pendingExport = { article, prepared };
  imageCount.textContent = `${prepared.assets.length} 张`;
  parseMs.textContent = formatMs(article.readabilityMs || 0);
  setStatus('待确认');
  setMessage(`标题：${article.title || 'article'}。嗅探到 ${prepared.assets.length} 张正文图片，请确认数量后下载。`);
  sniffBtn.disabled = false;
  downloadBtn.disabled = false;
}

async function runExport() {
  if (!pendingExport) {
    await sniffArticle();
  }

  if (!pendingExport) {
    throw new Error('请先嗅探正文和图片');
  }

  downloadBtn.disabled = true;
  sniffBtn.disabled = true;
  setStatus('处理中', 'busy');

  const { article, prepared } = pendingExport;

  setMessage(`已提取正文，发现 ${prepared.assets.length} 张正文图片，开始并发下载...`);
  const imageStart = now();
  const downloadedImages = await downloadImagesViaPage(pendingTabId, prepared.assets, article.pageUrl);
  const finalImages = await retryFailedImages(downloadedImages, article.pageUrl);
  const imageDuration = durationSince(imageStart);
  imageMs.textContent = formatMs(imageDuration);

  const failedImages = finalImages.filter((image) => image.failed);

  setMessage(
    failedImages.length
      ? `图片抓取完成，成功 ${finalImages.length - failedImages.length} 张，失败 ${failedImages.length} 张，开始打包...`
      : `图片抓取完成，成功 ${finalImages.length} 张，开始打包...`
  );

  const markdownStart = now();
  const markdown = renderMarkdown(prepared.html, finalImages);
  const markdownDuration = durationSince(markdownStart);
  parseMs.textContent = formatMs((article.readabilityMs || 0) + markdownDuration);

  setMessage('正在生成 ZIP...');
  const zipStart = now();
  const zipResult = await createMarkdownZip({
    title: article.title,
    markdown: buildMarkdownDocument(article, markdown),
    images: finalImages
  });
  const zipDuration = durationSince(zipStart);
  zipMs.textContent = formatMs(zipDuration);

  await downloadBlob(zipResult.zipData, zipResult.fileName);

  const successImages = finalImages.length - failedImages.length;
  setStatus('完成');
  setMessage(
    failedImages.length
      ? `下载完成：${zipResult.fileName}。成功 ${successImages} 张，失败 ${failedImages.length} 张，失败图片保留原始链接。`
      : `下载完成：${zipResult.fileName}，图片 ${successImages} 张。`
  );
  downloadBtn.disabled = false;
  sniffBtn.disabled = false;
}

async function retryFailedImages(images, pageUrl) {
  const failed = images.filter((image) => image.failed);
  if (!failed.length) {
    return images;
  }

  const retried = await downloadImages(failed, {
    concurrency: IMAGE_CONCURRENCY,
    pageUrl
  });

  const retriedByUrl = new Map(retried.map((image) => [image.sourceUrl, image]));
  return images.map((image) => {
    if (!image.failed) return image;
    return retriedByUrl.get(image.sourceUrl) || image;
  });
}

async function downloadImagesViaPage(tabId, assets, pageUrl) {
  if (!tabId || !assets.length) {
    return [];
  }

  try {
    const response = await sendMessage(tabId, {
      type: FETCH_IMAGES_MESSAGE_TYPE,
      assets
    });

    if (!response?.ok) {
      throw new Error(response?.error || '页面内图片抓取失败');
    }

    return response.images.map((image) => normalizeDownloadedImage(image));
  } catch {
    return downloadImages(assets, {
      concurrency: IMAGE_CONCURRENCY,
      pageUrl
    });
  }
}

function normalizeDownloadedImage(image) {
  if (image.failed || !image.data) {
    return image;
  }

  const data = normalizeBinaryData(image.data);
  if (!data) {
    return {
      ...image,
      failed: true,
      error: '图片二进制数据格式无效'
    };
  }

  return {
    ...image,
    data,
    zipPath: image.zipPath || `assets/${image.filename}`
  };
}

function normalizeBinaryData(data) {
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }

  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (ArrayBuffer.isView(data)) {
    return data;
  }

  if (data?.buffer instanceof ArrayBuffer) {
    return data.buffer;
  }

  return null;
}

async function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    await chrome.downloads.download({
      url,
      filename: fileName,
      saveAs: true,
      conflictAction: 'uniquify'
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function buildMarkdownDocument(article, markdown) {
  const title = article.title?.trim();
  const heading = title ? `# ${title}\n\n` : '';
  const source = article.pageUrl ? `> 来源：${article.pageUrl}\n\n` : '';
  return `${heading}${source}${markdown}`;
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        reject(new Error('未找到当前标签页'));
        return;
      }
      resolve(tab);
    });
  });
}

async function requestArticle(tabId) {
  try {
    return await sendMessage(tabId);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['assets/content.js']
    });
    return sendMessage(tabId);
  }
}

function sendMessage(tabId, message = { type: MESSAGE_TYPE }) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function resetMetrics() {
  imageCount.textContent = '-';
  parseMs.textContent = '-';
  imageMs.textContent = '-';
  zipMs.textContent = '-';
}

function setStatus(text, state = '') {
  statusPill.textContent = text;
  statusPill.className = `status-pill ${state}`.trim();
}

function setMessage(text) {
  message.textContent = text;
}
