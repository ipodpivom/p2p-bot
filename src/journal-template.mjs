import { HEADERS, formulaSeparator } from './sheets.mjs';

export async function initializeJournal(sheets) {
  const metadata = await sheets.api('?fields=properties(locale),sheets(properties(sheetId,title))');
  const existing = metadata.sheets.find(s => s.properties.title === sheets.cfg.sheetName);
  if (existing) {
    await sheets.inspect();
    return { created: false }; // A matching existing journal is left intact; other layouts fail inspection.
  }
  const sheetId = Math.max(0, ...metadata.sheets.map(s => s.properties.sheetId)) + 1;
  const separator = formulaSeparator(metadata.properties.locale || 'ru_RU');
  const cell = value => ({ userEnteredValue: String(value).startsWith('=') ? { formulaValue: value.replaceAll(';', separator) } : { stringValue: value } });
  const range = (r1, r2, c1, c2) => ({ sheetId, startRowIndex: r1 - 1, endRowIndex: r2, startColumnIndex: c1 - 1, endColumnIndex: c2 });
  const write = (row, column, values) => ({ updateCells: { start: { sheetId, rowIndex: row - 1, columnIndex: column - 1 }, rows: [{ values: values.map(cell) }], fields: 'userEnteredValue' } });
  const requests = [
    { addSheet: { properties: { sheetId, title: sheets.cfg.sheetName, gridProperties: { rowCount: 1000, columnCount: 15, frozenRowCount: 12 } } } },
    write(2, 2, ['P2P: личный журнал операций USDT / UAH']),
    write(3, 2, ['Вводи номинал и комиссию из ордера. Курс оценки остатка — F9.']),
    write(4, 2, ['Покупки, UAH', '', 'Продажи, UAH', '', 'Баланс, USDT', '', 'Комиссии, USDT', '', 'Результат с оценкой остатка']),
    write(5, 2, ['=SUMIF(D13:D1000;"Покупка";F13:F1000)', '', '=SUMIF(D13:D1000;"Продажа";F13:F1000)', '', '=ROUND(B7-D7;8)', '', '=SUM(I13:I1000)', '', '=IF(F9="";"";ROUND(D5+F7-B5;2))']),
    write(6, 2, ['Куплено нетто, USDT', '', 'Списано при продажах, USDT', '', 'Оценка остатка, UAH', '', 'Оценка комиссий, UAH', '', 'Продажи по средней всех покупок']),
    write(7, 2, ['=SUMIF(D13:D1000;"Покупка";J13:J1000)', '', '=SUMIF(D13:D1000;"Продажа";J13:J1000)', '', '=IF(F9="";"";ROUND(F5*F9;2))', '', '=ROUND(SUMPRODUCT(I13:I1000;G13:G1000);2)', '', '=IFERROR(ROUND(D5-D7*B9;2);"")']),
    write(8, 2, ['Средний курс покупки', '', 'Средний курс продажи', '', 'Курс оценки (введи вручную)', '', 'Комиссии / движение USDT', '', 'Результат / оборот покупок']),
    write(9, 2, ['=IFERROR(B5/B7;"")', '', '=IFERROR(D5/D7;"")', '', '', '', '=IFERROR(H5/(B7+D7);"")', '', '=IFERROR(J5/B5;"")']),
    write(12, 2, HEADERS),
    { updateCells: { start: { sheetId, rowIndex: 12, columnIndex: 1 }, rows: Array.from({ length: 138 }, (_, index) => {
      const row = index + 13;
      return { values: [cell(`=IF(F${row}="";"";ROW()-12)`), {}, {}, {}, {}, {}, {}, {}, cell(`=IF(H${row}="";"";IF(D${row}="Покупка";H${row}-I${row};H${row}+I${row}))`), cell(`=IFERROR(F${row}/J${row};"")`), {}] };
    }), fields: 'userEnteredValue' } },
    { repeatCell: { range: range(1, 1000, 2, 12), cell: { userEnteredFormat: { textFormat: { fontFamily: 'Arial', fontSize: 10 }, verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat' } },
    { repeatCell: { range: range(12, 12, 2, 12), cell: { userEnteredFormat: { backgroundColor: { red: 0.15, green: 0.25, blue: 0.4 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat' } },
    { repeatCell: { range: range(13, 1000, 3, 3), cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { repeatCell: { range: range(13, 1000, 6, 11), cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00########' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { setDataValidation: { range: range(13, 1000, 4, 4), rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Покупка' }, { userEnteredValue: 'Продажа' }] }, strict: true, showCustomUi: true } } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 12 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
  ];
  await sheets.api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  await sheets.inspect();
  return { created: true, sheetId };
}
