import { config } from './config.mjs';
import { Telegram } from './telegram.mjs';
import { UserSheets } from './user-sheets.mjs';
import { Store, acquireLock } from './store.mjs';
import { Ocr } from './ocr.mjs';
import { parseOcr } from './parser.mjs';
import { Bot } from './bot.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHealthServer } from './health.mjs';
import { FirestoreState, DurableStore } from './firestore.mjs';

let release, store, engine, heartbeat, healthServer, remote, leaseTimer, stopping = false;
const health = { ready: false, initialized: false, lastActivity: 0 };
const startedAt = Date.now();
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  const cfg = config();
  if (cfg.port) {
    healthServer = await startHealthServer({ port: cfg.port, status: () => ({ ...health, ready: health.ready && !stopping, initialized: health.initialized && !stopping }) });
    console.log(`HTTP monitoring: port ${cfg.port}, path /healthz.`);
  }
  release = acquireLock(cfg.dataDir); store = new Store(cfg.dataDir);
  const registry = new UserSheets(cfg, { beforeWrite: () => remote?.assertLease() });
  const telegram = new Telegram(cfg.token, cfg.maxFileBytes), sheets = registry.get(cfg.ownerId);
  await telegram.call('getMe');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('У бота активен webhook. Используй отдельного бота или явно отключи старый webhook перед запуском polling.');
  await sheets.inspect();
  engine = await new Ocr(cfg.dataDir).init();
  if (cfg.stateBackend === 'firestore') {
    remote = await FirestoreState.fromConfig(cfg, sheets);
    await remote.checkDatabase();
    health.initialized = true;
    let acquired;
    while (!stopping) {
      acquired = await remote.acquire();
      if (acquired.acquired) break;
      console.log('Ожидаю остановки предыдущей копии бота…');
      await delay(5000);
    }
    if (stopping) throw new Error('Запуск остановлен до получения доступа к хранилищу.');
    if (acquired.snapshot) store.restore(acquired.snapshot);
    else await remote.save(store.snapshot());
    store = new DurableStore(store, remote);
    leaseTimer = setInterval(() => {
      if (!remote.lost) remote.renew().catch(error => {
        console.error(error.message); stopping = true; health.ready = false; process.exitCode = 1;
      });
    }, 20000);
    console.log('Firestore подключён: черновики и очередь восстанавливаются после перезапуска.');
  }
  const ocr = { recognize: async buffer => {
    let timer;
    try {
      return await Promise.race([engine.recognize(buffer).then(parseOcr), new Promise((_, reject) => {
        timer = setTimeout(() => { engine.close().catch(() => {}); reject(new Error('Распознавание заняло больше 90 секунд.')); }, 90000);
      })]);
    } finally { clearTimeout(timer); }
  } };
  const bot = new Bot({ cfg, telegram, sheets, sheetsForUser: id => registry.get(id), store, ocr });
  const beat = () => writeFile(join(cfg.dataDir, 'heartbeat'), String(Date.now()), { mode: 0o600 }).catch(() => {});
  await beat(); heartbeat = setInterval(beat, 15000);
  console.log('Бот запущен. Разрешены только личные чаты указанных Telegram ID.');
  health.initialized = true; health.ready = true; health.lastActivity = Date.now();
  let failures = 0;
  while (!stopping) {
    try {
      const updates = await telegram.call('getUpdates', { offset: Number(store.get('offset') ?? 0), timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      health.lastActivity = Date.now();
      for (const update of updates) {
        if (stopping) break;
        remote?.assertLease();
        if (update.update_id < Number(store.get('offset') ?? 0)) continue;
        await bot.handle(update);
        await store.set('offset', update.update_id + 1);
        health.lastActivity = Date.now();
      }
      failures = 0;
    } catch (e) {
      if (remote?.lost) throw e;
      if (e.status === 401) throw new Error('Telegram отклонил токен бота.');
      // Render can briefly overlap the old and new instance during a deployment without a disk.
      if (e.status === 409 && Date.now() - startedAt > 120000) throw new Error('Конфликт Telegram polling: останови вторую копию бота или проверь webhook.');
      failures++; console.error(`Ошибка цикла (${failures}): ${e.message}`);
      await delay(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
} catch (e) { console.error(`Запуск остановлен: ${e.message}`); process.exitCode = 1; }
finally {
  health.ready = false; health.initialized = false; clearInterval(heartbeat); clearInterval(leaseTimer);
  await engine?.close().catch(() => {}); await remote?.release(); store?.close(); release?.();
  if (healthServer) await new Promise(resolve => healthServer.close(resolve));
}
