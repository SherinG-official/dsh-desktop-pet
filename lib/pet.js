/**
 * 桌宠（已并入本插件）：立绘代理 + 安装状态探测。
 *
 * 0.3.0 起把 `dsh-desktop-pet` 的整个运行时（lib / src / pet-app / renderer / assets）
 * 收进了 `./pet/`：浮窗、控制口、立绘都归本插件管，所以 profile 里**不需要**再单独装它。
 * 若旧的那个还装着，`lib/index.js` 会跳过内嵌挂载（否则两条 `/dsh-desktop-pet` 路由会撞），
 * 立绘也优先用内嵌那份。
 *
 * 三条纪律：
 *   1. 只放白名单里的 pose，其余一律 404 —— 用户输入永不进路径；
 *   2. 找不到立绘就当没有，不报错、不影响看板；
 *   3. 60 秒内缓存"独立包在哪"的探测结果。
 *
 * ⚠️ prefix 路由的路径**不能带结尾斜杠**：宿主 match() 的判定是
 * `pathname === prefix || pathname.startsWith(prefix + '/')`。
 * 注册成 `.../pet/` 时只有那个带斜杠的精确路径能命中，`.../pet/idle` 会落到 401。
 */

import { promises as fs, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PET_PACKAGE = 'dsh-desktop-pet'
export const ROUTE_PREFIX = '/api/session-board/pet'
/** 桌宠包里的合法表情/姿态（就是它的 assets/pet/*.png）。 */
export const POSES = ['base', 'idle', 'busy', 'alert', 'hover', 'chew', 'mini']

/** 内嵌的那份桌宠（本包 `./pet/`）。 */
export const VENDORED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pet')

const PROBE_TTL_MS = 60 * 1000

function dshHome() {
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return envHome !== '' ? envHome : path.join(os.homedir(), '.dsh')
}

/** 独立安装的桌宠包可能在哪（按可信度排序）。 */
export function candidateDirs() {
  const dirs = []

  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (profileDir !== '') dirs.push(path.join(profileDir, 'node_modules', PET_PACKAGE))

  const home = dshHome()
  dirs.push(path.join(home, 'profiles', 'desktop', 'node_modules', PET_PACKAGE))
  dirs.push(path.join(home, 'profiles', 'web', 'node_modules', PET_PACKAGE))
  dirs.push(path.join(home, 'plugins', PET_PACKAGE))

  return dirs
}

/** 独立包是否还装着（同步，供 apply 时决定要不要内嵌挂载）。 */
export function hasInstalledPet() {
  return candidateDirs().some((dir) => existsSync(path.join(dir, 'assets', 'pet', 'idle.png')))
}

let probe = { at: 0, dir: null }

/**
 * 找到**独立安装**的桌宠包目录，找不到返回 null。
 * @param {number} [now]
 * @param {string[]|null} [roots] 显式候选目录（测试用；给了就不用缓存）
 */
export async function resolvePetDir(now = Date.now(), roots = null) {
  const useCache = roots === null
  if (useCache && now - probe.at < PROBE_TTL_MS) return probe.dir

  let found = null
  for (const dir of useCache ? candidateDirs() : roots) {
    try {
      await fs.access(path.join(dir, 'assets', 'pet', 'idle.png'))
      found = dir
      break
    } catch {
      /* 换下一个候选 */
    }
  }

  if (useCache) probe = { at: now, dir: found }
  return found
}

/**
 * 读一张立绘：内嵌那份优先，其次才是独立包。
 *
 * @param {string} pose
 * @param {string[]|null} [roots] 显式候选目录（测试用：给了就只查这些）
 * @returns {Buffer|null}
 */
export function readPose(pose, roots = null) {
  if (!POSES.includes(pose)) return null
  const dirs = roots ?? [VENDORED_DIR, ...candidateDirs()]
  for (const dir of dirs) {
    try {
      return readFileSync(path.join(dir, 'assets', 'pet', `${pose}.png`))
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

function sendNotFound(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: { code: 'PET_POSE_UNAVAILABLE', message: '桌宠立绘不可用' } }))
}

/**
 * 桌宠立绘路由。
 * @returns {Array<{kind:'prefix', path:string, handler:Function}>}
 */
export function createPetRoutes() {
  return [
    {
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'METHOD', message: 'GET only' } }))
          return
        }
        const url = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
        // 前缀不带结尾斜杠：精确路径 `.../pet` 本身没有 pose → 404。
        if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
          sendNotFound(res)
          return
        }
        const pose = url.pathname.slice(ROUTE_PREFIX.length + 1).replace(/\.png$/, '')
        const bytes = readPose(pose)
        if (bytes === null) {
          sendNotFound(res)
          return
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'public, max-age=86400',
        })
        res.end(bytes)
      },
    },
  ]
}
