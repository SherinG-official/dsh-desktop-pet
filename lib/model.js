/**
 * 数据模型与状态机 —— 纯函数，零 IO，全部可单测。
 *
 * 约定：任何校验失败都返回 `{ ok:false, error:{ code, message, field? } }`，
 * 绝不静默接受非法输入（红线：非法状态转移要报错）。
 */

export const VERSION = 1

/** 工作项状态，顺序即看板列顺序。 */
export const STATUSES = ['backlog', 'active', 'review', 'done', 'paused']

/** 中文字段长度上限（按 Unicode 码点计，不是 UTF-16 单元）。 */
export const LIMITS = {
  title: 80,
  nextStep: 120,
  note: 2000,
  workspace: 80,
  sessions: 32,
  history: 50,
}

/** 状态转移表：只允许图上的边。`done → active` 是显式"重新打开"。 */
const TRANSITIONS = {
  backlog: ['active', 'paused'],
  active: ['backlog', 'review', 'paused'],
  review: ['active', 'done', 'paused'],
  done: ['active'],
  paused: ['active', 'backlog'],
}

/** 会话 id 允许的字符（`session-<uuid>` 及类似形态），杜绝路径分隔符。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * 构造一个失败结果。
 * @param {string} code 稳定的错误码（HTTP 层原样透出）
 * @param {string} message 面向人的说明
 * @param {string} [field] 出错的字段名
 */
export function err(code, message, field) {
  const error = field === undefined ? { code, message } : { code, message, field }
  return { ok: false, error }
}

/** 按 Unicode 码点数字符（中文一个字算 1）。 */
export function charCount(value) {
  return Array.from(String(value)).length
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 生成工作项 id：`wi_<yyyyMMdd>_<4 位 base36>`，日期取**本地**时间。
 * @param {number} [now] epoch 毫秒
 */
export function newId(now = Date.now()) {
  const d = new Date(now)
  const stamp =
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  let tail = Math.random().toString(36).slice(2, 6)
  while (tail.length < 4) tail += '0'
  return `wi_${stamp}_${tail}`
}

/** 空库的初始状态。 */
export function emptyState() {
  return { version: VERSION, revision: 0, items: [] }
}

/** 会话 id 归一：只做 trim（大小写与形态由 sessionKey 处理）。 */
export function normalizeSessionId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 会话 id 的比较键：容忍 `session-` 前缀的有无。
 *
 * projcache 文件名与客户端 snapshot 的 sessionId 在理论上可能只差这个前缀；
 * 全链路只走这一个比较入口，避免各处各写一遍字符串处理。
 */
export function sessionKey(value) {
  const id = normalizeSessionId(value)
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/** 两个会话 id 是否指同一个会话。 */
export function sameSession(a, b) {
  const ka = sessionKey(a)
  return ka !== '' && ka === sessionKey(b)
}

/**
 * 校验并归一化一份"新建/编辑"草稿。只接受白名单字段。
 * @returns {{ok:true, value:object} | {ok:false, error:object}}
 */
export function validateDraft(input) {
  if (!isObject(input)) return err('INVALID_BODY', '工作项必须是 JSON 对象')

  if (typeof input.title !== 'string' || input.title.trim() === '') {
    return err('TITLE_REQUIRED', '标题不能为空', 'title')
  }
  const title = input.title.trim()
  if (charCount(title) > LIMITS.title) {
    return err('TITLE_TOO_LONG', `标题最多 ${LIMITS.title} 字`, 'title')
  }
  const out = { title }

  if (input.nextStep !== undefined && input.nextStep !== null) {
    if (typeof input.nextStep !== 'string') return err('INVALID_BODY', 'nextStep 必须是字符串', 'nextStep')
    // 「下一步」是单行字段：换行一律折成空格，而不是报错。
    const oneLine = input.nextStep.replace(/\s*\r?\n+\s*/g, ' ').trim()
    if (charCount(oneLine) > LIMITS.nextStep) {
      return err('NEXT_STEP_TOO_LONG', `下一步最多 ${LIMITS.nextStep} 字`, 'nextStep')
    }
    out.nextStep = oneLine
  }

  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') return err('INVALID_BODY', 'note 必须是字符串', 'note')
    if (charCount(input.note) > LIMITS.note) {
      return err('NOTE_TOO_LONG', `备注最多 ${LIMITS.note} 字`, 'note')
    }
    out.note = input.note
  }

  if (input.workspace !== undefined && input.workspace !== null) {
    if (typeof input.workspace !== 'string') return err('INVALID_BODY', 'workspace 必须是字符串', 'workspace')
    const workspace = input.workspace.trim()
    if (charCount(workspace) > LIMITS.workspace) {
      return err('WORKSPACE_TOO_LONG', `workspace 最多 ${LIMITS.workspace} 字`, 'workspace')
    }
    out.workspace = workspace
  }

  if (input.sessions !== undefined) {
    if (!Array.isArray(input.sessions)) return err('SESSIONS_INVALID', 'sessions 必须是数组', 'sessions')
    const seen = new Set()
    const sessions = []
    for (const raw of input.sessions) {
      if (typeof raw !== 'string') return err('SESSIONS_INVALID', 'sessions 里只能放字符串', 'sessions')
      const id = normalizeSessionId(raw)
      if (!id || !SESSION_ID_RE.test(id)) {
        return err('SESSIONS_INVALID', `不合法的会话 id：${String(raw).slice(0, 40)}`, 'sessions')
      }
      const key = sessionKey(id)
      if (seen.has(key)) continue
      seen.add(key)
      sessions.push(id)
    }
    if (sessions.length > LIMITS.sessions) {
      return err('SESSIONS_TOO_MANY', `一个工作项最多关联 ${LIMITS.sessions} 个会话`, 'sessions')
    }
    out.sessions = sessions
  }

  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) {
      return err('UNKNOWN_STATUS', `未知状态：${String(input.status)}`, 'status')
    }
    out.status = input.status
  }

  return { ok: true, value: out }
}

/**
 * 归一化一条**已落盘**的记录。容忍缺省字段，但 id/title/status 不可修复时返回 null
 * （调用方丢弃并记录，绝不让整份文件因一条坏记录而打不开）。
 */
export function validateStoredItem(raw) {
  if (!isObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null
  if (!STATUSES.includes(raw.status)) return null

  const draft = validateDraft({
    title: raw.title,
    nextStep: typeof raw.nextStep === 'string' ? raw.nextStep : undefined,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    workspace: typeof raw.workspace === 'string' ? raw.workspace : undefined,
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
  })
  if (!draft.ok) return null

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  const item = {
    id: raw.id.trim(),
    ...draft.value,
    sessions: draft.value.sessions ?? [],
    status: raw.status,
    createdAt,
    updatedAt,
    closedAt: raw.status === 'done' ? (Number.isFinite(raw.closedAt) ? raw.closedAt : updatedAt) : null,
    history: Array.isArray(raw.history)
      ? raw.history.filter((e) => isObject(e) && Number.isFinite(e.at) && typeof e.kind === 'string').slice(-LIMITS.history)
      : [],
  }
  return item
}

/** 这条转移是否被允许（同状态不算转移，见 transition）。 */
export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false
  return (TRANSITIONS[from] ?? []).includes(to)
}

/** 追加一条 history，超过上限丢最旧的。 */
export function pushHistory(item, entry) {
  const history = Array.isArray(item.history) ? item.history.slice() : []
  history.push(entry)
  const capped = history.length > LIMITS.history ? history.slice(history.length - LIMITS.history) : history
  return { ...item, history: capped }
}

/**
 * 改状态。
 * @param {object} item 当前记录
 * @param {string} to 目标状态
 * @param {number} [now] epoch 毫秒
 */
export function transition(item, to, now = Date.now()) {
  if (!STATUSES.includes(to)) return err('UNKNOWN_STATUS', `未知状态：${String(to)}`, 'status')
  // 同状态是幂等的：重试不该产生一条 history，也不该报错。
  if (item.status === to) return { ok: true, value: item }
  if (!canTransition(item.status, to)) {
    return err('ILLEGAL_TRANSITION', `${item.status} → ${to} 不被允许`, 'status')
  }
  const next = {
    ...item,
    status: to,
    updatedAt: now,
    closedAt: to === 'done' ? now : null,
  }
  return { ok: true, value: pushHistory(next, { at: now, kind: 'status', from: item.status, to }) }
}

/** 把一段文本截成 history 里能放的长度。 */
function brief(value, max = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return Array.from(text).length > max ? Array.from(text).slice(0, max).join('') + '…' : text
}

/**
 * 打补丁（不含 status，状态只能走 transition）。
 * @param {object} item 当前记录
 * @param {object} patch 已通过 validateDraft 的字段子集
 * @param {number} [now] epoch 毫秒
 */
export function applyPatch(item, patch, now = Date.now()) {
  const next = { ...item }
  const entries = []

  if (patch.title !== undefined && patch.title !== item.title) {
    next.title = patch.title
    entries.push({ at: now, kind: 'title', to: brief(patch.title) })
  }
  if (patch.nextStep !== undefined && patch.nextStep !== item.nextStep) {
    next.nextStep = patch.nextStep
    entries.push({ at: now, kind: 'nextStep', to: brief(patch.nextStep) })
  }
  if (patch.note !== undefined && patch.note !== item.note) {
    next.note = patch.note
    entries.push({ at: now, kind: 'note', to: brief(patch.note) })
  }
  if (patch.workspace !== undefined && patch.workspace !== item.workspace) {
    next.workspace = patch.workspace
    entries.push({ at: now, kind: 'workspace', to: brief(patch.workspace) })
  }
  if (patch.sessions !== undefined) {
    const before = new Set(item.sessions.map(sessionKey))
    const after = new Set(patch.sessions.map(sessionKey))
    const added = patch.sessions.filter((id) => !before.has(sessionKey(id)))
    const removed = item.sessions.filter((id) => !after.has(sessionKey(id)))
    if (added.length > 0 || removed.length > 0) {
      next.sessions = patch.sessions.slice()
      for (const id of removed) entries.push({ at: now, kind: 'session-', to: brief(id) })
      for (const id of added) entries.push({ at: now, kind: 'session+', to: brief(id) })
    }
  }

  if (entries.length === 0) return { ok: true, value: item }

  let patched = next
  for (const entry of entries) patched = pushHistory(patched, entry)
  return { ok: true, value: { ...patched, updatedAt: now } }
}

/** 各状态计数（看板头部与测试都用）。 */
export function countByStatus(items) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1
  }
  return counts
}
