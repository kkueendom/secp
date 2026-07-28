import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import https from 'https';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECP_URL = 'https://www.secp.gov.pk/document/digital-lending-apps-being-run-and-administered-by-duly-licensed-lending-nbfcs/';

const OFFICIAL_NEWS_LISTINGS = [
  {
    name: 'SECP Official',
    url: `https://www.secp.gov.pk/media-center/press-releases/?s-year=${new Date().getFullYear()}`
  },
  {
    name: 'SECP Circulars',
    url: 'https://www.secp.gov.pk/laws/circulars/'
  }
];

const RSS_SOURCES = [
  { name: 'ProPakistani', url: 'https://propakistani.pk/feed/' },
  {
    name: null,
    url: googleNewsRss('Pakistan ("digital lending" OR fintech OR NBFC OR "access to finance" OR "digital payments" OR "open banking") when:21d')
  },
  {
    name: null,
    url: googleNewsRss('Pakistan (SECP OR SBP OR FIA OR PVARA) (lending OR fintech OR finance OR payment OR AML OR KYC) when:21d')
  },
  {
    name: null,
    url: googleNewsRss('site:pid.gov.pk Pakistan ("access to finance" OR "digital finance" OR lending OR fintech OR payments) when:21d')
  }
];

const DOMAIN_SIGNALS = [
  ['digital lending', 0.42], ['nano lending', 0.45], ['loan app', 0.38],
  ['microfinance', 0.28], ['micro-finance', 0.28], ['nbfc', 0.32],
  ['buy now pay later', 0.30], ['bnpl', 0.30], ['earned wage access', 0.30],
  ['ewa', 0.22], ['fintech', 0.22], ['digital finance', 0.30],
  ['digital banking', 0.25], ['digital payment', 0.24], ['cashless', 0.18],
  ['access to finance', 0.30], ['financial inclusion', 0.24],
  ['open banking', 0.32], ['credit bureau', 0.30], ['credit scoring', 0.26],
  ['consumer finance', 0.28], ['virtual asset', 0.20], ['crypto', 0.12]
];

const REGULATOR_SIGNALS = [
  'secp', 'state bank of pakistan', 'sbp', 'finance minister', 'finance ministry',
  'finance division', 'fia', 'pvara', 'government of pakistan', 'central bank'
];

const ACTION_SIGNALS = [
  'regulation', 'regulatory', 'policy', 'framework', 'rule', 'circular',
  'notification', 'guideline', 'license', 'licence', 'approval', 'whitelist',
  'enforcement', 'compliance', 'consumer protection', 'data protection',
  'aml', 'cft', 'kyc', 'interest rate', 'pricing cap', 'credit limit',
  'launches', 'introduces', 'directs', 'orders', 'reform'
];

const NEGATIVE_SIGNALS = [
  'power outage', 'electricity shutdown', 'mobile package prices', 'recharge tax',
  'smartphone launch', 'broadband speed', 'telecom package', 'startup story',
  'celebrity', 'gaming', 'automobile price'
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

const MAX_DISCOVERED_PER_FEED = 20;
const MAX_NEWS_PER_SOURCE_FINAL = 2;
const MAX_OFFICIAL_PER_SOURCE_FINAL = 5;
const MAX_TOTAL_NEWS = 24;
const RECENCY_DAYS = 21;
const EXISTING_RETENTION_DAYS = 45;
const MIN_RULE_SCORE = 0.38;
const MIN_FINAL_SCORE = 0.50;
const DRY_RUN = process.argv.includes('--dry-run');
const NEWS_ONLY = process.argv.includes('--news-only');

async function main() {
    console.log('SECP Auto-Updater Started:', new Date().toISOString());

  const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

  try {
      const [whitelistResult, newsItems] = await Promise.all([
        NEWS_ONLY ? Promise.resolve(null) : scrapeWhitelist(browser),
        scrapeNewsFromSources(browser)
      ]);

      const existingNews = refreshExistingNews(cleanExistingNews(loadExistingNews()), newsItems || []);
      const unseenNews = deduplicateNews(newsItems || [], existingNews);
      if (DRY_RUN) {
        console.log('\nNew candidate scores:');
        unseenNews.forEach(item => console.log(`${item.date} | ${item.source} | rule=${Number(item.ruleScore).toFixed(2)} | ${item.title}`));
      }
      const analyzedNews = unseenNews.length > 0 ? await analyzeNewsWithAI(unseenNews) : [];
      const relevantNews = analyzedNews.filter(shouldAcceptAnalyzedNews);
      console.log(`Accepted ${relevantNews.length}/${analyzedNews.length} newly analyzed articles`);

      const balancedNews = balanceNewsBySource(deduplicateAllNews([...relevantNews, ...existingNews]));
      if (DRY_RUN) {
        console.log('\nDry-run result:');
        balancedNews.slice(0, 12).forEach(item => {
          console.log(`${item.date} | ${item.source} | ${Number(item.relevanceScore).toFixed(2)} | ${item.title}`);
        });
      } else if (balancedNews.length > 0 || whitelistResult?.date) {
        saveNews(balancedNews, whitelistResult?.date);
      }

      if (whitelistResult && whitelistResult.apps && whitelistResult.apps.nanoApps.length > 0) {
        const oldApps = loadOldApps();
        const changelog = generateChangelog(oldApps, whitelistResult.apps);
        
        if (!DRY_RUN && changelog && (changelog.added.length > 0 || changelog.removed.length > 0 || changelog.changed.length > 0)) {
          saveChangelog(changelog, whitelistResult.date);
        }
        
        if (!DRY_RUN) updateHtml(whitelistResult.apps, whitelistResult.date);
      }

} catch (err) {
console.error('Error:', err.message);
process.exitCode = 1;
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
  const batches = await Promise.all([
    ...OFFICIAL_NEWS_LISTINGS.map(source => collectOfficialListing(browser, source)),
    collectPidHomepage(browser),
    ...RSS_SOURCES.map(source => collectRssFeed(source))
  ]);

  let candidates = deduplicateAllNews(batches.flat())
    .map(item => ({ ...item, ruleScore: scoreRegulatoryRelevance(item) }))
    .filter(item => item.ruleScore >= MIN_RULE_SCORE || isOfficialSource(item.source));

  candidates = filterRecentNews(candidates, RECENCY_DAYS)
    .sort(compareNews)
    .slice(0, 40);

  candidates = await enrichGenericArticles(browser, candidates);
  console.log(`Total eligible news candidates: ${candidates.length}`);
  return candidates;
}

function googleNewsRss(query) {
  const params = new URLSearchParams({
    q: query,
    hl: 'en-PK',
    gl: 'PK',
    ceid: 'PK:en'
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

async function collectOfficialListing(browser, source) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  try {
    console.log(`Collecting official source: ${source.name}`);
    await page.goto(source.url, { waitUntil: 'domcontentloaded' });
    const items = await page.evaluate((sourceName) => {
      const results = [];
      const seen = new Set();
      const datePattern = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;

      for (const link of document.querySelectorAll('a[href]')) {
        const href = link.href || '';
        const label = (link.textContent || '').trim();
        const isDownload = /download/i.test(label) || /\.pdf(?:$|\?)/i.test(href) || href.includes('wpdmdl');
        if (!isDownload || seen.has(href)) continue;

        let node = link.parentElement;
        let rowText = '';
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          if (datePattern.test(text) && text.length <= 500) {
            rowText = text;
            break;
          }
        }
        const match = rowText.match(datePattern);
        if (!match) continue;

        const title = rowText
          .replace(datePattern, '')
          .replace(/\bdownload\b/ig, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (title.length < 12) continue;

        seen.add(href);
        results.push({
          title,
          link: href,
          date: `${match[3]}/${Number(match[2])}/${Number(match[1])}`,
          excerpt: title,
          source: sourceName,
          sourceTier: 3
        });
      }
      return results;
    }, source.name);
    console.log(`  Found ${items.length} official records`);
    return items;
  } catch (error) {
    console.error(`Failed official source ${source.name}: ${error.message}`);
    return [];
  } finally {
    await page.close();
  }
}

async function collectPidHomepage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  try {
    console.log('Collecting official source: Government of Pakistan (PID)');
    await page.goto('https://pid.gov.pk/', { waitUntil: 'domcontentloaded' });
    const items = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const datePattern = /\b(\d{4})-(\d{2})-(\d{2})\b/;
      for (const link of document.querySelectorAll('a[href*="/site/press_detail/"]')) {
        if (seen.has(link.href)) continue;
        seen.add(link.href);

        let node = link.parentElement;
        let title = (node?.innerText || '').replace(/\s+/g, ' ').replace(/\bRead More\b/ig, '').trim();
        let date = '';
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          const match = text.match(datePattern);
          if (match) {
            date = `${match[1]}/${Number(match[2])}/${Number(match[3])}`;
            break;
          }
        }
        title = title.replace(/^PR No\.\s*\d+\s*/i, '').trim();
        if (title.length < 15 || !date) continue;
        results.push({
          title,
          link: link.href,
          date,
          excerpt: title,
          source: 'Government of Pakistan (PID)',
          sourceTier: 3
        });
      }
      return results;
    });
    console.log(`  Found ${items.length} PID records`);
    return items;
  } catch (error) {
    console.error(`Failed PID homepage: ${error.message}`);
    return [];
  } finally {
    await page.close();
  }
}

async function collectRssFeed(source) {
  try {
    console.log(`Collecting RSS: ${source.name || 'Google News discovery'}`);
    const response = await fetch(source.url, {
      headers: { 'user-agent': 'Mozilla/5.0 SECP-Watch/2.0' },
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
      .slice(0, MAX_DISCOVERED_PER_FEED)
      .map(match => match[1]);

    const items = blocks.map(block => {
      const title = cleanXml(readXmlTag(block, 'title'));
      const link = cleanXml(readXmlTag(block, 'link'));
      const pubDate = cleanXml(readXmlTag(block, 'pubDate') || readXmlTag(block, 'dc:date'));
      const description = cleanXml(readXmlTag(block, 'description'));
      const discoveredSource = cleanXml(readXmlTag(block, 'source'));
      const itemSource = source.name || discoveredSource || inferSourceFromTitle(title) || 'Google News';
      return {
        title: stripSourceSuffix(title, itemSource),
        link,
        date: normalizeDate(pubDate),
        excerpt: description.substring(0, 600),
        source: normalizeSourceName(itemSource),
        sourceTier: isOfficialSource(itemSource) ? 3 : 2
      };
    }).filter(item => item.title && item.link && item.date);

    console.log(`  Found ${items.length} RSS records`);
    return items;
  } catch (error) {
    console.error(`Failed RSS ${source.name || source.url}: ${error.message}`);
    return [];
  }
}

function readXmlTag(block, tagName) {
  const escaped = tagName.replace(':', '\\:');
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? match[1] : '';
}

function cleanXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#8217;/gi, '’')
    .replace(/&#8211;/gi, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferSourceFromTitle(title = '') {
  const match = title.match(/\s+-\s+([^-]{2,60})$/);
  return match ? match[1].trim() : '';
}

function stripSourceSuffix(title = '', source = '') {
  if (!source) return title;
  const suffix = new RegExp(`\\s+-\\s+${escapeRegex(source)}\\s*$`, 'i');
  return title.replace(suffix, '').trim();
}

function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSourceName(source = '') {
  const normalized = source.trim();
  if (/^pid\.gov\.pk$/i.test(normalized)) return 'Government of Pakistan (PID)';
  if (/^secp$/i.test(normalized)) return 'SECP Official';
  if (/state bank of pakistan|^sbp$/i.test(normalized)) return 'State Bank of Pakistan';
  return normalized;
}

async function enrichGenericArticles(browser, candidates) {
  const enriched = [];
  let fetchCount = 0;
  for (const item of candidates) {
    const isDiscoveryLink = (() => {
      try { return new URL(item.link).hostname === 'news.google.com'; } catch { return false; }
    })();
    const needsEnrichment = isDiscoveryLink || /PID/i.test(item.source) || item.title.length < 20 || /^(pid|home|latest news)$/i.test(item.title);
    if (!needsEnrichment || fetchCount >= 12) {
      enriched.push(item);
      continue;
    }

    fetchCount += 1;
    const page = await browser.newPage();
    page.setDefaultTimeout(45000);
    try {
      await page.goto(item.link, { waitUntil: 'domcontentloaded' });
      const data = await page.evaluate(() => {
        const title = document.querySelector('h1, h2.photo_h2, .post-title, .entry-title, .article-title')?.textContent?.trim() || '';
        const content = document.querySelector('.entry-content, .post-content, .article-content, .story-content, [role="main"], article');
        return { title, excerpt: (content?.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 900), link: location.href };
      });
      const cleanedTitle = /PID/i.test(item.source)
        ? data.title
            .replace(/^PR No\.\s*\d+\s*/i, '')
            .replace(/\s*(?:Islamabad|Karachi|Lahore):\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s*$/i, '')
            .trim()
        : data.title;
      const candidate = {
        ...item,
        title: cleanedTitle.length >= 12 ? cleanedTitle : item.title,
        excerpt: data.excerpt || item.excerpt,
        link: data.link || item.link
      };
      enriched.push({ ...candidate, ruleScore: scoreRegulatoryRelevance(candidate) });
    } catch (error) {
      console.log(`  Could not enrich ${item.source}: ${error.message}`);
      enriched.push(item);
    } finally {
      await page.close();
    }
  }
  return enriched.filter(item => item.ruleScore >= MIN_RULE_SCORE);
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
    const regex = new RegExp(`${monthNames[i]}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i');
    const match = dateStr.match(regex);
    if (match) {
      return `${match[2]}/${i + 1}/${parseInt(match[1])}`;
    }
  }

  const parsed = new Date(dateStr);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getUTCFullYear()}/${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}`;
  }
  
  return null;
}

function filterRecentNews(newsItems, recencyDays = RECENCY_DAYS) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - recencyDays);
  
  const filtered = newsItems.filter(item => {
    const date = parseDate(item.date);
    const futureLimit = new Date();
    futureLimit.setDate(futureLimit.getDate() + 1);
    return date && date >= cutoff && date <= futureLimit;
  });
  
  console.log(`Filtered out ${newsItems.length - filtered.length} articles outside the ${recencyDays}-day window`);
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

function scoreRegulatoryRelevance(item) {
  const title = String(item.title || '').toLowerCase();
  const body = `${title} ${String(item.excerpt || '').toLowerCase()}`;
  let score = 0;

  for (const [signal, weight] of DOMAIN_SIGNALS) {
    if (body.includes(signal)) score += title.includes(signal) ? weight : weight * 0.72;
  }

  const hasRegulator = REGULATOR_SIGNALS.some(signal => body.includes(signal));
  const hasAction = ACTION_SIGNALS.some(signal => body.includes(signal));
  if (hasRegulator) score += 0.25;
  if (hasAction) score += 0.24;
  if (hasRegulator && hasAction) score += 0.08;
  if (isOfficialSource(item.source)) score += 0.12;

  for (const signal of NEGATIVE_SIGNALS) {
    if (body.includes(signal)) score -= 0.55;
  }

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function shouldAcceptAnalyzedNews(item) {
  const ruleScore = item.ruleScore ?? scoreRegulatoryRelevance(item);
  return ruleScore >= MIN_RULE_SCORE && Number(item.relevanceScore) >= MIN_FINAL_SCORE;
}

function isOfficialSource(source = '') {
  return /secp|state bank|^sbp$|government of pakistan|pid|finance division|finance ministry|pvara/i.test(source);
}

function cleanExistingNews(items) {
  return filterRecentNews(items, EXISTING_RETENTION_DAYS)
    .map(item => {
      const ruleScore = scoreRegulatoryRelevance(item);
      return { ...item, ruleScore };
    })
    .filter(item => item.ruleScore >= MIN_RULE_SCORE && Number(item.relevanceScore || 0) >= 0.55);
}

function refreshExistingNews(existingItems, discoveredItems) {
  const discoveredByUrl = new Map(discoveredItems.map(item => [canonicalUrl(item.link), item]));
  return existingItems.map(existing => {
    const current = discoveredByUrl.get(canonicalUrl(existing.link));
    if (!current) return existing;
    return {
      ...existing,
      date: current.date || existing.date,
      title: current.title || existing.title,
      link: current.link || existing.link,
      source: current.source || existing.source,
      ruleScore: current.ruleScore ?? existing.ruleScore
    };
  });
}

function compareNews(a, b) {
  const dateDiff = parseDate(b.date) - parseDate(a.date);
  if (dateDiff !== 0) return dateDiff;
  const officialDiff = Number(isOfficialSource(b.source)) - Number(isOfficialSource(a.source));
  if (officialDiff !== 0) return officialDiff;
  return Number(b.relevanceScore ?? b.ruleScore ?? 0) - Number(a.relevanceScore ?? a.ruleScore ?? 0);
}

function balanceNewsBySource(newsItems, maxPerSource = MAX_NEWS_PER_SOURCE_FINAL) {
  const counts = new Map();
  return [...newsItems]
    .sort(compareNews)
    .filter(item => {
      const source = normalizeSourceName(item.source || 'Unknown');
      const cap = isOfficialSource(source) ? MAX_OFFICIAL_PER_SOURCE_FINAL : maxPerSource;
      const count = counts.get(source) || 0;
      if (count >= cap) return false;
      counts.set(source, count + 1);
      item.source = source;
      return true;
    })
    .slice(0, MAX_TOTAL_NEWS);
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
  const existingUrls = new Set(existingNews.map(item => canonicalUrl(item.link)));
  const existingTitles = new Set(existingNews.map(item => normalizeTitle(item.title)));
  
  return newNews.filter(item => {
    return !existingUrls.has(canonicalUrl(item.link)) && !existingTitles.has(normalizeTitle(item.title));
  });
}

function deduplicateAllNews(items) {
  const seenUrls = new Set();
  const seenItems = [];
  return items.filter(item => {
    const url = canonicalUrl(item.link);
    const title = normalizeTitle(item.title);
    if (!url || !title || seenUrls.has(url) || seenItems.some(seen => areNearDuplicate(item, seen))) return false;
    seenUrls.add(url);
    seenItems.push(item);
    return true;
  });
}

function areNearDuplicate(left, right) {
  const leftTitle = normalizeTitle(left.title);
  const rightTitle = normalizeTitle(right.title);
  if (leftTitle === rightTitle) return true;

  const leftDate = parseDate(left.date);
  const rightDate = parseDate(right.date);
  if (leftDate && rightDate && Math.abs(leftDate - rightDate) > 2 * 86400000) return false;

  const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'and', 'with', 'as', 'by', 'pakistan']);
  const tokens = value => new Set(value.split(' ').filter(token => token.length > 2 && !stopWords.has(token)));
  const leftTokens = tokens(leftTitle);
  const rightTokens = tokens(rightTitle);
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 && intersection / union >= 0.72;
}

function canonicalUrl(value = '') {
  try {
    const url = new URL(value);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach(key => url.searchParams.delete(key));
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

function normalizeTitle(value = '') {
  return value
    .toLowerCase()
    .replace(/\s+-\s+[^-]{2,50}$/, '')
    .replace(/[^a-z0-9\u0600-\u06ff\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function analyzeNewsWithAI(newsItems) {
  if (!DEEPSEEK_API_KEY) {
    console.log('DEEPSEEK_API_KEY not set, skipping AI analysis');
    return newsItems.map(item => ({
      ...item,
      summary: item.excerpt || '暂无摘要',
      businessImpact: '',
      keywords: [],
      relevanceScore: item.ruleScore ?? scoreRegulatoryRelevance(item)
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
      
      const prompt = `你是一位巴基斯坦金融科技监管政策专家，服务于一家在巴基斯坦开展 nano lending 业务的中国互金公司。请严格判断下面新闻是否会影响数字信贷的监管、牌照、定价、消费者保护、数据、KYC/AML、支付基础设施或融资准入。

新闻标题：${news.title}
新闻来源：${news.source}
新闻摘要：${news.excerpt || '暂无摘要'}

请按以下JSON格式返回（不要包含markdown格式）：
{
  "summary": "中文摘要（80-150字）",
  "businessImpact": "对我们nano lending业务的影响分析和关注点（50-100字）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "relevanceScore": 0-1的相关性评分（与巴基斯坦数字贷款监管的相关程度）
}

评分必须遵守：
- 0.85-1.00：直接发布或修改数字信贷、NBFC、KYC/AML、数据、消费者保护等监管规则；
- 0.65-0.84：明确影响数字金融、支付、信贷准入或持牌机构经营；
- 0.40-0.64：只有间接行业影响；
- 0.00-0.39：普通科技、电信套餐、停电、手机、企业故事或泛经济新闻。
不要因为文章出现 Pakistan、Karachi、loan、credit 或 fintech 单个词就给高分。`;

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

      const aiScore = Number(result.relevanceScore);
      const ruleScore = news.ruleScore ?? scoreRegulatoryRelevance(news);
      const combinedScore = Number.isFinite(aiScore)
        ? Math.min(1, Math.max(0, aiScore * 0.65 + ruleScore * 0.35))
        : ruleScore;

      analyzed.push({
        ...news,
        summary: result.summary || news.excerpt || '暂无摘要',
        businessImpact: result.businessImpact || '',
        keywords: result.keywords || [],
        relevanceScore: Number(combinedScore.toFixed(3))
      });
    } catch (err) {
      console.error(`Failed to analyze news: ${err.message}`);
      analyzed.push({
        ...news,
        summary: news.excerpt || '暂无摘要',
        businessImpact: '',
        keywords: [],
        relevanceScore: news.ruleScore ?? scoreRegulatoryRelevance(news)
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

function saveNews(newsItems, whitelistDate) {
  const newsPath = path.join(__dirname, '..', 'news.json');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
  
  let existingWhitelistDate = '';
  try {
    const existingData = fs.readFileSync(newsPath, 'utf-8');
    const existingJson = JSON.parse(existingData);
    if (existingJson.whitelistDate) {
      existingWhitelistDate = existingJson.whitelistDate;
    }
  } catch (e) {}
  
  const newsData = {
    lastUpdated: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    newsUpdateDate: todayStr,
    latestArticleDate: newsItems[0]?.date || '',
    whitelistDate: whitelistDate || existingWhitelistDate || '',
    items: newsItems.map(item => ({
      date: item.date,
      title: item.title,
      link: item.link,
      source: item.source || 'Unknown',
      summary: item.summary || '',
      businessImpact: item.businessImpact || '',
      keywords: item.keywords || [],
      relevanceScore: item.relevanceScore ?? 0.5
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

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();

export {
  balanceNewsBySource,
  cleanExistingNews,
  cleanXml,
  deduplicateAllNews,
  filterRecentNews,
  normalizeDate,
  normalizeTitle,
  refreshExistingNews,
  scoreRegulatoryRelevance,
  shouldAcceptAnalyzedNews
};
