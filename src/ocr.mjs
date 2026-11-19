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

export async function prepareOcrImage(input) {
  const source = sharp(input, { limitInputPixels: 24_000_000, failOn: 'error' }).rotate();
  const metadata = await source.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error('Нужен PNG, JPEG или WebP.');
  if (metadata.width < 450 || metadata.height < 600) throw new Error('Скриншот слишком маленький. Отправь оригинал как файл.');
  // Inverting an opaque RGBA PNG also inverted alpha to zero and made OCR see a blank image.
  let opaque = await source.flatten({ background: 'white' }).removeAlpha().png().toBuffer();
  const rotated = await sharp(opaque).metadata();
  const { data: thumbnail, info } = await sharp(opaque).resize({ width: Math.min(256, rotated.width) }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const isBlackColumn = x => {
    for (let y = 0; y < info.height; y++) if (thumbnail[y * info.width + x] > 8) return false;
    return true;
  };
  let first = 0, end = info.width;
  while (first < end && isBlackColumn(first)) first++;
  while (end > first && isBlackColumn(end - 1)) end--;
  // Remove substantial empty side bars, preserving all vertical content and phone UI margins.
  if (end - first >= info.width * 0.45 && info.width - end + first >= info.width * 0.1) {
    const left = Math.floor(first * rotated.width / info.width);
    const right = Math.ceil(end * rotated.width / info.width);
    opaque = await sharp(opaque).extract({ left, top: 0, width: right - left, height: rotated.height }).png().toBuffer();
  }
  const color = await sharp(opaque).resize({ width: 1500 }).png().toBuffer();
  const stats = await sharp(color).stats();
  const dark = stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3 < 128;
  const gray = sharp(color).grayscale();
  if (dark) gray.negate({ alpha: false });
  const normalized = await gray.normalize().png().toBuffer();
  const { width, height } = await sharp(normalized).metadata();
  return { normalized, color, width, height };
}

export async function hasCompletionBadge(color, words, width, height) {
  const status = words.find(word => word.source === 'full' && word.y < 0.25 && /^Завершити$/iu.test(word.text));
  if (!status) return false;
  const textHeight = status.height * height;
  const right = Math.floor(status.x * width) - 4;
  const left = Math.max(0, Math.floor(right - textHeight * 3));
  const top = Math.max(0, Math.floor(status.y * height - textHeight * 0.5));
  const bottom = Math.min(height, Math.ceil((status.y + status.height) * height + textHeight * 0.5));
  if (right <= left || bottom <= top) return false;
  const { data, info } = await sharp(color).extract({ left, top, width: right - left, height: bottom - top }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const green = (x, y) => {
    const index = (y * info.width + x) * info.channels;
    const [red, value, blue] = data.subarray(index, index + 3);
    return value > 85 && value > red * 1.35 && value > blue * 1.08;
  };
  let x0 = info.width, x1 = -1, y0 = info.height, y1 = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (green(x, y)) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const diameter = x1 - x0 + 1, badgeHeight = y1 - y0 + 1;
  if (diameter < width * 0.01 || diameter / badgeHeight < 0.75 || diameter / badgeHeight > 1.3) return false;
  const hit = (fx, fy) => {
    const cx = x0 + fx * (diameter - 1), cy = y0 + fy * (badgeHeight - 1), radius = Math.max(2, Math.ceil(diameter * 0.1));
    for (let y = Math.max(y0, Math.floor(cy - radius)); y <= Math.min(y1, Math.ceil(cy + radius)); y++)
      for (let x = Math.max(x0, Math.floor(cx - radius)); x <= Math.min(x1, Math.ceil(cx + radius)); x++) if (green(x, y)) return true;
    return false;
  };
  // Require the surrounding ring AND the inner check; green text alone is insufficient.
  return [[0.5,0.03],[0.97,0.5],[0.5,0.97],[0.03,0.5],[0.28,0.5],[0.43,0.64],[0.7,0.35]].every(([x,y]) => hit(x,y));
}

export class Ocr {
  constructor(dataDir) { this.dataDir = dataDir; this.workers = []; }
  async init() {
    const models = join(this.dataDir, 'models');
    await mkdir(models, { recursive: true });
    for (const code of ['eng', 'rus', 'ukr']) {
      const base = dirname(require.resolve(`@tesseract.js-data/${code}`));
      await copyFile(join(base, '4.0.0_best_int', `${code}.traineddata.gz`), join(models, `${code}.traineddata.gz`));
    }
    for (const languages of [['rus', 'ukr', 'eng'], ['eng']]) {
      const worker = await createWorker(languages, 1, { langPath: models, cachePath: models, gzip: true, errorHandler: () => {} });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
      this.workers.push(worker);
    }
    return this;
  }
  async recognize(input) {
    if (!this.workers.length) await this.init();
    const { normalized, color, width, height } = await prepareOcrImage(input);
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
    if (!words.length) throw new Error('На изображении не удалось прочитать текст.');
    const completedBadge = await hasCompletionBadge(color, words, width, height);
    // Small numeric crops avoid merging the currency glyph into the amount.
    const labels = groupRows(words.filter(w => w.source === 'full' && w.x < 0.46));
    const values = groupRows(words.filter(w => w.x > 0.46));
    const money = {};
    const hryvniaFields = [];
    try {
      await this.workers[1].setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.,' });
      for (const [field, pattern] of [['fiat', /ф[иі]ат|fiat/i], ['price', /Цена|Ціна|Price/i]]) {
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
        hryvniaFields.push(field);
        const { data } = await this.workers[1].recognize(numeric);
        money[field] = data.confidence >= 50 ? data.text.trim() : null;
      }
    } finally {
      await this.workers[1].setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '' });
    }
    return { words, width, height, money, completedBadge, hryvniaFields };
  }
  async close() { for (const w of this.workers) await w.terminate(); this.workers = []; }
}
