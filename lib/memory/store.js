/**
 * 工作组的持久化。
 *
 * 2026-10 起记忆从 JSON 里搬出来：**每个工作组一个 Markdown 文件**
 * `<dir>/memory/<groupId>.md`，JSON 只留元数据（名字、颜色、成员、时间）。
 *
 * 为什么：自动同步会让记忆越写越长，而工作台界面不该塞一大段文本；
 * 文件可以随便长，注入侧只取尾部摘录（见 model.renderMemoryBlock）。
 *
 * 关键约束：**注入路径必须同步**。`systemPrompt.section` 的 `text` 回调不能 await，
 * 所以文件内容常驻内存（cache），读盘走异步；`groupsOfSession()` 同步返回，
 * 并在返回前用 mtime 做一次廉价的同步检查（用户在外部编辑器改文件也能生效）。
 */

import { promises as fs, readFileSync, statSync } from 'node:fs'
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

/** 记忆文件里只留最新 maxChars：从最旧的整行开始丢，避免切半行。 */
export function trimMemoryText(text, maxChars = LIMITS.memoryFile) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  const lines = value.split('\n')
  let total = value.length
  while (lines.length > 1 && total > maxChars) {
    total -= lines[0].length + 1
    lines.shift()
  }
  return lines.join('\n')
}

/**
 * @param {{ file: string, log?: (message: string) => void }} options
 */
export function createMemoryStore({ file, log = () => {} }) {
  const dir = path.dirname(file)
  const memoryDir = path.join(dir, 'memory')
  const backupFile = `${file}.bak`
  let state = emptyMemory()
  let loadPromise = null
  let queue = Promise.resolve()
  /** id → { text: string, mtimeMs: number } */
  const cache = new Map()

  const fileOf = (id) => path.join(memoryDir, `${id}.md`)

  async function readFileText(target) {
    try {
      return await fs.readFile(target, 'utf8')
    } catch {
      return null
    }
  }

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

    // 迁移 + 预热：把 JSON 里的旧 memory 搬进 .md，再把 .md 读进 cache。
    let migrated = false
    for (const group of state.groups) {
      const target = fileOf(group.id)
      let text = await readFileText(target)
      if (text === null) {
        text = group.memory
        if (text !== '') {
          await fs.mkdir(memoryDir, { recursive: true })
          await writeFileDurable(target, text)
        }
        migrated = true
      } else if (group.memory !== '') {
        migrated = true
      }
      let mtimeMs = 0
      try {
        mtimeMs = statSync(target).mtimeMs
      } catch {
        /* 文件还不存在 */
      }
      cache.set(group.id, { text, mtimeMs })
      group.memory = text
    }
    if (migrated) {
      // JSON 里不再保存正文，避免两份真相。
      await persistJson().catch((error) => log(`工作组元数据回写失败：${error?.message ?? error}`))
    }
    return state
  }

  async function persistJson() {
    const payload = {
      version: 1,
      revision: state.revision,
      groups: state.groups.map((group) => ({
        id: group.id,
        name: group.name,
        color: group.color,
        order: group.order,
        memory: '',
        sessions: group.sessions,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      })),
    }
    await fs.mkdir(dir, { recursive: true })
    try {
      const current = await fs.readFile(file, 'utf8')
      await writeFileDurable(backupFile, current)
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`工作组 .bak 写入失败（继续写主文件）：${error?.message ?? error}`)
    }
    await writeFileDurable(file, `${JSON.stringify(payload, null, 2)}\n`)
  }

  function ready() {
    loadPromise ??= doLoad()
    return loadPromise
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
        // 先把记忆正文写进各自的 .md，再写元数据。顺序反了会丢内容。
        if (typeof result.writeMemory === 'function') await result.writeMemory()
        state = next
        await persistJson()
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

  /** 元数据视图：列表接口不要带正文（可能几十 KB）。 */
  function groupView(group) {
    const hit = cache.get(group.id)
    const text = hit === undefined ? group.memory : hit.text
    const preview = String(text ?? '')
      .split('\n')
      .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
      .find((line) => line !== '')
    return {
      id: group.id,
      name: group.name,
      color: group.color,
      order: group.order,
      sessions: group.sessions,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      memoryPath: fileOf(group.id),
      memorySize: String(text ?? '').length,
      memoryPreview: preview ?? '',
    }
  }

  async function writeMemoryFile(id, text) {
    await fs.mkdir(memoryDir, { recursive: true })
    await writeFileDurable(fileOf(id), text)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(fileOf(id)).mtimeMs
    } catch {
      /* 刚写完不可能不存在，忽略 */
    }
    cache.set(id, { text, mtimeMs })
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
      return {
        ok: true,
        state: draft,
        value: groupView(group),
        writeMemory: memory.value === '' ? undefined : () => writeMemoryFile(id, memory.value),
      }
    })
  }

  async function updateGroup(id, patch) {
    if (typeof id !== 'string' || id.trim() === '') return err('ID_REQUIRED', '缺少 id')
    if (!isPlainObject(patch)) return err('INVALID_BODY', '请求体必须是对象')

    let pendingMemory = null
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
        pendingMemory = memory.value
      }

      group.updatedAt = Date.now()
      draft.groups[index] = group
      return {
        ok: true,
        state: draft,
        value: groupView(group),
        writeMemory: pendingMemory === null ? undefined : () => writeMemoryFile(id, pendingMemory),
      }
    })
  }

  /**
   * 追加一段记忆（自动同步 / agent 写入都走这里）。
   * 只追加、不覆盖；超过上限从最旧的整行开始丢。
   */
  async function appendMemory(id, text) {
    const line = String(text ?? '').trim()
    if (line === '') return err('MEMORY_EMPTY', '追加内容不能为空')

    return mutate((draft) => {
      const index = indexOf(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作组：${id}`)
      const group = { ...draft.groups[index] }
      const hit = cache.get(id)
      const current = String(hit === undefined ? group.memory : hit.text)
      const next = trimMemoryText(current === '' ? line : `${current}\n${line}`)
      group.memory = next
      group.updatedAt = Date.now()
      draft.groups[index] = group
      return {
        ok: true,
        state: draft,
        value: { id, memorySize: next.length },
        writeMemory: () => writeMemoryFile(id, next),
      }
    })
  }

  async function deleteGroup(id) {
    return mutate((draft) => {
      const index = indexOf(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作组：${id}`)
      const [removed] = draft.groups.splice(index, 1)
      cache.delete(id)
      // 删组时连记忆文件一起删（否则下次同名组会读到旧记忆）。
      fs.rm(fileOf(id), { force: true }).catch(() => {})
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

      const current = draft.groups.filter((entry) => entry.sessions.includes(sid.value))
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
    memoryDir,
    limits: LIMITS,
    ready,
    /** 元数据快照（不含正文）。 */
    snapshot() {
      return {
        version: state.version,
        revision: state.revision,
        groups: state.groups.map((group) => groupView(group)),
      }
    },
    get revision() {
      return state.revision
    },
    /** 注入用：同步返回；文件被外部编辑器改过也当场生效（同步 stat + 必要时读）。 */
    groupsOfSession(sessionId) {
      const groups = groupsOfSessionIn(state, sessionId)
      return groups.map((group) => {
        const target = fileOf(group.id)
        let text = group.memory
        try {
          const stat = statSync(target)
          const hit = cache.get(group.id)
          if (hit === undefined || hit.mtimeMs !== stat.mtimeMs) {
            text = readFileSync(target, 'utf8')
            cache.set(group.id, { text, mtimeMs: stat.mtimeMs })
          } else {
            text = hit.text
          }
        } catch {
          /* 文件还没落盘：用缓存里的（可能是空串） */
        }
        return { ...group, memory: text, memoryPath: target }
      })
    },
    readGroupMemory(id) {
      const hit = cache.get(id)
      return hit === undefined ? null : hit.text
    },
    memoryPathOf(id) {
      return fileOf(id)
    },
    createGroup,
    updateGroup,
    appendMemory,
    deleteGroup,
    addSession,
    removeSession,
  }
}
