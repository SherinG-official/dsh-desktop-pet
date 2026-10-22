/**
 * HTTP 路由：/api/session-board/*
 *
 * 两条契约：
 *   1. 封套统一 `{ ok:true, value }` / `{ ok:false, error:{ code, message } }`；
 *   2. 非 GET 必须带 `x-dsh-plugin: session-board`（最小 CSRF 防护：自定义头会触发
 *      预检，而这个服务端从不回答预检）。
 *
 * 工作项路由全部是 exact —— webServer 只支持 exact / prefix，没有路径参数，
 * 所以 id 一律走请求体，不用 `/:id` 那种写法。桌宠立绘走 prefix（见 lib/pet.js）。
 */

import { httpError, readJson, replyError, replyOk, toHttpError } from './schema.js'

const PREFIX = '/api/session-board'
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

/** model/store 的失败结果 → 抛成带状态码的 HTTP 错误。 */
function must(result) {
  if (result?.ok !== true) throw toHttpError(result ?? {})
  return result
}

function requireId(body) {
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (id === '') throw httpError(400, 'ID_REQUIRED', '缺少 id')
  return id
}

/**
 * 建路由表（不注册，方便单测直接调 handler）。
 * @param {ReturnType<import('./store.js').createStore>} store
 */
export function createRoutes(store) {
  return [
    {
      kind: 'exact',
      path: `${PREFIX}/health`,
      handler: guard(async (req, res) => {
        method(req, 'GET')
        await store.ready()
        replyOk(res, {
          revision: store.revision,
          count: store.snapshot().items.length,
          file: store.fileName,
          backup: store.backupFileName,
        })
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/state`,
      handler: guard(async (req, res) => {
        method(req, 'GET')
        await store.ready()
        const snapshot = store.snapshot()
        replyOk(res, { revision: snapshot.revision, items: snapshot.items })
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/item/upsert`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        const result = must(await store.upsert(body.item ?? body, body.baseRevision))
        replyOk(res, { revision: result.revision, item: result.value })
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/item/status`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        const id = requireId(body)
        const result = must(await store.setStatus(id, body.status, body.baseRevision))
        replyOk(res, { revision: result.revision, item: result.value })
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/item/sessions`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        const id = requireId(body)
        const result = must(
          await store.sessionsOp(id, { add: body.add ?? [], remove: body.remove ?? [] }, body.baseRevision),
        )
        replyOk(res, { revision: result.revision, item: result.value })
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/item/delete`,
      handler: guard(async (req, res) => {
        method(req, 'POST')
        const body = await readJson(req)
        const id = requireId(body)
        const result = must(await store.remove(id))
        replyOk(res, { revision: result.revision, ...result.value })
      }),
    },
  ]
}

/**
 * 把路由挂到 webServer 上。
 * @param {object} ctx
 * @param {object} store
 * @param {Array<object>} [extraRoutes] 额外路由（例如桌宠立绘的 prefix 路由）
 * @returns 注销函数（没有 webServer 时是空操作）
 */
export function registerRoutes(ctx, store, extraRoutes = []) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  const disposers = []
  for (const route of [...createRoutes(store), ...extraRoutes]) {
    disposers.push(webServer.register(route))
  }
  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        console.warn(`[dsh-session-board] 注销路由失败：${String(error?.message ?? error)}`)
      }
    }
  }
}
