import { Readability } from '@mozilla/readability';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { collectArticleImages, renderMarkdown } from '../src/shared/markdown.js';
import { downloadImages } from '../src/shared/downloadImages.js';
import { createMarkdownZip } from '../src/shared/zip.js';
import { average, formatMs } from '../src/shared/performance.js';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);

const imageCount = Number(args.get('images') || 10);
const rounds = Number(args.get('rounds') || 5);
const articleText = createParagraphs(12);

const parseDurations = [];
const imageDurations = [];
const zipDurations = [];
let lastZipBuffer;
let lastMarkdown;
let lastImages;

for (let round = 0; round < rounds; round += 1) {
  const html = createMockArticleHtml(imageCount);
  const dom = new JSDOM(html, { url: 'https://example.test/posts/readability-demo' });
  const readabilityStart = performance.now();
  const article = new Readability(dom.window.document.cloneNode(true)).parse();
  const prepared = collectArticleImages(article.content, dom.window.document.URL, {
    documentFactory: createJsdomDocument
  });
  const readabilityDuration = performance.now() - readabilityStart;

  const imageStart = performance.now();
  const downloadedImages = await downloadImages(prepared.assets, {
    concurrency: 6,
    fetcher: mockImageFetch
  });
  const imageDuration = performance.now() - imageStart;

  const markdownStart = performance.now();
  const markdown = renderMarkdown(prepared.html, downloadedImages, {
    documentFactory: createJsdomDocument
  });
  const parseDuration = readabilityDuration + (performance.now() - markdownStart);

  const zipStart = performance.now();
  const { zipData } = await createMarkdownZip(
    {
      title: article.title,
      markdown,
      images: downloadedImages
    },
    { type: 'nodebuffer' }
  );
  const zipDuration = performance.now() - zipStart;

  parseDurations.push(parseDuration);
  imageDurations.push(imageDuration);
  zipDurations.push(zipDuration);
  lastZipBuffer = zipData;
  lastMarkdown = markdown;
  lastImages = downloadedImages;

}

await verifyZip(lastZipBuffer, imageCount);
verifyMarkdown(lastMarkdown, lastImages);

const avgParse = average(parseDurations);
const avgImage = average(imageDurations);
const avgZip = average(zipDurations);
const avgTotal = avgParse + avgImage + avgZip;

console.log('模拟测试报告');
console.log(`页面规模：正文文本 + ${imageCount} 张图片`);
console.log(`测试轮次：${rounds}`);
console.log(`平均解析耗时：${formatMs(avgParse)}`);
console.log(`图片下载并发耗时：${formatMs(avgImage)}`);
console.log(`打包耗时：${formatMs(avgZip)}`);
console.log(`预计总响应时间：${formatMs(avgTotal)}`);
console.log('结果：生成 ZIP 成功，Markdown 图片链接全部指向 ./assets/');

function createMockArticleHtml(count) {
  const images = Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return `<figure><img src="/images/source-${number}.png" alt="示例图片 ${number}"><figcaption>示例图片 ${number}</figcaption></figure>`;
  }).join('\n');

  return `<!doctype html>
    <html lang="zh-CN">
      <head><title>模拟文章：Markdown 导出测试</title></head>
      <body>
        <nav>导航内容应被 Readability 排除</nav>
        <main>
          <article>
            <h1>模拟文章：Markdown 导出测试</h1>
            ${articleText}
            ${images}
            <table>
              <tbody>
                <tr><td>序号</td><td>名称</td><td>作用</td></tr>
                <tr><td>1</td><td>加热区</td><td>加热表面</td></tr>
                <tr><td>2</td><td>打印板定位平行块</td><td>辅助打印板放置</td></tr>
              </tbody>
            </table>
          </article>
        </main>
        <aside>广告内容应被排除</aside>
      </body>
    </html>`;
}

function createParagraphs(count) {
  return Array.from({ length: count }, (_, index) => {
    return `<p>这是用于测速的正文段落 ${index + 1}。它模拟博客、知乎或 CSDN 中的长正文内容，用来触发 Readability 和 Turndown 的真实转换流程。</p>`;
  }).join('\n');
}

function createJsdomDocument(html) {
  return new JSDOM(`<body>${html}</body>`, {
    url: 'https://example.test/posts/readability-demo'
  }).window.document;
}

async function mockImageFetch(url) {
  const match = String(url).match(/source-(\d+)\.png$/);
  const imageNumber = Number(match?.[1] || 1);
  const latency = 18 + (imageNumber % 5) * 7;
  await new Promise((resolve) => setTimeout(resolve, latency));

  const bytes = new Uint8Array(1024 * 12);
  bytes.fill(imageNumber);

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/png'
    }
  });
}

async function verifyZip(zipBuffer, expectedImageCount) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const markdownFiles = files.filter((name) => name.endsWith('.md'));
  const imageFiles = files.filter((name) => name.startsWith('assets/image'));

  if (markdownFiles.length !== 1) {
    throw new Error(`expected one Markdown file, got ${markdownFiles.length}`);
  }

  if (imageFiles.length !== expectedImageCount) {
    throw new Error(`expected ${expectedImageCount} images, got ${imageFiles.length}`);
  }
}

function verifyMarkdown(markdown, images) {
  for (const image of images) {
    if (!markdown.includes(`./assets/${image.filename}`)) {
      throw new Error(`missing local image path for ${image.filename}`);
    }
  }

  if (!markdown.includes('| 序号 | 名称 | 作用 |')) {
    throw new Error('missing Markdown table header');
  }

  if (!markdown.includes('| --- | --- | --- |')) {
    throw new Error('missing Markdown table separator');
  }
}
