import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { parseOcr } from '../src/parser.mjs';
import { validate } from '../src/order.mjs';
import { stripHryvniaGlyph, prepareOcrImage, hasCompletionBadge } from '../src/ocr.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('fixtures/buy-zero-fee.json', import.meta.url)));
const ukrainian = () => JSON.parse(readFileSync(new URL('fixtures/buy-uk-padded.json', import.meta.url)));

test('Украинский PNG с боковыми полями: все данные покупки, ID и ник сохраняются точно', () => {
  const order = parseOcr(ukrainian());
  assert.deepEqual(order, { side: 'buy', status: 'completed', asset: 'USDT', currency: 'UAH', fiat: 566, price: 46.28,
    nominal: 12.22, fee: 0.07, total: 12.15, orderId: '20260000000000000004', createdAt: '2026-01-03 03:07:00', counterparty: 'SampleUkrSeller' });
  assert.deepEqual(validate(order).errors, []);
});

test('Завершити без подтверждённой галочки или внизу экрана не считается завершённым ордером', () => {
  const input = ukrainian(); input.completedBadge = false;
  assert.equal(parseOcr(input).status, null);
  input.completedBadge = true;
  for (const word of input.words) if (/Завершити/i.test(word.text)) word.y = 0.9;
  assert.equal(parseOcr(input).status, null);
});

test('Украинские подписи продажи не меняют учёт списания с комиссией', () => {
  const input = JSON.parse(readFileSync(new URL('fixtures/sell.json', import.meta.url)));
  const translations = new Map([['Продать','Продаж'],['Цена','Ціна'],['фиатной','фіату'],['Общее','Загальна'],['Комиссия','Комісія'],['Время','Час'],['Никнейм','Псевдонім']]);
  for (const word of input.words) word.text = translations.get(word.text) ?? word.text;
  const order = parseOcr(input);
  assert.equal(order.side, 'sell'); assert.equal(order.total, 42.5); assert.equal(order.nominal, 42.46); assert.equal(order.fee, 0.04);
  assert.deepEqual(validate(order).errors, []);
});

test('Тёмный RGBA PNG остаётся видимым после подготовки для OCR', async () => {
  const width=500, height=700, pixels=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const index=(y*width+x)*4, light=x>150&&x<350&&y>100&&y<160;
    pixels[index]=light?240:32; pixels[index+1]=light?240:38; pixels[index+2]=light?240:45; pixels[index+3]=255;
  }
  const image=await sharp(pixels,{raw:{width,height,channels:4}}).png().toBuffer();
  const {normalized}=await prepareOcrImage(image), metadata=await sharp(normalized).metadata(), stats=await sharp(normalized).stats();
  assert.equal(metadata.hasAlpha,false); assert.ok(stats.channels[0].max-stats.channels[0].min>200);
});

test('Чёрные боковые поля убираются без обрезания верхней и нижней части телефона', async () => {
  const width=900, height=1200, pixels=Buffer.alloc(width*height*3,0);
  for(let y=0;y<height;y++)for(let x=150;x<750;x++)for(let channel=0;channel<3;channel++)pixels[(y*width+x)*3+channel]=35;
  const image=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
  const prepared=await prepareOcrImage(image);
  assert.equal(prepared.width,1500); assert.ok(prepared.height>=2950&&prepared.height<=3020);
});

test('Зелёное кольцо без галочки не подтверждает статус; кольцо с галочкой подтверждает', async () => {
  const words=[{source:'full',text:'Завершити',x:0.45,y:0.18,width:0.2,height:0.02}];
  const render=async tick=>sharp(Buffer.from(`<svg width="500" height="900"><rect width="500" height="900" fill="#20262d"/><circle cx="198" cy="171" r="14" stroke="#28bb88" stroke-width="2.5" fill="none"/>${tick?'<path d="M190 171 L196 177 L207 164" stroke="#28bb88" stroke-width="3" fill="none"/>':''}</svg>`)).png().toBuffer();
  assert.equal(await hasCompletionBadge(await render(false),words,500,900),false);
  assert.equal(await hasCompletionBadge(await render(true),words,500,900),true);
});

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
