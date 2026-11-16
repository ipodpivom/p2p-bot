import { resolve } from 'node:path';
import { Sheets } from '../src/sheets.mjs';
import { FirestoreState } from '../src/firestore.mjs';
const cfg = {
  credentialsPath: resolve(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || 'secrets/google-service-account.json'),
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || 'YOUR_SPREADSHEET_ID',
  sheetName: process.env.GOOGLE_SHEET_NAME || 'P2P Учет',
  token: process.env.TELEGRAM_BOT_TOKEN || '0:', firestoreProjectId: process.env.FIRESTORE_PROJECT_ID || null,
};
try {
  const sheets = new Sheets(cfg); await sheets.inspect();
  console.log('Google Sheets: таблица доступна, структура журнала соответствует. Никакие ячейки не изменены.');
  if (process.env.STATE_BACKEND === 'firestore') {
    const remote = await FirestoreState.fromConfig(cfg, sheets); await remote.checkDatabase();
    console.log('Firestore: база доступна. Документы не изменены.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
