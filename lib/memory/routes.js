/**
 * 工作组 HTTP 路由：`/api/session-board/memory/*`
 *
 * 全部走**一条 prefix 路由**再自己切段（webServer 没有路径参数）。
 * ⚠️ prefix 路径**不能带结尾斜杠**：宿主的判定是
 * `pathname === prefix || pathname.startsWith(prefix + '/')`。
 *
 * 封套与非 GET 的自定义头校验与工作项路由一致（`{ok,value}` / `x-dsh-plugin`）。
 */

import { httpError, readJson, replyError, replyOk, toHttpError } from '../schema.js'
import { LIMITS, sessionsIndex } from './model.js'

export const MEMORY_ROUTE = '/api/session-board/memory'

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

function segments(url) {
  return url.pathname
    .slice(MEMORY_ROUTE.length)
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part))
}

/**
 * @param {ReturnType<import('./store.js').createMemoryStore>} store
 * @returns {Array<{kind:'prefix', path:string, handler:Function}>}
 */
export function createMemoryRoutes(store) {
  return [
    {
      kind: 'prefix',
      path: MEMORY_ROUTE,
      handler: guard(async (req, res) => {
        const url = new URL(req.url ?? MEMORY_ROUTE, 'http://localhost')
        const parts = segments(url)

        // GET /memory —— 全量状态（前端唯一的真相来源）
        if (parts.length === 0) {
          method(req, 'GET')
          await store.ready()
          const snapshot = store.snapshot()
          replyOk(res, {
            revision: snapshot.revision,
            limits: LIMITS,
            groups: snapshot.groups,
            sessionsIndex: sessionsIndex(snapshot),
          })
          return
        }

        // POST /memory/groups —— 新建
        if (parts.length === 1 && parts[0] === 'groups') {
          method(req, 'POST')
          const body = await readJson(req)
          const result = must(await store.createGroup(body))
          replyOk(res, { revision: result.revision, group: result.value })
          return
        }

        // /memory/groups/<id>
        if (parts.length === 2 && parts[0] === 'groups') {
          const id = parts[1]
          if (req.method === 'PATCH' || req.method === 'POST') {
            const body = await readJson(req)
            const result = must(await store.updateGroup(id, body))
            replyOk(res, { revision: result.revision, group: result.value })
            return
          }
          if (req.method === 'DELETE') {
            const result = must(await store.deleteGroup(id))
            replyOk(res, { revision: result.revision, deleted: result.value })
            return
          }
          throw httpError(405, 'METHOD', 'PATCH / DELETE only')
        }

        // /memory/groups/<id>/sessions/<sid>
        if (parts.length === 4 && parts[0] === 'groups' && parts[2] === 'sessions') {
          const [, groupId, , sessionId] = parts
          if (req.method === 'PUT' || req.method === 'POST') {
            const result = must(await store.addSession(groupId, sessionId))
            replyOk(res, { revision: result.revision, membership: result.value })
            return
          }
          if (req.method === 'DELETE') {
            const result = must(await store.removeSession(groupId, sessionId))
            replyOk(res, { revision: result.revision, membership: result.value })
            return
          }
          throw httpError(405, 'METHOD', 'PUT / DELETE only')
        }

        // GET /memory/session/<sid> —— 这个会话属于哪些组（角标用）
        if (parts.length === 2 && parts[0] === 'session') {
          method(req, 'GET')
          await store.ready()
          const groups = store.groupsOfSession(parts[1])
          replyOk(res, {
            revision: store.revision,
            groups: groups.map((group) => ({ id: group.id, name: group.name, color: group.color })),
          })
          return
        }

        throw httpError(404, 'NOT_FOUND', '没有这条工作组接口')
      }),
    },
  ]
}
