import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECP_URL = 'https://www.secp.gov.pk/document/digital-lending-apps-being-run-and-administered-by-duly-licensed-lending-nbfcs/';

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

async function main() {
    console.log('SECP Auto-Updater Started:', new Date().toISOString());

  const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

  try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60000);

      console.log('Visiting SECP page...');
      await page.goto(SECP_URL, { waitUntil: 'networkidle2' });

      const pageInfo = await page.evaluate(() => {
        const link = document.querySelector('a[href*="wpdmdl"]');
        const text = document.body.innerText;
        const dates = text.match(/(\w+\s+\d{1,2},?\s+\d{4})/g);
        return {
          pdfUrl: link ? link.href : null,
          dates: dates ? dates.slice(0, 5) : []
      };
    });

      console.log('PDF URL:', pageInfo.pdfUrl);
      console.log('Dates found:', pageInfo.dates);

      if (pageInfo.pdfUrl) {
        const pdfBuffer = await downloadPDF(pageInfo.pdfUrl);
        if (pdfBuffer) {
          const apps = await parsePDF(pdfBuffer);
          if (apps && apps.nanoApps.length > 0) {
            updateHtml(apps, pageInfo.dates[0]);
          }
        }
      }
} catch (err) {
console.error('Error:', err.message);
} finally {
  await browser.close();
}

  console.log('Done');
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
