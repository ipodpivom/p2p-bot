import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import { groupRows } from './parser.mjs';
const require = createRequire(import.meta.url);

// Normalized 16x20 mask of Binance's hryvnia glyph. Match pixels before removing it:
// stripping the OCR character "2" would also corrupt genuine amounts such as 2000.
const HRYVNIA = [2016,8184,16376,14396,28,28,28,65535,65535,0,0,65535,65535,30720,30720,14340,15390,16382,8184,2016];
export async function stripHryvniaGlyph(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().grayscale().threshold(170).raw().toBuffer({ resolveWithObject: true });
  let first = -1, last = -1;
  for (let x = 0; x <= info.width; x++) {
    let ink = 0;
    for (let y = 0; x < info.width && y < info.height; y++) if (data[y * info.width + x] < 128) ink++;
    if (ink >= 2 && first < 0) first = x;
    if (ink < 2 && first >= 0) { last = x - 1; break; }
  }
  if (first < 0 || last < first || last >= info.width - 4) return null;
  let top = info.height, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = first; x <= last; x++) {
    if (data[y * info.width + x] < 128) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  const glyphWidth = last - first + 1, glyphHeight = bottom - top + 1;
  if (glyphHeight < 10 || glyphWidth / glyphHeight < 0.4 || glyphWidth / glyphHeight > 1.2) return null;
  const glyph = await sharp(buffer).extract({ left: first, top, width: glyphWidth, height: glyphHeight }).grayscale().threshold(170).png().toBuffer();
  const mask = await sharp(glyph).resize(16, 20, { fit: 'fill', kernel: 'nearest' }).grayscale().raw().toBuffer();
  let differences = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 16; x++) {
    if ((mask[y * 16 + x] < 128) !== Boolean(HRYVNIA[y] & (1 << (15 - x)))) differences++;
  }
  if (differences / 320 > 0.18) return null;
  return sharp(buffer).extract({ left: last + 1, top: 0, width: info.width - last - 1, height: info.height })
    .extend({ left: 20, right: 20, top: 12, bottom: 12, background: 'white' }).png().toBuffer();
}

function flatten(blocks = []) {
  return blocks.flatMap(b => (b.paragraphs ?? []).flatMap(p => (p.lines ?? []).flatMap(l => l.words ?? [])));
}

export class Ocr {
  constructor(dataDir) { this.dataDir = dataDir; this.workers = []; }
  async init() {
    const models = join(this.dataDir, 'models');
    await mkdir(models, { recursive: true });
    for (const code of ['eng', 'rus']) {
      const base = dirname(require.resolve(`@tesseract.js-data/${code}`));
      await copyFile(join(base, '4.0.0_best_int', `${code}.traineddata.gz`), join(models, `${code}.traineddata.gz`));
    }
    for (const languages of [['rus', 'eng'], ['eng']]) {
      const worker = await createWorker(languages, 1, { langPath: models, cachePath: models, gzip: true, errorHandler: () => {} });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
      this.workers.push(worker);
    }
    return this;
  }
  async recognize(input) {
    if (!this.workers.length) await this.init();
    const image = sharp(input, { limitInputPixels: 24_000_000, failOn: 'error' }).rotate();
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error('Нужен PNG, JPEG или WebP.');
    if (metadata.width < 450 || metadata.height < 600) throw new Error('Скриншот слишком маленький. Отправь оригинал как файл.');
    const stats = await image.stats();
    const dark = stats.channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3 < 128;
    const normalized = await image.resize({ width: 1500, withoutEnlargement: false }).grayscale().negate(dark).normalize().png().toBuffer();
    const { width, height } = await sharp(normalized).metadata();
    const words = [];
    const read = async (worker, buffer, left = 0) => {
      const { data } = await worker.recognize(buffer, {}, { text: true, blocks: true });
      for (const word of flatten(data.blocks)) {
        words.push({ text: word.text, confidence: word.confidence, x: (word.bbox.x0 + left) / width, y: word.bbox.y0 / height,
          width: (word.bbox.x1 - word.bbox.x0) / width, height: (word.bbox.y1 - word.bbox.y0) / height, source: left ? 'right' : 'full' });
      }
    };
    await read(this.workers[0], normalized);
    // A separate English pass keeps long numeric IDs, times and Latin nicknames legible.
    const left = Math.floor(width * 0.46);
    await read(this.workers[1], await sharp(normalized).extract({ left, top: 0, width: width - left, height }).png().toBuffer(), left);
    // Small numeric crops avoid merging the currency glyph into the amount.
    const labels = groupRows(words.filter(w => w.source === 'full' && w.x < 0.46));
    const values = groupRows(words.filter(w => w.x > 0.46));
    const money = {};
    try {
      await this.workers[1].setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.,' });
      for (const [field, pattern] of [['fiat', /фиат|fiat/i], ['price', /Цена|Ціна|Price/i]]) {
        const label = labels.find(r => pattern.test(r.text));
        if (!label) continue;
        const value = values.filter(r => /\d/.test(r.text) && Math.abs(r.cy - label.cy) <= 0.03)
          .sort((a, b) => Math.abs(a.cy - label.cy) - Math.abs(b.cy - label.cy))[0];
        if (!value) continue;
        const pad = Math.ceil(height * 0.004);
        const top = Math.max(0, Math.floor(Math.min(...value.words.map(w => w.y)) * height) - pad);
        const bottom = Math.min(height, Math.ceil(Math.max(...value.words.map(w => w.y + w.height)) * height) + pad);
        const crop = await sharp(normalized).extract({ left, top, width: Math.floor(width * 0.95) - left, height: bottom - top }).png().toBuffer();
        const numeric = await stripHryvniaGlyph(crop);
        if (!numeric) continue;
        const { data } = await this.workers[1].recognize(numeric);
        money[field] = data.confidence >= 50 ? data.text.trim() : null;
      }
    } finally {
      await this.workers[1].setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '' });
    }
    return { words, width, height, money };
  }
  async close() { for (const w of this.workers) await w.terminate(); this.workers = []; }
}
