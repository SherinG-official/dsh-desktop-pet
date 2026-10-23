/**
 * 工作组的持久化：单个 JSON + 原子写 + `.bak` + 串行写队列 + revision。
 * 与 v1 工作项 store 同一套纪律（见 lib/store.js），但数据形状完全不同，
 * 所以单独一份，避免两套语义纠缠。
 *
 * 关键约束：**注入路径必须同步**。`systemPrompt.section` 的 `text` 回调不能 await，
 * 所以这里把状态常驻内存，写盘走异步旁路；`groupsOfSession()` 永远同步返回。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  LIMITS,
  emptyMemory,
  err,
  groupsOfSession as groupsOfSessionIn,
  makeGroupId,
  sanitizeMemory,
  validateColor,
  validateGroupName,
  validateMemory,
  validateOrder,
  validateSessionId,
} from './model.js'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function writeFileDurable(target, text) {
  const tmp = `${target}.tmp`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, target)
}

async function readJsonSafe(target) {
  let text
  try {
    text = await fs.readFile(target, 'utf8')
  } catch (error) {
    return { ok: false, code: error.code ?? 'READ_FAILED', message: String(error.message ?? error) }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, code: 'MALFORMED', message: String(error.message ?? error) }
  }
}

/**
 * @param {{ file: string, log?: (message: string) => void }} options
 */
export function createMemoryStore({ file, log = () => {} }) {
  const backupFile = `${file}.bak`
  let state = emptyMemory()
  let loadPromise = null
  let queue = Promise.resolve()

  async function doLoad() {
    const main = await readJsonSafe(file)
    let raw = main.ok ? main.value : null
    if (!main.ok && main.code !== 'ENOENT') {
      log(`工作组数据读取失败（${main.code}）：${main.message}`)
      const target = `${file}.corrupt-${Date.now()}`
      try {
        await fs.rename(file, target)
        log(`已把损坏的主文件备份为 ${path.basename(target)}`)
      } catch {
        /* 备份失败也要继续尝试 .bak */
      }
    }
    if (raw === null) {
      const backup = await readJsonSafe(backupFile)
      if (backup.ok && backup.value !== null) {
        raw = backup.value
        log('工作组主文件不可用，已从 .bak 恢复')
      }
    }
    state = sanitizeMemory(raw, log)
    return state
  }

  function ready() {
    loadPromise ??= doLoad()
    return loadPromise
  }

  async function persist(next) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      const current = await fs.readFile(file, 'utf8')
      await writeFileDurable(backupFile, current)
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`工作组 .bak 写入失败（继续写主文件）：${error?.message ?? error}`)
    }
    await writeFileDurable(file, `${JSON.stringify(next, null, 2)}\n`)
  }

  /** 串行执行一次写。mutator 拿深拷贝，返回 { ok, state, value }。 */
  function mutate(mutator) {
    const run = queue
      .then(async () => {
        await ready()
        const draft = structuredClone(state)
        const result = mutator(draft)
        if (!result || result.ok !== true) return result ?? err('STORE_FAILED', '内部错误')
        const next = result.state
        next.version = 1
        next.revision = state.revision + 1
        await persist(next)
        // 写盘成功后才切换内存态：注入读到的一定是已落盘版本。
        state = next
        return { ok: true, value: result.value, revision: next.revision }
      })
      .catch((error) => ({
        ok: false,
        error: { code: 'STORE_FAILED', message: String(error?.message ?? error) },
      }))
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function indexOf(draft, id) {
    return draft.groups.findIndex((group) => group.id === id)
  }

  /** 这个会话已经挂了多少组（用于上限判断）。 */
  function groupsOfId(draft, sessionId) {
    return draft.groups.filter((group) => group.sessions.includes(sessionId))
  }

  async function createGroup(input) {
    if (!isPlainObject(input)) return err('INVALID_BODY', '请求体必须是对象')
    const name = validateGroupName(input.name)
    if (!name.ok) return name
    const color = validateColor(input.color)
    if (!color.ok) return color
    const order = validateOrder(input.order)
    if (!order.ok) return order
    const memory = validateMemory(input.memory)
    if (!memory.ok) return memory

    return mutate((draft) => {
      if (draft.groups.length >= LIMITS.groups) {
        return err('GROUP_LIMIT', `工作组最多 ${LIMITS.groups} 个`)
      }
      const now = Date.now()
      const id = makeGroupId(now, new Set(draft.groups.map((group) => group.id)))
      const group = {
        id,
        name: name.value,
        color: color.value,
        order: order.value === 0 ? (draft.groups.length + 1) * 10 : order.value,
        memory: memory.value,
        sessions: [],
        createdAt: now,
        updatedAt: now,
      }
      draft.groups.push(group)
      return { ok: true, state: draft, value: group }
    })
  }

  async function updateGroup(id, patch) {
    if (typeof id !== 'string' || id.trim() === '') return err('ID_REQUIRED', '缺少 id')
    if (!isPlainObject(patch)) return err('INVALID_BODY', '请求体必须是对象')

    return mutate((draft) => {
      const index = indexOf(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作组：${id}`)
      const group = { ...draft.groups[index] }

      if (patch.name !== undefined) {
        const name = validateGroupName(patch.name)
        if (!name.ok) return name
        group.name = name.value
      }
      if (patch.color !== undefined) {
        const color = validateColor(patch.color)
        if (!color.ok) return color
        group.color = color.value
      }
      if (patch.order !== undefined) {
        const order = validateOrder(patch.order)
        if (!order.ok) return order
        group.order = order.value
      }
      if (patch.memory !== undefined) {
        const memory = validateMemory(patch.memory)
        if (!memory.ok) return memory
        group.memory = memory.value
      }

      group.updatedAt = Date.now()
      draft.groups[index] = group
      return { ok: true, state: draft, value: group }
    })
  }

  async function deleteGroup(id) {
    return mutate((draft) => {
      const index = indexOf(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作组：${id}`)
      const [removed] = draft.groups.splice(index, 1)
      // 只删组与归属关系，绝不动会话本身。
      return { ok: true, state: draft, value: { deleted: removed.id, sessions: removed.sessions.length } }
    })
  }

  async function addSession(groupId, sessionId) {
    const sid = validateSessionId(sessionId)
    if (!sid.ok) return sid

    return mutate((draft) => {
      const index = indexOf(draft, groupId)
      if (index === -1) return err('NOT_FOUND', `没有这个工作组：${groupId}`)
      const group = { ...draft.groups[index] }

      if (group.sessions.includes(sid.value)) {
        return { ok: true, state: draft, value: { groupId, sessionId: sid.value, changed: false } }
      }

      const current = groupsOfId(draft, sid.value)
      if (current.length >= LIMITS.groupsPerSession) {
        return err(
          'GROUPS_PER_SESSION_LIMIT',
          `一个会话最多挂 ${LIMITS.groupsPerSession} 个工作组（当前已有 ${current.length} 个）`,
        )
      }
      if (group.sessions.length >= LIMITS.sessionsPerGroup) {
        return err('GROUP_FULL', `一个工作组最多 ${LIMITS.sessionsPerGroup} 个会话`)
      }

      group.sessions = [...group.sessions, sid.value]
      group.updatedAt = Date.now()
      draft.groups[index] = group
      return { ok: true, state: draft, value: { groupId, sessionId: sid.value, changed: true } }
    })
  }

  async function removeSession(groupId, sessionId) {
    return mutate((draft) => {
      const index = indexOf(draft, groupId)
      if (index === -1) return err('NOT_FOUND', `没有这个工作组：${groupId}`)
      const group = { ...draft.groups[index] }
      if (!group.sessions.includes(sessionId)) {
        return { ok: true, state: draft, value: { groupId, sessionId, changed: false } }
      }
      group.sessions = group.sessions.filter((sid) => sid !== sessionId)
      group.updatedAt = Date.now()
      draft.groups[index] = group
      return { ok: true, state: draft, value: { groupId, sessionId, changed: true } }
    })
  }

  return {
    file,
    fileName: path.basename(file),
    backupFileName: path.basename(backupFile),
    limits: LIMITS,
    ready,
    /** 当前快照（深拷贝）。 */
    snapshot() {
      return structuredClone(state)
    },
    get revision() {
      return state.revision
    },
    /** 注入用：同步、无 IO。 */
    groupsOfSession(sessionId) {
      return groupsOfSessionIn(state, sessionId)
    },
    createGroup,
    updateGroup,
    deleteGroup,
    addSession,
    removeSession,
  }
}
