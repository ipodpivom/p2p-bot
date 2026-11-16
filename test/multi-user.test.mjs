import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.mjs';
import { UserSheets } from '../src/user-sheets.mjs';
import { Store } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';
import { parseOcr } from '../src/parser.mjs';
import { formulaSeparator, rowCells, HEADERS } from '../src/sheets.mjs';
import { initializeJournal } from '../src/journal-template.mjs';

const A = 'sheet_A_12345678901234567890', B = 'sheet_B_12345678901234567890', C = 'sheet_C_12345678901234567890';
const env = { TELEGRAM_BOT_TOKEN: `1234:${'x'.repeat(30)}`, ALLOWED_TELEGRAM_IDS: '42', GOOGLE_SPREADSHEET_ID: A };
const order = () => parseOcr(JSON.parse(readFileSync(new URL('fixtures/buy.json', import.meta.url))));

test('Config binds each authorized user to a distinct personal spreadsheet', () => {
  const cfg = config({ ...env, USER_SPREADSHEETS_JSON: JSON.stringify({ 77: B }) });
  assert.equal(cfg.userSpreadsheets.get('42'), A); assert.equal(cfg.userSpreadsheets.get('77'), B);
  assert.equal(cfg.allowedIds.has('77'), true);
  assert.throws(() => config({ ...env, USER_SPREADSHEETS_JSON: JSON.stringify({ 77: A }) }), /одну таблицу/);
  assert.throws(() => config({ ...env, ALLOWED_TELEGRAM_IDS: '42,77' }), /личная таблица/);
  for (const json of ['[]', 'null', '{invalid', '{"other":"id"}']) assert.throws(() => config({ ...env, USER_SPREADSHEETS_JSON: json }));
});

class MemorySheet {
  constructor(cfg) { this.cfg = cfg; this.orders = new Map(); }
  async api() { return {}; }
  async save(value) {
    if (this.orders.has(value.orderId)) return { existing: true, by: 'id', row: 13 };
    await this.api(':batchUpdate'); this.orders.set(value.orderId, value); return { existing: false, row: 13 };
  }
  async summary() { return `Summary for ${this.cfg.spreadsheetId}`; }
}
function context(t) {
  const directory = mkdtempSync(join(tmpdir(), 'p2p-user-test-'));
  const store = new Store(directory); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const cfg = config({ ...env, USER_SPREADSHEETS_JSON: JSON.stringify({ 77: B }) });
  let guarded = 0;
  const registry = new UserSheets(cfg, { factory: settings => new MemorySheet(settings), beforeWrite: () => { guarded++; } });
  const sent = [], telegram = {
    send: async (chat, text, markup) => { sent.push({ chat: String(chat), text, markup }); return { message_id: sent.length }; },
    answer: async () => {}, download: async () => Buffer.from('same screenshot'),
  };
  const bot = new Bot({ cfg, store, telegram, sheetsForUser: id => registry.get(id), ocr: { recognize: async () => order() } });
  const message = (id, text) => ({ message: { from: { id }, chat: { id, type: 'private' }, ...(text ? { text } : { document: { file_id: 'image', file_size: 10 } }) } });
  const click = (id, draft) => ({ callback_query: { id: 'callback', from: { id }, message: { chat: { id, type: 'private' } }, data: `save:${draft}` } });
  return { store, cfg, registry, bot, sent, message, click, guarded: () => guarded };
}
test('Two users save identical screenshots to their own books and get their own statistics', async t => {
  const c = context(t);
  await c.bot.handle(c.message(42)); await c.bot.handle(c.message(77));
  const first = c.store.pending('42')[0], second = c.store.pending('77')[0];
  assert.notEqual(first.id, second.id); assert.equal(first.spreadsheetId, A); assert.equal(second.spreadsheetId, B);
  await c.bot.handle(c.click(42, first.id)); await c.bot.handle(c.click(77, second.id));
  assert.equal(c.registry.get('42').orders.size, 1); assert.equal(c.registry.get('77').orders.size, 1); assert.equal(c.guarded(), 2);
  await c.bot.handle(c.message(77, '/stats')); assert.equal(c.sent.at(-1).text, `Summary for ${B}`);
  await c.bot.handle(c.message(42, '/table')); assert.ok(c.sent.at(-1).text.includes(A)); assert.ok(!c.sent.at(-1).text.includes(B));
  assert.throws(() => c.registry.get('999'), /не подключена/);
});
test('An authorized second user cannot confirm or list the first user draft', async t => {
  const c = context(t); await c.bot.handle(c.message(42)); const draft = c.store.pending('42')[0];
  await c.bot.handle(c.click(77, draft.id)); assert.equal(c.registry.get('42').orders.size, 0);
  await c.bot.handle(c.message(77, '/pending')); assert.equal(c.sent.at(-1).text, 'Нет ордеров, ожидающих подтверждения.');
});
test('Changing a binding never redirects an old draft; resending creates a new correctly bound draft', async t => {
  const c = context(t); await c.bot.handle(c.message(42)); const draft = c.store.pending('42')[0];
  c.cfg.userSpreadsheets.set('42', C);
  await c.bot.handle(c.click(42, draft.id)); assert.ok(c.sent.at(-1).text.includes('таблица изменилась'));
  assert.equal(c.registry.get('42').orders.size, 0);
  await c.bot.handle(c.message(42)); const fresh = c.store.pending('42').find(row => row.id !== draft.id);
  assert.equal(fresh.spreadsheetId, C);
});
test('Snapshots preserve user ownership and destination across restart, including old schema snapshots', t => {
  const c = context(t);
  c.store.create({ id: 'new', userId: '77', chatId: '77', hash: 'h', order: order(), spreadsheetId: B });
  const snapshot = c.store.snapshot(); c.store.restore(snapshot);
  assert.equal(c.store.draft('new', '77').spreadsheetId, B); assert.equal(c.store.draft('new', '42'), null);
  delete snapshot.drafts[0].spreadsheet_id; c.store.restore(snapshot);
  assert.equal(c.store.draft('new', '77').spreadsheetId, null);
});
test('Each book gets formulas compatible with its own locale', () => {
  assert.equal(formulaSeparator('ru_RU'), ';'); assert.equal(formulaSeparator('uk_UA'), ';');
  assert.equal(formulaSeparator('en_US'), ','); assert.equal(formulaSeparator('de_DE'), ';');
  const english = rowCells(order(), 13, ','); assert.ok(english[0].userEnteredValue.formulaValue.includes(',"",'));
  const russian = rowCells(order(), 13, ';'); assert.ok(russian[0].userEnteredValue.formulaValue.includes(';"";'));
});
test('Clean journal initialization creates a new tab, with empty data and exact headers', async () => {
  const calls = [], sheets = {
    cfg: { sheetName: 'P2P Учет' },
    api: async (path, options) => {
      if (path.startsWith('?')) return { properties: { locale: 'en_US' }, sheets: [{ properties: { sheetId: 0, title: 'Other user data' } }] };
      calls.push(JSON.parse(options.body)); return {};
    }, inspect: async () => {},
  };
  assert.equal((await initializeJournal(sheets)).created, true);
  const requests = calls[0].requests;
  assert.equal(requests[0].addSheet.properties.sheetId, 1);
  const header = requests.find(r => r.updateCells?.start?.rowIndex === 11).updateCells.rows[0].values;
  assert.deepEqual(header.map(c => c.userEnteredValue.stringValue), HEADERS);
  for (const request of requests) if (request.updateCells?.start?.rowIndex >= 12) {
    for (const row of request.updateCells.rows) for (const c of row.values) assert.ok(!c.userEnteredValue?.numberValue && !c.userEnteredValue?.stringValue);
  }
});
test('Initialization refuses an existing incompatible tab without overwriting it', async () => {
  let writes = 0;
  const sheets = { cfg: { sheetName: 'P2P Учет' }, api: async path => {
    if (path.startsWith('?')) return { properties: {}, sheets: [{ properties: { sheetId: 0, title: 'P2P Учет' } }] };
    writes++; return {};
  }, inspect: async () => { throw new Error('Wrong headers'); } };
  await assert.rejects(initializeJournal(sheets), /Wrong headers/); assert.equal(writes, 0);
});
