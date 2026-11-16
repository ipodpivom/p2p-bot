import { config } from '../src/config.mjs';
import { Sheets } from '../src/sheets.mjs';
import { initializeJournal } from '../src/journal-template.mjs';

try {
  const [userId, reference, ...flags] = process.argv.slice(2);
  if (!/^\d{1,16}$/.test(userId ?? '') || !reference || flags.some(flag => flag !== '--initialize')) throw new Error('Usage: node --env-file=.env scripts/add-user.mjs TELEGRAM_ID SHEET_URL [--initialize]');
  let spreadsheetId = reference;
  if (reference.startsWith('https://')) {
    const url = new URL(reference);
    if (url.hostname !== 'docs.google.com') throw new Error('Нужна ссылка Google Sheets.');
    spreadsheetId = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1];
  }
  const mappings = JSON.parse(process.env.USER_SPREADSHEETS_JSON || '{}');
  mappings[userId] = spreadsheetId;
  const cfg = config({ ...process.env, USER_SPREADSHEETS_JSON: JSON.stringify(mappings) });
  const sheets = new Sheets({ ...cfg, spreadsheetId: cfg.userSpreadsheets.get(userId) });
  if (flags.includes('--initialize')) {
    const result = await initializeJournal(sheets);
    console.log(result.created ? 'В личной таблице создан чистый журнал без чужих операций.' : 'Существующий журнал соответствует формату.');
  } else await sheets.inspect();
  console.log('Личная таблица проверена. Сохрани переменную USER_SPREADSHEETS_JSON в Render:');
  console.log(JSON.stringify(mappings));
  console.log('После сохранения и развёртывания пользователь сможет отправить /start и /table.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
