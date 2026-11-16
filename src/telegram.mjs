import { jsonRequest, ApiError } from './http.mjs';
export class Telegram {
  constructor(token, maxBytes = 12 * 1024 * 1024) { this.token = token; this.maxBytes = maxBytes; }
  async call(method, body = {}, timeout = 25000) {
    const result = await jsonRequest(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout,
    }, 'Telegram');
    if (!result.ok) throw new ApiError('Telegram', result.error_code ?? 500);
    return result.result;
  }
  send(chatId, text, markup) { return this.call('sendMessage', { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) }); }
  answer(id, text = '') { return this.call('answerCallbackQuery', { callback_query_id: id, text }); }
  async download(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    if (file.file_size > this.maxBytes) throw new Error('Файл больше 12 МБ.');
    if (!/^[\w./-]+$/.test(file.file_path ?? '') || file.file_path.includes('..')) throw new Error('Telegram вернул неверный путь файла.');
    let response;
    try { response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(45000) }); }
    catch { throw new Error('Не удалось скачать скриншот из Telegram.'); }
    if (!response.ok) throw new ApiError('Скачивание Telegram', response.status);
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > this.maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('Файл больше 12 МБ.'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
