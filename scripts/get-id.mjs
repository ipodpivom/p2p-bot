import { Telegram } from '../src/telegram.mjs';
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Сначала заполни TELEGRAM_BOT_TOKEN в .env.');
const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN);
try {
  const updates = await tg.call('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  const users = new Map();
  for (const u of updates) if (u.message?.chat?.type === 'private') users.set(u.message.from.id, u.message.from.username ?? u.message.from.first_name);
  if (!users.size) console.log('Напиши /start своему боту в Telegram и повтори команду. Основной бот при этом должен быть остановлен.');
  for (const [id, name] of users) console.log(`${name}: ${id}`);
  console.log('Укажи свой ID в ALLOWED_TELEGRAM_IDS в .env. Этот скрипт не подтверждает и не удаляет обновления.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
