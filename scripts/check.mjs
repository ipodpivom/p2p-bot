import { config } from '../src/config.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Sheets, nextRow } from '../src/sheets.mjs';
import { FirestoreState } from '../src/firestore.mjs';
try {
  const cfg = config();
  const tg = new Telegram(cfg.token), sheets = new Sheets(cfg);
  const bot = await tg.call('getMe');
  const webhook = await tg.call('getWebhookInfo');
  const { sheet, timezone } = await sheets.inspect();
  const rows = await sheets.values(`C13:L${sheet.gridProperties.rowCount}`);
  console.log(`Telegram: @${bot.username}. Лист: ${sheet.title}. Часовой пояс таблицы: ${timezone}. Следующая строка: ${nextRow(rows)}.`);
  console.log(webhook.url ? 'Внимание: активен webhook, polling не запустится.' : 'Webhook отсутствует. Проверка чтения пройдена; право записи этим скриптом не проверяется.');
  console.log('Ни одна ячейка не изменена. Для записи сервисному аккаунту нужна роль «Редактор».');
  if (cfg.stateBackend === 'firestore') {
    const remote = await FirestoreState.fromConfig(cfg, sheets);
    await remote.checkDatabase();
    console.log('Firestore: база доступна. Документы не изменялись.');
  }
} catch (e) { console.error(`Проверка не пройдена: ${e.message}`); process.exitCode = 1; }
