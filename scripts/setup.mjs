import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
const ask = async (prompt, secret = false) => { process.stdout.write(prompt); muted = secret; try { return (await rl.question('')).trim(); } finally { muted = false; if (secret) process.stdout.write('\n'); } };
try {
  try { await access('.env'); throw new Error('.env уже существует. Отредактируй его вручную, чтобы не потерять настройки.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const token = await ask('Токен от BotFather (ввод скрыт): ', true);
  if (!/^\d+:[A-Za-z0-9_-]{25,}$/.test(token)) throw new Error('Неверный формат токена.');
  const ids = await ask('Твой числовой Telegram ID (или Enter, чтобы определить позже): ');
  if (ids && !/^\d+(?:\s*,\s*\d+)*$/.test(ids)) throw new Error('ID должен содержать только цифры; несколько ID — через запятую.');
  const keyPath = (await ask('Путь к JSON-ключу Google service account (или Enter, чтобы положить позже): ')).replace(/^"|"$/g, '');
  if (keyPath) {
    const key = JSON.parse(await readFile(keyPath, 'utf8'));
    if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new Error('Это не JSON-ключ сервисного аккаунта Google.');
    await mkdir('secrets', { recursive: true, mode: 0o700 });
    if (resolve(keyPath) !== resolve('secrets/google-service-account.json')) await copyFile(keyPath, 'secrets/google-service-account.json');
    console.log(`Открой таблицу для ${key.client_email} с ролью «Редактор».`);
  }
  const template = await readFile('.env.example', 'utf8');
  await writeFile('.env', template.replace(/^TELEGRAM_BOT_TOKEN=.*$/m, `TELEGRAM_BOT_TOKEN=${token}`).replace(/^ALLOWED_TELEGRAM_IDS=.*$/m, `ALLOWED_TELEGRAM_IDS=${ids.replaceAll(' ', '')}`), { mode: 0o600, flag: 'wx' });
  console.log('Настройки сохранены в .env. Не пересылай его в чат и не добавляй в Git.');
  if (!ids) console.log('Напиши своему боту /start, затем выполни: node --env-file=.env scripts/get-id.mjs');
  console.log('Следующий шаг: npm run check');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { rl.close(); }
