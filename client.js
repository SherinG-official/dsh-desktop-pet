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
    /** 进程内只做一次"启动即进入看板"（热重载不重复抢焦点）。 */
    let booted = false
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

    /* ---- 工作组（host 持久化） ------------------------------------------ */

    const MEMORY_API = '/api/session-board/memory'
    const DRAG_TYPE = 'application/x-dsh-session'

    /** 工作组接口：非 GET 必须带 x-dsh-plugin 头（宿主的最小 CSRF 防护）。 */
    async function memoryRequest(path, method = 'GET', body) {
      const init = { method, headers: {} }
      if (method !== 'GET') {
        init.headers['x-dsh-plugin'] = 'session-board'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body ?? {})
      }
      const response = await fetch(`${MEMORY_API}${path}`, init)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `工作组接口失败（HTTP ${response.status}）`)
      }
      return payload.value
    }

    /** 组记忆的第一个非空行，给卡片做摘要。 */
    function memoryPreview(memory) {
      const line = String(memory ?? '')
        .split('\n')
        .map((entry) => entry.replace(/^[#>*\-\s]+/, '').trim())
        .find((entry) => entry !== '')
      return line ?? ''
    }

    /** 路径太长：从 `dsh-session-board` 开始显示，前面用省略号。 */
    function shortPath(target) {
      const text = String(target ?? '')
      if (text === '') return ''
      const marker = 'dsh-session-board'
      const index = text.indexOf(marker)
      return index === -1 ? text : `…${text.slice(index)}`
    }

    /** 从拖拽事件里取出会话 id。 */
    function sessionOfDrag(event) {
      try {
        return event.dataTransfer.getData(DRAG_TYPE) || ''
      } catch {
        return ''
      }
    }

    /**
     * 工作组的聚合状态：取组内**最急**的那个会话的状态。
     * waiting > working > idle > ended > older；没有会话 → empty。
     */
    const GROUP_RANK = { waiting: 0, working: 1, idle: 2, ended: 3, older: 4 }
    const GROUP_BUCKETS = [
      { key: 'waiting', label: '等你回答', hint: '组里有会话卡在等你' },
      { key: 'working', label: '进行中', hint: '组里有会话正在跑' },
      { key: 'idle', label: '空闲', hint: '组里最近的活动在 24 小时内' },
      { key: 'ended', label: '已结束', hint: '组里最近的活动在 24 小时到 7 天之间' },
      // ⚠️ older 必须在这里：否则「组里最急的会话超过 7 天」的组会被算进一个
      // 没有对应列的桶，整张组卡直接不渲染 —— 表现就是"拖进组之后消失了"。
      { key: 'older', label: '更早', hint: '组里最近的活动超过 7 天' },
      { key: 'empty', label: '空工作组', hint: '还没有会话，把会话拖进来' },
    ]

    function groupBucketOf(memberBuckets) {
      if (memberBuckets.length === 0) return 'empty'
      let best = memberBuckets[0]
      for (const bucket of memberBuckets) {
        if ((GROUP_RANK[bucket] ?? 9) < (GROUP_RANK[best] ?? 9)) best = bucket
      }
      return best
    }

    /**
     * 工作组默认**不展开**（用户要的是"别每次都多点一下"，不是把整组摊开）。
     * 折叠时只把「刚刚有动静的会话」作为预览行露出来（见 GroupCard 的 peek）。
     *
     * 为什么用时间而不是桶：一条会话停下来后先落进 idle（24 小时内），
     * 24 小时后才变 ended —— 只判 ended 会让 3 分钟前刚跑完的组什么都看不到。
     */
    const FRESH_MS = 15 * 60 * 1000

    /** 折叠卡片上要露出来的成员：正在跑 / 等你回答 / 最近 15 分钟内有活动。 */
    function freshMembers(members, now) {
      return members.filter((member) => {
        if (member.bucket === 'waiting' || member.bucket === 'working') return true
        const at = Number(member.row?.updatedAt)
        return Number.isFinite(at) && now - at <= FRESH_MS
      })
    }

    /** 伪工作组的 id：不属于任何组的会话，全部挂在这张「未分组」卡上（不可改名/删除/写记忆）。 */
    const UNGROUPED_ID = '__ungrouped__'

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
      /* ---- 入口按钮（只在侧边栏隐藏时出现，位置对齐左上角「新建会话 ⊕」）---- */
      // 放在窗口标题栏**右端**（窗口按钮左侧的空白区），完全避开左侧菜单；
      // 标题栏是拖拽区，必须显式 no-drag 才能点。
      '.dsh-sb-composerbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto}',
      // 右侧面板容器：占满可用高度、窄宽度下按单列排。
      '.dsh-sb-pane{display:flex;flex-direction:column;height:100%;min-height:0;overflow:auto}',
      '.dsh-sb-pane .dsh-sb-board{flex-direction:column;overflow:visible}',
      '.dsh-sb-pane .dsh-sb-col{max-width:none;min-width:0;width:100%}',
      // 未分组单独靠下：拉开距离 + 虚线分隔，和上面各状态分桶区分开
      '.dsh-sb-pane .dsh-sb-col-ungrouped{margin-top:20px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:10px}',
      /* 紧凑密度：右栏 ~400px，所有间距/字号各缩一档，头部改为纵向堆叠 */
      '.dsh-sb-pane .dsh-sb{font-size:12px}',
      '.dsh-sb-pane .dsh-sb-head{flex-direction:column;align-items:stretch;gap:6px;padding:8px 10px}',
      '.dsh-sb-pane .dsh-sb-head .dsh-sb-title{font-size:14px}',
      '.dsh-sb-pane .dsh-sb-head .dsh-sb-pet{width:26px;height:26px}',
      '.dsh-sb-pane .dsh-sb-pills{flex-wrap:wrap;gap:4px;justify-content:flex-start}',
      '.dsh-sb-pane .dsh-sb-pill{font-size:10px;padding:1px 7px;line-height:1.6}',
      '.dsh-sb-pane .dsh-sb-pill b{font-size:10px}',
      '.dsh-sb-pane .dsh-sb-btn{font-size:11px;padding:3px 8px}',
      '.dsh-sb-pane .dsh-sb-input{width:100%;padding:5px 9px;font-size:12px}',
      '.dsh-sb-pane .dsh-sb-sub{font-size:10px;line-height:1.5;margin-top:2px}',
      '.dsh-sb-pane .dsh-sb-board{gap:4px;padding:6px 8px 12px}',
      '.dsh-sb-pane .dsh-sb-col-head{padding:0 2px 4px;align-items:baseline}',
      '.dsh-sb-pane .dsh-sb-col-name{font-size:11px;letter-spacing:.04em}',
      '.dsh-sb-pane .dsh-sb-col-body{gap:6px}',
      '.dsh-sb-pane .dsh-sb-group{padding:7px 9px;gap:4px;border-radius:10px}',
      '.dsh-sb-pane .dsh-sb-group-headbtn{gap:6px}',
      '.dsh-sb-pane .dsh-sb-group-name{font-size:12px}',
      '.dsh-sb-pane .dsh-sb-group-count{font-size:10px;white-space:nowrap}',
      '.dsh-sb-pane .dsh-sb-group-meta{font-size:10px;gap:4px}',
      '.dsh-sb-pane .dsh-sb-group-memo{font-size:10px}',
      '.dsh-sb-pane .dsh-sb-card{padding:7px 9px;gap:4px}',
      '.dsh-sb-pane .dsh-sb-card-title{font-size:12px}',
      '.dsh-sb-pane .dsh-sb-card-meta{font-size:10px;gap:5px;flex-wrap:wrap}',
      '.dsh-sb-pane .dsh-sb-member-main{padding:3px 4px;gap:6px}',
      '.dsh-sb-pane .dsh-sb-member-title{font-size:11px}',
      '.dsh-sb-pane .dsh-sb-peek{padding-top:4px;gap:0}',
      '.dsh-sb-pane .dsh-sb-foot{display:none}',
      /* ---- 右栏最终布局：头部一行（药丸+搜索靠右）、状态左到右、未分组独占下一行 ---- */
      '.dsh-sb-pane .dsh-sb-head{flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px}',
      '.dsh-sb-pane .dsh-sb-pills{margin-left:auto;flex-wrap:wrap;justify-content:flex-end}',
      '.dsh-sb-pane .dsh-sb-input{flex:0 1 168px;min-width:120px;width:auto}',
      '.dsh-sb-pane .dsh-sb-board{flex-direction:row;flex-wrap:wrap;align-items:flex-start;gap:8px;overflow:visible}',
      '.dsh-sb-pane .dsh-sb-col{flex:0 0 210px;width:210px;max-width:none;min-width:0}',
      '.dsh-sb-pane .dsh-sb-col-ungrouped{flex:0 0 100%;width:100%;margin-top:20px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:10px}',
      /* 定稿尺寸：列 240px（组名不再截断）、行距 10、未分组贴紧上一行 */
      '.dsh-sb-pane .dsh-sb-board{align-content:flex-start;gap:10px}',
      '.dsh-sb-pane .dsh-sb-col{flex:0 0 240px;width:240px}',
      '.dsh-sb-pane .dsh-sb-col-ungrouped{margin-top:12px;padding-top:8px}',
      /* 根因：板子是 flex:1 的兄弟节点，会吃掉整列剩余高度，把未分组挤到最底部。
         这里把板子改成不伸展，未分组紧跟其后；三种状态均分宽度、左右填满。 */
      '.dsh-sb-pane .dsh-sb-board{flex:0 0 auto;align-content:flex-start}',
      '.dsh-sb-pane .dsh-sb-col{flex:1 1 0;min-width:200px;width:auto}',
      '.dsh-sb-pane .dsh-sb-col-ungrouped{flex:1 1 100%;width:100%;margin-top:12px}',
      '.dsh-sb-toast{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147483000;background:#7a1f2b;color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;line-height:1.6;max-width:70vw;white-space:pre-wrap;box-shadow:0 12px 30px -12px rgba(0,0,0,.6)}',
      // 底部细条：只在侧边栏折叠时出现；不覆盖任何控件（在布局流里）。
      '.dsh-sb-bottombar{display:none;align-items:center;gap:6px;margin:0 auto;padding:4px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer}',
      'body:has([data-sidebar-collapsed]) .dsh-sb-bottombar{display:inline-flex}',
      '.dsh-sb-bottombar:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-launcher:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
      // 展开时：侧边栏底部设置旁边（原生 footer action 的尺寸约束下尽量紧凑）。
      '.dsh-sb-action{display:flex;align-items:center;gap:6px;background:none;border:0;padding:6px 8px;border-radius:8px;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsh-sb-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-action.is-active{color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-action-text{overflow:hidden;text-overflow:ellipsis}',
      /* ---- 工作组卡片 ---- */
      '.dsh-sb-group{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}',
      '.dsh-sb-group:hover{border-color:var(--dsw-alias-brand-primary);box-shadow:0 6px 18px -10px rgba(20,40,90,.35)}',
      '.dsh-sb-group.is-cursor{box-shadow:0 0 0 2px rgba(77,107,254,.35),0 6px 18px -10px rgba(20,40,90,.35)}',
      '.dsh-sb-group.is-over{border-color:var(--dsw-alias-brand-primary);border-style:dashed;background:rgba(77,107,254,.08)}',
      '.dsh-sb-group[data-bucket="waiting"]{border-left:3px solid #ff9ec4}',
      '.dsh-sb-group[data-bucket="working"]{border-left:3px solid var(--dsw-alias-state-success-primary)}',
      '.dsh-sb-group[data-bucket="empty"]{border-style:dashed}',
      '.dsh-sb-group-head{display:flex;flex-direction:column;gap:6px}',
      '.dsh-sb-group-headbtn{display:flex;align-items:center;gap:8px;background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;width:100%}',
      '.dsh-sb-rename{display:flex;align-items:center;gap:6px}',
      '.dsh-sb-group-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sb-group-name-input{flex:1 1 auto;min-width:0;font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;padding:1px 6px}',
      '.dsh-sb-group-count{font-size:11px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.dsh-sb-chev{font-size:14px;color:var(--dsw-alias-label-secondary);width:14px;text-align:center;flex:0 0 auto}',
      '.dsh-sb-group-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-tag{font-size:10px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-sb-tag.waiting{color:#c2386b;border-color:rgba(255,158,196,.6);background:rgba(255,158,196,.14)}',
      '.dsh-sb-tag.working{color:var(--dsw-alias-state-success-primary);border-color:rgba(60,190,120,.5);background:rgba(60,190,120,.12)}',
      '.dsh-sb-group-memo{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}',
      '.dsh-sb-group-body{display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;margin-top:2px}',
      '.dsh-sb-member{display:flex;align-items:center;gap:6px}',
      '.dsh-sb-member-main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;background:none;border:0;padding:4px 6px;border-radius:8px;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-sb-member-main:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-sb-member-title{flex:1 1 auto;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sb-x{flex:0 0 auto;width:20px;height:20px;line-height:1;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px}',
      '.dsh-sb-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sb-member-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:6px 2px}',
      '.dsh-sb-peek{display:flex;flex-direction:column;gap:2px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px}',
      '.dsh-sb-peek-more{align-self:flex-start;background:none;border:0;padding:2px 4px;font-size:10px;color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dsh-sb-memo{display:flex;flex-direction:column;gap:6px;margin-top:6px}',
      '.dsh-sb-memo-head{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-memo-count{font-variant-numeric:tabular-nums}',
      '.dsh-sb-memo-count.warn{color:#c98a00}',
      '.dsh-sb-memo-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.6;resize:vertical;font-family:inherit}',
      '.dsh-sb-memo-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-memo-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-sb-memo-file{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-sb-memo-path{flex:1 1 180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px}',
      '.dsh-sb-memo-tip{font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:rgba(220,80,80,.4)}',
      '.dsh-sb-btn.primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}',
      '.dsh-sb-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dsh-sb-badge{font-size:10px;padding:0 6px;border-radius:999px;background:rgba(77,107,254,.14);color:var(--dsw-alias-brand-primary)}',
      '.dsh-sb-newgroup{display:flex;gap:8px;align-items:center}',
      '.dsh-sb-newgroup .dsh-sb-input{flex:1 1 auto}',
      '.dsh-sb-error{font-size:11px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}',
      '.dsh-sb-group.is-pseudo{border-style:dashed;background:transparent}',
      '.dsh-sb-group.is-pseudo .dsh-sb-group-name{color:var(--dsw-alias-label-secondary);font-weight:500}',
      /* 玻璃皮肤下：工作组卡与未分组区也跟随 */
      '.dsh-sb[data-skin="glass"] .dsh-sb-group{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.34)}',
      'body[data-ds-dark-theme] .dsh-sb[data-skin="glass"] .dsh-sb-group{background:rgba(24,34,58,.44);border-color:rgba(170,195,255,.22)}',
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
     * 这条会话是不是子代理会话。
     *
     * 字段名的坑：宿主内部叫 `parentSessionId` / `delegationDepth`，但客户端 store 在
     * `client/sessions/service.js` 里重命名成了 **`parentId`**，并且保留 `origin: 'subagent'`。
     * 只查 `parentSessionId` 会让子代理全部漏进看板（实际踩过），所以这里把
     * 两套命名 + origin 都查一遍。
     */
    function isSubagentRow(row) {
      if (!row) return false
      if (row.origin === 'subagent') return true
      if (row.parentId || row.parentSessionId || row.parentSession) return true
      const depth = row.delegationDepth ?? row.depth
      return Number.isFinite(depth) && depth > 0
    }

    /**
     * 一条会话属于哪一列。返回 null 表示不展示。
     *
     * @param {Set<string>} archived `useWorkspaces().archivedSessionIds` 的集合
     */
    function classify(row, status, now, archived) {
      if (!row) return null
      // 已归档：用户明确不想看（归档是 workspace 层的状态，不在 SessionSummary 里）。
      if (archived instanceof Set) {
        const key = row.sessionId ?? row.id
        if (typeof key === 'string' && archived.has(key)) return null
      }
      // 空会话没有内容可看；子代理会话会把看板刷爆，都不展示。
      if (row.blank === true) return null
      if (isSubagentRow(row)) return null

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
    /** 没有 usePanelInfo 时的兜底：当作"别的面板处于激活态"，浮动入口照常显示。 */
    const useNoPanelInfo = (selector) => selector({})

    /**
     * 首屏遮罩由 **host** 在文档解析阶段注入（见 lib/boot/firstpaint.js）。
     * 这里只负责：切到看板后把它淡出移除，外加一个 4 秒兜底 —— 绝不能盖死界面。
     */
    const FIRSTPAINT_ID = 'dsh-sb-firstpaint'

    function dismissFirstPaint() {
      const node = document.getElementById(FIRSTPAINT_ID)
      if (node === null) return
      node.classList.add('is-out')
      setTimeout(() => {
        try {
          node.remove()
        } catch {
          /* 已经没了 */
        }
      }, 460)
    }

    /**
     * 切到看板。
     *
     * 关键教训：插件的客户端 ctx **只有声明了 `inject` 的服务才有属性**。
     * 我们的 `inject` 只有 `['slots']`，所以 `ctx.layout` 是 undefined ——
     * 之前按钮点了没反应就是这个原因（异常被 catch 吞掉）。
     * 现在优先用 `ctx.inject(['layout'])` 里拿到的那个实例（见 apply）。
     */
    let layoutService = null
    let composerTrapInstalled = false

    /**
     * composer 里有宿主自己的 capture 阶段处理器（聚焦/拖拽），会把 pointerdown
     * 在到达 React 之前吞掉 —— 表现就是"有 hover/tooltip，但 onClick 不触发"。
     * 所以这里在 **document 的 capture 阶段**自己抓一次最原始的指针事件。
     */
    function installComposerTrap(ctx) {
      if (composerTrapInstalled) return
      composerTrapInstalled = true
      const handle = (event) => {
        // 宿主可能把 slot 渲染进 shadow DOM：跨过边界后 event.target 会被
        // 重定向成宿主元素，closest 找不到我们的按钮 —— 必须用 composedPath。
        let hit = false
        try {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          hit = path.some(
            (node) => node instanceof Element && node.classList !== undefined && node.classList.contains('dsh-sb-composerbtn'),
          )
        } catch {
          hit = false
        }
        if (!hit) {
          const target = event.target
          if (!(target instanceof Element) || target.closest('.dsh-sb-composerbtn') === null) return
        }
        event.preventDefault()
        event.stopPropagation()
        gotoBoard(ctx)
      }
      // 挂在 window 的 capture 阶段：宿主若在 document 上 capture 就吞事件，
      // window 这一层比它更早；三种事件都试，哪个先到算哪个。
      for (const type of ['pointerdown', 'mousedown', 'click']) {
        window.addEventListener(type, handle, true)
      }
    }

    function gotoBoard(ctx) {
      const candidates = [layoutService, ctx?.layout, ctx?.get?.('layout')]
      let lastError = null

      /** 兜底：点宿主自己渲染的侧边栏入口（必须排除我们自己的按钮）。 */
      const clickSidebarEntry = () => {
        try {
          const entries = document.querySelectorAll('[aria-label*="会话进程"]')
          for (const entry of entries) {
            if (entry.closest('[data-dsh-sb-own]') !== null) continue
            if (typeof entry.click === 'function') {
              entry.click()
              return true
            }
          }
        } catch {
          /* 忽略 */
        }
        return false
      }

      const fail = () => {
        // 不用 alert：Electron 渲染层可能把对话框禁掉，之前"毫无反应"就包含了这一层。
        // 直接把原因画在页面顶部，8 秒后自己消失。
        try {
          let node = document.getElementById('dsh-sb-error-toast')
          if (node === null) {
            node = document.createElement('div')
            node.id = 'dsh-sb-error-toast'
            document.body.appendChild(node)
          }
          node.className = 'dsh-sb-toast'
          node.textContent = `会话进程打不开：${lastError ?? '拿不到 layout 服务（layoutService 为空）'}`
          setTimeout(() => {
            try {
              node.remove()
            } catch {
              /* 忽略 */
            }
          }, 8000)
        } catch {
          /* 忽略 */
        }
        return false
      }

      for (const layout of candidates) {
        if (layout && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel(PANEL_ID)
          } catch (error) {
            lastError = error?.message ?? String(error)
            console.warn('[dsh-session-board] selectPanel 失败：', lastError)
            continue
          }
          // selectPanel 不抛 ≠ 真的切过去了。两种失败都算：
          //   1) 面板根节点根本没挂载
          //   2) 挂载了但不可见（宽高为 0 / 被隐藏）
          const visible = () => {
            const node = document.querySelector('.dsh-sb')
            if (node === null) return false
            const rect = node.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          }
          setTimeout(() => {
            if (visible()) return
            if (clickSidebarEntry()) {
              setTimeout(() => {
                if (visible()) return
                lastError = '调用了 layout.selectPanel，但看板没有显示（面板已挂载却不可见）'
                fail()
              }, 400)
              return
            }
            lastError = '调用了 layout.selectPanel，但看板没有显示，且找不到侧边栏入口'
            fail()
          }, 250)
          return true
        }
      }
      if (clickSidebarEntry()) return true
      return fail()
    }

    /** 侧边栏底部（Settings 旁边）的入口，侧边栏展开时用。 */
    function SidebarBoardAction(props) {
      const usePanelInfo = typeof props?.usePanelInfo === 'function' ? props.usePanelInfo : useNoPanelInfo
      const active = usePanelInfo((info) => info?.activePanelId === PANEL_ID)
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-sb-action${active ? ' is-active' : ''}`,
          title: '打开会话进程',
          onClick: () => gotoBoard(props?.ctx),
        },
        h(WhaleTail, { size: 16 }),
        h('span', { className: 'dsh-sb-action-text' }, '会话进程'),
      )
    }

    /**
     * 兜底入口：`shell.bottom` 里的一条细条，只在侧边栏折叠时显示
     * （用 CSS `:has([data-sidebar-collapsed])` 控制，不需要 JS 监听）。
     * 它在布局流里，不覆盖任何控件；宿主保证这个座位常驻。
     */
    function BottomBoardEntry(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-sb-bottombar',
          title: '打开会话进程',
          onClick: () => gotoBoard(props?.ctx),
        },
        h(WhaleTail, { size: 14 }),
        h('span', null, '会话进程'),
      )
    }
    /** 右侧面板 tab 的 id / kind（照抄 dsh-chemflow 的两段式做法）。 */
    const TAB_ID = 'dsh-session-board'
    const TAB_KIND = 'session-board'

    /** tab 类型定义：类型必须**立即**注册，打开逻辑不能等 body 挂载。 */
    function boardTabDefinition() {
      return { id: TAB_ID, kind: TAB_KIND, priority: 'extension', title: () => '会话进程' }
    }

    /** 打开右侧面板的「会话进程」tab（不切主面板、不影响当前会话）。 */
    function openBoardPane(ctx) {
      const sidebar = ctx?.get?.('sidebarRight') ?? ctx?.sidebarRight
      if (sidebar !== undefined && sidebar !== null && typeof sidebar.openTab === 'function') {
        try {
          sidebar.openTab(TAB_KIND)
          return true
        } catch (error) {
          console.warn('[dsh-session-board] openTab 失败：', error?.message ?? error)
        }
      }
      try {
        let node = document.getElementById('dsh-sb-error-toast')
        if (node === null) {
          node = document.createElement('div')
          node.id = 'dsh-sb-error-toast'
          document.body.appendChild(node)
        }
        node.className = 'dsh-sb-toast'
        node.textContent = '会话进程打不开：拿不到 sidebarRight 服务或 openTab'
        setTimeout(() => node.remove(), 6000)
      } catch {
        /* 忽略 */
      }
      return false
    }

    /** 头部图标（「结构」同一排）：打开右侧面板 tab。 */
    function HeaderBoardIcon(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-sb-headbtn',
          title: '会话进程',
          'aria-label': '会话进程',
          onClick: () => openBoardPane(props?.ctx),
        },
        h(WhaleTail, { size: 15 }),
      )
    }

    /** 右侧面板里的看板容器。 */
    function RightPaneBoard(props) {
      return h('div', { className: 'dsh-sb-pane' }, h(Panel, { ...props }))
    }

    function ComposerBoardButton(props) {
      const open = (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        if (event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
        openBoardPane(props?.ctx)
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-sb-composerbtn',
          title: '打开会话进程',
          'aria-label': '打开会话进程',
          'data-dsh-sb-own': '1',
          // composer 那层可能有拖拽/遮罩抢事件：click 之外再绑 pointerdown，
          // 哪个先到算哪个（gotoBoard 幂等）。
          onClick: open,
          onPointerDown: open,
          style: { pointerEvents: 'auto' },
        },
        h(WhaleTail, { size: 15 }),
      )
    }

    /** 没有 useWorkspaces 标准 prop 时的兜底：当成"没有任何归档"。 */
    const useNoWorkspaces = (selector) => selector({})
    /** 稳定的空数组：选择器每次都返回同一个引用，避免无谓重渲染。 */
    const EMPTY_ARCHIVED = Object.freeze([])

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
      const { row, bucket, now, cursor, onOpen, groups } = props
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title : '(无标题)'
      const turns = row.projectionValues?.sessionStats?.turns
      const at = Number.isFinite(row.updatedAt) ? row.updatedAt : null
      const where = workspaceName(row.cwd)
      const belongs = Array.isArray(groups) ? groups : []

      return h(
        'button',
        {
          type: 'button',
          className: `dsh-sb-card${cursor ? ' is-cursor' : ''}`,
          'data-bucket': bucket,
          draggable: true,
          onDragStart: (event) => {
            try {
              event.dataTransfer.setData(DRAG_TYPE, row.id)
              event.dataTransfer.effectAllowed = 'move'
            } catch {
              /* 没有 dataTransfer 就算了 */
            }
          },
          title: `${title}\n${row.cwd ?? ''}\n最近活动：${formatDateTime(at)}\n点击进入这个对话 · 可拖到工作组`,
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
          belongs.length > 0
            ? h('span', { className: 'dsh-sb-badge' }, `组 ${belongs.length}`)
            : null,
          h('span', { className: 'dsh-sb-when' }, formatAgo(at, now)),
        ),
      )
    }

    /** 组内一行会话：可拖出去（拖到「未分组」就是移出本组）。 */
    function MemberRow(props) {
      const { id, groupId, row, bucket, now, onOpen, onRemove } = props
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title : '(无标题)'
      const at = Number.isFinite(row.updatedAt) ? row.updatedAt : null

      return h(
        'div',
        {
          className: 'dsh-sb-member',
          draggable: true,
          onDragStart: (event) => {
            try {
              event.dataTransfer.setData(DRAG_TYPE, id)
              event.dataTransfer.setData(`${DRAG_TYPE}-group`, groupId)
              event.dataTransfer.effectAllowed = 'move'
            } catch {
              /* 没有 dataTransfer 就算了 */
            }
          },
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-sb-member-main',
            title: `${title}\n${row.cwd ?? ''}\n最近活动：${formatDateTime(at)}\n点击进入这个对话`,
            onClick: onOpen,
          },
          h('span', { className: `dsh-sb-dot ${bucket}`, 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-sb-member-title' }, title),
          h('span', { className: 'dsh-sb-when' }, formatAgo(at, now)),
        ),
        onRemove
          ? h(
              'button',
              { type: 'button', className: 'dsh-sb-x', title: '从这个工作组移出', onClick: onRemove },
              '×',
            )
          : null,
      )
    }

    /**
     * 工作组卡片：**卡片本身就是工作组**，不再是一个会话。
     * 单击展开成员与记忆编辑器；会话拖到卡上加入；卡片可被拖拽接收。
     */
    function GroupCard(props) {
      const {
        group,
        members,
        bucket,
        expanded,
        cursor,
        now,
        onToggle,
        onOpen,
        onOpenFile,
        onRename,
        onDelete,
        onRemoveMember,
        onDropSession,
        pseudo = false,
      } = props

      const [over, setOver] = React.useState(false)
      const [renaming, setRenaming] = React.useState(false)
      const [nameDraft, setNameDraft] = React.useState(group.name ?? '')
      const [confirming, setConfirming] = React.useState(false)

      React.useEffect(() => {
        setNameDraft(group.name ?? '')
        setRenaming(false)
        setConfirming(false)
      }, [group.id, group.name])

      const waiting = members.filter((member) => member.bucket === 'waiting').length
      const working = members.filter((member) => member.bucket === 'working').length
      const latest = members.reduce(
        (max, member) => Math.max(max, Number.isFinite(member.row.updatedAt) ? member.row.updatedAt : 0),
        0,
      )
      const preview = group.memoryPreview ?? memoryPreview(group.memory)
      // 折叠时露出的"刚刚有动静"的会话（不是把整组摊开）。
      const fresh = freshMembers(members, now)

      /** 确认改名：空名字或没改就只关输入框，不发请求。 */
      const commitRename = () => {
        const name = nameDraft.trim()
        if (name !== '' && name !== (group.name ?? '') && typeof onRename === 'function') {
          void onRename(group.id, name)
        }
        setRenaming(false)
      }

      return h(
        'div',
        {
          className: `dsh-sb-group${pseudo ? ' is-pseudo' : ''}${cursor ? ' is-cursor' : ''}${over ? ' is-over' : ''}`,
          'data-bucket': bucket,
          ...(pseudo
            ? {}
            : {
                onDragOver: (event) => {
                  event.preventDefault()
                  if (!over) setOver(true)
                },
                onDragLeave: () => setOver(false),
                onDrop: (event) => {
                  event.preventDefault()
                  setOver(false)
                  const sid = sessionOfDrag(event)
                  if (sid !== '') onDropSession(group.id, sid)
                },
              }),
        },
        h(
          'div',
          { className: 'dsh-sb-group-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-sb-group-headbtn',
              onClick: onToggle,
              title: expanded ? '收起这个工作组' : '展开这个工作组',
            },
            h('span', { className: `dsh-sb-dot ${bucket}`, 'aria-hidden': 'true' }),
            h('span', { className: 'dsh-sb-group-name' }, group.name),
            h('span', { className: 'dsh-sb-spacer' }),
            h('span', { className: 'dsh-sb-group-count' }, `${members.length} 个会话`),
            h('span', { className: 'dsh-sb-chev' }, expanded ? '−' : '+'),
          ),
          // ⚠️ 重命名输入框不能嵌在 <button> 里：按钮内的 input 会吞掉/转发
          // 键盘事件，Enter 永远到不了它自己的 onKeyDown —— 表现就是"一直可编辑"。
          renaming
            ? h(
                'div',
                { className: 'dsh-sb-rename' },
                h('input', {
                  className: 'dsh-sb-group-name-input',
                  value: nameDraft,
                  autoFocus: true,
                  onChange: (event) => setNameDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename()
                    } else if (event.key === 'Escape') {
                      setNameDraft(group.name ?? '')
                      setRenaming(false)
                    }
                  },
                }),
                h('button', { type: 'button', className: 'dsh-sb-btn primary', onClick: commitRename }, '确定'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-sb-btn',
                    onClick: () => {
                      setNameDraft(group.name ?? '')
                      setRenaming(false)
                    },
                  },
                  '取消',
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-sb-group-meta' },
          waiting > 0 ? h('span', { className: 'dsh-sb-tag waiting' }, `${waiting} 等你`) : null,
          working > 0 ? h('span', { className: 'dsh-sb-tag working' }, `${working} 在跑`) : null,
          members.length === 0
            ? h('span', { className: 'dsh-sb-tag' }, pseudo ? '没有未分组的会话' : '把会话拖到这里')
            : null,
          latest > 0 ? h('span', { className: 'dsh-sb-when' }, formatAgo(latest, now)) : null,
        ),
        preview !== '' ? h('div', { className: 'dsh-sb-group-memo' }, preview) : null,
        // 折叠状态下的"预览行"：只露出刚跑完 / 正在跑的会话，不摊开整组、
        // 也不显示记忆文件。这样既不用点开，也不会把卡片撑得很大。
        !expanded && fresh.length > 0
          ? h(
              'div',
              { className: 'dsh-sb-peek' },
              fresh.slice(0, 3).map((member) =>
                h(MemberRow, {
                  key: `peek-${member.id}`,
                  id: member.id,
                  groupId: pseudo ? '' : group.id,
                  row: member.row,
                  bucket: member.bucket,
                  now,
                  onOpen: () => onOpen(member.id),
                  onRemove: null,
                }),
              ),
              members.length > fresh.length
                ? h(
                    'button',
                    { type: 'button', className: 'dsh-sb-peek-more', onClick: onToggle },
                    `还有 ${members.length - fresh.length} 个 · 展开`,
                  )
                : null,
            )
          : null,
        expanded
          ? h(
              'div',
              { className: 'dsh-sb-group-body' },
              members.length === 0
                ? h(
                    'div',
                    { className: 'dsh-sb-member-empty' },
                    pseudo ? '所有会话都分组了。' : '这个工作组还没有会话。把「未分组」里的会话拖进来。',
                  )
                : members.map((member) =>
                    h(MemberRow, {
                      key: member.id,
                      id: member.id,
                      groupId: pseudo ? '' : group.id,
                      row: member.row,
                      bucket: member.bucket,
                      now,
                      onOpen: () => onOpen(member.id),
                      onRemove: pseudo ? null : () => onRemoveMember(group.id, member.id),
                    }),
                  ),
              pseudo
                ? null
                : h(
                    'div',
                    { className: 'dsh-sb-memo' },
                    h(
                      'div',
                      { className: 'dsh-sb-memo-head' },
                      h('span', null, '记忆文件'),
                      h('span', { className: 'dsh-sb-memo-count' }, `${group.memorySize ?? 0} 字`),
                    ),
                    // 记忆正文不在界面里铺开：只给文件路径 + 打开/复制。
                    // 文件本身可以很长，注入侧只取尾部摘录（见 lib/memory/model.js）。
                    h(
                      'div',
                      { className: 'dsh-sb-memo-file' },
                      h(
                        'code',
                        { className: 'dsh-sb-memo-path', title: group.memoryPath ?? '' },
                        shortPath(group.memoryPath),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-sb-btn',
                          onClick: () => onOpenFile(group.id),
                          title: '用系统默认程序打开这个 Markdown 文件',
                        },
                        '打开',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-sb-btn',
                          onClick: () => {
                            try {
                              void navigator.clipboard?.writeText(group.memoryPath ?? '')
                            } catch {
                              /* 剪贴板不可用就算了 */
                            }
                          },
                        },
                        '复制路径',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-sb-memo-foot' },
                      h('span', { className: 'dsh-sb-memo-tip' }, '会话会自动把结论同步进这个文件；只有尾部摘录进上下文'),
                      h('span', { className: 'dsh-sb-spacer' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-sb-btn',
                          onClick: () => {
                            setConfirming(false)
                            setRenaming(true)
                          },
                        },
                        '重命名',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-sb-btn danger',
                          onClick: () => {
                            // 两步：先问一次，再删。删组不删会话（红线）。
                            if (confirming) void onDelete(group.id)
                            else setConfirming(true)
                          },
                          onBlur: () => setConfirming(false),
                        },
                        confirming ? '确认删除？' : '删除工作组',
                      ),
                    ),
                  ),
            )
          : null,
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
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useNoWorkspaces

      const byId = useSessions((state) => (state && state.byId) || EMPTY_BY_ID)
      const storeItemCount = useSessions((state) => (Array.isArray(state?.items) ? state.items.length : 0))
      const active = usePanelInfo((info) => info?.activePanelId === PANEL_ID)
      const statuses = useSessionStatus((value) => value)

      // 看板一激活就撤掉 host 注入的首屏遮罩（两段式淡出）。
      React.useEffect(() => {
        if (active) dismissFirstPaint()
      }, [active])
      // 归档是工作区层的状态：SessionSummary 里没有，只能从 useWorkspaces 的快照拿。
      const archivedIds = useWorkspaces((state) => state?.archivedSessionIds ?? EMPTY_ARCHIVED)
      const archived = React.useMemo(
        () => new Set(Array.isArray(archivedIds) ? archivedIds : []),
        [archivedIds],
      )

      const now = useNow()
      const [query, setQuery] = React.useState('')
      const [cursor, setCursor] = React.useState(0)
      const [memory, setMemory] = React.useState({ revision: 0, groups: [], sessionsIndex: {} })
      const [memoryError, setMemoryError] = React.useState('')
      // 展开状态：**只记用户的显式覆盖**（id → 是否展开）。没覆盖过的组按状态自动展开。
      const [overrides, setOverrides] = React.useState(() => new Map())
      const [creating, setCreating] = React.useState(false)
      const [newGroupName, setNewGroupName] = React.useState('')

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

      /** 重拉工作组数据：前端唯一的真相来源。 */
      const reloadMemory = React.useCallback(async () => {
        try {
          const value = await memoryRequest('')
          setMemory({
            revision: value?.revision ?? 0,
            groups: Array.isArray(value?.groups) ? value.groups : [],
            sessionsIndex: value?.sessionsIndex ?? {},
          })
          setMemoryError('')
        } catch (error) {
          setMemoryError(String(error?.message ?? error))
        }
      }, [])

      React.useEffect(() => {
        void reloadMemory()
      }, [reloadMemory])

      React.useEffect(() => {
        if (active) void reloadMemory()
      }, [active, reloadMemory])

      /** 所有写操作都走这里：失败只记一条消息，不打断看板。 */
      const mutateMemory = async (run) => {
        try {
          await run()
          await reloadMemory()
        } catch (error) {
          setMemoryError(String(error?.message ?? error))
        }
      }

      /** 用户手动点了一次：把"当前实际状态取反"记成显式覆盖。 */
      const toggleGroup = (groupId, currentlyExpanded) => {
        setOverrides((previous) => {
          const next = new Map(previous)
          next.set(groupId, !currentlyExpanded)
          return next
        })
      }

      const submitNewGroup = () => {
        const name = newGroupName.trim()
        if (name === '') return
        void mutateMemory(async () => {
          await memoryRequest('/groups', 'POST', { name })
          setNewGroupName('')
          setCreating(false)
        })
      }

      /** 用系统默认程序打开这个组的记忆 .md（host 侧 spawn）。 */
      const openGroupFile = (groupId) =>
        mutateMemory(() => memoryRequest(`/groups/${groupId}/open`, 'POST'))
      const renameGroup = (groupId, name) =>
        mutateMemory(() => memoryRequest(`/groups/${groupId}`, 'PATCH', { name }))
      const removeGroup = (groupId) => mutateMemory(() => memoryRequest(`/groups/${groupId}`, 'DELETE'))
      const addToGroup = (groupId, sessionId) =>
        mutateMemory(() => memoryRequest(`/groups/${groupId}/sessions/${sessionId}`, 'PUT'))
      const removeFromGroup = (groupId, sessionId) =>
        mutateMemory(() => memoryRequest(`/groups/${groupId}/sessions/${sessionId}`, 'DELETE'))

      const { buckets, total, matched } = React.useMemo(() => {
        const groups = { waiting: [], working: [], idle: [], ended: [], older: [] }
        const needle = query.trim().toLowerCase()
        let totalCount = 0

        for (const [id, row] of Object.entries(byId)) {
          if (!row) continue
          totalCount += 1
          const bucket = classify(row, statusOf(statuses, id), now, archived)
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
      }, [byId, statuses, query, now, archived])

      /**
       * 看板现在以「工作组」为单位：组卡按组内最急的会话状态分桶，
       * 没进任何组的会话落到最下面那段「未分组」里（可拖进组）。
       */
      const view = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        const bySession = new Map()
        for (const bucket of BUCKETS) {
          for (const entry of buckets[bucket.key] ?? []) bySession.set(entry.id, { ...entry, bucket: bucket.key })
        }

        const groups = (memory.groups ?? []).map((group) => {
          const members = (Array.isArray(group.sessions) ? group.sessions : [])
            .map((sid) => {
              const entry = bySession.get(sid)
              return entry ? { id: sid, row: entry.row, bucket: entry.bucket } : null
            })
            .filter(Boolean)
            .sort((a, b) => (Number(b.row.updatedAt) || 0) - (Number(a.row.updatedAt) || 0))
          const bucket = groupBucketOf(members.map((member) => member.bucket))
          const latest = members.reduce(
            (max, member) => Math.max(max, Number.isFinite(member.row.updatedAt) ? member.row.updatedAt : 0),
            0,
          )
          return {
            group,
            members,
            bucket,
            latest,
            expanded: overrides.get(group.id) === true,
          }
        })

        const visibleGroups = groups.filter((entry) => {
          if (needle === '') return true
          if (String(entry.group.name).toLowerCase().includes(needle)) return true
          if (String(entry.group.memory ?? '').toLowerCase().includes(needle)) return true
          return entry.members.some((member) =>
            `${member.row.title ?? ''} ${member.row.cwd ?? ''}`.toLowerCase().includes(needle),
          )
        })

        const grouped = new Set()
        for (const group of memory.groups ?? []) {
          for (const sid of Array.isArray(group.sessions) ? group.sessions : []) grouped.add(sid)
        }

        const groupsById = new Map(groups.map((entry) => [entry.group.id, entry.group]))
        const ungrouped = []
        for (const bucket of BUCKETS) {
          // 重要：**更早的会话不再默认隐藏**。看板的用途是回看进度，
          // 7 天前的会话仍然有价值（本机 127 个会话里有 90+ 个超过 7 天）。
          for (const entry of buckets[bucket.key] ?? []) {
            if (grouped.has(entry.id)) continue
            if (needle !== '') {
              const haystack = `${entry.row.title ?? ''} ${entry.row.cwd ?? ''}`.toLowerCase()
              if (!haystack.includes(needle)) continue
            }
            ungrouped.push({
              ...entry,
              bucket: bucket.key,
              groups: (memory.sessionsIndex?.[entry.id] ?? [])
                .map((groupId) => groupsById.get(groupId))
                .filter(Boolean),
            })
          }
        }

        return { groups: visibleGroups, ungrouped }
      }, [buckets, memory, query, overrides, now])

      const flatGroups = React.useMemo(
        () =>
          view.ungrouped.length > 0
            ? [...view.groups.map((entry) => entry.group.id), UNGROUPED_ID]
            : view.groups.map((entry) => entry.group.id),
        [view],
      )

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
            setCursor((value) => Math.min(flatGroups.length - 1, Math.max(0, value + 1)))
          } else if (event.key === 'k' || event.key === 'ArrowUp') {
            event.preventDefault()
            setCursor((value) => Math.max(0, value - 1))
          } else if (event.key === 'Enter') {
            const active = view.groups.find((entry) => entry.group.id === flatGroups[cursor])
            if (active) {
              event.preventDefault()
              toggleGroup(active.group.id, active.expanded)
            }
          } else if (event.key === '/') {
            event.preventDefault()
            const input = document.querySelector('.dsh-sb-input')
            if (input) input.focus()
          } else if (event.key === 'Escape') {
            setQuery('')
            setOverrides(new Map())
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [active, flatGroups, cursor])

      React.useEffect(() => {
        if (cursor > flatGroups.length - 1) setCursor(Math.max(0, flatGroups.length - 1))
      }, [flatGroups, cursor])

      const counts = {
        waiting: buckets.waiting.length,
        working: buckets.working.length,
        idle: buckets.idle.length,
        ended: buckets.ended.length,
        older: buckets.older.length,
      }
      const groupCounts = { waiting: 0, working: 0, idle: 0, ended: 0, empty: 0 }
      for (const entry of view.groups) groupCounts[entry.bucket] = (groupCounts[entry.bucket] ?? 0) + 1
      const cursorId = flatGroups[cursor] ?? null
      const nothingMatched = view.groups.length === 0 && view.ungrouped.length === 0

      // 「未分组」伪卡片的聚合状态与展开状态（与真实组同一套规则）。
      const ungroupedMembers = view.ungrouped.map((entry) => ({
        id: entry.id,
        row: entry.row,
        bucket: entry.bucket,
      }))
      const ungroupedBucket = groupBucketOf(ungroupedMembers.map((member) => member.bucket))
      const ungroupedLatest = ungroupedMembers.reduce(
        (max, member) => Math.max(max, Number(member.row.updatedAt) || 0),
        0,
      )
      const ungroupedExpanded = overrides.get(UNGROUPED_ID) === true
      const toggleUngrouped = () => toggleGroup(UNGROUPED_ID, ungroupedExpanded)
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
            h('span', { className: 'dsh-sb-pill' }, '工作组', h('b', null, String(view.groups.length))),
            h('span', { className: 'dsh-sb-pill waiting' }, '等你回答', h('b', null, String(groupCounts.waiting))),
            h('span', { className: 'dsh-sb-pill working' }, '在跑', h('b', null, String(groupCounts.working))),
            h('span', { className: 'dsh-sb-pill' }, '未分组', h('b', null, String(view.ungrouped.length))),
            counts.older > 0
              ? h('span', { className: 'dsh-sb-pill' }, '更早', h('b', null, String(counts.older)))
              : null,
            h(
              'button',
              { className: 'dsh-sb-btn', onClick: () => setCreating((value) => !value) },
              creating ? '取消' : '+ 工作组',
            ),
            h(PetToggle),
          ),
          creating
            ? h(
                'div',
                { className: 'dsh-sb-newgroup' },
                h('input', {
                  className: 'dsh-sb-input',
                  placeholder: '新工作组名字（≤40 字）',
                  value: newGroupName,
                  autoFocus: true,
                  onChange: (event) => setNewGroupName(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitNewGroup()
                  },
                }),
                h('button', { className: 'dsh-sb-btn primary', onClick: submitNewGroup }, '创建'),
              )
            : null,
          h('input', {
            className: 'dsh-sb-input',
            placeholder: '按工作组名 / 会话标题 / 目录过滤…（/ 聚焦）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'span',
            { className: 'dsh-sb-sub' },
            `共 ${total} 个会话（宿主送到客户端的）· ${view.groups.length} 个工作组 · 未分组 ${view.ungrouped.length}` +
              (counts.older > 0 ? ` · 其中 ${counts.older} 个超过 7 天` : '') +
              (total - matched > 0 ? ` · ${total - matched} 个已归档/空白/子代理会话不展示` : '') +
              ' · 皮肤在「设置 → 皮肤」里切',
          ),
          memoryError !== ''
            ? h('div', { className: 'dsh-sb-error' }, `工作组：${memoryError}`)
            : null,
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
          : nothingMatched && query.trim() !== ''
            ? h('div', { className: 'dsh-sb-empty' }, `没有匹配「${query.trim()}」的工作组或会话。`)
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dsh-sb-board' },
                  // 「进行中」常驻：即使 0 个也显示，布局不跳。
                  GROUP_BUCKETS.filter((bucket) => (groupCounts[bucket.key] ?? 0) > 0 || bucket.key === 'working').map((bucket) => {
                    const entries = view.groups.filter((entry) => entry.bucket === bucket.key)
                    return h(
                      'div',
                      { className: 'dsh-sb-col', key: bucket.key },
                      h(
                        'div',
                        { className: 'dsh-sb-col-head', title: bucket.hint },
                        h('span', { className: 'dsh-sb-col-name' }, bucket.label),
                        h('span', { className: 'dsh-sb-col-count' }, String(entries.length)),
                      ),
                      h(
                        'div',
                        { className: 'dsh-sb-col-body' },
                        entries.map((entry) =>
                          h(GroupCard, {
                            key: entry.group.id,
                            group: entry.group,
                            members: entry.members,
                            bucket: entry.bucket,
                            expanded: entry.expanded,
                            cursor: cursorId === entry.group.id,
                            now,
                            onToggle: () => toggleGroup(entry.group.id, entry.expanded),
                            onOpen: openSession,
                            onOpenFile: openGroupFile,
                            onRename: renameGroup,
                            onDelete: () => removeGroup(entry.group.id),
                            onRemoveMember: removeFromGroup,
                            onDropSession: (groupId, sessionId) => {
                              // 拖进去之后钉住"展开"，否则会话从「未分组」消失、
                              // 组卡又收起，看起来就像丢了一样。
                              setOverrides((previous) => {
                                const next = new Map(previous)
                                next.set(groupId, true)
                                return next
                              })
                              void addToGroup(groupId, sessionId)
                            },
                          }),
                        ),
                      ),
                    )
                  }),
                  view.groups.length === 0
                    ? h(
                        'div',
                        { className: 'dsh-sb-col' },
                        h(
                          'div',
                          { className: 'dsh-sb-col-head' },
                          h('span', { className: 'dsh-sb-col-name' }, '工作组'),
                          h('span', { className: 'dsh-sb-col-count' }, '0'),
                        ),
                        h(
                          'div',
                          { className: 'dsh-sb-col-body' },
                          h(
                            'div',
                            { className: 'dsh-sb-empty-col' },
                            '还没有工作组 —— 点右上角「+ 工作组」建一个，再把会话拖进去。',
                          ),
                        ),
                      )
                    : null,
                ),
                view.ungrouped.length > 0
                  ? h(
                      'div',
                      { className: 'dsh-sb-col', key: 'ungrouped' },
                      h(
                        'div',
                        { className: 'dsh-sb-col-head' },
                        h('span', { className: 'dsh-sb-col-name' }, '未分组'),
                        h('span', { className: 'dsh-sb-col-count' }, String(view.ungrouped.length)),
                      ),
                      h(
                        'div',
                        { className: 'dsh-sb-col-body' },
                        h(GroupCard, {
                          group: { id: UNGROUPED_ID, name: '未分组', memory: '', memoryPath: '', memorySize: 0 },
                          members: ungroupedMembers,
                          bucket: ungroupedBucket,
                          expanded: ungroupedExpanded,
                          cursor: cursorId === UNGROUPED_ID,
                          now,
                          pseudo: true,
                          onToggle: toggleUngrouped,
                          onOpen: openSession,
                          onOpenFile: null,
                          onRename: null,
                          onDelete: null,
                          onRemoveMember: null,
                          onDropSession: null,
                        }),
                      ),
                    )
                  : null,
              ),

        h(
          'div',
          { className: 'dsh-sb-foot' },
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, 'j'), h('span', { className: 'dsh-sb-kbd' }, 'k'), ' 选工作组'),
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, 'Enter'), ' 展开/收起'),
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, '/'), ' 搜索'),
          h('span', null, h('span', { className: 'dsh-sb-kbd' }, 'Esc'), ' 清空'),
          h('span', null, '会话拖到工作组上加入 · 组内 × 移出 · 每个会话最多挂 3 个组'),
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

      const SettingsEntry = () => React.createElement(SettingsPage)
      const PaneEntry = (props) => React.createElement(RightPaneBoard, { ...props, ctx })
      const HeaderEntry = (props) => React.createElement(HeaderBoardIcon, { ...props, ctx })

      // 只保留「设置 → 皮肤」一件事放在常规座位。
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'skins', order: 26, label: '皮肤' }, SettingsEntry),
      )

      // 会话进程本体：右侧面板的一个 tab（不切主面板、不影响当前会话）。
      // 类型先注册（tabs.register），body 再挂到 key = TAB_ID 上，最后 openTab(kind)。
      ctx.inject(['sidebarRightTabs'], (scoped) => {
        const tabs = scoped.sidebarRightTabs
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') {
          console.warn('[dsh-session-board] 没有 sidebarRightTabs 服务，右侧 tab 不会注册')
          return
        }
        scoped.effect(() => tabs.register(boardTabDefinition()), 'dsh-session-board: right tab type')
      })
      slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, PaneEntry),
      )

      // 入口：「结构」同一排的头部图标。
      slots.inject('conversation.session.header.utilities', () =>
        slots.register({ name: 'conversation.session.header.utilities', id: 'session-board', order: 20, label: '会话进程' }, HeaderEntry),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return exports
  },
})
