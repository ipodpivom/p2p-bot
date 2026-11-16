export class ApiError extends Error {
  constructor(service, status) { super(`${service}: HTTP ${status}`); this.status = status; }
}
export async function jsonRequest(url, { timeout = 25000, ...options } = {}, service = 'API') {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error(`${service}: сеть недоступна или истекло время ожидания.`); }
  if (!response.ok) throw new ApiError(service, response.status);
  try { return await response.json(); } catch { throw new Error(`${service}: некорректный ответ.`); }
}
