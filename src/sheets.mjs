import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { jsonRequest } from './http.mjs';
import { dateSerial, validate } from './order.mjs';
export const HEADERS = ['№', 'Дата и время', 'Тип сделки', 'Контрагент', 'Сумма (UAH)', 'Курс ордера (UAH/USDT)', 'Номинал без комиссии (USDT)', 'Комиссия биржи (USDT)', 'Итого USDT', 'Реальный курс (UAH/USDT)', '№ Ордера'];
export const a1 = name => `'${name.replaceAll("'", "''")}'`;
const text = s => ({ userEnteredValue: { stringValue: String(s) } });
const num = n => ({ userEnteredValue: { numberValue: n } });
const formula = f => ({ userEnteredValue: { formulaValue: f } });

export function formulaSeparator(locale = 'ru_RU') {
  const decimal = new Intl.NumberFormat(locale.replaceAll('_', '-'), { numberingSystem: 'latn' }).formatToParts(1.1).find(part => part.type === 'decimal')?.value;
  return decimal === ',' ? ';' : ',';
}
export function rowCells(order, row, separator = ';') {
  const f = value => formula(value.replaceAll(';', separator));
  return [f(`=IF(F${row}="";"";ROW()-12)`),
    { ...num(dateSerial(order.createdAt)), userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' } } },
    text(order.side === 'buy' ? 'Покупка' : 'Продажа'), text(order.counterparty), num(order.fiat), num(order.price), num(order.nominal), num(order.fee),
    f(`=IF(H${row}="";"";IF(D${row}="Покупка";H${row}-I${row};H${row}+I${row}))`),
    f(`=IFERROR(F${row}/J${row};"")`), text(order.orderId)];
}

export function findExisting(rows, order) {
  for (let i = 0; i < rows.length; i++) {
    // Input range is C:L; long IDs remain strings, never Number().
    if (String(rows[i][9] ?? '') === order.orderId) return { row: i + 13, by: 'id' };
  }
  // Legacy rows with a missing order ID: flag an exact date / side / money match for manual review.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const date = typeof r[0] === 'number' ? r[0] : NaN;
    if (Math.abs(date - dateSerial(order.createdAt)) < 1 / 86400 && r[1] === (order.side === 'buy' ? 'Покупка' : 'Продажа') && Math.abs(Number(r[3]) - order.fiat) < 0.005 && Math.abs(Number(r[4]) - order.price) < 0.000001) {
      return { row: i + 13, by: 'fingerprint' };
    }
  }
  return null;
}

export function nextRow(rows) {
  let last = -1;
  // Skip prefilled formulas in H, J and K; preserve any manually entered input or ID.
  rows.forEach((r, i) => { if ([0, 1, 2, 3, 4, 6, 9].some(c => r[c] !== '' && r[c] != null)) last = i; });
  return last + 14;
}

export class Sheets {
  constructor(cfg, request = jsonRequest) { this.cfg = cfg; this.request = request; this.access = new Map(); }
  async token(scope = 'https://www.googleapis.com/auth/spreadsheets') {
    const cached = this.access.get(scope);
    if (cached?.until > Date.now() + 60000) return cached.token;
    let key;
    try { key = JSON.parse(await readFile(this.cfg.credentialsPath, 'utf8')); }
    catch { throw new Error('Не найден или повреждён JSON-ключ Google service account.'); }
    if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new Error('Нужен ключ сервисного аккаунта Google.');
    const now = Math.floor(Date.now() / 1000), base64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${base64({ alg: 'RS256', typ: 'JWT' })}.${base64({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signer = createSign('RSA-SHA256'); signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(key.private_key).toString('base64url')}`;
    const result = await this.request('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) }, 'Google OAuth');
    this.access.set(scope, { token: result.access_token, until: Date.now() + result.expires_in * 1000 });
    return result.access_token;
  }
  async api(path = '', options = {}) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${this.cfg.spreadsheetId}${path}`, {
      ...options, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
    }, 'Google Sheets');
  }
  async metadata() {
    const metadata = await this.api('?fields=spreadsheetId,properties(timeZone,locale),sheets(properties(sheetId,title,gridProperties))');
    const sheet = metadata.sheets.find(s => s.properties.title === this.cfg.sheetName)?.properties;
    if (!sheet) throw new Error(`Не найден лист «${this.cfg.sheetName}».`);
    return { sheet, timezone: metadata.properties.timeZone, locale: metadata.properties.locale || 'ru_RU' };
  }
  async values(range, render = 'UNFORMATTED_VALUE') {
    const r = await this.api(`/values/${encodeURIComponent(`${a1(this.cfg.sheetName)}!${range}`)}?valueRenderOption=${render}`);
    return r.values ?? [];
  }
  async inspect() {
    const meta = await this.metadata();
    const headers = (await this.values('B12:L12'))[0] ?? [];
    if (HEADERS.some((v, i) => v !== headers[i])) throw new Error('Структура B12:L12 изменилась. Запись остановлена, чтобы не попасть в чужие колонки.');
    return meta;
  }
  async save(order) {
    const check = validate(order);
    if (check.errors.length) throw new Error(`Сначала исправь поля: ${check.errors.join('; ')}`);
    const { sheet, locale } = await this.inspect();
    const rows = await this.values(`C13:L${sheet.gridProperties.rowCount}`);
    const existing = findExisting(rows, order);
    if (existing) return { existing: true, ...existing };
    const row = nextRow(rows);
    if (row > this.cfg.maxSheetRow) throw new Error('Достигнута строка 1000: сначала расширь диапазоны сводных формул. Ордер не записан.');
    const requests = [];
    if (row > sheet.gridProperties.rowCount) requests.push({ appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: row - sheet.gridProperties.rowCount + 50 } });
    const range = { sheetId: sheet.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 1, endColumnIndex: 12 };
    // One atomic write contains values, formulas, exact string ID, formatting and dropdown.
    requests.push({ copyPaste: { source: { ...range, startRowIndex: 12, endRowIndex: 13 }, destination: range, pasteType: 'PASTE_FORMAT' } });
    requests.push({ updateCells: { range, rows: [{ values: rowCells(order, row, formulaSeparator(locale)) }], fields: 'userEnteredValue' } });
    requests.push({ repeatCell: { range: { ...range, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' } } }, fields: 'userEnteredFormat.numberFormat' } });
    requests.push({ setDataValidation: { range: { ...range, startColumnIndex: 3, endColumnIndex: 4 }, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Покупка' }, { userEnteredValue: 'Продажа' }] }, strict: true, showCustomUi: true } } });
    // Recheck destination immediately before writing. Use one bot instance and don't edit this row concurrently.
    if (row <= sheet.gridProperties.rowCount) {
      const occupied = await this.values(`C${row}:L${row}`);
      if (nextRow(occupied) !== 13) throw new Error('Строка занята другим изменением. Нажми подтверждение ещё раз.');
    }
    await this.api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
    const savedId = (await this.values(`L${row}:L${row}`))[0]?.[0];
    if (savedId !== order.orderId) throw new Error('Не удалось подтвердить запись. Нажми подтверждение снова: номер ордера защитит от повтора.');
    return { existing: false, row };
  }
  async summary() {
    const rows = await this.values('B4:K9', 'FORMATTED_VALUE');
    const at = (r, c) => rows[r - 4]?.[c - 2] ?? '—';
    return `Показатели из таблицы (по текущим формулам):\nКуплено на: ${at(5,2)}\nПродано на: ${at(5,4)}\nБаланс: ${at(5,6)}\nРезультат с оценкой остатка: ${at(5,10)}\nРеализованный профит по формуле таблицы: ${at(7,10)}\nКурс оценки остатка (вводится вручную): ${at(9,6)}`;
  }
}
