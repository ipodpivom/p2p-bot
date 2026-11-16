import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { parseOcr } from '../src/parser.mjs';
import { validate } from '../src/order.mjs';
import { stripHryvniaGlyph } from '../src/ocr.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('fixtures/buy-zero-fee.json', import.meta.url)));

test('Покупка без комиссии: разделённая запятая, 400 гривен и 8.73 USDT', () => {
  const result = parseOcr(fixture());
  assert.deepEqual(result, { side: 'buy', status: 'completed', asset: 'USDT', currency: 'UAH', fiat: 400, price: 45.8,
    nominal: 8.73, fee: 0, total: 8.73, orderId: '20260000000000000003', createdAt: '2026-01-02 02:18:58', counterparty: 'SamplePartner' });
  assert.deepEqual(validate(result).errors, []);
});

test('Раздельные OCR-слова вокруг запятой не теряют зачисленную сумму', () => {
  const input = fixture(); delete input.money;
  assert.equal(parseOcr(input).total, 8.73);
});

test('Цифра 2 вместо гривны исправляется чтением изображения, а не удалением первой цифры', () => {
  const input = fixture();
  for (const word of input.words) if (word.y > 0.29 && word.y < 0.33 && word.x > 0.7 && /400/.test(word.text)) word.text = '2400';
  assert.equal(parseOcr(input).fiat, 400);
  delete input.money;
  assert.equal(parseOcr(input).fiat, 2400);
  assert.ok(validate(parseOcr(input)).errors.length);
});

test('Сумма кошелька читается из строки получения, а при расхождении блокирует запись', () => {
  const input = fixture(); input.words = input.words.filter(word => word.y > 0.25);
  assert.equal(parseOcr(input).total, 8.73);
  input.words = input.words.filter(word => !(word.x > 0.46 && word.y > 0.38 && word.y < 0.42));
  assert.equal(parseOcr(input).total, null);
  const conflicting = fixture();
  for (const word of conflicting.words) if (word.source === 'full' && word.y < 0.25 && word.text === '73') word.text = '72';
  assert.equal(parseOcr(conflicting).total, null);
});

test('Настоящая начальная цифра 2 не удаляется как знак гривны', async () => {
  // Pixel mask of a printed digit 2, independently captured from the sell screenshot.
  const digit = [4064,16376,65532,61502,24590,14,15,14,30,60,120,248,1008,4032,8064,7936,31744,65535,65535,32766];
  const width = 70, height = 40, pixels = Buffer.alloc(width * height, 255);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 16; x++) if (digit[y] & (1 << (15 - x))) pixels[(y + 10) * width + x + 5] = 0;
  for (let y = 10; y < 30; y++) for (let x = 35; x < 45; x++) pixels[y * width + x] = 0;
  const image = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
  assert.equal(await stripHryvniaGlyph(image), null);
});
