import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECP_URL = 'https://www.secp.gov.pk/document/digital-lending-apps-being-run-and-administered-by-duly-licensed-lending-nbfcs/';

const NEWS_SOURCES = [
  { name: 'SECP Official', url: 'https://www.secp.gov.pk/news/', type: 'official' },
  { name: 'ProPakistani', url: 'https://propakistani.pk/', type: 'media' },
  { name: 'Pakistan Today Profit', url: 'https://profit.pakistantoday.com.pk/', type: 'media' },
  { name: 'TechJuice', url: 'https://techjuice.pk/', type: 'media' },
  { name: 'Dawn', url: 'https://www.dawn.com/', type: 'media' }
];

const KEYWORDS = [
  'digital lending', 'nano lending', 'micro lending', 'microfinance',
  'NBFC', 'SECP', 'State Bank', 'SBP', 'central bank',
  'fintech', 'digital finance', 'digital banking',
  'BNPL', 'buy now pay later', 'EWA', 'earned wage access',
  'digital payment', 'mobile money', 'e-wallet', 'cashless',
  'credit', 'loan', 'lending', 'financing', 'payday',
  'regulation', 'policy', 'license', 'licensee', 'compliance',
  'interest rate', 'APR', 'usury',
  'Pakistan', 'Karachi', 'Lahore', 'Islamabad'
];

const PRESERVED_NOTES = {
    "paisayaar": "金果",
    "aitemaad": "萨摩耶",
    "hakeem": "LOCAL",
    "fauricash": "迈步",
    "smartqarza": "快牛",
    "jazzcash": "local",
    "moneytap": "致鑫",
    "pakcredit": "众志诚",
    "daira": "拍拍贷",
    "loanlado": "上海瑾灿",
    "sahara": "金格方",
    "paisaghur": "成都博问",
    "qarzmitra": "武汉 老板薛磊 cash代运营"
  };

const COLORS = ["#2ecc71","#27ae60","#1abc9c","#16a085","#e74c3c","#c0392b","#3498db","#2980b9","#0984e3","#6c5ce7","#0652DD","#ffc312","#009432","#38ada9","#00b894","#d63031","#e17055","#2d3436"];

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

const MAX_NEWS_PER_SOURCE = 8;
const MAX_ARTICLE_FETCH = 20;
const RECENCY_DAYS = 14;

async function main() {
    console.log('SECP Auto-Updater Started:', new Date().toISOString());

  const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

  try {
      const [whitelistResult, newsItems] = await Promise.all([
        scrapeWhitelist(browser),
        scrapeNewsFromSources(browser)
      ]);

      if (newsItems && newsItems.length > 0) {
        const existingNews = loadExistingNews();
        const filteredNews = deduplicateNews(newsItems, existingNews);
        
        if (filteredNews.length > 0) {
          const analyzedNews = await analyzeNewsWithAI(filteredNews);
          const relevantNews = analyzedNews.filter(n => n.relevanceScore >= 0.60);
          console.log(`Filtered ${analyzedNews.length - relevantNews.length} low-relevance articles`);
          saveNews([...relevantNews, ...existingNews].slice(0, 20));
        } else {
          console.log('No new news found');
        }
      }

      if (whitelistResult && whitelistResult.apps && whitelistResult.apps.nanoApps.length > 0) {
        const oldApps = loadOldApps();
        const changelog = generateChangelog(oldApps, whitelistResult.apps);
        
        if (changelog && (changelog.added.length > 0 || changelog.removed.length > 0 || changelog.changed.length > 0)) {
          saveChangelog(changelog, whitelistResult.date);
        }
        
        updateHtml(whitelistResult.apps, whitelistResult.date);
      }

} catch (err) {
console.error('Error:', err.message);
} finally {
  await browser.close();
}

  console.log('Done');
}

async function scrapeWhitelist(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  console.log('Visiting SECP page...');
  await page.goto(SECP_URL, { waitUntil: 'networkidle2' });

  const pageInfo = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    let pdfUrl = null;
    
    for (const link of links) {
      const href = link.href || '';
      const text = link.textContent || '';
      if (href.includes('wpdmdl') && (text.includes('PDF') || text.includes('pdf') || text.includes('download') || text.includes('Download'))) {
        pdfUrl = href;
        break;
      }
    }
    
    if (!pdfUrl) {
      for (const link of links) {
        const href = link.href || '';
        if (href.includes('wpdmdl')) {
          pdfUrl = href;
          break;
        }
      }
    }
    
    const text = document.body.innerText;
    const dates = text.match(/(\w+\s+\d{1,2},?\s+\d{4})/g);
    return {
      pdfUrl: pdfUrl,
      dates: dates ? dates.slice(0, 5) : []
    };
  });

  console.log('PDF URL:', pageInfo.pdfUrl);
  console.log('Dates found:', pageInfo.dates);

  await page.close();

  if (pageInfo.pdfUrl) {
    const pdfBuffer = await downloadPDF(pageInfo.pdfUrl);
    if (pdfBuffer) {
      const apps = await parsePDF(pdfBuffer);
      if (apps && apps.nanoApps && apps.nanoApps.length > 0) {
        return { apps, date: pageInfo.dates[0] };
      }
    }
  }
  return null;
}

async function scrapeNewsFromSources(browser) {
  const allNews = [];
  
  for (const source of NEWS_SOURCES) {
    try {
      console.log(`Scraping ${source.name}...`);
      const candidateUrls = await collectArticleUrls(browser, source);
      console.log(`  Found ${candidateUrls.length} candidate URLs`);
      
      const articles = await fetchArticles(browser, candidateUrls, source.name);
      console.log(`  Successfully fetched ${articles.length} articles`);
      
      allNews.push(...articles);
    } catch (err) {
      console.error(`Failed to scrape ${source.name}:`, err.message);
    }
  }
  
  const filtered = filterByKeywords(allNews);
  const recent = filterRecentNews(filtered);
  const sorted = recent.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  console.log(`Total news found (after filtering): ${sorted.length}`);
  return sorted.slice(0, 20);
}

async function collectArticleUrls(browser, source) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  
  try {
    await page.goto(source.url, { waitUntil: 'networkidle2' });
    
    const urls = await page.evaluate((maxNews) => {
      const results = [];
      const seen = new Set();
      
      const articleSelectors = [
        'article a[href]', '.post a[href]', '.news-item a[href]', '.story a[href]', '.content a[href]',
        '.entry-content a[href]', '.article-body a[href]', '.blog-post a[href]',
        '.post-title a[href]', '.entry-title a[href]', '.article-title a[href]',
        '.td-module-title a[href]', '.jeg_post_title a[href]', '.post-title-link a[href]',
        'h2 a[href]', 'h3 a[href]', 'h4 a[href]'
      ];
      
      for (const selector of articleSelectors) {
        document.querySelectorAll(selector).forEach(a => {
          const href = a.href;
          if (seen.has(href)) return;
          if (!href.startsWith('http')) return;
          if (href.includes('#')) return;
          if (href.includes('/tag/') || href.includes('/category/') || href.includes('/author/')) return;
          if (href.includes('/wp-admin/') || href.includes('/login/') || href.includes('/register/')) return;
          
          const path = new URL(href).pathname;
          if (path === '/' || path === '') return;
          if (path.includes('.pdf') || path.includes('.jpg') || path.includes('.png')) return;
          
          const parent = a.parentElement;
          if (parent && (parent.tagName === 'NAV' || parent.tagName === 'HEADER' || parent.classList?.contains('nav') || parent.classList?.contains('header'))) {
            return;
          }
          
          const grandParent = parent?.parentElement;
          if (grandParent && (grandParent.tagName === 'NAV' || grandParent.tagName === 'HEADER' || grandParent.classList?.contains('nav') || grandParent.classList?.contains('header'))) {
            return;
          }
          
          const article = a.closest('article, .post, .news-item, .story');
          const heading = a.closest('h1, h2, h3, h4');
          if (!article && !heading && !href.match(/\/\d{4}\/\d{1,2}\//)) {
            return;
          }
          
          seen.add(href);
          results.push(href);
        });
        
        if (results.length >= maxNews) break;
      }
      
      return results.slice(0, maxNews);
    }, MAX_NEWS_PER_SOURCE);
    
    return urls;
  } finally {
    await page.close();
  }
}

async function fetchArticles(browser, urls, sourceName) {
  const articles = [];
  const limitedUrls = urls.slice(0, MAX_ARTICLE_FETCH);
  
  for (const url of limitedUrls) {
    try {
      const article = await fetchArticle(browser, url, sourceName);
      if (article && article.date) {
        articles.push(article);
        console.log(`  ✅ ${article.date} - ${article.title.substring(0, 40)}...`);
      } else {
        console.log(`  ❌ No date found: ${url}`);
      }
    } catch (err) {
      console.log(`  ❌ Failed: ${url} - ${err.message}`);
    }
  }
  
  return articles;
}

async function fetchArticle(browser, url, sourceName) {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    const data = await page.evaluate(() => {
      const title = document.querySelector('h1, .post-title, .entry-title, .article-title')?.textContent?.trim() || '';
      if (!title || title.length < 10) return null;
      
      let date = '';
      
      const timeEl = document.querySelector('time, .post-date, .entry-date, .published, .updated');
      if (timeEl) {
        date = timeEl.getAttribute('datetime') || timeEl.textContent.trim();
      }
      
      if (!date) {
        const dateMeta = document.querySelector('meta[property="article:published_time"], meta[name="pubdate"], meta[name="date"]');
        if (dateMeta) date = dateMeta.getAttribute('content') || '';
      }
      
      if (!date) {
        const dateText = document.querySelector('.date, .post-date, .news-date')?.textContent?.trim() || '';
        if (dateText) date = dateText;
      }
      
      if (!date) {
        const urlMatch = window.location.href.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
        if (urlMatch) date = `${urlMatch[1]}-${urlMatch[2].padStart(2, '0')}-${urlMatch[3].padStart(2, '0')}`;
      }
      
      if (!date) return null;
      
      const content = document.querySelector('.entry-content, .post-content, .article-content, .story-content, [role="main"]') || document.querySelector('article');
      const text = content?.textContent?.trim().substring(0, 1500) || '';
      
      return { title, date, text };
    });
    
    if (!data || !data.date) return null;
    
    let normalizedDate = normalizeDate(data.date);
    if (!normalizedDate) return null;
    
    return {
      title: data.title,
      link: url,
      date: normalizedDate,
      excerpt: data.text.substring(0, 300),
      source: sourceName
    };
  } finally {
    await page.close();
  }
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  
  const isoMatch = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}/${parseInt(isoMatch[2])}/${parseInt(isoMatch[3])}`;
  }
  
  const slashMatch = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    return `${slashMatch[1]}/${parseInt(slashMatch[2])}/${parseInt(slashMatch[3])}`;
  }
  
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  for (let i = 0; i < monthNames.length; i++) {
    const regex = new RegExp(`${monthNames[i]}\\s+(\\d{1,2}),?\\s+(\\d{4})`);
    const match = dateStr.match(regex);
    if (match) {
      return `${match[2]}/${i + 1}/${parseInt(match[1])}`;
    }
  }
  
  return null;
}

function filterRecentNews(newsItems) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENCY_DAYS);
  
  const filtered = newsItems.filter(item => {
    const date = parseDate(item.date);
    return date && date >= cutoff;
  });
  
  console.log(`Filtered out ${newsItems.length - filtered.length} old articles (older than ${RECENCY_DAYS} days)`);
  return filtered;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  
  const match = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }
  
  return new Date(dateStr);
}

function filterByKeywords(newsItems) {
  return newsItems.filter(item => {
    const text = (item.title + ' ' + item.excerpt).toLowerCase();
    return KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  });
}

function loadExistingNews() {
  const newsPath = path.join(__dirname, '..', 'news.json');
  if (!fs.existsSync(newsPath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(newsPath, 'utf-8'));
    return data.items || [];
  } catch (e) {
    return [];
  }
}

function deduplicateNews(newNews, existingNews) {
  const existingUrls = new Set(existingNews.map(n => n.link));
  const existingTitles = new Set(existingNews.map(n => n.title.toLowerCase()));
  
  return newNews.filter(item => {
    return !existingUrls.has(item.link) && !existingTitles.has(item.title.toLowerCase());
  });
}

async function analyzeNewsWithAI(newsItems) {
  if (!DEEPSEEK_API_KEY) {
    console.log('DEEPSEEK_API_KEY not set, skipping AI analysis');
    return newsItems.map(item => ({
      ...item,
      summary: item.excerpt || '暂无摘要',
      businessImpact: '',
      keywords: [],
      relevanceScore: 0.5
    }));
  }

  const deepseek = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: DEEPSEEK_BASE_URL
  });

  const analyzed = [];
  
  for (const news of newsItems) {
    try {
      console.log(`Analyzing: ${news.title}`);
      
      const prompt = `你是一位巴基斯坦金融科技监管政策专家，服务于一家中国互金公司（在巴基斯坦开展nano lending业务）。请分析以下新闻并提供中文分析：

新闻标题：${news.title}
新闻摘要：${news.excerpt || '暂无摘要'}

请按以下JSON格式返回（不要包含markdown格式）：
{
  "summary": "中文摘要（80-150字）",
  "businessImpact": "对我们nano lending业务的影响分析和关注点（50-100字）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "relevanceScore": 0-1的相关性评分（与巴基斯坦数字贷款监管的相关程度）
}`;

      const response = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300
      });

      const content = response.choices[0].message.content.trim();
      let result;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: content };
      } catch (e) {
        result = { summary: content, businessImpact: '', keywords: [], relevanceScore: 0.5 };
      }

      analyzed.push({
        ...news,
        summary: result.summary || news.excerpt || '暂无摘要',
        businessImpact: result.businessImpact || '',
        keywords: result.keywords || [],
        relevanceScore: result.relevanceScore || 0.5
      });
    } catch (err) {
      console.error(`Failed to analyze news: ${err.message}`);
      analyzed.push({
        ...news,
        summary: news.excerpt || '暂无摘要',
        businessImpact: '',
        keywords: [],
        relevanceScore: 0.5
      });
    }
  }
  
  return analyzed.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function downloadPDF(url) {
    return new Promise((resolve, reject) => {
      const request = (u) => {
        https.get(u, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            request(res.headers.location);
            return;
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      };
      request(url);
  });
}

async function parsePDF(buffer) {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer);
      console.log('PDF pages:', data.numpages);

      const lines = data.text.split('\n').filter(l => l.trim());
      const nanoApps = [];
      const otherApps = [];
      let section = null;

      for (const line of lines) {
        if (line.includes('Nano Lending') || line.includes('Nano Finance')) {
          section = 'nano';
          continue;
        }
        if (line.includes('Other Lending') || line.includes('BNPL') || line.includes('EWA')) {
          section = 'other';
          continue;
        }

       const match = line.match(/^\d+\.?\s*(.+?)(?:\s{2,}|\|)(.+?)(?:\s{2,}|\|)(.+)$/);
        if (match && section) {
          const [, name, nbfc, tag] = match;
          const id = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
          const app = {
            id,
            name: name.trim(),
            nbfc: nbfc.trim(),
            tag: tag.trim(),
            color: COLORS[(section === 'nano' ? nanoApps : otherApps).length % COLORS.length],
            letter: name.trim()[0].toUpperCase()
          };
          if (PRESERVED_NOTES[id]) app.note = PRESERVED_NOTES[id];

          if (section === 'nano') nanoApps.push(app);
          else otherApps.push(app);
        }
      }

      console.log(`Parsed: Nano=${nanoApps.length}, Other=${otherApps.length}`);
      return { nanoApps, otherApps };
    } catch (e) {
      console.error('PDF parse error:', e.message);
      return null;
  }
}

function loadOldApps() {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return { nanoApps: [], otherApps: [] };
  }

  const html = fs.readFileSync(htmlPath, 'utf-8');
  
  const nanoMatch = html.match(/const nanoApps = (\[[\s\S]*?\]);/);
  const otherMatch = html.match(/const otherApps = (\[[\s\S]*?\]);/);

  try {
    return {
      nanoApps: nanoMatch ? JSON.parse(nanoMatch[1]) : [],
      otherApps: otherMatch ? JSON.parse(otherMatch[1]) : []
    };
  } catch (e) {
    console.error('Failed to load old apps:', e.message);
    return { nanoApps: [], otherApps: [] };
  }
}

function generateChangelog(oldApps, newApps) {
  const oldNanoMap = new Map(oldApps.nanoApps.map(a => [a.id, a]));
  const oldOtherMap = new Map(oldApps.otherApps.map(a => [a.id, a]));
  
  const newNanoMap = new Map(newApps.nanoApps.map(a => [a.id, a]));
  const newOtherMap = new Map(newApps.otherApps.map(a => [a.id, a]));

  const added = [];
  const removed = [];
  const changed = [];

  const allOldIds = new Set([...oldNanoMap.keys(), ...oldOtherMap.keys()]);
  const allNewIds = new Set([...newNanoMap.keys(), ...newOtherMap.keys()]);

  for (const id of allNewIds) {
    if (!allOldIds.has(id)) {
      const app = newNanoMap.get(id) || newOtherMap.get(id);
      added.push({ id, name: app.name, nbfc: app.nbfc, tag: app.tag, type: newNanoMap.has(id) ? 'Nano' : 'Other' });
    } else {
      const oldApp = oldNanoMap.get(id) || oldOtherMap.get(id);
      const newApp = newNanoMap.get(id) || newOtherMap.get(id);
      
      if (oldApp.nbfc !== newApp.nbfc || oldApp.tag !== newApp.tag) {
        changed.push({ 
          id, 
          name: newApp.name,
          changes: [
            oldApp.nbfc !== newApp.nbfc ? { field: 'NBFC', from: oldApp.nbfc, to: newApp.nbfc } : null,
            oldApp.tag !== newApp.tag ? { field: 'Tag', from: oldApp.tag, to: newApp.tag } : null
          ].filter(Boolean)
        });
      }
    }
  }

  for (const id of allOldIds) {
    if (!allNewIds.has(id)) {
      const app = oldNanoMap.get(id) || oldOtherMap.get(id);
      removed.push({ id, name: app.name, nbfc: app.nbfc, tag: app.tag });
    }
  }

  return { added, removed, changed };
}

function saveChangelog(changelog, date) {
  const changelogPath = path.join(__dirname, '..', 'changelog.json');
  
  let history = [];
  if (fs.existsSync(changelogPath)) {
    try {
      history = JSON.parse(fs.readFileSync(changelogPath, 'utf-8'));
    } catch (e) {
      history = [];
    }
  }

  const entry = {
    date: date || new Date().toLocaleDateString('zh-CN'),
    timestamp: new Date().toISOString(),
    ...changelog
  };

  history.unshift(entry);
  
  if (history.length > 20) {
    history = history.slice(0, 20);
  }

  fs.writeFileSync(changelogPath, JSON.stringify(history, null, 2), 'utf-8');
  console.log('changelog.json updated');
}

function saveNews(newsItems) {
  const newsPath = path.join(__dirname, '..', 'news.json');
  
  const newsData = {
    lastUpdated: new Date().toISOString(),
    items: newsItems.map(item => ({
      date: item.date,
      title: item.title,
      link: item.link,
      source: item.source || 'Unknown',
      summary: item.summary || '',
      businessImpact: item.businessImpact || '',
      keywords: item.keywords || [],
      relevanceScore: item.relevanceScore || 0.5
    }))
  };

  fs.writeFileSync(newsPath, JSON.stringify(newsData, null, 2), 'utf-8');
  console.log('news.json updated');
}

function updateHtml(apps, updateDate) {
    const htmlPath = path.join(__dirname, '..', 'index.html');
    if (!fs.existsSync(htmlPath)) {
      console.error('index.html not found');
      return;
    }

    let html = fs.readFileSync(htmlPath, 'utf-8');

    if (apps.nanoApps.length > 0) {
      const str = JSON.stringify(apps.nanoApps, null, 2);
      html = html.replace(/const nanoApps = \[[\s\S]*?\];/, `const nanoApps = ${str};`);
    }

    if (apps.otherApps.length > 0) {
      const str = JSON.stringify(apps.otherApps, null, 2);
      html = html.replace(/const otherApps = \[[\s\S]*?\];/, `const otherApps = ${str};`);
    }

    if (updateDate) {
      html = html.replace(/白名单更新：[\w\s,]+/, `白名单更新：${updateDate}`);
    }

    const total = apps.nanoApps.length + apps.otherApps.length;
    html = html.replace(/>\d+ 个已批准</, `>${total} 个已批准<`);
    html = html.replace(/显示全部 \d+ 个 APP/g, `显示全部 ${total} 个 APP`);

    fs.writeFileSync(htmlPath, html, 'utf-8');
    console.log('index.html updated');
}

main();