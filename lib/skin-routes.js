/**
 * 皮肤 HTTP 面：/api/session-board/skins*
 *
 * 全部走和其它路由一样的封套与 CSRF 头；id 走请求体或路径尾段，绝不拼进磁盘路径
 * （真正的合法性判断在 lib/skins.js 的 ID_RE 里）。
 */

import { httpError, readJson, replyError, replyOk, toHttpError } from './schema.js'

const PREFIX = '/api/session-board/skins'
const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_HEADER_VALUE = 'session-board'

function guard(handler) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.headers?.[PLUGIN_HEADER] !== PLUGIN_HEADER_VALUE) {
        throw httpError(403, 'FORBIDDEN', `缺少 ${PLUGIN_HEADER}: ${PLUGIN_HEADER_VALUE} 头`)
      }
      await handler(req, res)
    } catch (error) {
      replyError(res, error)
    }
  }
}

function method(req, expected) {
  if (req.method !== expected) throw httpError(405, 'METHOD', `${expected} only`)
}

function must(result) {
  if (result?.ok !== true) throw toHttpError(result ?? {})
  return result
}

/**
 * @param {ReturnType<import('./skins.js').createSkinStore>} skins
 */
export function createSkinRoutes(skins) {
  return [
    // 列表：当前激活 + 用户导入的那些
    {
      kind: 'exact',
      path: PREFIX,
      handler: guard(async (req, res) => {
        method(req, 'GET')
        replyOk(res, await skins.list())
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/import`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        const result = must(await skins.save(body))
        replyOk(res, result.value)
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/delete`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        const result = must(await skins.remove(body.id))
        replyOk(res, result.value)
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/active`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        if (body.id === undefined) throw httpError(400, 'ID_REQUIRED', '缺少 id（传 null 表示恢复默认）')
        const result = must(await skins.setActive(body.id === null ? '' : body.id))
        replyOk(res, result.value)
      }),
    },
    // 单套皮肤全文（token 表 + CSS）：prefix 路由。
    // ⚠️ prefix 路径不能带结尾斜杠 —— 宿主 match() 是
    // `pathname === prefix || pathname.startsWith(prefix + '/')`；带斜杠会让 `/skins/<id>`
    // 全部漏给宿主网关（返回 401）。exact 仍优先，所以 `/skins` 列表不受影响。
    {
      kind: 'prefix',
      path: PREFIX,
      handler: guard(async (req, res) => {
        method(req, 'GET')
        const url = new URL(req.url ?? PREFIX, 'http://localhost')
        if (!url.pathname.startsWith(`${PREFIX}/`)) {
          throw httpError(404, 'SKIN_NOT_FOUND', '缺少皮肤 id')
        }
        const id = decodeURIComponent(url.pathname.slice(PREFIX.length + 1)).replace(/\.json$/, '')
        const skin = await skins.read(id)
        if (skin === null) throw httpError(404, 'SKIN_NOT_FOUND', `没有这个皮肤：${id}`)
        replyOk(res, skin)
      }),
    },
  ]
}
