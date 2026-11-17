import { number, round } from './order.mjs';

export function groupRows(words) {
  const rows = [];
  for (const word of [...words].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x)) {
    const cy = word.y + word.height / 2;
    let row = rows.find(r => Math.abs(r.cy - cy) < Math.max(0.004, word.height * 0.55));
    if (!row) { row = { cy, words: [] }; rows.push(row); }
    row.words.push(word);
  }
  return rows.map(r => ({ ...r, words: r.words.sort((a, b) => a.x - b.x), text: r.words.sort((a, b) => a.x - b.x).map(w => w.text).join(' ') }));
}

export function parseOcr(result) {
  const words = result.words.filter(w => w.text?.trim());
  const full = words.filter(w => w.source !== 'right'), right = words.filter(w => w.source === 'right');
  const rows = groupRows(full), rightRows = groupRows(right.length ? right : full.filter(w => w.x > 0.46));
  const text = rows.map(r => r.text).join('\n');
  const allText = words.map(w => w.text).join(' ');
  const leftText = row => row.words.filter(w => w.x < 0.46).map(w => w.text).join(' ');
  const findLabel = regex => rows.find(r => regex.test(leftText(r)));
  const amountLabel = findLabel(/ф[иі]ат|fiat/i), priceLabel = findLabel(/Цена|Ціна|Price/i);
  // The trade heading precedes fiat fields. Counterparty names must not influence the side.
  const heading = rows.filter(row => row.cy < (amountLabel?.cy ?? 0.4)).map(leftText).join('\n');
  const isBuy = /(?:^|\s)(?:Купить|Купити|Куп[іи]вля|Buy)(?=\s|USDT|$)/iu.test(heading);
  const isSell = /(?:^|\s)(?:Продать|Продати|Продаж|Sell)(?=\s|USDT|$)/iu.test(heading);
  const statusRows = rows.filter(row => row.cy < Math.min(0.25, amountLabel?.cy ?? 0.25));
  const explicitCompleted = statusRows.some(row => !/не\s*заверш|not\s+completed/iu.test(row.text) &&
    row.words.some(word => /^(?:Завершено|Завершена|Completed|Виконано|Успішно)$/iu.test(word.text)));
  const localizedCompleted = result.completedBadge === true && statusRows.some(row => row.words.some(word => /^Завершити$/iu.test(word.text)));
  const order = { side: isBuy && !isSell ? 'buy' : isSell && !isBuy ? 'sell' : null,
    status: explicitCompleted || localizedCompleted ? 'completed' : null,
    asset: /USDT/i.test(text) ? 'USDT' : null, currency: /\bUAH\b/i.test(allText) ? 'UAH' : null,
    fiat: null, price: null, nominal: null, fee: null, total: null, orderId: null, createdAt: null, counterparty: null };
  function aligned(label, limit = 0.025) {
    if (!label) return '';
    const row = [...rightRows].sort((a, b) => Math.abs(a.cy - label.cy) - Math.abs(b.cy - label.cy))[0];
    return row && Math.abs(row.cy - label.cy) <= limit ? row.text : '';
  }
  function numeric(text) {
    const found = text.replace(/[−–]/g, '-').match(/[-+]?\d[\d\s\u00a0]*[,.]?\d*/);
    return found ? number(found[0]) : null;
  }
  function alignedFull(label, limit) {
    if (!label) return '';
    const candidates = groupRows(full.filter(w => w.x > 0.46));
    const row = candidates.sort((a,b) => Math.abs(a.cy - label.cy) - Math.abs(b.cy - label.cy))[0];
    return row && Math.abs(row.cy - label.cy) < limit ? row.text : '';
  }
  // The Russian pass reads the hryvnia sign more reliably (English can turn ₴660 into 2660).
  order.fiat = Object.hasOwn(result.money ?? {}, 'fiat') ? number(result.money.fiat) : numeric(alignedFull(amountLabel, 0.03) || aligned(amountLabel, 0.03));
  order.price = Object.hasOwn(result.money ?? {}, 'price') ? number(result.money.price) : numeric(alignedFull(priceLabel, 0.025) || aligned(priceLabel));
  const feeLabel = findLabel(/Комисс|Коміс|Fee/i);
  const fee = numeric(aligned(feeLabel));
  order.fee = fee === null ? null : Math.abs(fee);
  // The large signed amount is the actual wallet credit/debit, never fiat / price.
  const joinedDecimal = text => text.replace(/(\d)\s*([,.])\s*(?=\d)/g, '$1$2');
  const hero = rows.find(r => /[-+−–]\s*\d[\d,.]*\s*USDT/i.test(joinedDecimal(r.text)) && r.cy < 0.25);
  const total = hero && joinedDecimal(hero.text).match(/[-+−–]\s*(\d+(?:[,.]\d+)?)\s*USDT/i);
  const heroTotal = total ? number(total[1]) : null;
  const nominalLabel = findLabel(/Общее|Загальна|Total/i);
  const displayedNominal = numeric(aligned(nominalLabel));
  // Read the second printed wallet amount too; never calculate it from nominal and fee.
  const receiptLabel = rows.find(r => /Количество|Кількість|Quantity|Amount/i.test(leftText(r)) &&
    rows.some(next => next.cy >= r.cy && next.cy - r.cy < 0.045 && /получени|отриман|receiv/i.test(leftText(next))));
  const detailTotal = order.side === 'buy' ? numeric(aligned(receiptLabel)) : order.side === 'sell' ? displayedNominal : null;
  order.total = heroTotal !== null && detailTotal !== null && Math.abs(heroTotal - detailTotal) > 0.000001 ? null : heroTotal ?? detailTotal;
  if (order.side === 'buy') order.nominal = displayedNominal;
  else {
    // On Binance sell screens "Общее кол-во" includes the fee. The transferred amount doesn't.
    const quantities = rightRows.filter(r => /USDT/i.test(r.text) && r.cy > (nominalLabel?.cy ?? 0.3) + 0.015 && r.cy < (feeLabel?.cy ?? 0.55) - 0.012);
    order.nominal = numeric(quantities[0]?.text ?? '');
  }
  const idLabel = findLabel(/ордера|ордеру|Order/i);
  const idCandidates = rightRows.map(r => ({ r, match: r.text.replace(/\s/g, '').match(/\d{15,30}/) })).filter(x => x.match);
  const id = idCandidates.sort((a, b) => Math.abs(a.r.cy - (idLabel?.cy ?? 0.55)) - Math.abs(b.r.cy - (idLabel?.cy ?? 0.55)))[0];
  order.orderId = id?.match[0] ?? null;
  const dateLabel = findLabel(/Время|Час|Created|Time/i);
  const dateLine = aligned(dateLabel, 0.025).replace(/\s*([:-])\s*/g, '$1');
  const match = dateLine.match(/(20\d{2}-\d{2}-\d{2})\s*(\d{2}:\d{2}:\d{2})/);
  if (match) order.createdAt = `${match[1]} ${match[2]}`;
  const nickLabel = findLabel(/Никнейм|Нікнейм|Псевдон[іи]м|Nickname/i);
  if (nickLabel) {
    const options = rightRows.filter(r => r.cy >= nickLabel.cy - 0.015 && r.cy < nickLabel.cy + 0.045 && !/UAH|USDT|\d{2}:\d{2}|20\d{2}-/.test(r.text));
    const candidate = options[0]?.words.filter(w => w.confidence >= 45 && /[\p{L}\p{N}]/u.test(w.text)).map(w => w.text).join(' ').trim();
    order.counterparty = candidate || options[0]?.text.replace(/[^\wА-Яа-яЁё.-]+$/g, '').trim() || null;
  }
  // No guesses for missing money, fees, IDs, timestamps or status: validation requires a correction.
  for (const key of ['fiat', 'price', 'nominal', 'fee', 'total']) if (order[key] !== null) order[key] = round(order[key]);
  return order;
}
