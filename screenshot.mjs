import puppeteer from 'puppeteer';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, 'temporary screenshots');
if (!existsSync(dir)) mkdirSync(dir);

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] ? `-${process.argv[3]}` : '';

const existing = readdirSync(dir).filter(f => f.endsWith('.png'));
const n = existing.length + 1;
const file = join(dir, `screenshot-${n}${label}.png`);

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
// Viewport-only screenshot to avoid timeout on very long pages
await page.screenshot({ path: file, fullPage: false });
await browser.close();
console.log(`Saved: ${file}`);
