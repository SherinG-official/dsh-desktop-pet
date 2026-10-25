/**
 * 工作组（对外叫「工作组」，数据结构里仍叫 group）的**纯函数层**：
 * 校验、上限、反查、渲染。没有 IO，也没有 `Date.now()`（时间由调用方传）。
 *
 * 记忆从 0.4 起存在**每个组一个 Markdown 文件**里（见 store.js）：
 * 文件可以长，但**注入只取尾部摘录**，并给出文件路径让 agent 自己去读。
 * 所以这里的上限都是"进上下文的那一段"，不是文件本身。
 */

/** 硬上限。改这里不需要动别处。 */
export const LIMITS = {
  /** 单组记忆文件上限（字符）。超了从最旧的条目开始丢。 */
  memoryFile: 64_000,
  /** 每组注入的摘录字符数（取**最新**的尾部）。 */
  excerptPerGroup: 1_500,
  /** 一次注入的总字符数上限。 */
  injectTotal: 4_000,
  /** 一个会话最多挂几个工作组。 */
  groupsPerSession: 3,
  /** 工作组总个数。 */
  groups: 50,
  /** 单个工作组里的会话数。 */
  sessionsPerGroup: 200,
  /** 工作组名字符数。 */
  groupName: 40,
}

/** 这些前缀的会话是子代理，永远不进组（否则子代理也会被注入，纯浪费）。 */
export const SUBAGENT_PREFIXES = ['subagent-', 'child-', 'delegate-']

/** DSH 会话 id 的前缀，别自作主张去掉。 */
export const SESSION_PREFIX = 'session-'

export function err(code, message, field) {
  return { ok: false, error: { code, message, ...(field === undefined ? {} : { field }) } }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话 id 是不是子代理的。 */
export function isSubagentSession(id) {
  const text = String(id ?? '')
  return SUBAGENT_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/**
 * 校验并规范化会话 id。
 * @param {unknown} raw
 * @returns {{ok:true, value:string} | {ok:false, error:object}}
 */
export function validateSessionId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (id === '') return err('SESSION_ID_REQUIRED', '缺少会话 id', 'sessionId')
  if (id.length > 120) return err('SESSION_ID_INVALID', '会话 id 过长', 'sessionId')
  if (isSubagentSession(id)) return err('SESSION_ID_SUBAGENT', '子代理会话不能加入工作组', 'sessionId')
  if (!id.startsWith(SESSION_PREFIX)) {
    return err('SESSION_ID_PREFIX', `会话 id 必须以 ${SESSION_PREFIX} 开头`, 'sessionId')
  }
  return { ok: true, value: id }
}

function normalizeName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** 校验工作组名字。 */
export function validateGroupName(raw) {
  const name = normalizeName(raw)
  if (name === '') return err('GROUP_NAME_REQUIRED', '工作组名字不能为空', 'name')
  const chars = Array.from(name)
  if (chars.length > LIMITS.groupName) {
    return err('GROUP_NAME_TOO_LONG', `工作组名字最多 ${LIMITS.groupName} 个字符`, 'name')
  }
  return { ok: true, value: name }
}

/** `#rgb` / `#rrggbb` / 空串。 */
export function validateColor(raw) {
  const color = typeof raw === 'string' ? raw.trim() : ''
  if (color === '') return { ok: true, value: '' }
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return err('GROUP_COLOR_INVALID', '颜色要写成 #rgb 或 #rrggbb', 'color')
  }
  return { ok: true, value: color.toLowerCase() }
}

/** 记忆正文：文件模式，上限放宽到 64k（注入侧另有摘录上限）。 */
export function validateMemory(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') return err('GROUP_MEMORY_INVALID', '记忆必须是字符串', 'memory')
  if (raw.length > LIMITS.memoryFile) {
    return err(
      'GROUP_MEMORY_TOO_LONG',
      `工作组记忆文件最多 ${LIMITS.memoryFile} 个字符（当前 ${raw.length}）`,
      'memory',
    )
  }
  return { ok: true, value: raw }
}

/** 排序权重：小的在前。 */
export function validateOrder(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: 0 }
  const order = Number(raw)
  if (!Number.isFinite(order) || order < 0 || order > 9999) {
    return err('GROUP_ORDER_INVALID', 'order 必须是 0–9999 的数', 'order')
  }
  return { ok: true, value: Math.trunc(order) }
}

/** 空状态。 */
export function emptyMemory() {
  return { version: 1, revision: 0, groups: [] }
}

/** 生成一个不撞车的 id。 */
export function makeGroupId(now, taken = new Set()) {
  const base = `grp_${Math.trunc(now).toString(36)}`
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}_${i}`
    if (!taken.has(next)) return next
  }
  return `${base}_${Math.trunc(Math.random() * 1e6).toString(36)}`
}

/**
 * 读盘后的修复：坏记录丢掉、子代理会话剔除、**不截断记忆**（记忆在 .md 里）。
 */
export function sanitizeMemory(raw, log = () => {}) {
  if (!isPlainObject(raw)) return emptyMemory()
  const groups = []
  const ids = new Set()

  for (const entry of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!isPlainObject(entry)) {
      log('丢弃一个无法修复的工作组记录')
      continue
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || id.length > 64 || ids.has(id)) {
      log('丢弃一个 id 无效或重复的工作组记录')
      continue
    }
    const name = normalizeName(entry.name)
    if (name === '') {
      log('丢弃一个没有名字的工作组记录')
      continue
    }
    // memory 字段在 JSON 里只作为**迁移来源**：读盘后由 store 搬进 .md 并清空。
    const memory = typeof entry.memory === 'string' ? entry.memory : ''
    const sessions = []
    const seen = new Set()
    for (const candidate of Array.isArray(entry.sessions) ? entry.sessions : []) {
      const checked = validateSessionId(candidate)
      if (!checked.ok) continue
      if (seen.has(checked.value)) continue
      seen.add(checked.value)
      sessions.push(checked.value)
      if (sessions.length >= LIMITS.sessionsPerGroup) break
    }
    ids.add(id)
    groups.push({
      id,
      name,
      color: typeof entry.color === 'string' ? entry.color : '',
      order: Number.isFinite(Number(entry.order)) ? Math.trunc(Number(entry.order)) : 0,
      memory,
      sessions,
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Math.trunc(Number(entry.createdAt)) : 0,
      updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Math.trunc(Number(entry.updatedAt)) : 0,
    })
  }

  groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return {
    version: 1,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    groups,
  }
}

/** 这个会话属于哪些工作组（按 order、再按名字排）。 */
export function groupsOfSession(state, sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return []
  return (state?.groups ?? [])
    .filter((group) => group.sessions.includes(id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
}

/** 会话 → 工作组 id 列表，给前端角标用。 */
export function sessionsIndex(state) {
  const index = {}
  for (const group of state?.groups ?? []) {
    for (const sid of group.sessions) {
      if (!Array.isArray(index[sid])) index[sid] = []
      index[sid].push(group.id)
    }
  }
  return index
}

/**
 * 把若干工作组的记忆渲染成注入块。**确定性**：同样输入永远同样字节。
 *
 * 文件可以很长，所以这里只摘**最新的尾部**，并附上文件路径 —— agent 想要
 * 完整历史就自己去读那个 .md（它有 read 工具）。
 *
 * @param {Array<{id:string,name:string,memory:string,memoryPath?:string}>} groups
 * @param {{ limit?: number, revision?: number, excerpt?: number }} [options]
 * @returns {{ text: string, truncated: boolean, used: number, groups: number }}
 */
export function renderMemoryBlock(groups, options = {}) {
  const { limit = LIMITS.injectTotal, revision = 0, excerpt = LIMITS.excerptPerGroup } = options
  const blocks = []
  let used = 0
  let truncated = false

  for (const group of groups ?? []) {
    const body = String(group?.memory ?? '').trim()
    if (body === '') continue
    const file = String(group?.memoryPath ?? '')
    const cut = body.length > excerpt
    const shown = cut ? body.slice(-excerpt) : body
    const head = `## 工作组：${group.name}\n<!-- workbench-memory:${group.id} r${revision}${file === '' ? '' : ` file=${file}`} -->`
    const tail = cut
      ? `\n（只摘录最近 ${excerpt} 字${file === '' ? '' : `；完整记忆：${file}`}）`
      : file === ''
        ? ''
        : `\n（完整记忆：${file}）`
    const block = `${head}\n${shown}${tail}`
    if (used + block.length > limit) {
      truncated = true
      break
    }
    blocks.push(block)
    used += block.length
  }

  if (blocks.length === 0) return { text: '', truncated: false, used: 0, groups: 0 }

  const separator = '\n\n---\n\n'
  let text = blocks.join(separator)
  if (truncated) text += `${separator}（记忆已截断：只注入前 ${blocks.length} 个工作组）`
  return { text, truncated, used: text.length, groups: blocks.length }
}
