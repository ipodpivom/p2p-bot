import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOcr } from '../src/parser.mjs';
import { validate, applyEdit, dateSerial } from '../src/order.mjs';
import { Sheets, HEADERS, nextRow, findExisting, rowCells } from '../src/sheets.mjs';
import { Store, acquireLock } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';
import { DurableStore } from '../src/firestore.mjs';

const fixture = side => JSON.parse(readFileSync(new URL(`fixtures/${side}.json`, import.meta.url)));
const buy = () => parseOcr(fixture('buy'));
const sell = () => parseOcr(fixture('sell'));
const cfg = { spreadsheetId: 'fake-sheet-id', sheetName: 'P2P Учет', maxSheetRow: 1000, maxFileBytes: 12e6, allowedIds: new Set(['42']) };

test('Обезличенный пример OCR покупки: точные суммы, дата, длинный ID и ник', () => {
  assert.deepEqual(buy(), { side: 'buy', status: 'completed', asset: 'USDT', currency: 'UAH', fiat: 660, price: 46.07, nominal: 14.32, fee: 0.07, total: 14.25, orderId: '20260000000000000001', createdAt: '2026-01-01 02:22:26', counterparty: 'SampleSeller' });
  assert.deepEqual(validate(buy()).errors, []);
});
test('Обезличенный пример OCR продажи: комиссия включена в списанные 42,5 USDT', () => {
  assert.deepEqual(sell(), { side: 'sell', status: 'completed', asset: 'USDT', currency: 'UAH', fiat: 2000, price: 47.1, nominal: 42.46, fee: 0.04, total: 42.5, orderId: '20260000000000000002', createdAt: '2026-01-01 01:14:26', counterparty: 'SampleBuyer' });
  assert.deepEqual(validate(sell()).errors, []);
});
test('Не угадывает комиссию или дату на обрезанном скриншоте', () => {
  const f = fixture('buy'); f.words = f.words.filter(w => w.y < 0.42);
  assert.ok(validate(parseOcr(f)).errors.length > 0);
});
test('Слова Buy и Sell в нике контрагента не определяют тип сделки', () => {
  for (const [side, before, after] of [['sell', 'SampleBuyer', 'SampleBuyer'], ['buy', 'SampleSeller', 'SellPartner']]) {
    const input = fixture(side);
    input.words = input.words.map(word => word.text === before ? { ...word, text: after } : word);
    assert.equal(parseOcr(input).side, side);
  }
});
test('Запрещает незавершённые ордера, другую валюту и несовместимые суммы', () => {
  for (const change of [{ status: 'cancelled' }, { currency: 'USD' }, { total: 14.32 }, { fee: -0.07 }, { orderId: 20260000000000000001 }, { fiat: 2660 }, { createdAt: '2026-02-31 02:22:26' }]) assert.ok(validate({ ...buy(), ...change }).errors.length, JSON.stringify(change));
});
test('Исправление с десятичной запятой сохраняет ID как строку', () => {
  const edited = applyEdit(buy(), 'fiat=660,00\norderId=20260000000000000001');
  assert.equal(edited.fiat, 660); assert.equal(edited.orderId, buy().orderId);
  assert.throws(() => applyEdit(buy(), 'unknown=1'));
});
test('Дата не зависит от часового пояса сервера', () => { assert.ok(Math.abs(dateSerial(buy().createdAt) - 46023.098912037036) < 1e-8); });
test('Следующая строка игнорирует заранее протянутые формулы', () => {
  const rows = Array.from({ length: 148 }, () => ['', '', '', '', '', '', '', '', '', '']);
  rows[0] = [46337, 'Покупка', 'nickname', 660, 46.07, 14.32, 0.07, 14.25, 46.3, 'long-id'];
  assert.equal(nextRow(rows), 14);
  rows[3][6] = 0; assert.equal(nextRow(rows), 17);
});
test('Поиск повторов сохраняет все 20 цифр номера и замечает старые записи без ID', () => {
  const o = buy(), row = [dateSerial(o.createdAt), 'Покупка', o.counterparty, o.fiat, o.price, o.nominal, o.fee, o.total, 46.32, o.orderId];
  assert.deepEqual(findExisting([row], o), { row: 13, by: 'id' });
  row[9] = '—'; assert.deepEqual(findExisting([row], o), { row: 13, by: 'fingerprint' });
});
test('Ник с = не становится формулой, ID хранится текстом, номинал берётся со скриншота', () => {
  const cells = rowCells({ ...buy(), counterparty: '=IMPORTXML("bad")' }, 40);
  assert.equal(cells[3].userEnteredValue.stringValue, '=IMPORTXML("bad")');
  assert.equal(cells[6].userEnteredValue.numberValue, 14.32);
  assert.equal(cells[10].userEnteredValue.stringValue, buy().orderId);
});

class FakeSheets extends Sheets {
  constructor(rows = []) { super(cfg); this.rows = rows; this.grid = 160; this.writes = 0; this.loseResponse = false; }
  async api(path, options) {
    if (path.startsWith('?fields=')) return { properties: { timeZone: 'Europe/Simferopol' }, sheets: [{ properties: { sheetId: 0, title: cfg.sheetName, gridProperties: { rowCount: this.grid } } }] };
    if (path.startsWith('/values/')) {
      const range = decodeURIComponent(path.split('/values/')[1].split('?')[0]).split('!')[1];
      if (range === 'B12:L12') return { values: [HEADERS] };
      const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (!match) throw new Error(`Unexpected range ${range}`);
      const start = Number(match[2]), end = Number(match[4]);
      if (end > this.grid) throw new Error('Outside grid');
      if (match[1] === 'L') return { values: this.rows.slice(start - 13, end - 12).map(r => [r[9]]) };
      return { values: this.rows.slice(start - 13, end - 12) };
    }
    if (path === ':batchUpdate') {
      const { requests } = JSON.parse(options.body); this.lastRequests = requests;
      for (const req of requests) {
        if (req.appendDimension) this.grid += req.appendDimension.length;
        if (req.updateCells) {
          const cells = req.updateCells.rows[0].values, idx = req.updateCells.range.startRowIndex - 12;
          const vals = cells.slice(1).map(c => c.userEnteredValue.numberValue ?? c.userEnteredValue.stringValue ?? '');
          vals[7] = vals[1] === 'Покупка' ? vals[5] - vals[6] : vals[5] + vals[6];
          this.rows[idx] = vals; this.writes++;
        }
      }
      if (this.loseResponse) { this.loseResponse = false; throw new Error('Response lost after commit'); }
      return {};
    }
    throw new Error(`Unexpected API ${path}`);
  }
}
test('Sheets: запись + проверка ID, повтор не добавляет строку', async () => {
  const sheets = new FakeSheets();
  assert.deepEqual(await sheets.save(buy()), { existing: false, row: 13 });
  assert.equal(sheets.rows[0][7], 14.25);
  assert.deepEqual(await sheets.save(buy()), { existing: true, by: 'id', row: 13 });
  assert.equal(sheets.writes, 1);
});
test('Sheets: потеря ответа после записи восстанавливается по ID без дубликата', async () => {
  const sheets = new FakeSheets(); sheets.loseResponse = true;
  await assert.rejects(sheets.save(sell()), /Response lost/);
  assert.equal((await sheets.save(sell())).existing, true); assert.equal(sheets.writes, 1);
});
test('Sheets: добавляет место после конца сетки и не выходит за сводные формулы', async () => {
  const rows = Array.from({ length: 148 }, (_, i) => [46337 + i, 'Покупка', 'old', 1, 1, 1, 0, 1, 1, String(i)]);
  const sheets = new FakeSheets(rows);
  assert.equal((await sheets.save(buy())).row, 161); assert.ok(sheets.grid > 160);
  const full = new FakeSheets(Array.from({ length: 988 }, (_, i) => [46337+i, 'Покупка', 'old', 1, 1, 1, 0, 1, 1, String(i)])); full.grid = 1000;
  await assert.rejects(full.save(buy()), /строка 1000/);
});
test('Sheets: ошибка заголовка останавливает запись', async () => {
  const sheets = new FakeSheets(); sheets.values = async () => [['Changed header']];
  await assert.rejects(sheets.save(buy()), /Структура/); assert.equal(sheets.writes, 0);
});

function context(t) {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-bot-test-'));
  const store = new Store(dir); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const sent = [];
  const telegram = { send: async (chat, text, markup) => { sent.push({ chat, text, markup }); return { message_id: sent.length }; }, answer: async () => {}, download: async () => Buffer.from('test image') };
  const sheets = new FakeSheets(); let recognitions = 0;
  const bot = new Bot({ cfg, store, telegram, sheets, ocr: { recognize: async () => { recognitions++; return buy(); } } });
  const message = { update_id: 10, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, document: { file_id: 'photo', file_size: 10 } } };
  const click = (id, action = 'save', userId = 42) => ({ callback_query: { id: 'cb', from: { id: userId }, message: { chat: { id: 42, type: 'private' } }, data: `${action}:${id}` } });
  return { dir, store, sent, sheets, bot, message, click, count: () => recognitions };
}
test('Бот: скриншот → предпросмотр → отдельное подтверждение → запись', async t => {
  const c = context(t); await c.bot.handle(c.message);
  assert.equal(c.sheets.writes, 0); assert.equal(c.store.pending('42').length, 1);
  const draft = c.store.pending('42')[0]; await c.bot.handle(c.click(draft.id));
  assert.equal(c.sheets.writes, 1); assert.equal(c.store.draft(draft.id, '42').status, 'saved');
  await c.bot.handle(c.click(draft.id)); await c.bot.handle(c.message);
  assert.equal(c.sheets.writes, 1); assert.equal(c.count(), 1);
});
test('Бот: чужой пользователь и групповой чат не могут распознавать или сохранять', async t => {
  const c = context(t); c.message.message.from.id = 99; await c.bot.handle(c.message);
  c.message.message.from.id = 42; c.message.message.chat.type = 'group'; await c.bot.handle(c.message);
  assert.equal(c.count(), 0); assert.equal(c.sheets.writes, 0);
});

test('Бот: повторная отправка ошибочного черновика запускает OCR заново и сохраняет тот же ID', async t => {
  const c = context(t); let calls = 0;
  c.bot.ocr.recognize = async () => ++calls === 1 ? { ...buy(), fiat: 2660, total: null } : buy();
  await c.bot.handle(c.message);
  const first = c.store.pending('42')[0];
  assert.equal(first.order.total, null);
  assert.equal(c.sent.at(-1).markup.inline_keyboard.some(row => row.some(button => button.callback_data.startsWith('save:'))), false);
  await c.bot.handle(c.message);
  assert.equal(calls, 2);
  const pending = c.store.pending('42');
  assert.equal(pending.length, 1); assert.equal(pending[0].id, first.id);
  assert.deepEqual(validate(pending[0].order).errors, []); assert.equal(c.sheets.writes, 0);
  await c.bot.handle(c.message); assert.equal(calls, 2);
});
test('Бот: сбой Sheets оставляет подтверждение доступным после перезапуска', async t => {
  const c = context(t); await c.bot.handle(c.message);
  const draft = c.store.pending('42')[0]; c.sheets.loseResponse = true;
  await c.bot.handle(c.click(draft.id)); assert.equal(c.store.draft(draft.id, '42').status, 'pending');
  const secondStore = new Store(c.dir);
  assert.equal(secondStore.draft(draft.id, '42').order.orderId, buy().orderId); secondStore.close();
  await c.bot.handle(c.click(draft.id)); assert.equal(c.sheets.writes, 1); assert.equal(c.store.draft(draft.id, '42').status, 'saved');
});
test('Бот: чужой ID не может подтвердить сохранённый черновик', async t => {
  const c = context(t); await c.bot.handle(c.message); const draft = c.store.pending('42')[0];
  await c.bot.handle(c.click(draft.id, 'save', 99)); assert.equal(c.sheets.writes, 0);
});
test('SQLite хранит offset и черновики, блокировка не даёт запустить вторую копию', t => {
  const c = context(t); c.store.set('offset', 123);
  const release = acquireLock(c.dir); assert.throws(() => acquireLock(c.dir), /другой процесс/); release();
  const second = new Store(c.dir); assert.equal(second.get('offset'), '123'); second.close();
});
test('Бот: не показывает подтверждение черновика, если облачное сохранение не удалось', async t => {
  const c = context(t);
  c.bot.store = new DurableStore(c.store, { assertLease() {}, save: async () => { throw new Error('storage offline'); } });
  await c.bot.handle(c.message);
  assert.equal(c.store.pending('42').length, 0);
  assert.equal(c.sent.filter(m => m.markup?.inline_keyboard).length, 0);
  assert.ok(c.sent.at(-1).text.includes('storage offline'));
});
