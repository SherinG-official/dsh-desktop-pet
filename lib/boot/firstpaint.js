/**
 * 首屏注入：在**文档解析阶段**就把启动遮罩画上，盖住宿主自己的 loading 卡片。
 *
 * 机制（已从宿主 `dsh-host-webserver` 源码确认）：插件在 `webserver/index-inject`
 * 事件里往 table 里推行，行只允许这几种：
 *
 *   { kind:'style',    text }                 // 插到 <head>
 *   { kind:'html',     placement, html }      // 插到 <head>/<body> 开头
 *   { kind:'script',   placement, text }      // 内联脚本
 *   { kind:'script-src', placement, src }
 *   { kind:'global',   name, value }
 *
 * 这里只用 `style` + `html`：不依赖外链、不执行脚本，坏了也只是多一层背景。
 *
 * 三条纪律：
 *   1. **只注入一次**（模块级 flag）—— 重复注入会叠两层，极端情况下盖死界面；
 *   2. **kill switch**：`<DSH_HOME>/dsh-session-board/boot.disabled` 存在就完全不注入；
 *   3. 不需要客户端配合也能自己消失 —— 客户端会调 dismiss，但页面里还有一条
 *      CSS 兜底动画（`animation` 到 4.2s 自动淡出），以防客户端模块加载失败。
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIRSTPAINT_ID = 'dsh-sb-firstpaint'

const CSS = `
#${FIRSTPAINT_ID}{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 0%,#141d3a 0%,#0b1020 55%,#070b16 100%);color:#c8d4f5;transition:opacity .42s ease;will-change:opacity;animation:${FIRSTPAINT_ID}-failsafe .5s ease 4.2s forwards}
#${FIRSTPAINT_ID}.is-out{opacity:0;pointer-events:none;animation:none}
#${FIRSTPAINT_ID} svg{width:46px;height:46px;stroke:#8fb0ff;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;animation:${FIRSTPAINT_ID}-breathe 1.8s ease-in-out infinite}
#${FIRSTPAINT_ID} .dsh-sb-fp-text{font-size:12px;letter-spacing:.18em;opacity:.75}
@keyframes ${FIRSTPAINT_ID}-breathe{0%,100%{opacity:.5;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
@keyframes ${FIRSTPAINT_ID}-failsafe{to{opacity:0;pointer-events:none}}
@media (prefers-reduced-motion: reduce){#${FIRSTPAINT_ID} svg{animation:none}}
`.trim()

const HTML = `<div id="${FIRSTPAINT_ID}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21c0-4.2 1.6-7.4 4.2-9.4"/><path d="M12 21c0-4.2-1.6-7.4-4.2-9.4"/><path d="M7.8 11.6c-1.9.5-3.3 1.8-4 3.9 2.2.2 3.8-.4 4.9-1.6"/><path d="M16.2 11.6c1.9.5 3.3 1.8 4 3.9-2.2.2-3.8-.4-4.9-1.6"/><path d="M12 12V3.5"/></svg><div class="dsh-sb-fp-text">会话进程</div></div>`

let installed = false

function dshHome() {
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return envHome !== '' ? envHome : path.join(os.homedir(), '.dsh')
}

export function bootDisabled() {
  return existsSync(path.join(dshHome(), 'dsh-session-board', 'boot.disabled'))
}

/**
 * 注册首屏注入。
 * @param {object} ctx 插件 context
 * @param {{ enabled?: boolean, log?: (message: string) => void }} [options]
 */
export function installFirstPaint(ctx, options = {}) {
  const { enabled = true, log = () => {} } = options
  if (!enabled || installed) return false
  if (bootDisabled()) {
    log('检测到 boot.disabled，跳过首屏注入')
    return false
  }
  installed = true

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: CSS })
      table.push({ kind: 'html', placement: 'body', html: HTML })
    })
  })
  log('首屏遮罩已注入（文档解析阶段绘制）')
  return true
}
