/**
 * 用户皮肤仓库：`$DSH_HOME/dsh-session-board/skins/<id>/{skin.json,skin.css}`。
 *
 * 皮肤是**纯数据**（token 表 + CSS），不是插件包 —— 所以切换是热的（换 token 层 + 换
 * 一个 <style>），不需要改 profile、不需要重启。内置三套在客户端里，这里只管用户导入的。
 *
 * 安全边界：
 *   · id 只允许 `[a-z0-9-]`，用户输入永远不会直接拼进路径；
 *   · token 名必须以 `--` 开头，值必须是 { light, dark } 成对字符串；
 *   · CSS 上限 64 KiB，token 上限 200 个。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const TOKEN_NAME_RE = /^--[a-zA-Z0-9-]{1,64}$/
const MAX_CSS = 64 * 1024
const MAX_TOKENS = 200
const MAX_NAME = 40
const MAX_TAGLINE = 120

export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
  return slug
}

function fail(code, message, field) {
  const error = field === undefined ? { code, message } : { code, message, field }
  return { ok: false, error }
}

/** 客户端内置皮肤 id：用户皮肤不能占用，也不能删。 */
const BUILTIN_IDS = ['whale', 'glass', 'fairy', 'native']

/**
 * 校验并归一化一份皮肤输入。
 * @param {object} input `{ id?, name, accent?, tagline?, tokens?, css? }`
 */
export function validateSkin(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('INVALID_SKIN', '皮肤必须是 JSON 对象')
  }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') return fail('SKIN_NAME_REQUIRED', '皮肤需要一个名字', 'name')
  if (Array.from(name).length > MAX_NAME) return fail('SKIN_NAME_TOO_LONG', `名字最多 ${MAX_NAME} 字`, 'name')

  const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : slugify(name)
  if (!ID_RE.test(id)) return fail('SKIN_ID_INVALID', `皮肤 id 只能是 a-z0-9-，实际是「${id}」`, 'id')

  const accent = typeof input.accent === 'string' ? input.accent.trim() : ''
  const tagline = typeof input.tagline === 'string' ? input.tagline.trim() : ''
  if (Array.from(tagline).length > MAX_TAGLINE) return fail('SKIN_TAGLINE_TOO_LONG', `描述最多 ${MAX_TAGLINE} 字`, 'tagline')

  const tokens = {}
  if (input.tokens !== undefined && input.tokens !== null) {
    if (typeof input.tokens !== 'object' || Array.isArray(input.tokens)) {
      return fail('SKIN_TOKENS_INVALID', 'tokens 必须是对象', 'tokens')
    }
    const names = Object.keys(input.tokens)
    if (names.length > MAX_TOKENS) return fail('SKIN_TOKENS_TOO_MANY', `最多 ${MAX_TOKENS} 个 token`, 'tokens')
    for (const tokenName of names) {
      if (!TOKEN_NAME_RE.test(tokenName)) {
        return fail('SKIN_TOKEN_NAME_INVALID', `token 名必须形如 --foo-bar：${tokenName}`, 'tokens')
      }
      const pair = input.tokens[tokenName]
      if (typeof pair !== 'object' || pair === null || typeof pair.light !== 'string' || typeof pair.dark !== 'string') {
        return fail('SKIN_TOKEN_PAIR_INVALID', `${tokenName} 必须是 { light, dark } 两个字符串`, 'tokens')
      }
      tokens[tokenName] = { light: pair.light, dark: pair.dark }
    }
  }

  const css = typeof input.css === 'string' ? input.css : ''
  if (css.length > MAX_CSS) return fail('SKIN_CSS_TOO_LARGE', `CSS 最多 ${MAX_CSS} 字符`, 'css')

  return { ok: true, value: { id, name, accent, tagline, tokens, css } }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 建一个皮肤仓库。
 * @param {{ dir: string, log?: (m: string) => void }} options dir = `$DSH_HOME/dsh-session-board`
 */
export function createSkinStore({ dir, log = () => {} }) {
  const root = path.join(dir, 'skins')
  const stateFile = path.join(dir, 'skins-state.json')
  let state = { active: null }

  async function loadState() {
    try {
      const text = await fs.readFile(stateFile, 'utf8')
      const parsed = JSON.parse(text)
      state = { active: typeof parsed?.active === 'string' ? parsed.active : null }
    } catch {
      state = { active: null }
    }
    return state
  }

  async function saveState() {
    await fs.mkdir(dir, { recursive: true })
    await writeAtomic(stateFile, JSON.stringify(state, null, 2) + '\n')
  }

  async function readSkin(id) {
    if (!ID_RE.test(id)) return null
    try {
      const folder = path.join(root, id)
      const meta = JSON.parse(await fs.readFile(path.join(folder, 'skin.json'), 'utf8'))
      let css = ''
      try {
        css = await fs.readFile(path.join(folder, 'skin.css'), 'utf8')
      } catch {
        css = ''
      }
      return { ...meta, id, css }
    } catch {
      return null
    }
  }

  async function list() {
    await loadState()
    let entries = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    const user = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue
      const skin = await readSkin(entry.name)
      if (skin === null) continue
      user.push({
        id: skin.id,
        name: skin.name,
        accent: skin.accent ?? '',
        tagline: skin.tagline ?? '',
        user: true,
        tokens: skin.tokens ?? {},
        hasCss: typeof skin.css === 'string' && skin.css.length > 0,
      })
    }
    user.sort((a, b) => a.name.localeCompare(b.name))
    return { active: state.active, user }
  }

  async function save(input) {
    const validated = validateSkin(input)
    if (!validated.ok) return validated
    const skin = validated.value
    const folder = path.join(root, skin.id)

    // 内置皮肤 id 不允许被用户覆盖（客户端那三套永远可用）。
    if (BUILTIN_IDS.includes(skin.id)) {
      return fail('SKIN_ID_RESERVED', `「${skin.id}」是内置皮肤 id，换个名字`, 'id')
    }

    await fs.mkdir(folder, { recursive: true })
    const meta = {
      id: skin.id,
      name: skin.name,
      accent: skin.accent,
      tagline: skin.tagline,
      tokens: skin.tokens,
      version: 1,
    }
    await writeAtomic(path.join(folder, 'skin.json'), JSON.stringify(meta, null, 2) + '\n')
    await writeAtomic(path.join(folder, 'skin.css'), skin.css)
    log(`保存皮肤 ${skin.id}`)
    return { ok: true, value: { id: skin.id, name: skin.name, accent: skin.accent, tagline: skin.tagline, user: true } }
  }

  async function remove(id) {
    if (!ID_RE.test(id)) return fail('SKIN_ID_INVALID', 'id 不合法', 'id')
    if (BUILTIN_IDS.includes(id)) return fail('SKIN_ID_RESERVED', '内置皮肤不能删', 'id')
    try {
      await fs.rm(path.join(root, id), { recursive: true, force: true })
    } catch (error) {
      return fail('SKIN_DELETE_FAILED', String(error?.message ?? error))
    }
    if (state.active === id) {
      state.active = null
      await saveState()
    }
    return { ok: true, value: { deleted: id } }
  }

  async function setActive(id) {
    const clean = typeof id === 'string' ? id.trim() : ''
    if (clean !== '' && !ID_RE.test(clean) && clean !== 'native') {
      return fail('SKIN_ID_INVALID', 'id 不合法', 'id')
    }
    state.active = clean === '' ? null : clean
    await saveState()
    return { ok: true, value: { active: state.active } }
  }

  return {
    list,
    read: readSkin,
    save,
    remove,
    setActive,
    async getActive() {
      await loadState()
      return state.active
    },
  }
}
