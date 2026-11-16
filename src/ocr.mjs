import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);

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
    return { words, width, height };
  }
  async close() { for (const w of this.workers) await w.terminate(); this.workers = []; }
}
