import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const processStartedAt = Math.round(Date.now() - process.uptime() * 1000);

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'bot.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        image_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, sheet_row INTEGER);
      CREATE INDEX IF NOT EXISTS drafts_image ON drafts(user_id, image_hash);`);
    if (!this.db.prepare('PRAGMA table_info(drafts)').all().some(column => column.name === 'spreadsheet_id')) this.db.exec('ALTER TABLE drafts ADD COLUMN spreadsheet_id TEXT');
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  create(draft) {
    this.db.prepare('INSERT INTO drafts(id,user_id,chat_id,image_hash,payload,created_at,spreadsheet_id) VALUES (?,?,?,?,?,?,?)')
      .run(draft.id, String(draft.userId), String(draft.chatId), draft.hash, JSON.stringify(draft.order), Date.now(), draft.spreadsheetId ?? null);
  }
  draft(id, userId) {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id=? AND user_id=?').get(id, String(userId));
    return r ? { id: r.id, userId: r.user_id, chatId: r.chat_id, hash: r.image_hash, status: r.status, order: JSON.parse(r.payload), row: r.sheet_row, createdAt: r.created_at, spreadsheetId: r.spreadsheet_id } : null;
  }
  byHash(hash, userId) {
    const r = this.db.prepare("SELECT id FROM drafts WHERE image_hash=? AND user_id=? AND status IN ('pending','saved') ORDER BY created_at DESC LIMIT 1").get(hash, String(userId));
    return r ? this.draft(r.id, userId) : null;
  }
  pending(userId) {
    return this.db.prepare("SELECT id FROM drafts WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 15").all(String(userId)).map(r => this.draft(r.id, userId));
  }
  edit(id, userId, order) { this.db.prepare("UPDATE drafts SET payload=? WHERE id=? AND user_id=? AND status='pending'").run(JSON.stringify(order), id, String(userId)); }
  finish(id, userId, status, row = null) { this.db.prepare('UPDATE drafts SET status=?, sheet_row=? WHERE id=? AND user_id=?').run(status, row, id, String(userId)); }
  snapshot() {
    // Old closed drafts are a cache; the spreadsheet retains authoritative order IDs indefinitely.
    this.db.exec("DELETE FROM drafts WHERE status <> 'pending' AND id NOT IN (SELECT id FROM drafts WHERE status <> 'pending' ORDER BY created_at DESC LIMIT 200)");
    return { version: 1, meta: this.db.prepare('SELECT key,value FROM meta').all(), drafts: this.db.prepare('SELECT * FROM drafts').all() };
  }
  restore(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.meta) || !Array.isArray(snapshot.drafts)) throw new Error('Некорректный формат сохранённого состояния.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM meta; DELETE FROM drafts');
      const meta = this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)');
      const draft = this.db.prepare('INSERT INTO drafts(id,user_id,chat_id,image_hash,status,payload,created_at,sheet_row,spreadsheet_id) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const row of snapshot.meta) meta.run(row.key, row.value);
      for (const row of snapshot.drafts) draft.run(row.id, row.user_id, row.chat_id, row.image_hash, row.status, row.payload, row.created_at, row.sheet_row, row.spreadsheet_id ?? null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

export function acquireLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'bot.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const owner = JSON.stringify({ pid: process.pid, startedAt: processStartedAt });
      const fd = openSync(file, 'wx', 0o600); writeSync(fd, owner); closeSync(fd);
      return () => { try { if (readFileSync(file, 'utf8') === owner) unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid, previous;
      try { previous = JSON.parse(readFileSync(file, 'utf8')); pid = previous.pid; } catch { throw new Error('Не удалось прочитать data/bot.lock.'); }
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Повреждён data/bot.lock. Убедись, что бот остановлен, и убери файл блокировки.');
      // Docker can reuse the same PID on restart; a different process start identifies a stale lock.
      if (pid === process.pid && previous.startedAt !== processStartedAt) { unlinkSync(file); continue; }
      try { process.kill(pid, 0); throw new Error('Уже запущен другой процесс бота с этой папкой data.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      unlinkSync(file);
    }
  }
  throw new Error('Не удалось получить блокировку процесса.');
}
