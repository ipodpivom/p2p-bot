import { resolve } from 'node:path';
export function config(env = process.env) {
  const ids = String(env.ALLOWED_TELEGRAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!/^\d+:[A-Za-z0-9_-]{25,}$/.test(env.TELEGRAM_BOT_TOKEN ?? '')) throw new Error('Заполни TELEGRAM_BOT_TOKEN в .env.');
  if (!ids.length || ids.some(id => !/^\d{1,16}$/.test(id))) throw new Error('Заполни ALLOWED_TELEGRAM_IDS своим числовым Telegram ID.');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(env.GOOGLE_SPREADSHEET_ID ?? '')) throw new Error('Неверный GOOGLE_SPREADSHEET_ID.');
  let mappings;
  try { mappings = JSON.parse(env.USER_SPREADSHEETS_JSON || '{}'); } catch { throw new Error('USER_SPREADSHEETS_JSON должен содержать JSON-объект Telegram ID → ID таблицы.'); }
  if (!mappings || Array.isArray(mappings) || typeof mappings !== 'object') throw new Error('USER_SPREADSHEETS_JSON должен быть объектом.');
  const ownerId = ids[0];
  const userSpreadsheets = new Map([[ownerId, env.GOOGLE_SPREADSHEET_ID]]);
  for (const [id, sheetId] of Object.entries(mappings)) {
    if (!/^\d{1,16}$/.test(id) || typeof sheetId !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) throw new Error('Неверный Telegram ID или ID таблицы в USER_SPREADSHEETS_JSON.');
    userSpreadsheets.set(id, sheetId);
  }
  for (const id of ids) if (!userSpreadsheets.has(id)) throw new Error(`Для Telegram ID ${id} не указана личная таблица в USER_SPREADSHEETS_JSON.`);
  if (new Set(userSpreadsheets.values()).size !== userSpreadsheets.size) throw new Error('Двум пользователям нельзя назначить одну таблицу: выбран раздельный учёт.');
  const port = env.PORT ? Number(env.PORT) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('PORT должен быть целым числом от 1 до 65535.');
  const stateBackend = env.STATE_BACKEND || 'sqlite';
  if (!['sqlite', 'firestore'].includes(stateBackend)) throw new Error('STATE_BACKEND: sqlite или firestore.');
  return {
    token: env.TELEGRAM_BOT_TOKEN, allowedIds: new Set(userSpreadsheets.keys()), ownerId, userSpreadsheets, spreadsheetId: userSpreadsheets.get(ownerId),
    sheetName: env.GOOGLE_SHEET_NAME || 'P2P Учет', credentialsPath: resolve(env.GOOGLE_SERVICE_ACCOUNT_FILE || 'secrets/google-service-account.json'),
    dataDir: resolve(env.DATA_DIR || 'data'), port, maxFileBytes: 12 * 1024 * 1024, maxSheetRow: 1000,
    stateBackend, firestoreProjectId: env.FIRESTORE_PROJECT_ID || null,
  };
}
