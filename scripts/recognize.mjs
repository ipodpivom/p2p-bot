import { Ocr } from '../src/ocr.mjs';
import { parseOcr } from '../src/parser.mjs';
import { validate } from '../src/order.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
if (!process.argv[2]) throw new Error('Usage: node scripts/recognize.mjs image.png [result.json]');
const ocr = new Ocr(resolve('data'));
try {
  const result = await ocr.recognize(await readFile(process.argv[2]));
  const order = parseOcr(result);
  console.log(JSON.stringify({ order, validation: validate(order) }, null, 2));
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify({ ...result, order }, null, 2));
} finally { await ocr.close(); }
