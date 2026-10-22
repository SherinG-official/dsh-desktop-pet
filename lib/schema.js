/**
 * HTTP 层的小工具：请求体解析、错误构造、JSON 响应。
 * 手写、零依赖 —— 这里不值得引 schema 库。
 */

/** 请求体上限：工作项数据量很小，64 KiB 足够，超大直接拒。 */
const MAX_BODY_BYTES = 64 * 1024

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 构造一个带 HTTP 语义的错误。
 * @param {number} statusCode
 * @param {string} code 稳定错误码（进封套）
 * @param {string} message
 */
export function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

/**
 * 读一个 JSON 对象请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'BODY_TOO_LARGE', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw httpError(400, 'INVALID_BODY', '请求体不是合法 JSON')
  }
  if (!isObject(data)) throw httpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象')
  return data
}

export function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 成功封套：`{ ok: true, value }`。 */
export function replyOk(res, value) {
  sendJson(res, 200, { ok: true, value })
}

/** 失败封套：`{ ok: false, error: { code, message } }`。 */
export function replyError(res, error) {
  sendJson(res, error?.statusCode ?? 500, {
    ok: false,
    error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
  })
}

/** 把 model 层的失败结果转成一个 httpError。 */
export function toHttpError(result) {
  const code = result.error?.code ?? 'INTERNAL'
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'STALE_REVISION' || code === 'ILLEGAL_TRANSITION'
        ? 409
        : code === 'INVALID_BODY' || code === 'STORE_FAILED'
          ? 500
          : 400
  return httpError(status, code, result.error?.message ?? code)
}
