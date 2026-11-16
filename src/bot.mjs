import { randomBytes, createHash } from 'node:crypto';
import { preview, validate, applyEdit, FIELDS } from './order.mjs';

export function buttons(id, order) {
  const rows = [];
  if (!validate(order).errors.length) rows.push([{ text: '✅ Записать в таблицу', callback_data: `save:${id}` }]);
  rows.push([{ text: '✏ Исправить', callback_data: `edit:${id}` }, { text: 'Отмена', callback_data: `cancel:${id}` }]);
  return { inline_keyboard: rows };
}

export class Bot {
  constructor({ cfg, telegram, sheets, sheetsForUser, store, ocr }) { Object.assign(this, { cfg, telegram, sheets, sheetsForUser, store, ocr }); }
  sheetId(userId) { return this.cfg.userSpreadsheets?.get(String(userId)) ?? this.cfg.spreadsheetId; }
  personalSheets(userId) { return this.sheetsForUser ? this.sheetsForUser(String(userId)) : this.sheets; }
  async show(draft) { return this.telegram.send(draft.chatId, preview(draft.order, draft.id), buttons(draft.id, draft.order)); }
  authorized(user, chat) { return user && this.cfg.allowedIds.has(String(user.id)) && chat?.type === 'private'; }
  async handle(update) {
    if (update.callback_query) return this.callback(update.callback_query);
    const m = update.message;
    if (!m?.from || !m.chat) return;
    const userId = String(m.from.id), chatId = String(m.chat.id), command = m.text?.trim().split(/\s/)[0]?.split('@')[0];
    if (command === '/id') {
      if (m.chat.type === 'private') await this.telegram.send(chatId, `Твой Telegram ID: ${userId}`);
      return;
    }
    if (!this.authorized(m.from, m.chat)) {
      if (m.chat.type === 'private') await this.telegram.send(chatId, `Твой доступ ещё не подключён. Telegram ID: ${userId}. Передай его администратору вместе со ссылкой на свою таблицу.`);
      return;
    }
    if (['/start', '/help'].includes(command)) {
      await this.telegram.send(chatId, 'Отправь полный скриншот завершённого Binance P2P ордера USDT/UAH. Лучше как файл без сжатия. Я покажу поля для подтверждения и запишу ордер в твою личную таблицу.\n\n/table — твоя таблица\n/pending — твои незаписанные ордера\n/stats — показатели твоей таблицы\n/id — твой ID\n/cancel — выйти из режима исправления\n\nПокупка: nominal − fee = total. Продажа: nominal + fee = total.'); return;
    }
    if (command === '/cancel') { await this.store.set(`edit:${userId}`, ''); await this.telegram.send(chatId, 'Режим исправления закрыт.'); return; }
    if (command === '/table') { await this.telegram.send(chatId, `Твоя таблица: https://docs.google.com/spreadsheets/d/${this.sheetId(userId)}/edit`); return; }
    if (command === '/stats') { try { await this.telegram.send(chatId, await this.personalSheets(userId).summary()); } catch (e) { await this.telegram.send(chatId, e.message); } return; }
    if (command === '/pending') {
      const drafts = this.store.pending(userId);
      if (!drafts.length) await this.telegram.send(chatId, 'Нет ордеров, ожидающих подтверждения.');
      for (const draft of drafts) await this.show(draft);
      return;
    }
    const editMatch = m.text?.match(/^\/edit(?:@\w+)?\s+([a-f0-9]{12})\s+/i);
    const editSession = this.store.get(`edit:${userId}`);
    const session = editSession ? JSON.parse(editSession) : null;
    if (editMatch || (m.text && session && m.reply_to_message?.message_id === session.messageId)) {
      const id = editMatch?.[1] ?? session.id, draft = this.store.draft(id, userId);
      if (!draft || draft.status !== 'pending') { await this.telegram.send(chatId, 'Этот ордер уже закрыт.'); return; }
      try {
        const order = applyEdit(draft.order, m.text);
        await this.store.edit(id, userId, order); await this.store.set(`edit:${userId}`, '');
        await this.show({ ...draft, order });
      } catch (e) { await this.telegram.send(chatId, e.message); }
      return;
    }
    const file = m.document ?? m.photo?.at(-1);
    if (!file) { await this.telegram.send(chatId, 'Пришли скриншот как фото или PNG/JPEG-файл. Команды: /help, /pending.'); return; }
    if (file.file_size > this.cfg.maxFileBytes) { await this.telegram.send(chatId, 'Размер скриншота должен быть до 12 МБ.'); return; }
    await this.telegram.send(chatId, 'Распознаю скриншот…');
    let draft;
    try {
      const buffer = await this.telegram.download(file.file_id);
      const hash = createHash('sha256').update(buffer).digest('hex');
      const previous = this.store.byHash(hash, userId);
      if (previous && (!previous.spreadsheetId || previous.spreadsheetId === this.sheetId(userId))) {
        if (previous.status === 'saved') await this.telegram.send(chatId, `Этот скриншот уже обработан. Строка ${previous.row}.`);
        else await this.show(previous);
        return;
      }
      const order = await this.ocr.recognize(buffer);
      draft = { id: randomBytes(6).toString('hex'), userId, chatId, hash, order, spreadsheetId: this.sheetId(userId) };
      await this.store.create(draft);
    } catch (e) {
      // Never log OCR text, Telegram URLs, keys or financial records.
      await this.telegram.send(chatId, `Не удалось разобрать скриншот. Отправь полный оригинал без обрезки. ${e.message}`);
      return;
    }
    await this.show(draft);
  }
  async callback(query) {
    const chat = query.message?.chat, userId = String(query.from?.id);
    if (!this.authorized(query.from, chat)) { await this.telegram.answer(query.id, 'Нет доступа.'); return; }
    const match = query.data?.match(/^(save|edit|cancel):([a-f0-9]{12})$/);
    if (!match) { await this.telegram.answer(query.id); return; }
    const [, action, id] = match, draft = this.store.draft(id, userId);
    // A stale callback acknowledgement must never prevent reconciliation of a saved write.
    await this.telegram.answer(query.id).catch(() => {});
    if (!draft || draft.chatId !== String(chat.id)) { await this.telegram.send(chat.id, 'Ордер не найден.'); return; }
    if (draft.status !== 'pending') { await this.telegram.send(chat.id, draft.status === 'saved' ? `Уже обработан. Строка ${draft.row}.` : 'Ордер отменён.'); return; }
    if (action === 'cancel') { await this.store.finish(id, userId, 'cancelled'); await this.telegram.send(chat.id, 'Ордер отменён.'); return; }
    if (action === 'edit') {
      const prompt = await this.telegram.send(chat.id, `Ответь на это сообщение исправленными полями, каждое с новой строки.\nНапример:\nfiat=660\nnominal=14.32\nfee=0.07\ntotal=14.25\n\nПоля: ${FIELDS.join(', ')}\nside: buy/sell. createdAt: 2026-11-11 02:22:26.\nОтмена: /cancel`, { force_reply: true, selective: true });
      await this.store.set(`edit:${userId}`, JSON.stringify({ id, messageId: prompt.message_id })); return;
    }
    const check = validate(draft.order);
    if (check.errors.length) { await this.show(draft); return; }
    if (draft.spreadsheetId && draft.spreadsheetId !== this.sheetId(userId)) {
      await this.telegram.send(chat.id, 'Твоя подключённая таблица изменилась. Отмени этот черновик и отправь скриншот заново для записи в новую таблицу.'); return;
    }
    let result;
    try { result = await this.personalSheets(userId).save(draft.order); }
    catch (e) {
      await this.telegram.send(chat.id, `Запись пока не подтверждена: ${e.message}\nОрдер сохранён локально. Можно повторить подтверждение; перед записью я снова проверю номер ордера.`, buttons(id, draft.order)); return;
    }
    if (result.existing && result.by === 'fingerprint') {
      await this.telegram.send(chat.id, `В строке ${result.row} уже есть сделка с теми же датой, типом, суммой и курсом. Проверь её вручную: новый ордер не добавлен.`, buttons(id, draft.order)); return;
    }
    await this.store.finish(id, userId, 'saved', result.row);
    await this.telegram.send(chat.id, result.existing ? `Ордер уже есть в таблице, строка ${result.row}. Повтор не добавлен.` : `✅ Ордер записан в строку ${result.row}.`);
  }
}
