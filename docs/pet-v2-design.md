# 桌宠 v2：状态机、进度与交互 —— 设计稿

> 状态：**P0 已实现**（状态机 + 点击穿透），P1/P2 仍未动。基线 0.3.1（`243a03b`）。
> P0 实现过程中推翻了两条设计假设，见 §13「实现时发现的事实」——那两条比本文
> 任何设计更值得先读。

---

## 一、现状盘点（先看清我们手里有什么）

**已有的**（0.3.1）：

| 部件 | 现状 |
| --- | --- |
| 表达 | 只有 **3 个**：`base` / `chew` / `hover`（`renderer/pet.js:32` 的 `FRAMES`） |
| 状态 | 一个布尔 `busy`（Host 的 `agent/status` 为准，45 秒 TTL，磁盘 mtime 兜底） |
| 素材 | 包里已有 **7 张**：`base` `chew` `hover` `mini` + **未使用的 `idle` `busy` `alert`** |
| 图层 | 同一张图两层：`bodyBase/bodyChew` + `knotBase/knotChew`，靠 `data-chew` 交叉淡入 |
| 气泡 | 固定显示 token/累计/余额/上下文条，忙碌时标题变「正在干活…」 |
| 圆钮 | 148×176，SVG 进度环 = 上下文占用，隐藏后的回程 |
| 信号 | Host 侧已接 `agent/status`；控制端口 52118 已有 `busy:0\|1` |
| 已知缺陷 | ① 空闲时没有**任何**自主行为（不眨眼、不睡、不动）② 不知道 agent **在做什么** ③ 透明区域**吃点击**（HANDOFF 里挂着） |

**结论**：素材已经比代码能用的多（3/7），信号通道（控制端口 + Host 订阅）已经铺好。
v2 的主要工作是**把状态机补出来**，而不是加新管线。

---

## 二、社区参考（都读过原始材料）

### 2.1 `@asahimoon/dsh-desktop-pet` —— DSH 生态里最接近的竞品

同一个赛道（DSH bundle 插件 + 鲸鱼娘）。要点：

- **状态联动表**（原文口径）：

  | DSH 事件 | 表现 |
  | --- | --- |
  | 工具调用中 | `working` + 气泡显示**工具名** |
  | 回合完成（`session/event` `turn/end`） | `celebrate` 欢呼 → 睡 25 秒 → 自动恢复待机 |
  | 新任务到来（exec 心跳） | 立刻醒来进入工作 |
  | 任务失败 / LLM 出错 | `error` 惊吓 → `disappointed` 失落 |
  | 思考中（`turn/start`） | `think` 沉思 |
  | 等待批准 / 阻塞 | `wait` |
  | 新会话（`agent/session-start`） | `welcome` 挥手 |

- **任务进度黑框**：宠物下方一条黑色信息条，两档。悬停简略 `[23:30] ⚙ 执行中 pwsh`
  + `📋 2/3 · 验收`；常驻详细档还能显示**具体在做什么**——文件路径（正在读/写的）、
  grep 的目录、pwsh 的命令，取自**工具调用参数**，外加已完成步骤 `✅调研 ✅编码`。
- 信号走本机 HTTP POST `127.0.0.1:43991`，5 秒心跳；空闲打盹、额度/成长账本、
  多角色 sprite 包（兼容 Codex / petdex）、热配置、鼠标穿透、桌面置底。

### 2.2 `clawd-pet` —— Claude Code 的像素桌宠（状态粒度最细）

12 个事件 → 12 个动画，且**按数量分档**：

| 事件 | 状态 | 特征 |
| --- | --- | --- |
| 用户发 prompt | `thinking` | 头部起伏 + 思路气泡 |
| 工具调用（少量） | `typing` | 点头 + 浮空键帽 |
| 工具调用（**≥3 次**） | `building` | 抖动 + 锤子 + 像素块 |
| Task/plan 类工具 | `planning` | 左右看 + 写字板 |
| 工具失败 | `error` | 抖动 + 黑烟 + "ERROR" |
| 子 agent（1 个） | `juggling` | 摇摆 + 环绕光球 |
| 子 agent（**≥2**） | `conducting` | 挥手 + 指挥棒 + 小人 |
| 权限/通知 | `alert` | 跳 + 感叹号 |
| 上下文压缩 | `sweeping` | 摇摆 + 扫帚 + 灰尘 |
| 空闲 25–40 秒 | `dancing` | 弹跳 + 音符 |
| 空闲 ~50 秒 | `sleeping` | 下沉 + 漂浮 z |

外加：完成时**逐字流式**渲染 Markdown 回复的气泡（可关闭，8 秒自动隐藏）、
按额度剩余变色的「食物条」。实现方式是在 `~/.claude/settings.json` 装 hooks，
hook 写状态文件，Electron 轮询——**它没有进程内 API，只能靠 hook 文件**。
DSH 这边有真正的插件事件总线，我们能做得比它干净。

### 2.3 `hermes-agent` —— 透明窗口吃点击的修法（可直接抄的实战修正）

commit `446a843`「never let a blank pet-overlay window capture clicks」，原文：

> Spawn the overlay with `setIgnoreMouseEvents(true, { forward: true })` so it can
> never capture clicks until the renderer explicitly re-arms interactivity over
> solid sprite pixels […] `forward:true` keeps mousemove flowing so the renderer
> can re-arm the moment the cursor touches the pet.

理由说得很清楚：透明窗口默认是**可点的**，页面加载慢 / 白屏 / 渲染进程挂掉时，
它就是桌面上一块**看不见的点击黑洞**。所以他们：

1. **spawn 时就置为穿透**（默认安全），渲染进程接管后再按需「武装」；
2. 每次因显示器变化重新定位后**再次重申穿透**；
3. 顺带修了一个 close 竞态（`close()` 在 macOS 可被中止 → 窗口残留）。

这正是我们 HANDOFF 里那条「副屏上那枚圆钮的透明区域会吃掉点击」的标准解。

### 2.4 其它（简述）

- **vscode-pets**：把宠物行为做成显式的**状态机 + 权重随机的转移**（idle 里随机
  决定去走/去追/去睡），动画帧由「每状态一组帧 + 帧率」驱动。可借鉴的是
  **转移用权重而非 if-else**，以及状态自带帧序列的结构。
- **Shimeji / zhizhiji-shimeji**：更重的行为树（重力、爬窗口边、抛掷、复制个体）。
  **不适合我们**——它是「宠物自娱自乐」，我们要的是「反映 agent 在干什么」。
  唯一值得拿的：被打断后的**恢复优先级**（用户交互 > 事件状态 > 自主行为）。
- **PixelPal**：六维属性 / 四维需求衰减 + 工作派遣 + 图鉴。属于养成游戏，
  与「工具型桌宠」目标不同；**只借用「长时间不被打理会变化」这一个想法**（见 5.4）。

---

## 三、可借用的信号（DSH 真有的，已核实）

全部来自本机 DSH 源码，不是猜的：

| 事件 | 出处 | 载荷要点 |
| --- | --- | --- |
| `agent/status` | `packages/core/agent/src/runtime-types.ts:280` | `{ agent, status: 'idle' \| 'running' }`（`AgentStatus` 见 `:109`） |
| `agent/error` | 同文件 `:393` | `{ agent, error }` |
| `agent/disposed` | 同文件 `:270` | `{ agent }`，防止 running 集合泄漏 |
| `subagent/start` / `subagent/end` | `packages/subagent/subagent/src/index.ts:161,170` | 子 agent 生死 → clawd 的 juggling/conducting 分档 |
| `session/event` | `packages/core/session/src/index.ts:72` | 会话事件总线，下面几条都在它里面 |
| ↳ `turn/start` | `packages/core/session/src/types.ts:276` | `{ turn }` |
| ↳ `turn/end` | 同文件 `:285` | `{ turn, reason }`，`reason.kind ∈ completed \| aborted \| blocked \| error \| max-tokens \| interrupted`（`:200-221`） |
| ↳ `step/start` / `step/end` | `:287,289` | `{ turn, step }` → **步骤 N/M 里的 N** |
| ↳ `tool/call` | `:341` | `{ turn, step, callId, name, arguments }` —— **`arguments` 是模型给的原始 JSON 字符串**，asahimoon 的「具体在做什么」就是从这儿解析的 |
| ↳ `tool/result` | `:355` | `{ turn, step, message, error? }`，`error` 只在失败时给 → 失败计数 |
| ↳ `assistant/message` | `:321` | `{ turn, step, message, stream, usage? }` → 完成时气泡可拿回复文本 |
| `session/flush` | `packages/core/session/src/index.ts:81` | 落盘时机 |

订阅方式（社区插件的通行写法，已核实多处）：
`ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') … })`，
见 `session-title/src/index.ts:356`、`session-telemetry/src/coordinator.ts:104`、
`auto-review/src/index.ts:279` 等。

---

## 四、设计目标（写清楚「不做什么」，避免范围蔓延）

**做**：

1. **让桌宠像活的**：空闲时有自主微行为，不再只会在忙碌/悬停之间跳。
2. **让它说人话**：知道 agent **正在做什么**（工具名 + 关键参数），而不是只有「正在干活…」。
3. **像个正经桌面住户**：不再吃掉透明区域的点击。
4. **保持已有的稳定性**：0.3.1 建立的「Host 真话优先 + 磁盘兜底 + TTL」不推翻，只扩展。

**不做**（明确划掉）：

- ❌ 不做养成/成长/图鉴/零食系统（PixelPal 路线，与工具属性冲突）。
- ❌ 不做 Shimeji 式重力/爬窗口/复制个体。
- ❌ 不做多角色 sprite 包与在线素材市场（asahimoon 的 petdex 路线）——
  除非明确要，且需要先解决素材授权。
- ❌ 不加 Chat/LLM 对话（那是另一个插件的事）。
- ❌ 不引入新运行时依赖（坚持「零第三方依赖」这条现有卖点）。

---

## 五、状态机设计

### 5.1 状态集合（6 个，全部有素材或可由现有素材表达）

| 状态 | 素材 | 含义 | 退出条件 |
| --- | --- | --- | --- |
| `idle` | `idle.png`（已有未用） | 待机，轻微呼吸 | 任何事件 |
| `working` | `chew.png`（现有） | agent 在跑 | `turn/end` |
| `thinking` | `busy.png`（已有未用） | 回合开始、还没调工具（等模型） | 首个 `tool/call` |
| `celebrate` | `alert.png` 或 `hover.png` | 回合 **成功** 结束 | 3 秒后 → `idle` |
| `error` | `alert.png` | 回合 **失败** / agent 报错 | 4 秒后 → `idle` |
| `sleep` | `idle.png` + CSS 下沉 | 长时间空闲（默认 3 分钟无回合） | 任何事件 |

> **素材策略**：先用包里现成的 7 张（`idle`/`busy`/`alert` 目前完全没用上），
> 不为 v2 新画素材。`sleep` 用 `idle` + 已有的 `breathe` keyframes 降速 + 轻微下沉
> 表达，必要时才补图。

### 5.2 转移（优先级：用户交互 > 回合事件 > 自主行为）

```
                 ┌──────────── 用户悬停（hover）────────────┐ 最高
                 │                                          │
  [sleep] ──任意事件──> [idle] ──turn/start──> [thinking] ──首个 tool/call──> [working]
     ↑                    ↑                        │                          │
     │                    │                        │ turn/end                 │ turn/end
  3 分钟无回合             │                        ↓                          ↓
     │                    └──── 3s / 4s ──── [celebrate] / [error] ←──────────┘
     └────────────────────────────────────────────────────────────────────────
```

**判定规则**（`turn/end` 的 `reason.kind` 决定去 `celebrate` 还是 `error`）：

| `reason.kind` | 状态 | 备注 |
| --- | --- | --- |
| `completed` | `celebrate` | 正常干完 |
| `error` | `error` | LLM/工具失败 |
| `aborted` | `idle` **不庆祝** | 用户自己中断的，庆祝会显得莫名其妙 |
| `blocked` | `idle`（或 `wait` 文案） | 等批准 |
| `max-tokens` | `idle` | 上限截断 |
| `interrupted` | `idle` | 崩溃后补写的收尾，**只可能出现在冷读**，实时不会来 |

### 5.3 中断与恢复（容易翻车的地方，先定死）

- **粘性优先级**：`celebrate` / `error` 是**有时限的覆盖态**（3/4 秒）。
  期间若来了新的 `turn/start`，**立刻**切 `working`（不能等计时器）。
- **悬停永远最高**：悬停时面部切 `hover`，但 **`data-state` 不丢**——
  移开鼠标要回到「本来就该在的状态」，而不是回到 `idle`。
  （0.3.1 已经是这么做的：`setChewing(busy && !hovered)`，只扩展不重写。）
- **多 agent**：`working` 的判据仍是「任一 agent 在跑」（0.3.1 的 `running` 集合），
  但进度黑框只跟**最近活跃的那个 session**。
- **Host 掉线**：沿用 0.3.1 的 45 秒 TTL，退回磁盘启发式；**新增**：TTL 过期时
  状态机整体退化为「只有 `idle`/`working`」两态（不要凭猜播庆祝/报错）。

### 5.4 自主行为（让 `idle` 不呆）

只做两条**不需要新素材**的：

1. **眨眼 / 换气**：`idle` 下随机间隔（8–20 秒）触发一次轻微缩放/位移，
   复用现有 `breathe` / `ahoge` keyframes，只改节奏。
2. **入睡**：连续 3 分钟没有任何回合事件 → `sleep`（下沉 + 呼吸变慢）。

不做散步（会与拖拽、多屏 DPI 打架）、不做吃东西/玩耍（需要新素材与素材授权）。

---

## 六、进度黑框设计（v2 最有价值的一块）

### 6.1 目的

把「正在干活…」变成**可读的一行**，例如：

```
悬停简略：  [16:42] ⚙ 编辑 src/pet.js            📋 步骤 2
常驻详细：  [16:42] ⚙ 编辑 src/pet.js — 正在写 45 行
            ✅ 读 metrics.js   ✅ 跑测试   ⏳ 提交
```

### 6.2 数据从哪来（`tool/call` 的 `arguments` 解析）

`tool/call` 给的是**原始 JSON 字符串**（`types.ts:341` 明确写了 "unparsed"）。
设计一个**纯函数** `describeToolCall(name, argumentsJson)`，返回
`{ icon, label, detail }`，按工具名分派：

| 工具名 | icon | label | detail 取自 |
| --- | --- | --- | --- |
| `read` / `read_file` | 📖 | 读文件 | `arguments.file_path`（取 basename） |
| `write` / `edit` | 📝 | 编辑 | `file_path` + 行数（能算出才给） |
| `grep` | 🔍 | 搜索 | `pattern` + `path` |
| `glob` | 🔎 | 找文件 | `pattern` |
| `pwsh` / `bash` | ⚙ | 执行 | 命令首词（**截断，不显示完整命令**） |
| `todo_write` | 📋 | 更新任务 | 条目数 |
| `subagent` / `task` | 🧑🤝🧑 | 派子 agent | `description` |
| `web_search` / `web_fetch` | 🌐 | 联网 | 查询词（截断） |
| （未知） | 🔧 | 工具名原样 | — |

**安全红线**（必须在实现里守住，写进测试）：

- `arguments` 里可能有**凭据、完整命令、长路径**——**只抽白名单字段**，
  其余一律不显示；未知工具**只显示工具名**，绝不 dump JSON。
- 所有字段**截断到 ~60 字符**，去掉换行。
- 解析失败（JSON 不合法）→ 退化为「工具名」，**不能抛**（`tool/call` 是高频道事件，
  抛异常会污染会话总线）。

### 6.3 展示形态

- **悬停时**在气泡里替换掉 token 三行中的两行 → 显示进度行（token 数字退到副行）。
- **常驻档**（右键菜单开关）：气泡常显，显示当前工具 + 已完成步骤勾选。
- **步骤计数**：`step/start` 给 N，但没有 M（总数）。两个选择：
  - (a) 只显示「第 N 步」（诚实、零成本）——**推荐 v2 先这么做**；
  - (b) 有 `todo_write` 时用它的清单当 M 与勾选来源（更接近 asahimoon）。
- **时间戳** `[HH:MM]`：用事件自带 `time`，格式与现有 UI 一致。

---

## 七、点击穿透（修掉「透明区域吃点击」）

### 7.1 方案（抄 hermes-agent 的实战修正）

1. **创建窗口时**：`win.setIgnoreMouseEvents(true, { forward: true })`
   —— 默认穿透，`forward: true` 保证 `mousemove` 仍流向渲染进程。
2. **渲染进程**：用现有 `pointermove`（已经在监听）判断光标是否落在**不透明像素**上：
   - 需要一个**命中掩码**。最省的做法：额外加载一张 alpha 掩码（可运行时从
     `base.png` 用 canvas 降采样到 1/4 生成，**不需要新素材**），
     取该点 alpha > 阈值 → 判定为「在宠物身上」。
   - 命中 → `api.setInteractive(true)`（主进程 `setIgnoreMouseEvents(false)`）；
     移出 → 立刻 `setInteractive(false)`。
3. **每次移动窗口后重申穿透**（`snap`、`showPet`、拖拽结束、缩放变化），
   避免留下鼠标可点的透明区。
4. **兜底**：窗口 `did-finish-load` 前若渲染进程没来得及武装，窗口保持穿透
   （即「坏页面 = 不挡路」，而不是黑洞）。

### 7.2 两个窗口都要做

桌宠 330×440 与圆钮 148×176 都有大片透明，**同一套机制**。
圆钮本身是实体图形，掩码命中率会很高，穿透收益最大。

### 7.3 风险

- **拖拽会受影响**：现在 `pointerdown` 在 document 上。穿透态下，光标不在
  宠物身上时**收不到** pointerdown —— 这正是我们要的；但在宠物身上时必须有
  指针事件，否则拖不动。所以「武装」的时机必须在 `pointermove` 里足够快，
  否则会有**第一帧拖不动的黏滞感**。
  **缓解**：把命中区域**外扩 ~8px**（比可见边缘宽松），宁可多接受一点点误触。
- **性能**：掩码查询是 O(1) 的数组索引，`pointermove` 里做没问题。

---

## 八、接口设计（Host ↔ 浮窗）

### 8.1 控制端口：从「一个布尔」扩成「一行 JSON」

现状是 `busy:0|1` 这种动词式命令，v2 需要携带**结构化**的进度信息。
设计（**向后兼容**：老命令继续可用）：

```
pet event {"kind":"state","state":"working","tool":{"icon":"📝","label":"编辑 src/pet.js"},"step":2,"turn":7}
```

- 走既有的 52118 端口，一行一条，`\n` 结尾（沿用现在的帧格式）。
- **仍然是「Host 推、浮窗收」**，不改成轮询。
- **心跳**：沿用 15 秒重报当前完整快照（不只是 busy），这样浮窗中途启动也能补齐
  工具名与步骤。
- **TTL**：45 秒不变；过期 → 退化为 `idle`/`working` 两态（见 5.3）。

> 备选：asahimoon 用独立 HTTP POST 端口（43991）。**不采用**——我们已经有 52118
> 这条已验证的通道，再开一条只是多一个要守护的东西。

### 8.2 Host 侧新增模块

```
lib/
  index.js          现有：控制器 + 控制路由 + busy relay（保留）
  pet-state.js      新：会话事件 → 桌宠状态快照（纯逻辑，可单测）
  tool-label.js     新：describeToolCall(name, argsJson) → {icon,label,detail}（纯函数）
```

两个新文件都是**纯函数/纯状态**，不碰 Electron、不碰 socket → 可直接单测
（这是本仓库现有测试风格：`lib/index.js` 的纯函数都被导出来测）。

### 8.3 渲染进程

```
renderer/
  pet.js            改：FRAMES 扩到 6；faceFor() → stateFor()；进度行渲染
  pet.css           改：新增 [data-state=sleep|celebrate|error|thinking] 的动画
  mask.js           新：由 art 生成 alpha 命中掩码（约 40 行）
```

---

## 九、配置项（加在现有 Schemastery Config 里）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `idleSleepMs` | `180000` | 多久无回合进入 `sleep`（0 = 不睡） |
| `celebrateMs` | `3000` | 庆祝/报错的持续时长 |
| `showProgress` | `"hover"` | `hover` / `always` / `off` —— 进度黑框展示档位 |
| `clickThrough` | `true` | 透明区域点击穿透（关掉可回到现在的行为） |

**热生效**：现有配置只在插件加载时读。**v2 不做热配置**（asahimoon 有，但那需要
一条配置 → 浮窗的推送链路；先按现状「改完重启桌面端」，避免范围膨胀）。

---

## 十、测试与验收

### 10.1 单测（`tests/`，沿用 vitest）

- `describeToolCall`：每种工具名 → 期望的 icon/label；**未知工具只给名字**；
  **非法 JSON 不抛**；长参数被截断；**敏感字段不外泄**（构造一个含
  `api_key` 的 arguments，断言输出里没有它）。
- 状态机（`pet-state.js`）：`turn/start` → `thinking`；首个 `tool/call` → `working`；
  `turn/end{completed}` → `celebrate` → 计时后 `idle`；`{aborted}` → **不庆祝**；
  `agent/error` → `error`；TTL 过期 → 降级两态；多 agent 时 busy 判据。
- 现有 22 个测试**必须全绿**（尤其 busy relay 那 6 个不能被破坏）。

### 10.2 实机验证（沿用 0.3.1 那套，脚本已在 `_shots/pet-live-check.ps1`）

透明窗口 **不能用 `CopyFromScreen`**（只能拍到窗口后面的东西），必须
`PrintWindow(PW_RENDERFULLCONTENT)` —— 0.3.1 已验证过这条路。

对每个状态各截一张：`idle` / `thinking` / `working` / `celebrate` / `error` / `sleep`，
人工看图确认表情正确（这正是 0.3.1 抓出「气泡还写着正在干活」的方式）。

### 10.3 点击穿透的验收（**必须真点**，不能只看代码）

1. 把桌宠放在桌面某处，点它**周围 20px 的透明区** → 事件应落到下层窗口
   （用一个记事本/浏览器验证焦点没有跑到桌宠上）。
2. 点**宠物身上** → 拖拽正常、单击挤压动画正常。
3. 把圆钮放在副屏，重复 1、2（HANDOFF 说副屏是重灾区）。
4. 杀掉渲染进程（模拟白屏）→ 透明区**不应**吃点击。

### 10.4 回归红线

- 圆钮的唤回、缩放、贴角、右键菜单**全部**仍可用。
- `show`/`hide`/`toggle` 控制路由行为不变。
- 0.3.1 的「Host 掉线后退回磁盘兜底」仍然可用（拔掉插件验证）。

---

## 十一、分期与工作量

| 期 | 内容 | 依赖 | 估量 |
| --- | --- | --- | --- |
| **P0** | 6 态状态机（含 `idle`/`sleep`/`celebrate`/`error`）+ 测试 | 无（素材现成） | 中 |
| **P0** | 点击穿透（两窗口 + 掩码 + 重申时机） | 无 | 中 |
| **P1** | 进度黑框（`describeToolCall` + 控制端口 JSON 帧 + 气泡改造） | P0 的状态机 | 中大 |
| **P1** | `subagent` 计数 → `working` 的子变体；`tool/result.error` 计数 | P1 | 小 |
| **P2** | 多角色 sprite 包 / 零食成长 / 冒烟测试 / 跨平台打包 | 需素材授权、CI | 大 |
| **P2** | 独立 exe 形态（asahimoon 的「形态二」） | 打包链路 | 大 |

**建议**：P0 一起做（状态机 + 穿透），它们是「像活的」与「不碍事」两条底线；
P1 的进度黑框单独一期，因为它要动控制端口协议，值得单独验证。

---

## 十二、待你拍板的问题

1. **素材**：`idle`/`busy`/`alert` 三张未使用的图，**是否本来就是为状态机准备的**？
   我想先按「是」用（不新画素材）；如果你希望 v2 有新表情，需要先定素材来源与授权。
2. **`sleep` 的表现**：用 `idle` + CSS 表达够不够？还是要专门一张睡脸？
3. **进度黑框默认档位**：默认「悬停才显示」（安静）还是「常驻」（像 asahimoon）？
4. **点击穿透的取舍**：穿透后**单击宠物**仍然挤压，但**在透明区拖拽**会失效
   （光标不在宠物上就没有 pointerdown）。你接受吗？还是要保留一条「穿透开关」随时关掉？
5. **要不要独立 exe 形态**（不装插件也能跑）？这是 asahimoon 的差异点，但工作量不小。

---

## 十三、实现时发现的事实（推翻了两条设计假设）

写 P0 的过程中有两件事只有真跑才会暴露。它们比本文的设计部分更重要：**任何基于
文件名或 Electron 文档的推断，都要用一次真实验证兜住。**

### 13.1 素材不是六张表情，是「一张全身 + 一堆方形头像」

原计划「用上闲置的 `idle`/`busy`/`alert`」是错的。实测：

| 文件 | 尺寸 | 长宽比 | 不透明占比 | 实质 |
| --- | --- | --- | --- | --- |
| `base` / `chew` / `hover` | ~397×420 | 0.95 | 72% | **全身立绘**（同一角色的三种表情） |
| `idle` / `busy` / `alert` | 256×256 | 1.00 | 77% | **方形头像裁切**，和 `mini` 同一族 |
| `mini`（页面按钮用） | 96×96 | 1.00 | 78% | 头像 |

后果：把 `alert` 画进桌宠槽位，屏幕上会变成一个**浮空的大头**；而 `alert` 还带一条
「Deepseek」字样的横幅，`idle`/`busy` 则是同一张脸的近似裁切——**它们不是表情，是头像**。

处理：`FACE_OF` 只映射全身三张（`base`/`chew`/`hover`），六态之间的区分交给
CSS 动画 + 气泡文案；`renderer/pet.js` 的 `FRAMES` 白名单也只剩这三张，**从结构上**
让后来者没法按文件名误用。测试里锁死这条：任何态映射到 `idle`/`busy`/`alert` 都会红。

> 顺带：`base.png` 本身是 **72% 不透明的胸像**，不是透明底立绘。这直接决定了 13.2。

### 13.2 点击穿透：`forward: true` 在这台机器上不送事件，而且遮挡面比预想小
设计抄的是 hermes-agent 的实战修正：`setIgnoreMouseEvents(true, { forward: true })`
启动，渲染层收到 `mousemove` 再「武装」自己。**实测这条链路在这里断了：**

同一段光标扫过窗口，用渲染层自己的计数：

| 状态 | 渲染层收到的 `pointermove` |
| --- | --- |
| 穿透开（`forward: true`） | **0** |
| 穿透关 | 8 |

也就是说窗口一旦忽略鼠标，就再也收不到指针事件，**永远没机会把自己武装回来**——
`forward: true` 救不了这个（至少 Windows + 本机 Electron 版本如此）。

改成：**主进程 60ms 轮询 `screen.getCursorScreenPoint()`**，把窗口相对坐标通过 IPC
交给渲染层做命中测试，渲染层自己翻 `setIgnoreMouseEvents`。渲染层拥有素材，所以命中
测试归它；主进程拥有窗口标志，所以开关归它。光标离开窗口时主进程直接解除武装（这条
也必须按窗口分别记账，共用一个变量会让桌宠的状态覆盖圆钮的）。

还有两个只有真点才会发现的坑：

1. **`pointerenter`/`pointerleave` 不能和逐像素命中测试共存**：它们按整个*窗口矩形*
   武装，而命中测试按角色像素判定，结果从角落进入窗口会被武装、之后没人再解除它——
   正好制造出这个功能要消灭的「隐形点击黑洞」。两个渲染层里的这对监听都删了。
2. **`WindowFromPoint` 不是判断穿透的正确 oracle**：它对分层（layered）穿透窗口仍会
   报出该窗口。必须先移动光标再问，或者干脆**发一次真实点击**看焦点落到谁身上。
   我一开始用它做验收，得到了「穿透失败」的假结论。

**适用面：比设计时设想的小。** 桌宠窗口 330×440 里，`base.png` 是 72% 不透明的胸像，
几乎没有「空白区」可回收；真正受益的是**圆钮**（148×176 的矩形里一个圆盘，四角是实实在在
的空白）。验收因此放在圆钮上做：

| 检查 | 结果 |
| --- | --- |
| 圆盘中心可交互 | ✅ 命中 |
| 圆钮四角真实点击 | ✅ 落到下层（不是圆钮） |
| 渲染层判定序列 | ✅ `off → ON → off` |

---

## 附：本文引用的外部材料

- [`@asahimoon/dsh-desktop-pet`](https://www.npmjs.com/package/@asahimoon/dsh-desktop-pet)（npm README，0.2.0）
- [`clawd-pet`](https://www.npmjs.com/package/clawd-pet)（npm README，1.2.0）
- [`hermes-agent` commit 446a843](https://github.com/NousResearch/hermes-agent/commit/446a8430486972b95a8749396277fd84b79851b2)（透明窗口点击穿透修正）
- [Electron: Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)
- [vscode-pets 的宠物行为与状态](https://deepwiki.com/tonybaloney/vscode-pets/3.3-pet-behaviors-and-states)
- [PixelPal](https://github.com/chrislitality-svg/PixelPal) / [zhizhiji-shimeji](https://github.com/YuZhu412/zhizhiji-shimeji)（行为树/养成路线，本文不采用）
- DSH 源码：`packages/core/session/src/types.ts`、`packages/core/agent/src/runtime-types.ts`、
  `packages/subagent/subagent/src/index.ts`、`packages/session/session-title/src/index.ts`
