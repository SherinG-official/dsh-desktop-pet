/**
 * 持久化：单个 JSON 文件 + 原子写 + `.bak` + 串行写队列 + revision。
 *
 * 纪律（红线 3）：
 *   1. 先写 `<file>.tmp`，fsync，再 rename 覆盖主文件；
 *   2. 覆盖前把上一版复制成 `<file>.bak`（只留 1 份）；
 *   3. 所有写走同一条 promise 链，并发请求不会互相吃掉写；
 *   4. 每次成功写 revision+1，供前端做乐观更新与冲突检测。
 *
 * 读盘失败的分级：
 *   主文件坏 → 备份成 `<file>.corrupt-<ts>` 并尝试 `.bak`；
 *   单条记录坏 → 丢弃该条并记日志，绝不因为一条坏记录让整份文件打不开。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  LIMITS,
  applyPatch,
  emptyState,
  err,
  newId,
  normalizeSessionId,
  sessionKey,
  transition,
  validateDraft,
  validateStoredItem,
} from './model.js'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** history 里放得下的短文本。 */
function brief(value, max = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/** 写文件：临时文件 + fsync + rename，保证读者永远看到完整内容。 */
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
 * 建一个 store。
 * @param {{ file: string, log?: (message: string) => void }} options
 */
export function createStore({ file, log = () => {} }) {
  const backupFile = `${file}.bak`
  let state = emptyState()
  let loadPromise = null
  let queue = Promise.resolve()

  /** 把读不懂的主文件挪到一边，保住现场。 */
  async function quarantine() {
    const target = `${file}.corrupt-${Date.now()}`
    try {
      await fs.rename(file, target)
      log(`主文件无法解析，已备份为 ${path.basename(target)}`)
    } catch (error) {
      log(`主文件无法解析，备份失败：${String(error?.message ?? error)}`)
    }
  }

  function sanitize(raw) {
    if (!isPlainObject(raw)) return emptyState()
    const items = []
    for (const entry of Array.isArray(raw.items) ? raw.items : []) {
      const item = validateStoredItem(entry)
      if (item === null) {
        log('丢弃一条无法修复的工作项记录')
        continue
      }
      items.push(item)
    }
    return {
      version: 1,
      revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
      items,
    }
  }

  async function doLoad() {
    const main = await readJsonSafe(file)
    let raw = main.ok ? main.value : null
    if (!main.ok) {
      if (main.code !== 'ENOENT') {
        log(`读取主文件失败（${main.code}）：${main.message}`)
        await quarantine()
      }
    }
    if (raw === null) {
      const backup = await readJsonSafe(backupFile)
      if (backup.ok && backup.value !== null) {
        raw = backup.value
        log('主文件不可用，已从 .bak 恢复')
      }
    }
    state = sanitize(raw)
    return state
  }

  function load() {
    loadPromise ??= doLoad()
    return loadPromise
  }

  async function persist(next) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    // 先把当前主文件复制成 .bak（首个版本没有主文件，忽略 ENOENT）。
    try {
      const current = await fs.readFile(file, 'utf8')
      await writeFileDurable(backupFile, current)
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`写 .bak 失败（继续写主文件）：${String(error?.message ?? error)}`)
    }
    await writeFileDurable(file, `${JSON.stringify(next, null, 2)}\n`)
  }

  function revisionGuard(draft, baseRevision) {
    if (baseRevision === undefined || baseRevision === null) return null
    if (!Number.isInteger(baseRevision)) {
      return err('INVALID_BODY', 'baseRevision 必须是整数', 'baseRevision')
    }
    if (baseRevision !== draft.revision) {
      return err('STALE_REVISION', `数据已在别处更新（当前 revision ${draft.revision}）`)
    }
    return null
  }

  /**
   * 串行执行一次写：mutator 拿到当前状态的深拷贝，返回 { ok, state, value }。
   */
  function mutate(mutator) {
    const run = queue
      .then(async () => {
        await load()
        const draft = structuredClone(state)
        const result = mutator(draft)
        if (!result || result.ok !== true) return result ?? err('STORE_FAILED', '内部错误')
        const next = result.state
        next.version = 1
        next.revision = state.revision + 1
        await persist(next)
        state = next
        return { ok: true, value: result.value, revision: next.revision }
      })
      .catch((error) => ({
        ok: false,
        error: { code: 'STORE_FAILED', message: String(error?.message ?? error) },
      }))
    // 队列本身永远保持 resolved，否则一次失败会毒化后面所有写。
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function findIndex(draft, id) {
    return draft.items.findIndex((item) => item.id === id)
  }

  /**
   * 新建或整体更新（草稿语义：没传的字段保持原值，传了的覆盖）。
   * 状态不走这里，避免一次 upsert 顺带绕过状态机。
   */
  async function upsert(input, baseRevision) {
    const validated = validateDraft(input)
    if (!validated.ok) return validated
    const draftInput = validated.value
    const wantedId = typeof input?.id === 'string' ? input.id.trim() : ''

    return mutate((draft) => {
      const stale = revisionGuard(draft, baseRevision)
      if (stale !== null) return stale

      const now = Date.now()
      const index = wantedId === '' ? -1 : findIndex(draft, wantedId)

      if (index === -1) {
        const id = wantedId === '' ? newId(now) : wantedId
        if (draft.items.some((item) => item.id === id)) {
          return err('DUPLICATE_ID', `工作项 ${id} 已存在`, 'id')
        }
        const status = draftInput.status ?? 'backlog'
        const item = {
          id,
          title: draftInput.title,
          status,
          nextStep: draftInput.nextStep ?? '',
          note: draftInput.note ?? '',
          sessions: draftInput.sessions ?? [],
          workspace: draftInput.workspace ?? '',
          createdAt: now,
          updatedAt: now,
          closedAt: status === 'done' ? now : null,
          history: [{ at: now, kind: 'create', to: brief(draftInput.title) }],
        }
        draft.items.push(item)
        return { ok: true, state: draft, value: item }
      }

      const patched = applyPatch(draft.items[index], draftInput, now)
      if (!patched.ok) return patched
      draft.items[index] = patched.value
      return { ok: true, state: draft, value: patched.value }
    })
  }

  async function setStatus(id, status, baseRevision) {
    return mutate((draft) => {
      const stale = revisionGuard(draft, baseRevision)
      if (stale !== null) return stale
      const index = findIndex(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作项：${id}`)
      const moved = transition(draft.items[index], status, Date.now())
      if (!moved.ok) return moved
      draft.items[index] = moved.value
      return { ok: true, state: draft, value: moved.value }
    })
  }

  async function sessionsOp(id, { add = [], remove = [] } = {}, baseRevision) {
    return mutate((draft) => {
      const stale = revisionGuard(draft, baseRevision)
      if (stale !== null) return stale
      const index = findIndex(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作项：${id}`)
      const item = draft.items[index]

      const removed = new Set(remove.map(sessionKey))
      const kept = item.sessions.filter((sid) => !removed.has(sessionKey(sid)))
      const next = kept.slice()
      for (const raw of add) {
        const sid = normalizeSessionId(raw)
        if (sid === '') return err('SESSIONS_INVALID', 'add 里不能有空 id', 'add')
        if (!next.some((existing) => sessionKey(existing) === sessionKey(sid))) next.push(sid)
      }

      // 复用草稿校验（长度上限、字符集、去重都在 model 里，只有一份实现）。
      const validated = validateDraft({ title: item.title, sessions: next })
      if (!validated.ok) return validated

      const patched = applyPatch(item, { sessions: validated.value.sessions }, Date.now())
      if (!patched.ok) return patched
      draft.items[index] = patched.value
      return { ok: true, state: draft, value: patched.value }
    })
  }

  async function remove(id) {
    return mutate((draft) => {
      const index = findIndex(draft, id)
      if (index === -1) return err('NOT_FOUND', `没有这个工作项：${id}`)
      draft.items.splice(index, 1)
      return { ok: true, state: draft, value: { deleted: id } }
    })
  }

  return {
    file,
    fileName: path.basename(file),
    backupFileName: path.basename(backupFile),
    limits: LIMITS,
    ready: load,
    /** 当前快照（深拷贝，调用方随便改）。 */
    snapshot() {
      return structuredClone(state)
    },
    get revision() {
      return state.revision
    },
    upsert,
    setStatus,
    sessionsOp,
    remove,
  }
}
