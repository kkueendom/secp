● Read(SECP解读\scripts\scrape-secp.js)
  ⎿  Read 376 lines
                                                                                                                                                                                                                           ● /**
   * SECP Whitelist Auto-Updater                                                                                                                                                                                              * 自动抓取 SECP 官网的 Digital Lending App 白名单数据                                                                                                                                                                      */                                                                                                                                                                                                                                                                                                                                                                                                                                                   import puppeteer from 'puppeteer';
  import fs from 'fs';
  import path from 'path';
  import { fileURLToPath } from 'url';
  import https from 'https';

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // SECP 白名单页面 URL
  const SECP_WHITELIST_URL = 'https://www.secp.gov.pk/document/digital-lending-apps-being-run-and-administered-by-duly-licensed-lending-nbfcs/';

  // 现有的备注数据（从 index.html 中提取保留）
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

  // 为每个 APP 生成颜色
  const COLORS = [
    "#2ecc71", "#27ae60", "#1abc9c", "#16a085", "#e74c3c", "#c0392b",
    "#3498db", "#2980b9", "#0984e3", "#6c5ce7", "#0652DD", "#ffc312",
    "#009432", "#38ada9", "#00b894", "#d63031", "#e17055", "#2d3436"
  ];

  function getColor(index) {
    return COLORS[index % COLORS.length];
  }

  function generateId(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * 从 SECP 页面抓取白名单数据
   */
  async function scrapeWhitelist() {
    console.log('启动浏览器...');

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60000);

      console.log('访问 SECP 白名单页面...');
      await page.goto(SECP_WHITELIST_URL, { waitUntil: 'networkidle2' });

      const pageInfo = await page.evaluate(() => {
        const downloadLink = document.querySelector('a[href*="wpdmdl"]');
        const pdfUrl = downloadLink ? downloadLink.href : null;
        const dateText = document.body.innerText.match(/(?:Updated|Last Modified|Date)[:\s]*(\w+\s+\d{1,2},?\s+\d{4})/i);
        const updateDate = dateText ? dateText[1] : null;
        const allText = document.body.innerText;
        const dateMatch = allText.match(/(\w+\s+\d{1,2},?\s+\d{4})/g);

        return {
          pdfUrl,
          updateDate,
          possibleDates: dateMatch ? dateMatch.slice(0, 5) : []
        };
      });

      console.log('PDF URL:', pageInfo.pdfUrl);
      console.log('可能的更新日期:', pageInfo.possibleDates);

      if (pageInfo.pdfUrl) {
        console.log('下载 PDF...');
        const pdfData = await downloadPDF(pageInfo.pdfUrl);

        if (pdfData) {
          console.log('解析 PDF...');
          const apps = await parsePDF(pdfData);

          if (apps && apps.nanoApps.length > 0) {
            return {
              nanoApps: apps.nanoApps,
              otherApps: apps.otherApps,
              updateDate: findLatestDate(pageInfo.possibleDates)
            };
          }
        }
      }

      console.log('尝试从页面直接提取数据...');
      const pageApps = await page.evaluate(() => {
        const text = document.body.innerText;
        return { text: text.substring(0, 5000) };
      });

      console.log('页面内容预览:', pageApps.text.substring(0, 500));
      return null;

    } finally {
      await browser.close();
    }
  }

  function downloadPDF(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          downloadPDF(response.headers.location).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    });
  }

  async function parsePDF(pdfBuffer) {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(pdfBuffer);

      console.log('PDF 页数:', data.numpages);
      console.log('PDF 文本长度:', data.text.length);

      const text = data.text;
      const nanoApps = [];
      const otherApps = [];
      const lines = text.split('\n').filter(line => line.trim());

      let currentSection = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.includes('Nano Lending') || line.includes('Nano Finance')) {
          currentSection = 'nano';
          continue;
        }
        if (line.includes('Other Lending') || line.includes('BNPL') || line.includes('EWA')) {
          currentSection = 'other';
          continue;
        }

        const appMatch = line.match(/^\d+\.?\s*(.+?)(?:\s{2,}|\|)(.+?)(?:\s{2,}|\|)(.+)$/);
        if (appMatch) {
          const [, appName, nbfc, type] = appMatch;
          const app = {
            id: generateId(appName.trim()),
            name: appName.trim(),
            nbfc: nbfc.trim(),
            tag: type.trim(),
            color: getColor(currentSection === 'nano' ? nanoApps.length : otherApps.length),
            letter: appName.trim()[0].toUpperCase()
          };

          if (PRESERVED_NOTES[app.id]) {
            app.note = PRESERVED_NOTES[app.id];
          }

          if (currentSection === 'nano') {
            nanoApps.push(app);
          } else {
            otherApps.push(app);
          }
        }
      }

      console.log(`解析结果: Nano=${nanoApps.length}, Other=${otherApps.length}`);
      return { nanoApps, otherApps };

    } catch (error) {
      console.error('PDF 解析失败:', error.message);
      return null;
    }
  }

  function findLatestDate(dates) {
    if (!dates || dates.length === 0) return null;

    const parsed = dates.map(d => {
      try {
        return { original: d, date: new Date(d) };
      } catch {
        return null;
      }
    }).filter(d => d && !isNaN(d.date.getTime()));

    if (parsed.length === 0) return dates[0];
    parsed.sort((a, b) => b.date - a.date);
    return parsed[0].original;
  }

  function updateIndexHtml(data) {
    const indexPath = path.join(__dirname, '..', 'index.html');

    if (!fs.existsSync(indexPath)) {
      console.error('index.html 不存在:', indexPath);
      return false;
    }

    let html = fs.readFileSync(indexPath, 'utf-8');

    if (data.nanoApps && data.nanoApps.length > 0) {
      const nanoAppsStr = JSON.stringify(data.nanoApps, null, 6)
        .replace(/"([^"]+)":/g, '$1:')
        .replace(/"/g, '"');

      html = html.replace(
        /const nanoApps = \[[\s\S]*?\];/,
        `const nanoApps = ${nanoAppsStr};`
      );
    }

    if (data.otherApps && data.otherApps.length > 0) {
      const otherAppsStr = JSON.stringify(data.otherApps, null, 6)
        .replace(/"([^"]+)":/g, '$1:')
        .replace(/"/g, '"');

      html = html.replace(
        /const otherApps = \[[\s\S]*?\];/,
        `const otherApps = ${otherAppsStr};`
      );
    }

    if (data.updateDate) {
      const today = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      html = html.replace(/白名单更新：[\w\s,]+/, `白名单更新：${data.updateDate}`);
      html = html.replace(/新闻更新：[\w\s,]+/, `新闻更新：${today}`);
    }

    const totalApps = (data.nanoApps?.length || 14) + (data.otherApps?.length || 11);
    html = html.replace(/>\d+ 个已批准</, `>${totalApps} 个已批准<`);
    html = html.replace(/显示全部 \d+ 个 APP/g, `显示全部 ${totalApps} 个 APP`);

    fs.writeFileSync(indexPath, html, 'utf-8');
    console.log('index.html 已更新');
    return true;
  }

  async function main() {
    console.log('========================================');
    console.log('SECP 白名单自动更新脚本');
    console.log('时间:', new Date().toISOString());
    console.log('========================================\n');

    try {
      const data = await scrapeWhitelist();

      if (data && (data.nanoApps?.length > 0 || data.otherApps?.length > 0)) {
        console.log('\n抓取成功！');
        console.log(`Nano Lending Apps: ${data.nanoApps?.length || 0} 个`);
        console.log(`Other Lending Apps: ${data.otherApps?.length || 0} 个`);
        console.log(`更新日期: ${data.updateDate || '未知'}`);
        updateIndexHtml(data);
      } else {
        console.log('\n未能获取到新数据，保持现有数据不变');
      }

    } catch (error) {
      console.error('脚本执行失败:', error);
      process.exit(1);
    }

    console.log('\n========================================');
    console.log('脚本执行完成');
    console.log('========================================');
  }

  main();
