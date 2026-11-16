import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { jsonRequest } from './http.mjs';

const LEASE_MS = 90000;
const string = value => ({ stringValue: value });
const integer = value => ({ integerValue: String(value) });

export class FirestoreState {
  constructor({ projectId, botId, token, request = jsonRequest, now = Date.now, owner = randomUUID() }) {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId ?? '') || !/^\d+$/.test(botId ?? '')) throw new Error('Некорректные настройки Firestore projectId / botId.');
    this.url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/p2pBotState/${botId}`;
    Object.assign(this, { token, request, now, owner });
    this.version = null; this.until = 0; this.lost = false; this.queue = Promise.resolve();
  }
  static async fromConfig(cfg, sheets) {
    let key;
    try { key = JSON.parse(await readFile(cfg.credentialsPath, 'utf8')); }
    catch { throw new Error('Не найден JSON-ключ Google для Firestore.'); }
    return new FirestoreState({ projectId: cfg.firestoreProjectId || key.project_id, botId: cfg.token.split(':')[0], token: () => sheets.token('https://www.googleapis.com/auth/datastore') });
  }
  serial(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async api(method = 'GET', params = new URLSearchParams(), fields) {
    return this.request(`${this.url}${params.size ? `?${params}` : ''}`, {
      method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      ...(fields ? { body: JSON.stringify({ fields }) } : {}), timeout: 15000,
    }, 'Firestore');
  }
  async read() { try { return await this.api(); } catch (error) { if (error.status === 404) return null; throw error; } }
  async checkDatabase() {
    return this.request(this.url.split('/documents/')[0], { headers: { Authorization: `Bearer ${await this.token()}` }, timeout: 15000 }, 'Firestore database');
  }
  acquire() {
    return this.serial(async () => {
      const doc = await this.read(), fields = doc?.fields ?? {};
      if (Number(fields.leaseUntil?.integerValue ?? 0) > this.now() && fields.leaseOwner?.stringValue !== this.owner) return { acquired: false };
      const params = new URLSearchParams();
      if (doc) params.set('currentDocument.updateTime', doc.updateTime);
      else params.set('currentDocument.exists', 'false');
      for (const field of ['leaseOwner', 'leaseUntil']) params.append('updateMask.fieldPaths', field);
      const until = this.now() + LEASE_MS;
      let result;
      try { result = await this.api('PATCH', params, { leaseOwner: string(this.owner), leaseUntil: integer(until) }); }
      catch (error) { if ([409, 412].includes(error.status)) return { acquired: false }; throw error; }
      this.version = result.updateTime; this.until = until; this.lost = false;
      const payload = fields.snapshot?.stringValue;
      let snapshot = null;
      try { snapshot = payload ? JSON.parse(payload) : null; }
      catch { this.lost = true; throw new Error('Повреждено состояние бота в Firestore. Запуск остановлен.'); }
      return { acquired: true, snapshot };
    });
  }
  assertLease() {
    if (this.lost || !this.version || this.now() >= this.until) {
      this.lost = true;
      throw new Error('Потеряно соединение с хранилищем или право работы этой копии бота. Требуется перезапуск.');
    }
  }
  update(fields) {
    this.assertLease();
    const params = new URLSearchParams({ 'currentDocument.updateTime': this.version });
    for (const key of Object.keys(fields)) params.append('updateMask.fieldPaths', key);
    return this.api('PATCH', params, fields).then(result => { this.version = result.updateTime; this.until = Number(fields.leaseUntil.integerValue); })
      .catch(error => { this.lost = true; throw new Error(`Состояние не подтверждено хранилищем: ${error.message}`); });
  }
  renew() { return this.serial(() => this.update({ leaseUntil: integer(this.now() + LEASE_MS) })); }
  save(snapshot) {
    return this.serial(() => {
      const payload = JSON.stringify(snapshot);
      if (Buffer.byteLength(payload, 'utf8') > 750000) throw new Error('Слишком много незавершённых черновиков. Заверши или отмени старые через /pending.');
      return this.update({ snapshot: string(payload), leaseUntil: integer(this.now() + LEASE_MS) });
    });
  }
  release() {
    return this.serial(async () => {
      if (!this.version || this.lost) return;
      const params = new URLSearchParams({ 'currentDocument.updateTime': this.version });
      params.append('updateMask.fieldPaths', 'leaseUntil');
      try { await this.api('PATCH', params, { leaseUntil: integer(0) }); } catch {}
      this.lost = true;
    });
  }
}

// Keep SQLite as a local cache. Every mutation is durable before the user sees confirmation.
export class DurableStore {
  constructor(local, remote) { this.local = local; this.remote = remote; }
  get(...args) { return this.local.get(...args); }
  draft(...args) { return this.local.draft(...args); }
  byHash(...args) { return this.local.byHash(...args); }
  pending(...args) { return this.local.pending(...args); }
  async mutate(method, args) {
    this.remote.assertLease();
    const before = this.local.snapshot();
    this.local[method](...args);
    try { await this.remote.save(this.local.snapshot()); }
    catch (error) { this.local.restore(before); throw error; }
  }
  set(...args) { return this.mutate('set', args); }
  create(...args) { return this.mutate('create', args); }
  edit(...args) { return this.mutate('edit', args); }
  finish(...args) { return this.mutate('finish', args); }
  close() { this.local.close(); }
}
