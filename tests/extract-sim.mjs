import { JSDOM } from 'jsdom';
import { extractReadableArticle } from '../src/content/content.js';
import { collectArticleImages, renderMarkdown } from '../src/shared/markdown.js';

await testBambuWiki();
await testZhihuLikePage();
await testWordPressLazyImages();

console.log('正文提取回归测试通过');
console.log('- Bambu Wiki: 未包含侧边栏目录，保留正文标题和 Markdown 表格');
console.log('- Zhihu 专栏: 未包含底部广告/推荐/评论/头像，仅保留正文图片');
console.log('- WordPress 博客: 支持 noscript/图片链接懒加载，过滤广告图');

async function testBambuWiki() {
  const response = await fetch('https://wiki.bambulab.com/zh/x2d/manual/x2d-intro');
  const html = await response.text();
  const sourceDom = new JSDOM(html, {
    url: 'https://wiki.bambulab.com/zh/x2d/manual/x2d-intro'
  });
  const templateContent = sourceDom.window.document
    .querySelector('template[slot="contents"]')
    ?.content?.querySelector('div')?.innerHTML;

  if (!templateContent) {
    throw new Error('Bambu Wiki source content not found');
  }

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>X2D 主要部件介绍 | Bambu Lab Wiki</title></head>
      <body>
        <main>
          <aside class="page-col-sd">
            <div>页面内容</div>
            <div>特色部件：辅助挤出机</div>
            <div>Core-XY 运动系统</div>
          </aside>
          <section class="page-col-content">
            <div class="contents">${templateContent}</div>
          </section>
        </main>
      </body>
    </html>`,
    { url: 'https://wiki.bambulab.com/zh/x2d/manual/x2d-intro' }
  );

  const article = extractReadableArticle(dom.window.document, dom.window.location);
  const markdown = toMarkdown(article, dom.window.document.URL);

  assertIncludes(markdown, '## 特色部件：辅助挤出机', 'Bambu heading should be preserved');
  assertIncludes(markdown, '| ![](./assets/image2.png) | ![](./assets/image3.png) |', 'Bambu image table should be Markdown');
  assertNotIncludes(markdown, '页面内容', 'Bambu side table of contents should be removed');
}

async function testZhihuLikePage() {
  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>用自然掌控云平台：a - 知乎</title></head>
      <body>
        <main>
          <article class="Post-Main">
            <header>
              <h1>用自然掌控云平台：a</h1>
              <div class="AuthorInfo"><img class="Avatar" src="https://pic.example/avatar.jpg">作者信息</div>
            </header>
            <div class="Post-RichTextContainer">
              <p>这是知乎专栏正文第一段，文本足够长，用于模拟真实文章内容，确保精确正文容器会被优先选择。</p>
              <p>这是知乎专栏正文第二段，继续补充正文内容，而不是推荐阅读、评论区域或广告区域。</p>
              <h2>正文小标题</h2>
              <p><img src="https://pic.example/article-1.png" width="640" height="360" alt="正文配图"></p>
              <table><tbody><tr><td>维度</td><td>结果</td></tr><tr><td>正文</td><td>保留</td></tr></tbody></table>
            </div>
            <section class="Comments-container">
              <img src="https://pic.example/comment-avatar.jpg" width="48" height="48">还没有评论，发表第一个评论吧
            </section>
          </article>
          <aside class="Sidebar">
            <div class="AdCard"><img src="https://pic.example/ad.png">阿里云的广告</div>
          </aside>
          <section class="Recommendations-Main">
            <h2>推荐阅读</h2>
            <div><img src="https://pic.example/recommend.png">大语言模型推荐卡片</div>
          </section>
        </main>
      </body>
    </html>`,
    { url: 'https://zhuanlan.zhihu.com/p/2035028875445538817' }
  );

  const article = extractReadableArticle(dom.window.document, dom.window.location);
  const prepared = collectArticleImages(article.content, dom.window.document.URL, {
    documentFactory: (value) => new JSDOM(`<body>${value}</body>`, { url: dom.window.document.URL }).window.document
  });
  const markdown = renderMarkdown(prepared.html, prepared.assets, {
    documentFactory: (value) => new JSDOM(`<body>${value}</body>`, { url: dom.window.document.URL }).window.document
  });

  assertIncludes(markdown, '## 正文小标题', 'Zhihu article heading should be preserved');
  assertIncludes(markdown, '| 维度 | 结果 |', 'Zhihu table should be Markdown');
  assertNotIncludes(markdown, '大语言模型推荐卡片', 'Zhihu recommendation block should be removed');
  assertNotIncludes(markdown, '阿里云的广告', 'Zhihu ad block should be removed');
  assertNotIncludes(markdown, '还没有评论', 'Zhihu comments should be removed');

  if (prepared.assets.length !== 1 || !prepared.assets[0].sourceUrl.endsWith('/article-1.png')) {
    throw new Error(`expected exactly one article image, got ${prepared.assets.map((asset) => asset.sourceUrl).join(', ')}`);
  }
}

async function testWordPressLazyImages() {
  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Propellers for FPV Drones - Oscar Liang</title></head>
      <body>
        <main id="main">
          <article class="post hentry">
            <div class="entry-content">
              <h1>Propellers for FPV Drones</h1>
              <p>This guide explains propeller recommendations, pitch, blade count and practical choices for FPV pilots.</p>
              <p>This paragraph adds enough meaningful article text so the extractor should choose the WordPress entry content container.</p>
              <figure>
                <noscript><img src="https://oscarliang.com/wp-content/uploads/2024/propeller-guide.jpg" alt="Propeller guide"></noscript>
              </figure>
              <div data-gallery='{"image":"https://oscarliang.com/wp-content/uploads/2024/hidden-propeller.webp"}'></div>
              <p><a href="https://oscarliang.com/wp-content/uploads/2024/propeller-table.png"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Propeller table"></a></p>
              <h2 id="Propeller-Recommendations">Propeller Recommendations</h2>
              <p>Recommended propellers depend on motor KV, frame size and battery voltage.</p>
              <div class="adthrive-ad"><img src="https://ads.example/ad.jpg">Advertisement</div>
            </div>
          </article>
        </main>
      </body>
    </html>`,
    { url: 'https://oscarliang.com/propellers/#Propeller-Recommendations' }
  );

  const article = extractReadableArticle(dom.window.document, dom.window.location);
  const prepared = collectArticleImages(article.content, dom.window.document.URL, {
    documentFactory: (value) => new JSDOM(`<body>${value}</body>`, { url: dom.window.document.URL }).window.document
  });
  const markdown = renderMarkdown(prepared.html, prepared.assets, {
    documentFactory: (value) => new JSDOM(`<body>${value}</body>`, { url: dom.window.document.URL }).window.document
  });

  assertIncludes(markdown, '## Propeller Recommendations', 'WordPress heading should be preserved');
  assertNotIncludes(markdown, 'Advertisement', 'WordPress ad block should be removed');

  const urls = prepared.assets.map((asset) => asset.sourceUrl);
  if (urls.length !== 3) {
    throw new Error(`expected three WordPress article images, got ${urls.join(', ')}`);
  }

  assertIncludes(urls.join('\n'), 'propeller-guide.jpg', 'noscript image should be discovered');
  assertIncludes(urls.join('\n'), 'propeller-table.png', 'linked full-size image should be discovered');
  assertIncludes(urls.join('\n'), 'hidden-propeller.webp', 'raw HTML image URL should be discovered');
}

function toMarkdown(article, baseUrl) {
  const prepared = collectArticleImages(article.content, baseUrl, {
    documentFactory: (value) => new JSDOM(`<body>${value}</body>`, { url: baseUrl }).window.document
  });

  return renderMarkdown(prepared.html, prepared.assets, {
    documentFactory: (value) => new JSDOM(`<body>${value}</body>`, { url: baseUrl }).window.document
  });
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(message);
  }
}

function assertNotIncludes(value, expected, message) {
  if (value.includes(expected)) {
    throw new Error(message);
  }
}
