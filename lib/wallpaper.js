/**
 * 壁纸：`<DSH_HOME>/dsh-session-board/wallpapers/` 里**最新的一张图**。
 *
 * 照 dsh-boot-suite 的做法：不提供上传 UI，丢图即换（按 mtime 取最新）。
 * 只做只读路由，客户端把它当 `background-image` 用；没有图就静默 404。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const WALLPAPER_ROUTE = '/api/session-board/wallpaper'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}

function dshHome() {
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return envHome !== '' ? envHome : path.join(os.homedir(), '.dsh')
}

/** 壁纸目录：显式 config > `<home>/dsh-session-board/wallpapers`。 */
export function resolveWallpaperDir(config) {
  const explicit = typeof config?.wallpaperDir === 'string' ? config.wallpaperDir.trim() : ''
  if (explicit !== '') return path.resolve(explicit)
  return path.join(dshHome(), 'dsh-session-board', 'wallpapers')
}

/** 目录里最新的一张图（按 mtime），没有就 null。 */
export function newestWallpaper(dir) {
  if (!existsSync(dir)) return null
  let best = null
  for (const name of readdirSync(dir)) {
    if (!IMAGE_EXT.test(name)) continue
    const file = path.join(dir, name)
    try {
      const stat = statSync(file)
      if (!stat.isFile()) continue
      if (best === null || stat.mtimeMs > best.mtimeMs) {
        best = { file, name, mtimeMs: stat.mtimeMs, type: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream' }
      }
    } catch {
      /* 读不到就跳过 */
    }
  }
  return best
}

/** 壁纸只读路由（用 prefix，和桌宠图片路由同一套已验证可用的形态）。 */
export function createWallpaperRoutes(dir) {
  return [
    {
      kind: 'prefix',
      path: WALLPAPER_ROUTE,
      handler: async (req, res) => {
        const url = new URL(req.url ?? WALLPAPER_ROUTE, 'http://localhost')
        // 只接受精确路径（允许 ?t= 之类的查询串）。
        if (url.pathname !== WALLPAPER_ROUTE) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '壁纸只在这个路径提供' } }))
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'METHOD', message: 'GET only' } }))
          return
        }
        const hit = newestWallpaper(dir)
        if (hit === null) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: { code: 'NO_WALLPAPER', message: '壁纸目录里没有图片' } }))
          return
        }
        let bytes
        try {
          bytes = readFileSync(hit.file)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'READ_FAILED', message: String(error?.message ?? error) } }))
          return
        }
        // 用 setHeader + statusCode（不用 writeHead）：某些前置中间件会先写状态行，
        // 实测 writeHead(200) 曾被吞成 400，而 header 仍然生效。
        res.statusCode = 200
        res.setHeader('content-type', hit.type)
        res.setHeader('content-length', String(bytes.length))
        res.setHeader('cache-control', 'public, max-age=86400')
        res.setHeader('x-wallpaper', encodeURIComponent(hit.name))
        res.end(bytes)
      },
    },
  ]
}
