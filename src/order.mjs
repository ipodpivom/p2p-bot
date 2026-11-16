export const FIELDS = ['side', 'fiat', 'price', 'nominal', 'fee', 'total', 'orderId', 'createdAt', 'counterparty'];
export const round = (n, places = 8) => Math.round((n + Number.EPSILON) * 10 ** places) / 10 ** places;

export function number(text) {
  const clean = String(text ?? '').replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  return /^[-+]?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : null;
}

export function validDate(text) {
  if (!/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text ?? '')) return false;
  const date = new Date(text.replace(' ', 'T') + 'Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 19).replace('T', ' ') === text;
}

// Keep the wall-clock date printed by Binance. No implicit server timezone conversion.
export function dateSerial(text) {
  if (!validDate(text)) throw new Error('Неверная дата ордера.');
  return Date.parse(text.replace(' ', 'T') + 'Z') / 86400000 + 25569;
}

export function validate(order) {
  const errors = [], warnings = [];
  if (!['buy', 'sell'].includes(order.side)) errors.push('тип: buy или sell');
  if (order.status !== 'completed') errors.push('на скриншоте нет подтверждения «Завершено»');
  if (order.asset !== 'USDT' || order.currency !== 'UAH') errors.push('поддерживаются только USDT / UAH');
  for (const key of ['fiat', 'price', 'nominal', 'total']) {
    if (!Number.isFinite(order[key]) || order[key] <= 0) errors.push(`${key}: нужно число больше нуля`);
  }
  if (!Number.isFinite(order.fee) || order.fee < 0) errors.push('fee: нужна комиссия ≥ 0');
  if (typeof order.orderId !== 'string' || !/^\d{15,30}$/.test(order.orderId)) errors.push('orderId: нужны все цифры номера ордера в текстовом виде');
  if (!validDate(order.createdAt)) errors.push('createdAt: YYYY-MM-DD HH:mm:ss');
  if (typeof order.counterparty !== 'string' || !order.counterparty.trim() || order.counterparty.length > 120) errors.push('counterparty: укажи контрагента');
  if (Number.isFinite(order.nominal) && Number.isFinite(order.fee) && Number.isFinite(order.total)) {
    const expected = order.side === 'buy' ? order.nominal - order.fee : order.nominal + order.fee;
    if (Math.abs(expected - order.total) > 0.000001) errors.push('nominal / fee / total не сходятся: покупка = номинал − комиссия, продажа = номинал + комиссия');
    if (order.fee > order.nominal * 0.1) warnings.push('Комиссия больше 10% номинала — проверь скриншот.');
  }
  if (order.fiat > 0 && order.price > 0 && order.nominal > 0) {
    const difference = Math.abs(order.fiat / order.price - order.nominal);
    if (difference > 0.02) errors.push('fiat / price отличается от nominal более чем на 0,02 USDT');
  }
  return { errors, warnings };
}

const labels = { side: 'Тип', fiat: 'Сумма, ₴', price: 'Курс ордера', nominal: 'Номинал без комиссии, USDT', fee: 'Комиссия, USDT', total: 'Зачислено / списано, USDT', orderId: '№ ордера', createdAt: 'Дата и время', counterparty: 'Контрагент' };
export function preview(order, id) {
  const result = validate(order);
  return [`Ордер ${id}`, ...FIELDS.map(key => `${labels[key]}: ${key === 'side' ? ({ buy: 'Покупка', sell: 'Продажа' }[order.side] ?? 'не распознано') : (order[key] ?? 'не распознано')}`),
    ...(order.total > 0 && order.fiat > 0 ? [`Фактический курс: ${round(order.fiat / order.total, 4)} ₴/USDT`] : []),
    ...result.errors.map(e => `❗ ${e}`), ...result.warnings.map(e => `⚠ ${e}`),
    'Сверь номер, дату, суммы и комиссию со скриншотом.'].join('\n');
}

export function applyEdit(order, text) {
  const edited = { ...order };
  const lines = text.replace(/^\/edit(?:@\w+)?\s+[a-f0-9]+\s*/i, '').split('\n').filter(s => s.trim());
  if (!lines.length) throw new Error('Пришли поля в формате fiat=660, каждое с новой строки.');
  for (const line of lines) {
    const split = line.indexOf('=');
    const key = line.slice(0, split).trim(), value = line.slice(split + 1).trim();
    if (split < 1 || !FIELDS.includes(key)) throw new Error(`Неизвестное поле: ${key}.`);
    edited[key] = ['fiat', 'price', 'nominal', 'fee', 'total'].includes(key) ? number(value) : value;
  }
  return edited;
}
