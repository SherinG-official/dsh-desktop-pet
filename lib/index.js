/**
 * 插件主体：数据文件 → store → 路由（工作项 + 桌宠立绘 + 皮肤仓库），
 * 并在没有独立桌宠包时，把内嵌的 `./pet/` 当作子插件挂起来。
 *
 * 看板本身不读这里的工作项数据 —— 会话进程全部来自客户端 session store。
 * 工作项接口是 v1 遗产（保留、界面不展示）；皮肤与桌宠是现在在用的。
 */

import os from 'node:os'
import path from 'node:path'
import { createPetRoutes, hasInstalledPet } from './pet.js'
import { registerRoutes } from './routes.js'
import { createSkinRoutes } from './skin-routes.js'
import { createSkinStore } from './skins.js'
import { createStore } from './store.js'

export const name = 'session-board'
export const inject = ['webServer']

/** 只展开 `~` / `~/` / `~\` 这一种形态（和宿主 home-paths 的规则一致）。 */
function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

function dshHome() {
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return envHome !== '' ? envHome : path.join(os.homedir(), '.dsh')
}

/**
 * 数据文件位置：显式 config > $DSH_HOME > ~/.dsh，然后落到 `<home>/dsh-workbench/workbench.json`。
 *
 * 目录名沿用 `dsh-workbench`：这是 v1 写下的数据，改名会让已有的工作项"消失"。
 * @param {object} [config]
 */
export function resolveDataFile(config) {
  const explicit = typeof config?.dataFile === 'string' ? config.dataFile.trim() : ''
  if (explicit !== '') return path.resolve(expandHome(explicit))
  return path.join(dshHome(), 'dsh-workbench', 'workbench.json')
}

/**
 * 皮肤仓库目录：显式 config > `$DSH_HOME/dsh-session-board`。
 * @param {object} [config]
 */
export function resolveSkinDir(config) {
  const explicit = typeof config?.skinDir === 'string' ? config.skinDir.trim() : ''
  if (explicit !== '') return path.resolve(expandHome(explicit))
  return path.join(dshHome(), 'dsh-session-board')
}

/**
 * 把内嵌的桌宠作为子插件挂起来。
 *
 * 只在**没有**独立安装的 `dsh-desktop-pet` 时挂：两份同时活着会各自 spawn 一个浮窗，
 * 而且两条 `/dsh-desktop-pet` 精确路由会撞（webServer 直接抛 duplicate route）。
 *
 * 用动态 import 而不是静态 import：`./pet/lib/index.js` 依赖 `@deepseek-ai/schemastery`
 * 与它自己的 `src/`，任何一处缺失都只该让"桌宠"缺席，不能让整个插件的 apply 抛掉。
 *
 * @param {object} ctx
 * @param {{ pet?: boolean|object }} config `pet: false` 可彻底关掉内嵌桌宠
 * @param {(message: string) => void} log
 */
function mountEmbeddedPet(ctx, config, log) {
  if (config?.pet === false) return
  if (hasInstalledPet()) {
    log('检测到独立安装的 dsh-desktop-pet，跳过内嵌桌宠（两款同时挂会撞控制路由）')
    return
  }
  const overrides = config?.pet && typeof config.pet === 'object' ? config.pet : {}
  import('../pet/lib/index.js')
    .then((mod) => {
      try {
        ctx.plugin(mod, { enabled: true, controlPanel: true, ...overrides })
        log('已挂载内嵌桌宠（浮窗 + 控制口 + 立绘）')
      } catch (error) {
        log(`内嵌桌宠挂载失败：${String(error?.message ?? error)}`)
      }
    })
    .catch((error) => log(`内嵌桌宠加载失败：${String(error?.message ?? error)}`))
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataFile?: string, skinDir?: string, pet?: boolean|object }} [config]
 */
export function apply(ctx, config = {}) {
  const log = (message) => console.warn(`[dsh-session-board] ${message}`)
  const store = createStore({ file: resolveDataFile(config), log })
  const skins = createSkinStore({ dir: resolveSkinDir(config), log })

  ctx.effect(
    () => registerRoutes(ctx, store, [...createPetRoutes(), ...createSkinRoutes(skins)]),
    'dsh-session-board: routes',
  )

  mountEmbeddedPet(ctx, config, log)
}
