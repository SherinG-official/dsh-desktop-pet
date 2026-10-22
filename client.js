/**
 * dsh-session-board —— 会话进程看板 + 鲸蓝娘（DeepSeek 娘）皮肤。
 *
 * 功能：自动识别会话进程 —— 等你回答 / 工作中 / 闲置 / 结束 —— 点一下直接进那个对话。
 * 零维护：状态全部从宿主已有的 session store 推出来（useSessions / useSessionStatus）。
 *
 * 皮肤（B 档）分两层，互不干扰：
 *   1. 全局层：`ctx.theme.overrideTokens(...)` 覆盖宿主的 alias token —— 官方口子，
 *      全 App 所有读 token 的组件自动跟随、明暗切换照常、卸载即还原。
 *   2. 本面板层：`.dsh-sb-*` 自有样式（渐变、状态色条、鲸尾、樱花点缀），只作用于自己。
 *
 * 契约（照本机已验证插件 dsh-session-recycle-bin / dsh-paper-radar-panel）：
 *   - 单文件自包含：`window.__ModuleLoader__.load({ id, factory })`
 *   - factory 里**只** require('react')
 *   - 页面挂 `main`（keyed），入口挂 `sidebar.panellist`
 *   - 样式只用 token + 自有前缀，`<style>` 在 apply 里注册并随 effect 移除
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-board',
  factory: (require) => {
    'use strict'

    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'session-board'
    /** 桌宠立绘的来源（host 侧 lib/pet.js 把 dsh-desktop-pet 的 PNG 转出来）。 */
    const PET_ROUTE = '/api/session-board/pet/'
    /** 桌宠自己的控制路由：/dsh-desktop-pet?action=status|toggle。 */
    const PET_CONTROL = '/dsh-desktop-pet'
    /** 24 小时：闲置 / 结束 的分界线。 */
    const IDLE_WINDOW_MS = 24 * 60 * 60 * 1000
    /** 7 天：结束 / 更早 的分界线（更早默认收起）。 */
    const ARCHIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

    const BUCKETS = [
      { key: 'waiting', label: '等你回答', hint: '会话卡在审批或提问上，进去回一句它就能继续' },
      { key: 'working', label: '工作中', hint: '当前正在跑的会话' },
      { key: 'idle', label: '闲置', hint: '没在跑，但 24 小时内动过' },
      { key: 'ended', label: '结束', hint: '没在跑，且超过 24 小时没动' },
      { key: 'older', label: '更早', hint: '超过 7 天没动（默认收起）' },
    ]

    /* ------------------------------------------------------------------ */
    /* 皮肤                                                                */
    /* ------------------------------------------------------------------ */
    /*
     * 一套皮肤 = alias token 覆盖（全 App 生效，官方口子）+ 可选的全局 CSS。
     * 换肤不用重启：overrideTokens 换层 + <style> 换内容即可。
     *
     * 鲸蓝娘：实色、蓝紫，克制的玻璃感。
     * 液态玻璃：极光底 + 半透明 token + 只在小面积上用 backdrop-filter
     *   （性能教训来自参考实现：大面积逐帧模糊会卡；saturate() 更贵，一律不用）。
     */

    const SKIN_KEY = 'dsh-session-board:skin'
    const DEFAULT_SKIN = 'whale'

    const WHALE_TOKENS = {
      '--dsw-alias-bg-base': { light: '#f4f8ff', dark: '#080e1b' },
      '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#101a2e' },
      '--dsw-alias-bg-layer-2': { light: '#eef4ff', dark: '#16233c' },
      '--dsw-alias-bg-layer-3': { light: '#e3ecfd', dark: '#1d2d4b' },
      '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#131f36' },
      '--dsw-alias-border-l1': { light: '#d9e4f7', dark: '#22304a' },
      '--dsw-alias-border-l2': { light: '#bed0ee', dark: '#31456b' },
      '--dsw-alias-brand-primary': { light: '#3b6ff0', dark: '#7c9bff' },
      '--dsw-alias-label-primary': { light: '#16233a', dark: '#e9effc' },
      '--dsw-alias-label-secondary': { light: '#5b6b86', dark: '#a3b3cc' },
      '--dsw-alias-state-error-primary': { light: '#d95f5f', dark: '#ff8f8f' },
      '--dsw-alias-state-idle-primary': { light: '#8a94a6', dark: '#8b97ab' },
      '--dsw-alias-state-success-primary': { light: '#2f9e6b', dark: '#4cd19a' },
      '--dsw-alias-state-warn-primary': { light: '#d9862f', dark: '#f0b46a' },
      '--dsw-specific-sidebar-fill': { light: '#e9f1ff', dark: '#0c1526' },
      '--dsw-alias-button-primary-fill': { light: '#3b6ff0', dark: '#4d6bfe' },
      '--dsw-alias-button-primary-hover': { light: '#2f5fd8', dark: '#6a86ff' },
    }

    const GLASS_TOKENS = {
      '--dsw-alias-bg-base': { light: 'rgba(234,240,252,0.58)', dark: 'rgba(9,13,24,0.58)' },
      '--dsw-alias-bg-layer-1': { light: 'rgba(255,255,255,0.64)', dark: 'rgba(20,28,48,0.60)' },
      '--dsw-alias-bg-layer-2': { light: 'rgba(255,255,255,0.46)', dark: 'rgba(30,40,66,0.46)' },
      '--dsw-alias-bg-layer-3': { light: 'rgba(255,255,255,0.36)', dark: 'rgba(38,50,80,0.42)' },
      '--dsw-alias-bg-overlay': { light: 'rgba(255,255,255,0.80)', dark: 'rgba(18,26,44,0.82)' },
      '--dsw-alias-border-l1': { light: 'rgba(120,150,210,0.34)', dark: 'rgba(140,170,255,0.22)' },
      '--dsw-alias-border-l2': { light: 'rgba(90,120,180,0.46)', dark: 'rgba(160,190,255,0.32)' },
      '--dsw-alias-brand-primary': { light: '#4b74ff', dark: '#8aa6ff' },
      '--dsw-alias-label-primary': { light: '#16213a', dark: '#e9f0ff' },
      '--dsw-alias-label-secondary': { light: '#5a6b8c', dark: '#a8b8d8' },
      '--dsw-alias-state-error-primary': { light: '#d96161', dark: '#ff8f8f' },
      '--dsw-alias-state-idle-primary': { light: '#8b96aa', dark: '#8d9ab4' },
      '--dsw-alias-state-success-primary': { light: '#22a06b', dark: '#54d6a2' },
      '--dsw-alias-state-warn-primary': { light: '#d9862f', dark: '#f2b872' },
      '--dsw-specific-sidebar-fill': { light: 'rgba(245,248,255,0.52)', dark: 'rgba(11,17,32,0.52)' },
      '--dsw-alias-button-primary-fill': { light: '#4b74ff', dark: '#5d7dff' },
      '--dsw-alias-button-primary-hover': { light: '#3a63ec', dark: '#7a95ff' },
    }

    /**
     * 液态玻璃（Apple Liquid Glass 风格）的全局层。
     *
     * 真实"折射"在纯 CSS 里做不到：`backdrop-filter` 不接受 `url(#svg)`，也没办法采样
     * 背后像素做位移。行业做法是用四层叠出"透镜感"：
     *   1. 磨砂底 —— blur + saturate；
     *   2. 边缘折射环 —— 1px 高光描边 + inset 上下高光；
     *   3. 镜面高光 —— 145° 的白色线性渐变（左上亮、右下透）；
     *   4. 悬浮感 —— 大半径、低透明度的柔和外投影。
     * 圆角用 squircle（`corner-shape: superellipse`），宿主本身也在用它。
     *
     * 命中宿主表面的办法：CSS Module 的类名是 `<构建哈希>_<语义名>`，所以用
     * `[class*="_composer"]` 这类**语义后缀**匹配，构建哈希重算也不会失效
     * （这比社区那种维护哈希前缀表的做法稳）。
     */
    /**
     * 液态玻璃：同一个材质，用在**四类**真正该是玻璃的面 ——
     *   1. 会话输入卡   `[data-composer-card]`（InputBar 写死的稳定标记）
     *   2. 设置面板     `[data-shortcut-modal="settings"]`
     *   3. 弹窗         `[role="dialog"]`（宿主 Modal 原语的 panel 固定带 role=dialog + aria-modal）
     *   4. 本插件看板   `.dsh-sb-card` / 胶囊 / 搜索框
     * 按钮、菜单、侧栏选中行不碰：上一版刷过，每个小控件都浮一层反而脏，已回退。
     *
     * 三个关键事实（从参考实现里量出来的）：
     *   1. 宿主给输入卡打了稳定标记 `data-composer-card`；设置面板有 `data-shortcut-modal`；
     *      所有 Modal 弹窗的 panel 都是 `role="dialog"` + `aria-modal="true"` + `<hash>_dialog`。
     *   2. 折射靠一个"裸" `<feDisplacementMap scale>`：不给 in/in2 时它把 backdrop
     *      快照自己的 alpha 边当作位移图，贴边处的内容因此被弯折。
     *   3. 输入卡/设置面板这份材质挂在 `::before`（避免 containing block 副作用）；
     *      弹窗因为定位五花八门，改用元素自身的 `backdrop-filter`。
     */
    const GLASS_SURFACE = ':is([data-composer-card],[data-shortcut-modal="settings"])'
    /**
     * 弹窗：宿主所有基于 `Modal` 原语的对话框都带 `role="dialog"`
     * （重命名会话、归档确认、用量面板、账号浮层……）；设置面板也在里面，但走上面那套规格。
     */
    const GLASS_POPUP = '[role="dialog"]:not([data-shortcut-modal="settings"]),[role="alertdialog"]'

    const GLASS_GLOBAL_CSS = [
      // 淡冷调蓝紫底：只给玻璃一点可折射的东西，不重绘整个界面。
      'html[data-dsh-sb-skin="glass"] body{background-image:radial-gradient(56% 44% at 12% 4%,rgba(122,165,255,.22),transparent 60%),radial-gradient(48% 42% at 88% 10%,rgba(198,168,255,.18),transparent 62%)!important;background-attachment:fixed!important}',
      'html[data-dsh-sb-skin="glass"] body[data-ds-dark-theme]{background-image:radial-gradient(54% 42% at 14% 6%,rgba(66,133,244,.26),transparent 60%),radial-gradient(46% 40% at 84% 8%,rgba(147,92,246,.24),transparent 62%)!important;background-attachment:fixed!important}',

      /* ---------- 会话输入卡 + 设置面板 ---------- */
      `html[data-dsh-sb-skin="glass"] ${GLASS_SURFACE}{isolation:isolate;background-color:rgba(255,255,255,.55)!important;background-image:none!important;border:1px solid rgba(255,255,255,.45)!important;border-radius:24px!important;corner-shape:superellipse(1.18);box-shadow:0 20px 48px -26px rgba(10,20,50,.60)!important}`,
      'html[data-dsh-sb-skin="glass"] [data-composer-card]{position:relative!important}',
      `html[data-dsh-sb-skin="glass"] ${GLASS_SURFACE}::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;` +
        'background:linear-gradient(145deg,rgba(255,255,255,.18),rgba(255,255,255,.02) 46%,rgba(126,146,255,.10));' +
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 -1px 0 rgba(255,255,255,.08),inset 0 0 26px rgba(255,255,255,.06);' +
        '-webkit-backdrop-filter:blur(18px) saturate(160%) url(#dsh-sb-refract);backdrop-filter:blur(18px) saturate(160%) url(#dsh-sb-refract)}',
      // 设置面板内部导航不要自己铺实底，否则玻璃被盖住
      'html[data-dsh-sb-skin="glass"] [data-shortcut-modal="settings"] > nav{background-color:transparent!important}',

      /* ---------- 弹窗（重命名会话、确认框、用量面板…） ---------- */
      // 直接用元素自身的 backdrop-filter，不挂伪元素：弹窗的定位五花八门（有的还是
      // createPortal 出来的 fixed 面板），伪元素锚点容易跑。backdrop-filter 不会盖住内容，
      // 也就不存在上一版"设置里看不到字"的层叠问题。
      // 排除设置面板：它走上面那套 24px 的规格。
      `html[data-dsh-sb-skin="glass"] ${GLASS_POPUP}{` +
        'background-color:rgba(255,255,255,.60)!important;' +
        'background-image:linear-gradient(145deg,rgba(255,255,255,.26),rgba(255,255,255,.03) 52%,rgba(126,146,255,.12))!important;' +
        'border:1px solid rgba(255,255,255,.50)!important;' +
        'border-radius:18px!important;' +
        'corner-shape:superellipse(1.12);' +
        '-webkit-backdrop-filter:blur(16px) saturate(160%) url(#dsh-sb-refract);backdrop-filter:blur(16px) saturate(160%) url(#dsh-sb-refract);' +
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.60),inset 0 -1px 0 rgba(255,255,255,.08),0 18px 44px -24px rgba(10,20,50,.55)!important' +
        '}',

      /* ---------- 看板自身 ---------- */
      'html[data-dsh-sb-skin="glass"] .dsh-sb-card{background-color:rgba(255,255,255,.30)!important;background-image:linear-gradient(145deg,rgba(255,255,255,.40),rgba(255,255,255,.05) 55%,rgba(126,146,255,.10))!important;border-color:rgba(255,255,255,.46)!important;border-radius:16px!important;-webkit-backdrop-filter:blur(12px) saturate(150%);backdrop-filter:blur(12px) saturate(150%);box-shadow:inset 0 1px 0 rgba(255,255,255,.62),0 12px 28px -20px rgba(10,20,50,.5)!important;corner-shape:superellipse(1.1)}',
      'html[data-dsh-sb-skin="glass"] .dsh-sb-card:hover{border-color:rgba(255,255,255,.8)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.85),0 16px 34px -20px rgba(10,20,50,.55)!important}',
      'html[data-dsh-sb-skin="glass"] .dsh-sb-card.is-cursor{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 0 0 2px var(--dsw-alias-brand-primary),0 16px 34px -20px rgba(10,20,50,.55)!important}',
      'html[data-dsh-sb-skin="glass"] .dsh-sb-pill,html[data-dsh-sb-skin="glass"] .dsh-sb-input{background-color:rgba(255,255,255,.34)!important;border-color:rgba(255,255,255,.5)!important}',

      /* ---------- 暗色 ---------- */
      `html[data-dsh-sb-skin="glass"] body[data-ds-dark-theme] ${GLASS_SURFACE}{background-color:rgba(18,26,44,.60)!important;border-color:rgba(170,195,255,.26)!important;box-shadow:0 22px 50px -26px rgba(0,0,0,.8)!important}`,
      `html[data-dsh-sb-skin="glass"] body[data-ds-dark-theme] ${GLASS_SURFACE}::before{background:linear-gradient(145deg,rgba(170,195,255,.14),rgba(255,255,255,.02) 46%,rgba(124,90,255,.12));box-shadow:inset 0 1px 0 rgba(255,255,255,.20),inset 0 -1px 0 rgba(255,255,255,.04),inset 0 0 26px rgba(140,170,255,.06)}`,
      'html[data-dsh-sb-skin="glass"] body[data-ds-dark-theme] .dsh-sb-card{background-color:rgba(34,46,74,.52)!important;background-image:linear-gradient(145deg,rgba(170,195,255,.18),rgba(255,255,255,.02) 55%,rgba(124,90,255,.12))!important;border-color:rgba(170,195,255,.26)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.20),0 12px 28px -20px rgba(0,0,0,.7)!important}',
      `html[data-dsh-sb-skin="glass"] body[data-ds-dark-theme] ${GLASS_POPUP}{background-color:rgba(18,26,44,.66)!important;background-image:linear-gradient(145deg,rgba(170,195,255,.16),rgba(255,255,255,.02) 52%,rgba(124,90,255,.14))!important;border-color:rgba(170,195,255,.26)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.20),0 20px 46px -24px rgba(0,0,0,.8)!important}`,
    ].join('\n')

    /** 折射过滤器：裸 feDisplacementMap（不显式 in/in2 → 用 backdrop 自己的 alpha 边做位移图）。 */
    const REFRACT_SVG_ID = 'dsh-sb-refract-svg'
    const REFRACT_SVG =
      '<svg id="dsh-sb-refract-svg" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;visibility:hidden;overflow:hidden">' +
      '<filter id="dsh-sb-refract" x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">' +
      '<feDisplacementMap scale="60"/>' +
      '</filter></svg>'

    function ensureRefractFilter() {
      if (document.getElementById(REFRACT_SVG_ID) !== null) return
      const holder = document.createElement('div')
      holder.innerHTML = REFRACT_SVG
      const svg = holder.firstElementChild
      if (svg !== null) document.body.appendChild(svg)
    }

    function removeRefractFilter() {
      const existing = document.getElementById(REFRACT_SVG_ID)
      if (existing !== null) existing.remove()
    }

    const SKINS = [
      { id: 'whale', name: '鲸蓝娘', accent: '#3b6ff0', tagline: '鲸蓝实色 · 安静', tokens: WHALE_TOKENS, css: '' },
      {
        id: 'glass',
        name: '液态玻璃',
        accent: '#7aa2ff',
        tagline: '冷调蓝紫 · 磨砂玻璃 · 悬浮',
        tokens: GLASS_TOKENS,
        css: GLASS_GLOBAL_CSS,
      },
      { id: 'native', name: '原生', accent: '', tagline: '宿主默认外观', tokens: null, css: '' },
    ]

    /* ---- 皮肤管理器（host 持久化 + 热切换） ------------------------------ */

    const SKIN_API = '/api/session-board/skins'
    /** 用户导入的皮肤（含 token 表与 CSS），由 host 拉取。 */
    let userSkins = []
    /** 当前主题服务与撤销句柄；theme 服务就绪后由 apply 填入。 */
    let skinTheme = null
    let skinDispose = null
    let activeSkinId = null

    function readStoredSkin() {
      try {
        const stored = localStorage.getItem(SKIN_KEY)
        return SKINS.some((skin) => skin.id === stored) ? stored : DEFAULT_SKIN
      } catch {
        return DEFAULT_SKIN
      }
    }

    function storeSkin(id) {
      try {
        localStorage.setItem(SKIN_KEY, id)
      } catch {
        /* 隐私模式写不进去就算了 */
      }
    }

    async function skinRequest(path, options) {
      const opts = options ?? {}
      const method = opts.method ?? 'GET'
      const headers = {}
      if (opts.body !== undefined) headers['content-type'] = 'application/json'
      if (method !== 'GET') headers['x-dsh-plugin'] = 'session-board'
      const response = await fetch(SKIN_API + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      const payload = await response.json().catch(() => null)
      if (!payload || payload.ok !== true) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        error.code = payload?.error?.code ?? `HTTP_${response.status}`
        throw error
      }
      return payload.value
    }

    /** 拉列表：`{ active, user: [meta...] }`。 */
    async function loadSkinList() {
      const value = await skinRequest('')
      userSkins = Array.isArray(value?.user) ? value.user : []
      return { active: typeof value?.active === 'string' ? value.active : null, user: userSkins }
    }

    function teardownSkin() {
      try {
        if (typeof skinDispose === 'function') skinDispose()
      } catch {
        /* 已经拆过了 */
      }
      skinDispose = null
      document.documentElement.removeAttribute('data-dsh-sb-skin')
      removeRefractFilter()
    }

    function applyResolvedSkin(skin) {
      teardownSkin()
      if (!skin) return
      let disposeTokens = null
      let styleEl = null
      // 文档级开关：玻璃皮肤那段全局 CSS 全部挂在 `html[data-dsh-sb-skin="glass"]` 下，
      // 切走时属性和 <style> 一起消失，不会留残影。
      document.documentElement.setAttribute('data-dsh-sb-skin', skin.id)
      if (skin.id === 'glass') ensureRefractFilter()
      if (skin.tokens && skinTheme && typeof skinTheme.overrideTokens === 'function') {
        disposeTokens = skinTheme.overrideTokens('dsh-session-board:skin', skin.tokens)
      }
      if (skin.css) {
        styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-session-board-skin', skin.id)
        styleEl.textContent = skin.css
        document.head.appendChild(styleEl)
      }
      skinDispose = () => {
        try {
          if (typeof disposeTokens === 'function') disposeTokens()
        } catch {
          /* 忽略 */
        }
        if (styleEl) styleEl.remove()
      }
      activeSkinId = skin.id
      storeSkin(skin.id)
      notifySkin()
    }

    /* ---- 当前皮肤的小订阅：设置页改了，看板立刻跟着换材质 ---- */
    const skinListeners = new Set()

    function notifySkin() {
      for (const listener of skinListeners) {
        try {
          listener(activeSkinId)
        } catch {
          /* 组件已卸载 */
        }
      }
    }

    function useActiveSkin() {
      const [id, setId] = React.useState(() => activeSkinId ?? readStoredSkin())
      React.useEffect(() => {
        const listener = (value) => setId(value ?? readStoredSkin())
        skinListeners.add(listener)
        listener(activeSkinId)
        return () => {
          skinListeners.delete(listener)
        }
      }, [])
      return id
    }

    /** 按 id 应用：内置皮肤本地就有，用户皮肤可能要先拉全文。 */
    async function applySkinById(id) {
      let skin = SKINS.find((entry) => entry.id === id) ?? userSkins.find((entry) => entry.id === id)
      if (!skin && typeof id === 'string' && id !== '') {
        try {
          skin = await skinRequest(`/${encodeURIComponent(id)}`)
          userSkins = [...userSkins.filter((entry) => entry.id !== skin.id), skin]
        } catch {
          skin = null
        }
      }
      applyResolvedSkin(skin ?? SKINS[0])
      return activeSkinId
    }

    /** 用户动作：应用 + 写回 host，保证换浏览器/重启后仍是这套。 */
    async function setSkin(id) {
      const applied = await applySkinById(id)
      try {
        await skinRequest('/active', { method: 'POST', body: { id: applied } })
      } catch {
        /* 持久化失败不影响本次观感 */
      }
      return applied
    }

    const EMPTY_BY_ID = {}

    const CSS = [
      /* ---- 画布 ---------------------------------------------------------- */
      '.dsh-sb{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.dsh-sb *{box-sizing:border-box}',
      '.dsh-sb::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(900px 380px at 12% -8%,rgba(77,107,254,.16),transparent 62%),radial-gradient(700px 320px at 92% 6%,rgba(79,195,247,.12),transparent 60%)}',
      '.dsh-sb > *{position:relative}',

      /* ---- 头部 ---------------------------------------------------------- */
      '.dsh-sb-head{display:flex;align-items:center;gap:10px;padding:16px 22px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap;backdrop-filter:saturate(140%)}',
      '.dsh-sb-mark{width:22px;height:22px;flex:0 0 auto;color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-pet{flex:0 0 auto;object-fit:contain;user-select:none;filter:drop-shadow(0 6px 14px rgba(20,40,90,.22))}',
      '.dsh-sb-pet[data-pose="alert"]{animation:dsh-sb-hop 2.6s ease-in-out infinite}',
      '@keyframes dsh-sb-hop{0%,86%,100%{transform:translateY(0)}90%{transform:translateY(-4px)}94%{transform:translateY(0)}}',
      '.dsh-sb-title{font-size:15px;font-weight:650;margin:0;letter-spacing:.2px}',
      '.dsh-sb-spacer{flex:1 1 auto}',
      '.dsh-sb-pills{display:flex;gap:6px;flex-wrap:wrap}',
      '.dsh-sb-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-sb-pill b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-sb-pill.waiting{border-color:rgba(255,158,196,.55);background:rgba(255,158,196,.12)}',
      '.dsh-sb-pill.working{border-color:rgba(47,158,107,.45);background:rgba(47,158,107,.10)}',
      '.dsh-sb-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;transition:border-color .15s ease,background-color .15s ease,transform .15s ease}',
      '.dsh-sb-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}',
      '.dsh-sb-input{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px 11px;font-size:12px;font-family:inherit;min-width:210px;transition:border-color .15s ease,box-shadow .15s ease}',
      '.dsh-sb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px rgba(77,107,254,.14)}',
      '.dsh-sb-sub{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin-top:-2px}',

      /* ---- 看板 ---------------------------------------------------------- */
      '.dsh-sb-board{display:flex;gap:14px;align-items:flex-start;overflow-x:auto;overflow-y:hidden;padding:16px 22px 26px;flex:1 1 auto;min-height:0}',
      '.dsh-sb-col{flex:1 1 232px;min-width:232px;max-width:400px;display:flex;flex-direction:column;gap:9px;min-height:0;max-height:100%}',
      '.dsh-sb-col-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:4px 2px 6px;font-size:12px;color:var(--dsw-alias-label-secondary);background:linear-gradient(var(--dsw-alias-bg-base) 72%,transparent)}',
      '.dsh-sb-col-name{font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.2px}',
      '.dsh-sb-col-count{min-width:20px;text-align:center;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:10px;font-variant-numeric:tabular-nums}',
      '.dsh-sb-col-toggle{margin-left:auto;background:none;border:0;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;font-family:inherit;padding:0}',
      '.dsh-sb-col-toggle:hover{color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-col-body{display:flex;flex-direction:column;gap:9px;overflow-y:auto;min-height:0;padding:1px 2px 6px}',

      /* ---- 卡片 ---------------------------------------------------------- */
      '.dsh-sb-card{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px 10px 16px;cursor:pointer;text-align:left;font-family:inherit;color:inherit;width:100%;overflow:hidden;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}',
      '.dsh-sb-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-state-idle-primary);opacity:.75}',
      '.dsh-sb-card:hover{transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);box-shadow:0 6px 18px -10px rgba(20,40,90,.45)}',
      '.dsh-sb-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-sb-card[data-bucket="waiting"]{background:linear-gradient(180deg,rgba(255,158,196,.14),rgba(255,158,196,.04));border-color:rgba(255,158,196,.45)}',
      '.dsh-sb-card[data-bucket="waiting"]::before{background:#ff9ec4;opacity:1}',
      '.dsh-sb-card[data-bucket="working"]::before{background:var(--dsw-alias-state-success-primary);opacity:1}',
      '.dsh-sb-card[data-bucket="ended"]::before,.dsh-sb-card[data-bucket="older"]::before{opacity:.4}',
      '.dsh-sb-card.is-cursor{box-shadow:0 0 0 2px rgba(77,107,254,.35),0 6px 18px -10px rgba(20,40,90,.4)}',
      '.dsh-sb-card-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;line-height:1.45;margin:0 0 6px}',
      '.dsh-sb-card-title span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
      '.dsh-sb-card-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex-wrap:wrap}',
      '.dsh-sb-card-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dsh-sb-when{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}',

      /* ---- 状态点 -------------------------------------------------------- */
      '.dsh-sb-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary);display:inline-block}',
      '.dsh-sb-dot.waiting{background:#ff9ec4;box-shadow:0 0 0 3px rgba(255,158,196,.22);animation:dsh-sb-pulse 2.4s ease-in-out infinite}',
      '.dsh-sb-dot.working{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px rgba(47,158,107,.18);animation:dsh-sb-pulse 2.4s ease-in-out infinite}',
      '.dsh-sb-dot.ended{background:var(--dsw-alias-state-idle-primary);opacity:.55}',
      '.dsh-sb-dot.older{background:var(--dsw-alias-state-idle-primary);opacity:.3}',
      '@keyframes dsh-sb-pulse{0%,100%{box-shadow:0 0 0 3px rgba(47,158,107,.10)}50%{box-shadow:0 0 0 5px rgba(47,158,107,.05)}}',

      /* ---- 空态 ---------------------------------------------------------- */
      '.dsh-sb-empty-col{position:relative;border:1px dashed var(--dsw-alias-border-l1);border-radius:14px;padding:20px 12px;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary);background:radial-gradient(120px 60px at 50% 0%,rgba(77,107,254,.06),transparent 70%)}',
      '.dsh-sb-empty{position:relative;border:1px dashed var(--dsw-alias-border-l1);border-radius:16px;padding:44px 24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;margin:6px 22px;background:radial-gradient(600px 260px at 50% 0%,rgba(77,107,254,.10),transparent 65%)}',
      '.dsh-sb-empty-mark{width:56px;height:56px;margin:0 auto 12px;opacity:.6;color:var(--dsw-alias-brand-primary)}',

      /* ---- 底部 ---------------------------------------------------------- */
      '.dsh-sb-foot{padding:9px 22px 13px;font-size:11px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;display:flex;gap:14px;flex-wrap:wrap;align-items:center}',
      '.dsh-sb-kbd{font-family:ui-monospace,Consolas,monospace;font-size:10px;padding:1px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',

      '.dsh-sb-skins{display:flex;gap:4px;align-items:center}',
      '.dsh-sb-skin{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;font-family:inherit;transition:border-color .15s ease,color .15s ease}',
      '.dsh-sb-skin:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-skin.on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-sb-swatch{width:9px;height:9px;border-radius:50%;display:inline-block}',
      '.dsh-sb-swatch.native{background:linear-gradient(135deg,#9aa4b8,#5b6678)}',
      /* 液态玻璃：只在面板这层用真模糊（小面积，代价可控；大区块不逐帧模糊） */
      '.dsh-sb[data-skin="glass"]{background:rgba(255,255,255,.10)}',
      'body[data-ds-dark-theme] .dsh-sb[data-skin="glass"]{background:rgba(255,255,255,.045)}',
      '.dsh-sb[data-skin="glass"] .dsh-sb-card{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.28);backdrop-filter:blur(14px);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 12px 28px -20px rgba(10,20,50,.55)}',
      'body[data-ds-dark-theme] .dsh-sb[data-skin="glass"] .dsh-sb-card{background:rgba(255,255,255,.06);border-color:rgba(150,180,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 12px 28px -20px rgba(0,0,0,.7)}',
      '.dsh-sb[data-skin="glass"] .dsh-sb-col-head{background:transparent}',
      '.dsh-sb[data-skin="glass"] .dsh-sb-empty,.dsh-sb[data-skin="glass"] .dsh-sb-empty-col{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.22)}',
      /* 「工作中」卡片：呼吸光环（只动 box-shadow，不触发重排） */
      '.dsh-sb-card[data-bucket="working"]{animation:dsh-sb-glow 3.2s ease-in-out infinite}',
      '@keyframes dsh-sb-glow{0%,100%{box-shadow:0 0 0 1px rgba(47,158,107,.22)}50%{box-shadow:0 0 0 1px rgba(47,158,107,.42),0 0 20px -4px rgba(47,158,107,.4)}}',
      '.dsh-sb-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:4px 8px;font-size:12px;font-family:inherit;cursor:pointer}',
      '.dsh-sb-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-sb-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sb-skins-panel{margin:0 22px 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px;flex:0 0 auto;max-height:46vh;overflow:auto}',
      '.dsh-sb-skin-row{display:flex;align-items:center;gap:8px;font-size:12px}',
      '.dsh-sb-skin-name{font-weight:600}',
      '.dsh-sb-skin-tag{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-sb-skin-on{font-size:11px;color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px}',
      '.dsh-sb-import{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:8px}',
      '.dsh-sb-import-text{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;font-size:11px;font-family:ui-monospace,Consolas,monospace;resize:vertical;line-height:1.5;width:100%}',
      '.dsh-sb-import-text:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh-sb-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-skin-err{font-size:11px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}',
      /* ---- 设置页（外观 / 皮肤）---- */
      '.dsh-sb-page{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dsh-sb-page h3{margin:0;font-size:14px;font-weight:600}',
      '.dsh-sb-page .sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin-top:-8px}',
      '.dsh-sb-skin-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-sb-skin-card.on{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}',
      '.dsh-sb-preview{width:56px;height:40px;border-radius:10px;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);background-size:cover}',
      '.dsh-sb-skin-body{flex:1 1 auto;min-width:0}',
      '.dsh-sb-skin-body .name{font-weight:600;font-size:13px}',
      '.dsh-sb-skin-body .tag{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.dsh-sb-settings-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsh-sb-divider{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0}',
      '.dsh-sb-pet-row{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '@media (prefers-reduced-motion: reduce){.dsh-sb-dot{animation:none}.dsh-sb-card{transition:none}.dsh-sb-card:hover{transform:none}.dsh-sb-card[data-bucket="working"]{animation:none}}',
      '@media (max-width: 980px){.dsh-sb-board{flex-direction:column;overflow-x:hidden;overflow-y:auto}.dsh-sb-col{max-width:none;width:100%;min-width:0}}',
    ].join('\n')

    /* ------------------------------------------------------------------ */
    /* 时间                                                                */
    /* ------------------------------------------------------------------ */

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** 完整本地时间：`yyyy-MM-dd HH:mm`（只打时分会在跨天时骗人）。 */
    function formatDateTime(ms) {
      if (!Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    function formatDate(ms) {
      if (!Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
    function formatAgo(ms, now) {
      if (!Number.isFinite(ms)) return '—'
      const delta = Math.max(0, now - ms)
      if (delta < 60 * 1000) return '刚刚'
      if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)} 分钟前`
      if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)} 小时前`
      if (delta < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(delta / 86400000)} 天前`
      return formatDate(ms)
    }

    /** cwd 的末段，卡片上显示成"在哪个目录干的"。 */
    function workspaceName(cwd) {
      if (typeof cwd !== 'string' || cwd.trim() === '') return ''
      const parts = cwd.split(/[\\/]+/).filter(Boolean)
      return parts.length === 0 ? cwd : parts[parts.length - 1]
    }

    /* ------------------------------------------------------------------ */
    /* 会话分类                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 一条会话属于哪一列。返回 null 表示不展示。
     */
    function classify(row, status, now) {
      if (!row) return null
      // 空会话没有内容可看；子会话（子代理）会把看板刷爆，都不展示。
      if (row.blank === true) return null
      if (row.parentSessionId) return null
      if (Number.isFinite(row.depth) && row.depth > 0) return null

      const pending = status && typeof status === 'object' ? status.pendingInteraction : undefined
      if (pending) return 'waiting'
      if (row.running === true) return 'working'

      const at = Number.isFinite(row.updatedAt) ? row.updatedAt : 0
      if (at === 0) return 'older'
      if (now - at <= IDLE_WINDOW_MS) return 'idle'
      if (now - at <= ARCHIVE_WINDOW_MS) return 'ended'
      return 'older'
    }

    /* ------------------------------------------------------------------ */
    /* hooks                                                               */
    /* ------------------------------------------------------------------ */

    const useNoSessions = (selector) => selector({ byId: EMPTY_BY_ID, items: [] })
    const useNoStatus = () => null
    const useAlwaysActive = () => true

    /** 渲染期不读时钟：每 30 秒推一次 now，相对时间才不会停在挂载时刻。 */
    function useNow() {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(timer)
      }, [])
      return now
    }

    function statusOf(statuses, id) {
      if (!statuses || typeof statuses.get !== 'function') return undefined
      return statuses.get(id)
    }

    /* ------------------------------------------------------------------ */
    /* 图标                                                                */
    /* ------------------------------------------------------------------ */

    /** 鲸尾标记：面板头与空态共用。原创几何，不带任何第三方素材。 */
    function WhaleTail(props) {
      const size = Number.isFinite(props?.size) ? props.size : 22
      return h(
        'svg',
        {
          className: props?.className,
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 21c0-4.2 1.6-7.4 4.2-9.4' }),
        h('path', { d: 'M12 21c0-4.2-1.6-7.4-4.2-9.4' }),
        h('path', { d: 'M7.8 11.6c-1.9.5-3.3 1.8-4 3.9 2.2.2 3.8-.4 4.9-1.6' }),
        h('path', { d: 'M16.2 11.6c1.9.5 3.3 1.8 4 3.9-2.2.2-3.8-.4-4.9-1.6' }),
        h('path', { d: 'M12 12V3.5' }),
      )
    }

    /** 桌宠立绘：走 host 代理路由；拿不到就回退到鲸尾矢量图。 */
    function PetAvatar(props) {
      const { pose, size } = props
      const [broken, setBroken] = React.useState(false)
      if (broken) return h(WhaleTail, { size, className: 'dsh-sb-mark' })
      return h('img', {
        className: 'dsh-sb-pet',
        'data-pose': pose,
        src: `${PET_ROUTE}${pose}.png`,
        width: size,
        height: size,
        alt: '',
        draggable: false,
        onError: () => setBroken(true),
      })
    }

    /** 桌宠浮窗的开关：只在桌宠插件装了、控制路由活着时出现。 */
    function PetToggle() {
      const [state, setState] = React.useState({ alive: false, visible: false })

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(`${PET_CONTROL}?action=status`)
            const payload = await response.json()
            if (alive) setState({ alive: true, visible: payload?.visible === true })
          } catch {
            if (alive) setState({ alive: false, visible: false })
          }
        }
        load()
        const timer = setInterval(load, 20000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      if (!state.alive) return null

      const toggle = async () => {
        try {
          const response = await fetch(`${PET_CONTROL}?action=toggle`)
          const payload = await response.json()
          setState({ alive: true, visible: payload?.visible === true })
        } catch {
          setState({ alive: false, visible: false })
        }
      }

      return h(
        'button',
        { className: 'dsh-sb-btn', onClick: toggle, title: '显示 / 隐藏桌面上的桌宠浮窗' },
        state.visible ? '收起桌宠' : '叫出桌宠',
      )
    }

    function PanelIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 18
      const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useNoSessions
      const useSessionStatus = typeof props?.useSessionStatus === 'function' ? props.useSessionStatus : useNoStatus
      const byId = useSessions((state) => (state && state.byId) || EMPTY_BY_ID)
      const statuses = useSessionStatus((value) => value)

      // 有会话在等回答时，图标上点一个樱粉点——唯一需要人立刻知道的信号。
      let waiting = 0
      if (statuses && typeof statuses.get === 'function') {
        for (const id of Object.keys(byId)) {
          const status = statuses.get(id)
          if (status && status.pendingInteraction) waiting += 1
        }
      }

      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 5.5, height: 16, rx: 1.8 }),
        h('rect', { x: 9.5, y: 4, width: 5.5, height: 10, rx: 1.8 }),
        h('rect', { x: 16, y: 4, width: 5, height: 13, rx: 1.8 }),
        waiting > 0 ? h('circle', { cx: 19.2, cy: 4.8, r: 2.4, fill: '#ff9ec4', stroke: 'none' }) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件                                                                */
    /* ------------------------------------------------------------------ */

    function SessionCard(props) {
      const { row, bucket, now, cursor, onOpen } = props
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title : '(无标题)'
      const turns = row.projectionValues?.sessionStats?.turns
      const at = Number.isFinite(row.updatedAt) ? row.updatedAt : null
      const where = workspaceName(row.cwd)

      return h(
        'button',
        {
          type: 'button',
          className: `dsh-sb-card${cursor ? ' is-cursor' : ''}`,
          'data-bucket': bucket,
          title: `${title}\n${row.cwd ?? ''}\n最近活动：${formatDateTime(at)}\n点击进入这个对话`,
          onClick: onOpen,
        },
        h(
          'div',
          { className: 'dsh-sb-card-title' },
          h('span', null, title),
        ),
        h(
          'div',
          { className: 'dsh-sb-card-meta' },
          h('span', { className: `dsh-sb-dot ${bucket}`, 'aria-hidden': 'true' }),
          bucket === 'working' ? h('span', null, '正在跑') : null,
          where ? h('span', { className: 'dsh-sb-card-path' }, where) : null,
          Number.isFinite(turns) && turns > 0 ? h('span', null, `${turns} turns`) : null,
          h('span', { className: 'dsh-sb-when' }, formatAgo(at, now)),
        ),
      )
    }

    function Column(props) {
      const { bucket, entries, now, onOpen, collapsed, onToggle, cursorId } = props
      return h(
        'div',
        { className: 'dsh-sb-col' },
        h(
          'div',
          { className: 'dsh-sb-col-head', title: bucket.hint },
          h('span', { className: 'dsh-sb-col-name' }, bucket.label),
          h('span', { className: 'dsh-sb-col-count' }, String(entries.length)),
          bucket.key === 'older'
            ? h('button', { className: 'dsh-sb-col-toggle', onClick: onToggle }, collapsed ? '展开' : '收起')
            : null,
        ),
        collapsed
          ? null
          : h(
              'div',
              { className: 'dsh-sb-col-body' },
              entries.length === 0
                ? h(
                    'div',
                    { className: 'dsh-sb-empty-col' },
                    bucket.key === 'waiting' ? '没有在等你的' : '这一列是空的',
                  )
                : entries.map((entry) =>
                    h(SessionCard, {
                      key: entry.id,
                      row: entry.row,
                      bucket: bucket.key,
                      now,
                      cursor: cursorId === entry.id,
                      onOpen: () => onOpen(entry.id),
                    }),
                  ),
            ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 主面板                                                              */
    /* ------------------------------------------------------------------ */

    function Panel(props) {
      const sessionsWired = typeof props.useSessions === 'function'
      const useSessions = sessionsWired ? props.useSessions : useNoSessions
      const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNoStatus
      const usePanelInfo = typeof props.usePanelInfo === 'function' ? props.usePanelInfo : useAlwaysActive

      const byId = useSessions((state) => (state && state.byId) || EMPTY_BY_ID)
      const storeItemCount = useSessions((state) => (Array.isArray(state?.items) ? state.items.length : 0))
      const active = usePanelInfo((info) => info?.activePanelId === PANEL_ID)
      const statuses = useSessionStatus((value) => value)

      const now = useNow()
      const [query, setQuery] = React.useState('')
      const [showOlder, setShowOlder] = React.useState(false)
      const [cursor, setCursor] = React.useState(0)

      const openSession = (sessionId) => {
        // 先切回会话面板，再选中那个会话：两条路都试，缺哪个都不至于点了没反应。
        try {
          props.ctx?.layout?.selectPanel?.('conversation')
        } catch {
          /* 忽略 */
        }
        const workspace = props.ctx?.get?.('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') {
          try {
            workspace.openSession(sessionId)
          } catch {
            /* 忽略 */
          }
        }
      }

      const { buckets, total, matched } = React.useMemo(() => {
        const groups = { waiting: [], working: [], idle: [], ended: [], older: [] }
        const needle = query.trim().toLowerCase()
        let totalCount = 0

        for (const [id, row] of Object.entries(byId)) {
          if (!row) continue
          totalCount += 1
          const bucket = classify(row, statusOf(statuses, id), now)
          if (bucket === null) continue
          if (needle !== '') {
            const haystack = `${row.title ?? ''} ${row.cwd ?? ''}`.toLowerCase()
            if (!haystack.includes(needle)) continue
          }
          groups[bucket].push({ id, row, sort: Number.isFinite(row.updatedAt) ? row.updatedAt : 0 })
        }

        let matchedCount = 0
        for (const key of Object.keys(groups)) {
          groups[key].sort((a, b) => b.sort - a.sort)
          matchedCount += groups[key].length
        }

        return { buckets: groups, total: totalCount, matched: matchedCount }
      }, [byId, statuses, query, now])

      const flat = React.useMemo(() => {
        const list = []
        for (const bucket of BUCKETS) {
          if (bucket.key === 'older' && !showOlder) continue
          for (const entry of buckets[bucket.key] ?? []) list.push(entry.id)
        }
        return list
      }, [buckets, showOlder])

      React.useEffect(() => {
        if (!active) return undefined
        const onKeyDown = (event) => {
          const tag = event.target?.tagName
          const typing = tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable === true
          if (typing) {
            if (event.key === 'Escape' && event.target.blur) event.target.blur()
            return
          }
          if (event.metaKey || event.ctrlKey || event.altKey) return

          if (event.key === 'j' || event.key === 'ArrowDown') {
            event.preventDefault()
            setCursor((value) => Math.min(flat.length - 1, Math.max(0, value + 1)))
          } else if (event.key === 'k' || event.key === 'ArrowUp') {
            event.preventDefault()
            setCursor((value) => Math.max(0, value - 1))
          } else if (event.key === 'Enter') {
            if (flat[cursor]) {
              event.preventDefault()
              openSession(flat[cursor])
            }
          } else if (event.key === '/') {
            event.preventDefault()
            const input = document.querySelector('.dsh-sb-input')
            if (input) input.focus()
          } else if (event.key === 'Escape') {
            setQuery('')
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [active, flat, cursor])

      React.useEffect(() => {
        if (cursor > flat.length - 1) setCursor(Math.max(0, flat.length - 1))
      }, [flat, cursor])

      const counts = {
        waiting: buckets.waiting.length,
        working: buckets.working.length,
        idle: buckets.idle.length,
        ended: buckets.ended.length,
        older: buckets.older.length,
      }
      const cursorId = flat[cursor] ?? null
      // 立绘跟着看板状态换表情。
      // 注意素材真相（来自桌宠会话的实测）：idle/busy/alert 是 256×256 方形头像，
      // base/chew/hover 是 ~397×420 全身立绘；alert 还带一条 logo 横幅，放大了很怪，
      // 所以小头像只用 idle/busy，空态用全身 base。
      const pose = counts.working > 0 ? 'busy' : 'idle'
      // 皮肤现在在「设置 → 外观 / 皮肤」里切换；看板只订阅当前值用来切自己的材质。
      const skinId = useActiveSkin()

      return h(
        'div',
        { className: 'dsh-sb', 'data-skin': skinId },
        h(
          'div',
          { className: 'dsh-sb-head' },
          h(PetAvatar, { pose, size: 34 }),
          h('h2', { className: 'dsh-sb-title' }, '会话进程'),
          h('span', { className: 'dsh-sb-spacer' }),
          h(
            'div',
            { className: 'dsh-sb-pills' },
            h('span', { className: 'dsh-sb-pill working' }, '工作中', h('b', null, String(counts.working))),
            h('span', { className: 'dsh-sb-pill waiting' }, '等你回答', h('b', null, String(counts.waiting))),
            h('span', { className: 'dsh-sb-pill' }, '闲置', h('b', null, String(counts.idle))),
            h('span', { className: 'dsh-sb-pill' }, '结束', h('b', null, String(counts.ended))),
            counts.older > 0
              ? h(
                  'button',
                  { className: 'dsh-sb-btn', onClick: () => setShowOlder((value) => !value) },
                  showOlder ? `收起更早 ${counts.older}` : `更早 ${counts.older}`,
                )
              : null,
            h(PetToggle),
          ),
          h('input', {
            className: 'dsh-sb-input',
            placeholder: '按标题或目录过滤…（/ 聚焦）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'span',
            { className: 'dsh-sb-sub' },
            `共 ${total} 个会话 · 状态全自动（24 小时分界）· 皮肤在「设置 → 外观 / 皮肤」里切`,
          ),
        ),

        total === 0
          ? h(
              'div',
              { className: 'dsh-sb-empty' },
              h(PetAvatar, { pose: 'base', size: 84 }),
              !sessionsWired
                ? '这个面板没拿到 useSessions 标准 prop —— 宿主版本可能变了。把这句话发给我。'
                : storeItemCount > 0
                  ? `读取会话索引失败：store 里有 ${storeItemCount} 条会话，但 byId 是空的。把这句话发给我。`
                  : '还没有会话。发第一条消息后这里就会出现它的进程状态。',
            )
          : matched === 0 && query.trim() !== ''
            ? h('div', { className: 'dsh-sb-empty' }, `没有匹配「${query.trim()}」的会话。`)
            : h(
                'div',
                { className: 'dsh-sb-board' },
                BUCKETS.filter((bucket) => bucket.key !== 'older' || showOlder || counts.older > 0).map((bucket) =>
                  h(Column, {
                    key: bucket.key,
                    bucket,
                    entries: buckets[bucket.key] ?? [],
                    now,
                    onOpen: openSession,
                    collapsed: bucket.key === 'older' ? !showOlder : false,
                    onToggle: () => setShowOlder((value) => !value),
                    cursorId,
                  }),
                ),
              ),

        h(
          'div',
          { className: 'dsh-sb-foot' },
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, 'j'), h('span', { className: 'dsh-sb-kbd' }, 'k'), ' 移动'),
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, 'Enter'), ' 进入对话'),
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, '/'), ' 搜索'),
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, 'Esc'), ' 清空搜索'),
          h('span', null, '闲置/结束 24 小时分界 · 更早超过 7 天'),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 设置页：外观 / 皮肤                                                  */
    /* ------------------------------------------------------------------ */

    /** 皮肤卡片的缩略色块。 */
    const SKIN_PREVIEWS = {
      whale: 'linear-gradient(135deg,#3b6ff0,#7c9bff 55%,#eef4ff)',
      glass: 'linear-gradient(135deg,rgba(120,150,255,.95),rgba(190,150,255,.65) 45%,rgba(150,238,224,.85))',
      native: 'linear-gradient(135deg,#9aa4b8,#5b6678)',
    }

    function builtinMeta() {
      return SKINS.map((skin) => ({
        id: skin.id,
        name: skin.name,
        accent: skin.accent,
        tagline: skin.tagline,
        user: false,
      }))
    }

    function SettingsPage() {
      const skinId = useActiveSkin()
      const [list, setList] = React.useState(builtinMeta)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [importText, setImportText] = React.useState('')
      const [importName, setImportName] = React.useState('')
      const [pet, setPet] = React.useState(null)

      const refresh = React.useCallback(async () => {
        const value = await loadSkinList()
        setList([...builtinMeta(), ...(value.user ?? []).map((skin) => ({ ...skin, user: true }))])
        return value
      }, [])

      React.useEffect(() => {
        refresh().catch(() => {})
      }, [refresh])

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(`${PET_CONTROL}?action=status`)
            const payload = await response.json()
            if (alive) setPet(payload)
          } catch {
            if (alive) setPet(null)
          }
        }
        load()
        const timer = setInterval(load, 20000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const apply = async (id) => {
        setError(null)
        setBusy(true)
        try {
          await setSkin(id)
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (id) => {
        setError(null)
        setBusy(true)
        try {
          await skinRequest('/delete', { method: 'POST', body: { id } })
          await refresh()
          if (skinId === id) await setSkin(DEFAULT_SKIN)
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy(false)
        }
      }

      const doImport = async () => {
        setError(null)
        setBusy(true)
        try {
          if (importText.trim() === '') throw new Error('先把皮肤 JSON 粘进来')
          let payload
          try {
            payload = JSON.parse(importText)
          } catch {
            throw new Error('粘进来的不是合法 JSON')
          }
          if (importName.trim() !== '') payload.name = importName.trim()
          const saved = await skinRequest('/import', { method: 'POST', body: payload })
          await refresh()
          await setSkin(saved.id)
          setImportText('')
          setImportName('')
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy(false)
        }
      }

      const togglePet = async () => {
        try {
          const response = await fetch(`${PET_CONTROL}?action=toggle`)
          setPet(await response.json())
        } catch {
          setPet(null)
        }
      }

      return h(
        'div',
        { className: 'dsh-sb-page' },
        h('h3', null, '皮肤'),
        h(
          'div',
          { className: 'sub' },
          '只改配色与材质，不动宿主结构；切换立刻生效，不用重启。液态玻璃会把输入卡、气泡、对话框做成磨砂玻璃（冷调蓝紫 + 悬浮投影 + 内高光）。',
        ),
        list.map((skin) =>
          h(
            'div',
            { key: skin.id, className: `dsh-sb-skin-card${skin.id === skinId ? ' on' : ''}` },
            h('div', {
              className: 'dsh-sb-preview',
              style: { background: SKIN_PREVIEWS[skin.id] ?? (skin.accent || SKIN_PREVIEWS.native) },
            }),
            h(
              'div',
              { className: 'dsh-sb-skin-body' },
              h('div', { className: 'name' }, skin.name),
              h('div', { className: 'tag' }, skin.tagline || (skin.user ? '导入的皮肤' : '')),
            ),
            h(
              'div',
              { className: 'dsh-sb-settings-actions' },
              skin.id === skinId
                ? h('span', { className: 'dsh-sb-skin-on' }, '使用中')
                : h('button', { className: 'dsh-sb-btn primary', disabled: busy, onClick: () => apply(skin.id) }, '应用'),
              skin.user
                ? h('button', { className: 'dsh-sb-btn danger', disabled: busy, onClick: () => remove(skin.id) }, '删除')
                : null,
            ),
          ),
        ),

        h('div', { className: 'dsh-sb-divider' }),
        h('h3', null, '导入皮肤'),
        h('div', { className: 'sub' }, '粘一段 JSON：tokens 里给 { light, dark } 成对颜色，css 可选（作用到全 App）。'),
        h('input', {
          className: 'dsh-sb-input',
          placeholder: '名称（留空则用 JSON 里的 name）',
          value: importName,
          onChange: (event) => setImportName(event.target.value),
        }),
        h('textarea', {
          className: 'dsh-sb-import-text',
          rows: 5,
          placeholder:
            '{ "name": "Neon Night", "accent": "#00e5ff", "tagline": "赛博霓虹", "tokens": { "--dsw-alias-brand-primary": { "light": "#00b8d4", "dark": "#66f0ff" } } }',
          value: importText,
          onChange: (event) => setImportText(event.target.value),
        }),
        h(
          'div',
          { className: 'dsh-sb-settings-actions' },
          h('button', { className: 'dsh-sb-btn primary', disabled: busy, onClick: doImport }, busy ? '处理中…' : '导入并应用'),
          h('span', { className: 'dsh-sb-hint' }, '存到 ~/.dsh/dsh-session-board/skins/'),
        ),
        error ? h('div', { className: 'dsh-sb-skin-err' }, error.message ?? String(error)) : null,

        h('div', { className: 'dsh-sb-divider' }),
        h('h3', null, '桌宠'),
        h('div', { className: 'sub' }, '看板头部用的是桌宠包里的立绘（idle / busy / base）。'),
        h(
          'div',
          { className: 'dsh-sb-pet-row' },
          pet
            ? h('span', null, `浮窗：${pet.visible ? '显示中' : '已收起'} · ${pet.running ? '在跑' : '未运行'}`)
            : h('span', null, '未检测到 dsh-desktop-pet'),
          pet ? h('button', { className: 'dsh-sb-btn', onClick: togglePet }, pet.visible ? '收起桌宠' : '叫出桌宠') : null,
        ),

        h('div', { className: 'dsh-sb-divider' }),
        h(
          'div',
          { className: 'dsh-sb-hint' },
          `主题服务：${skinTheme ? '已连接' : '未连接'} · 当前：${skinId} · 文档标记：${document.documentElement.getAttribute('data-dsh-sb-skin') ?? '无'}`,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* apply                                                               */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      // 样式：本面板自己的那一层（只作用在 .dsh-sb 里）。
      const style = document.createElement('style')
      style.setAttribute('data-dsh-session-board', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(
        () => () => {
          style.remove()
        },
        'dsh-session-board: styles',
      )

      // 皮肤先按缓存应用一次（此刻 theme 可能还没就绪 —— 玻璃那层全局 CSS 不依赖
      // overrideTokens，先把文档标记挂上，用户切到玻璃立刻就能看见）。
      applySkinById(readStoredSkin()).catch(() => {})

      // 皮肤：官方口子 overrideTokens —— 全 App 的 alias token 覆盖，明暗各一套。
      // 用 ctx.inject 声明"可选依赖"：没有 theme 服务的组合里，看板照样能用，只是没换肤。
      // 顺序：先用本地缓存秒开 → 再对齐 host 里持久化的 active（换浏览器也一致）。
      ctx.inject(['theme'], (scope) => {
        scope.effect(() => {
          let disposed = false
          skinTheme = scope.theme
          ;(async () => {
            await applySkinById(readStoredSkin())
            if (disposed) return
            try {
              const listed = await loadSkinList()
              if (!disposed && listed.active && listed.active !== activeSkinId) {
                await applySkinById(listed.active)
              }
            } catch {
              /* host 还没准备好就先用缓存 */
            }
          })()
          return () => {
            disposed = true
            teardownSkin()
            skinTheme = null
          }
        }, 'dsh-session-board: skin')
      })

      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[dsh-session-board] 没有 slots 服务，UI 未注册')
        return
      }

      const PanelEntry = (props) => React.createElement(Panel, { ...props, ctx })
      const IconEntry = (props) => React.createElement(PanelIcon, props)
      const SettingsEntry = () => React.createElement(SettingsPage)

      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, PanelEntry))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '会话进程' }, IconEntry),
      )
      // 皮肤管理器放在「设置 → 皮肤」，不再挤在看板头部。
      // order 取 26：设置导航列高度固定、末尾条目会被裁掉（回收站用 25 才可见），26 紧跟其后。
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'skins', order: 26, label: '皮肤' }, SettingsEntry),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return exports
  },
})
