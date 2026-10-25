# dsh-session-board

**会话进程看板**：自动识别每个会话现在的状态——等你回答 / 工作中 / 闲置 / 结束——点一下就跳进那个对话。
自带「鲸蓝娘」皮肤，并把你的桌宠角色嵌进看板。

## 为什么是这个东西

会话多了以后，麻烦的不是"找不到"（搜索能解决），而是**不知道哪个还在跑、哪个在等我、哪个已经凉了**。
DSH 的会话列表只按时间排，你得点进去才知道进展。这个插件把**状态**变成一等公民。

| 列 | 判定（全自动） | 含义 |
| --- | --- | --- |
| 等你回答 | 会话有 `pendingInteraction`（审批/提问） | 最该先处理，排第一 |
| 工作中 | `running === true` | 正在跑 |
| 闲置 | 没在跑，24 小时内动过 | 刚干完 / 待续 |
| 结束 | 没在跑，24 小时～7 天没动 | 凉了 |
| 更早 | 超过 7 天没动 | 默认收起 |

**零维护**：状态全部来自宿主已有的 session store（`useSessions` / `useSessionStatus` 标准 props），
不读会话文件、不解 zstd、不联网。剔除空会话（`blank`）与子会话（`parentSessionId` / `depth > 0`）。

## 皮肤：鲸蓝娘

分两层，互不干扰：

1. **全局层**——`ctx.theme.overrideTokens('dsh-session-board:skin', …)`：官方扩展点，
   覆盖宿主的 alias token（明/暗各一套），全 App 自动跟随、明暗切换照常、卸载即还原。
   覆盖的是公开的 14 个 token + `bg-layer-3` / `button-primary-*`。

2. **面板层**——`.dsh-sb-*` 自有样式：渐变底、状态色左边条、卡片 hover 抬升、
   等待列樱粉底、脉冲状态点、`工作 中` 呼吸光环、`prefers-reduced-motion` 下关掉全部动效。

### 皮肤管理器（内置 3 套 + 自己导入，**全部热切换**）

**位置：设置 → 外观 / 皮肤**（`settings.section`，id `appearance`）。看板头部不再放开关。

| 皮肤 | 说明 |
| --- | --- |
| **鲸蓝娘**（默认） | 实色蓝紫：`#f4f8ff`/`#080e1b`，品牌色 `#3b6ff0` |
| **液态玻璃** | 冷调蓝紫磨砂玻璃：极光底 + 输入卡/气泡/对话框/菜单/头部的磨砂层 + squircle + 内高光 + 柔和投影 |
| **原生** | 撤销所有覆盖，回到宿主默认外观 |
| **自己导入** | 设置页底部粘一段 JSON → 导入并应用，立刻可用、可删除 |

切换 = 换 `overrideTokens` 那一层 + 换一个 `<style>` + 换 `html[data-dsh-sb-skin]` 属性，所以是热的、
不用重启；所选皮肤会写回 host（`skins-state.json`），换浏览器或重启都保持一致。
同一页里还集成了**桌宠**（状态 + 显示/隐藏），看板头部的立绘就是它。

#### 液态玻璃：四类面（含真折射）

| 目标 | 选择器 | 做法 |
| --- | --- | --- |
| 会话输入卡 | `[data-composer-card]` | 圆角 24 + squircle、blur 18 + **折射**、内高光、柔投影 |
| 设置面板 | `[data-shortcut-modal="settings"]` | 同上，另把内部 `nav` 的实底去掉 |
| 弹窗（重命名会话、确认框、用量面板…） | `[role="dialog"]` / `[role="alertdialog"]` | 圆角 18、blur 16 + 折射；弹窗定位五花八门，用元素自身 `backdrop-filter` 而非伪元素 |
| 本插件看板 | `.dsh-sb-card` / 胶囊 / 搜索框 | blur 12 + 16px 圆角；键盘游标带 brand 描边 |

**按钮、菜单、侧栏选中行一律不碰**——试过，每个小控件都浮一层玻璃反而脏，回退了。
玻璃是"浮起来的面"，只有这四类该浮。

两个必须守住的约束（都踩过）：

- 玻璃层永远 `z-index:-1` + 父元素 `isolation:isolate`，否则会盖住文字（设置里"看不到字"那次）；
- 玻璃面必须保留半透明底色（浅色 `rgba(255,255,255,.55)` / 深色 `rgba(18,26,44,.60)`），
  全透明会在深色遮罩上变成"深底深字"。

真折射用的是社区 `dsh-liquid-glass-input` / `dsh-theme-liquid-glass` 同一个手法：

```html
<svg width="0" height="0" style="position:fixed;visibility:hidden">
  <filter id="dsh-sb-refract" filterUnits="objectBoundingBox" x="-20%" y="-20%" width="140%" height="140%">
    <feDisplacementMap scale="60"/>
  </filter>
</svg>
```

```css
[data-composer-card]::before{
  backdrop-filter: blur(18px) saturate(160%) url(#dsh-sb-refract);
}
```

`feDisplacementMap` 不写 `in`/`in2` 时，会拿 backdrop 快照**自身的 alpha 边**当位移图，
于是贴边处的内容被弯折 —— 就是"隔着有厚度的玻璃看"。**仅 Chromium 生效**，其它内核退化成磨砂。

三个细节：

1. 过滤器挂在 **`::before` 伪元素**上（`border-radius: inherit; z-index: 0`），不挂在卡片本体 ——
   `backdrop-filter` 会让元素变成 fixed 后代的包含块，挂在本体上弹层会跑位。
2. 卡片本体底色设为透明，玻璃层（模糊 + 折射 + 蓝紫渐变 + 内高光）由伪元素承担。
3. 外形：`border-radius: 24px` + `corner-shape: superellipse(1.18)`（支持的内核是 squircle），
   外加 `0 20px 48px -26px` 的柔投影做悬浮感。

> 性能取舍：`button` 这类小件用 blur 10、**不加折射**（折射在几十个小控件上是噪音且更贵）；
> 折射只留给 T1 的大面。消息列表、侧栏背景仍然不铺玻璃——参考实现也明确说大面积模糊会掉帧。

> 回收站面板自带 `:root` 私有调色板（`dsh-session-recycle-bin/client.css`），不读 token，
> 所以换肤后它不跟随。这不是冲突，只是风格不统一。

## 桌宠（已并入本插件）

`dsh-desktop-pet` 的整个运行时（`lib / src / pet-app / renderer / assets`）已经收进本包的
**`./pet/`**，由 `lib/index.js` 作为子插件挂载 —— 所以 profile 里**不需要**再单独装它：

1. 插件页卸载 `dsh-desktop-pet`
2. 重启桌面端
3. 浮窗、控制口 `/dsh-desktop-pet`、立绘都由本插件提供

保护逻辑：如果检测到**独立安装**的桌宠还在，会跳过内嵌挂载（两份同时活着会各 spawn 一个浮窗，
而且两条 `/dsh-desktop-pet` 精确路由会撞）。日志里会写
`检测到独立安装的 dsh-desktop-pet，跳过内嵌桌宠`。

配置：`pet: false` 彻底关掉内嵌桌宠；`pet: { enabled, controlPanel, scale }` 透传给桌宠本身。

> 并入时打了一个补丁：`pet/lib/index.js` 原先 `import Schema from '@deepseek-ai/schemastery'`。
> 宿主那条 `@deepseek-ai/*` 解析只覆盖**插件入口**，不覆盖被动态 import 的相对子模块 ——
> 保留它会让内嵌桌宠静默加载失败（`/dsh-desktop-pet` 变 404、没有浮窗）。现在改成普通对象
> `PET_DEFAULTS` + `apply` 里合并默认值，零外部依赖，默认值与原来的 `Config` 逐项一致。

看板侧：

- **立绘**：host 侧 `lib/pet.js` 把 `pet/assets/pet/<pose>.png` 通过只读路由
  `/api/session-board/pet/<pose>` 转出来（白名单 7 个姿态；内嵌优先，回退独立包）。
- **按素材真相选图**：`idle` / `busy` / `alert` 是 256×256 **方形头像**，
  `base` / `chew` / `hover` 是 ~397×420 **全身立绘**，`alert` 还带 logo 横幅。
  所以头部小头像只用 `idle` / `busy`，空态用全身 `base`；不用 `alert`。
- **显隐开关**：设置 → 皮肤 → 「桌宠」里的显示/隐藏（走 `/dsh-desktop-pet?action=status|toggle`），
  看板头部也留了一个小按钮。
- 立绘读不到时自动回退到自绘鲸尾矢量图。

> ⚠️ **素材归属**：立绘与浮窗代码来自你自己的 `dsh-desktop-pet`（Apache-2.0）。
> 本机自用没问题；要发布本插件的话，保留其 LICENSE/NOTICE 或换成自有素材。

## 工作组（跨会话共享记忆）

> 状态：**host 层已完成并测试**（数据 / API / 注入）；看板 UI 还在改（卡片即工作组）。

### 为什么能注入（M0 结论，别删）

`@deepseek-ai/dsh-system-prompt` 组装时：

```js
text: typeof section.text === "function" ? section.text(context) : section.text
```

`@deepseek-ai/dsh-agent` 给的 context：

```js
{ agent, scope: agent, ...(signal && { signal }) }
```

所以 **`context.agent.id` 就是会话 id**，但求值处**没有 `await`** —— 回调必须同步、
必须返回字符串。`lib/memory/store.js` 因此把状态常驻内存，注入零 IO。

### 数据与上限

**记忆正文不再进 JSON**：每个工作组一个 Markdown 文件，放在
`$DSH_HOME/dsh-session-board/memory/<groupId>.md`；`memory.json` 只留元数据
（名字、颜色、成员、时间）。

```jsonc
// memory.json
{ "version": 1, "revision": 7,
  "groups": [{ "id": "grp_…", "name": "化学实验室", "color": "#4f8cc9",
               "order": 10, "memory": "", "sessions": ["session-…"] }] }
```

| 规则 | 值 | 行为 |
| --- | --- | --- |
| 记忆文件 | 64k 字符 | 超了**从最旧的整行开始丢**（滚动） |
| 每组注入摘录 | 1500 字符（取**最新**尾部） | 文件再长，进上下文的也只有这一段 + 文件路径 |
| 注入总量 | 4000 字符 | 超了只注入前 N 组，并注明「记忆已截断」 |
| 每组会话数 | 200 | 超了拒绝 |
| 一个会话挂几组 | **3** | 第 4 个直接拒绝（`GROUPS_PER_SESSION_LIMIT`） |
| 工作组总数 | 50 | 超了拒绝 |
| 组名 | 40 字符 | 超了拒绝 |
| 子代理会话 | — | `subagent-` / `child-` / `delegate-` 一律拒绝入组 |

### 会话自己写记忆

注册了 `workgroup_note` 工具（`lib/memory/tools.js`）：会话在得出阶段性结论时调用一次，
内容以 `- [模型] yyyy-MM-dd HH:mm …` 追加进对应工作组的 `.md`。注入段落末尾也会提醒它这么做。

工作台界面**不显示记忆正文**，只给文件路径 + 「打开 / 复制路径」；记忆再长也不挤占界面。

注入位置 **order 1500**（工具说明 1000–1200 之后、运行环境 10000 之前），渲染成：

```markdown
## 工作组：化学实验室
<!-- workbench-memory:grp_xxx r7 -->
…记忆正文…
```

多组之间 `\n\n---\n\n`。**组外会话返回空串**，系统提示一个字节都不变；
记忆为空的工作组也不占用上下文。

### HTTP

前缀 `/api/session-board/memory`（一条 prefix 路由再切段，非 GET 要 `x-dsh-plugin`）：

```
GET    /memory                              → { revision, limits, groups, sessionsIndex }
POST   /memory/groups                       { name, color?, memory?, order? }
PATCH  /memory/groups/<id>                  { name?, color?, memory?, order? }
DELETE /memory/groups/<id>                  只删组与归属，不碰会话
PUT    /memory/groups/<id>/sessions/<sid>
DELETE /memory/groups/<id>/sessions/<sid>
GET    /memory/session/<sid>                → 该会话所属组（角标用）
```

## 用法

- 侧边栏点「会话进程」图标（三竖条）→ 中央区域变成看板；**每次启动都会直接落在看板**
- 侧边栏折叠后入口不可见 → 用 **`Ctrl/⌘ + Shift + B`** 切回看板
- **看板的单位是「工作组」**：卡片显示组名、组内会话数、聚合状态（等你回答 / 在跑）、记忆首行
- 折叠的组卡会**露出刚跑完 / 正在跑的会话行**（最多 3 行）+「还有 N 个 · 展开」，不用点开也能直接进对话
- 点标题行 → 原地展开全部成员 + 记忆文件入口（不换页）
- `+ 工作组` 建组；展开后 `重命名` / `删除工作组`（删除两步确认，只删组不删会话）
- 把「未分组」卡里的会话**拖到组卡上** → 加入；组内会话点 `×` 移出（也可拖到别的组）
- 「未分组」本身**也是一张卡**（排在最后，虚线边框），列出所有还没进组的会话；它不接受拖入
- 记忆在每组一个 `.md` 文件里（工作台只显示路径），会话可用 `workgroup_note` 自己写
- `j` / `k` 选工作组，`Enter` 展开/收起，`/` 搜索，`Esc` 清空并收起
- 侧边栏图标上的**樱粉点** = 有工作组里的会话卡在等你回答

## 数据

```
$DSH_HOME/dsh-workbench/workbench.json           # v1 工作项（界面不展示，目录名沿用）
$DSH_HOME/dsh-workbench/workbench.json.bak
$DSH_HOME/dsh-session-board/memory.json          # 工作组 + 共享记忆
$DSH_HOME/dsh-session-board/memory.json.bak
$DSH_HOME/dsh-session-board/skins/<id>/skin.json # 导入的皮肤（token 表 + 元数据）
$DSH_HOME/dsh-session-board/skins/<id>/skin.css  # 可选，全局 CSS
$DSH_HOME/dsh-session-board/skins-state.json     # { active: '<皮肤 id>' }
```

看板本身**不读任何会话文件**；皮肤是唯一的持久化写入（导入/删除/切激活）。目录名保留
`dsh-workbench` 是为了不丢 v1 的工作项数据。

## HTTP

前缀 `/api/session-board`。非 GET 必须带 `x-dsh-plugin: session-board`。
封套 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session-board/pet/<pose>` | 桌宠立绘（prefix 路由，白名单 pose） |
| GET | `/api/session-board/skins` | `{ active, user: [meta…] }` |
| GET | `/api/session-board/skins/<id>` | 单套皮肤全文（tokens + css） |
| POST | `/api/session-board/skins/import` | 导入/覆盖一套用户皮肤 |
| POST | `/api/session-board/skins/delete` | 删除用户皮肤 |
| POST | `/api/session-board/skins/active` | 记住激活的是哪套 |
| GET | `/state` · `/health` | v1 工作项（界面不再调用） |
| POST | `/item/upsert` · `/item/status` · `/item/sessions` · `/item/delete` | 同上 |

## 安装 / 升级

> ⚠️ `desktop` profile 由 Electron 应用独占，CLI 装不了；在应用里操作。

**本版（0.3.0）把桌宠并进来了**，所以：

1. 插件页 **卸载** `dsh-desktop-pet`（独立桌宠）
2. 若之前装过旧的「会话工作台」（`dsh-workbench`），也一并卸载
3. **添加插件 → 安装第三方插件**，粘本目录路径（若已在装，跳过）
4. 按提示**重启**桌面端

重启后浮窗应该照常出现——这次是 `dsh-session-board` 在管它。日志里能看到
`已挂载内嵌桌宠（浮窗 + 控制口 + 立绘）`；如果还是单独立着，会写
`检测到独立安装的 dsh-desktop-pet，跳过内嵌桌宠`（说明第 1 步没生效）。

两个包同时装着会各挂一个侧边栏图标；`main` 的 key 已改成 `session-board`，所以不会互相顶掉。

## 许可

- 本插件代码：**MIT**（根目录 `LICENSE`）
- `pet/` 子目录：来自 [dsh-desktop-pet](https://github.com/SherinG-official/dsh-desktop-pet)，**Apache-2.0**，
  许可文本保留在 `pet/LICENSE`；该子树不受根目录 MIT 覆盖

## 开发

```powershell
npm run test:no-spawn   # 43 个测试：模型 / 存储 / 工作项路由 / 桌宠立绘 / 皮肤仓库
```

`node --test tests/` 在受限沙箱里会因 `spawn EPERM` 失败（测试跑器为每个文件开子进程）。
