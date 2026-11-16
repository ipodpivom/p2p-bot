import { Sheets } from './sheets.mjs';

export class UserSheets {
  constructor(cfg, { factory = settings => new Sheets(settings), beforeWrite = () => {} } = {}) {
    Object.assign(this, { cfg, factory, beforeWrite }); this.clients = new Map();
  }
  get(userId) {
    const spreadsheetId = this.cfg.userSpreadsheets.get(String(userId));
    if (!spreadsheetId) throw new Error('Личная таблица пользователя не подключена.');
    if (!this.clients.has(spreadsheetId)) {
      const client = this.factory({ ...this.cfg, spreadsheetId });
      const api = client.api.bind(client);
      client.api = (path, options) => { if (path === ':batchUpdate') this.beforeWrite(); return api(path, options); };
      this.clients.set(spreadsheetId, client);
    }
    return this.clients.get(spreadsheetId);
  }
}
