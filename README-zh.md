# dsh-desktop-pet

DeepSeek Harness 的桌面桌宠：一个置顶浮窗，工作时实时显示 token 用量与账户余额。隐藏后由一枚小圆钮代替它待在桌面上——圆钮既是唤回的按钮，也是上下文占用与余额的常驻读数。harness 页面里还有一组控制按钮，桌宠被退出后从那里就能重新拉起来。

[English](README.md) · [Español](README-es.md) · [हिन्दी](README-hi.md) · [Português](README-pt.md)

## Compatibility

| 面向 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.2.0-rc.2`（desktop profile） |
| Node | `^22.19.0 || >=24.0.0` |
| 平台 | Windows（浮窗宿主是 Electron） |

## What it does

以 Host 插件的形式**掌管浮窗进程的生命周期**。

插件接口本身开不出浮窗：Client 模块（`dsh.client`）跑在 harness 页面里，Host 插件跑在 Node 里、拿不到 Electron 的窗口 API。所以浮窗仍然是独立进程，而这个插件负责管理它——激活时拉起、卸载时终止、崩溃后重启。

这个进程管着**两个窗口，同一时刻只显示其中一个**：

| 窗口 | 何时在屏幕上 |
|---|---|
| 桌宠本体 | 平时 |
| 小圆钮（standby medallion） | 桌宠被隐藏时 |

圆钮是必需的，不是装饰：桌面端自身**没有**「显示桌宠」开关，所以隐藏曾经是一扇单向门——`visible: false` 会被记住，而没有任何东西能把它改回来。圆钮补上了这个缺口，顺便把两个最该盯着看的数字顶在脸上：**上下文占用百分比**（脸外那圈进度环，同时以数字显示）和**账户余额**。

同一个坑还有第二个入口：桌宠右键菜单里的「退出桌宠」是**正常退出**（exit code 0），插件刻意不重启它——那是在说「我不玩了」。以前这意味着在重启整个桌面端之前，桌宠再也回不来了。所以浮窗进程之外还有一层控制面：

```
harness 页面 ──HTTP──> Host 插件 ──TCP 127.0.0.1:52118──> 浮窗进程
```

Host 插件在 Web 服务上注册一条 JSON 路由 `/dsh-desktop-pet`（`action` 查询参数：`status` / `show` / `hide` / `toggle` / `scale` / `start` / `stop` / `restart` / `icon`）。**`show` 和 `toggle` 会在浮窗没运行时把它拉起来**，所以「退出桌宠」不再是终点。

浮窗自己读数据，不向 harness 要任何东西：

| 显示 | 来源 |
|---|---|
| token 用量 | 引擎自己记录的 `tokenUsage` 投影行，位于 `<DSH 主目录>/storages/session_projcache/sessions/*.json` |
| 账户余额 | 官方 `GET https://api.deepseek.com/user/balance`，密钥取自 `~/.dsh/.credentials.yaml`，只在浮窗进程内使用 |

因为注册走的是单个 `ctx.effect()`，**在 harness 里关掉插件就等于关掉桌宠**，热重载也不会留下孤儿进程。

## Using it

| 操作 | 结果 |
|---|---|
| 拖动 | 移动桌宠。松手后位置会被记住，**点击不会**把它弹回屏幕角落 |
| 单击 | 拍一下：播放一次果冻式挤压动画，仅此而已 |
| 双击 | 打开 / 唤到最前 DeepSeek Harness 主窗口 |
| 右键 | 菜单：打开 Harness、刷新用量与余额、**桌宠大小**（75% / 100% / 125% / 150%）、隐藏桌宠、显示在右下角、退出桌宠 |
| 右键 → 隐藏桌宠 | 桌宠消失，圆钮出现在它刚才站的位置 |
| 单击圆钮 | 桌宠回来，圆钮消失 |
| 拖动圆钮 | 换地方；位置同样会被记住 |
| 右键圆钮 | 菜单：唤回桌宠、打开 Harness、刷新、桌宠大小、退出桌宠 |

圆钮第一次出现时会顶着一个小气泡说「点我唤回桌宠」，五秒后自己消失——那是它唯一一次自我介绍。

**页面里的控制**（`dsh.client` 模块，见 `client.js`）：

| 位置 | 是什么 |
|---|---|
| 输入框左侧的小圆钮 | 桌宠的脸。单击 = 显示 / 隐藏；桌宠被退出时单击 = 把它重新拉起来。运行中脸上带个绿点，未运行则变淡 |
| 设置页 → 桌宠 | 完整面板：运行状态与 pid、显示 / 隐藏 / 重新启动进程 / 退出进程、大小 75% / 100% / 125% / 150% |

两个入口都走上面那条 HTTP 路由，所以它们看到的状态和浮窗本身永远是同一个。

桌宠大小是**整窗等比缩放**（用 `setZoomFactor`，所以文字、描边、命中区域一起缩放，布局不会错位），并以底边中点为锚点，脚不会跳。缩放是在菜单、页面面板里即时生效并记住的；插件配置里的 `scale` 只是首次启动的初值。

设置保存在 `<DSH 主目录>/desktop/pet-window.json`：位置、可见性、缩放比例和圆钮的位置。

## Install

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-desktop-pet-0.3.1.tgz
```

⚠️ 用**目录路径**安装不会注册 bundle——必须是 tarball（或 npm / git 源）。装完要重启桌面端：bundle 插件和 `dsh.client` 客户端模块都在启动时扫描并加载。

同名版本的 tarball 内容变了 pnpm **不会**重装（`file:` 依赖按锁文件里的 integrity 判定为「已是最新」）。改了代码要重装的话，先 `dsh plugin --profile desktop remove dsh-desktop-pet` 再 `add`。

浮窗宿主是 `electron`，作为普通依赖安装。pnpm 的构建脚本审批门必须放行它——harness 会把这个决定留在 profile 的 `pnpm-workspace.yaml` 里：

```yaml
allowBuilds:
  electron: true
```

如果 profile 里的 electron 因为 pnpm 的 side-effects 缓存问题装残了（缺 `electron.exe`），把一份独立运行时放到 `<DSH 主目录>/desktop-pet-runtime` 即可：插件优先用它，profile 里的那份坏了也不影响。

## Configuration

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 插件激活时是否拉起浮窗 |
| `command` | string | `''` | 承载浮窗的可执行文件。留空则用 `<DSH 主目录>/desktop-pet-runtime` 里的 electron，其次在包目录附近逐个目录查找 |
| `args` | string[] | `[]` | 传给 `command` 的参数。留空则运行随包分发的浮窗入口 |
| `cwd` | string | `''` | 浮窗进程的工作目录。留空用 `<DSH 主目录>/desktop-pet`——**刻意不取用户主目录**（那里的 `NTUSER.DAT` 锁会让文件监视器挂掉），也不放插件包内（运行中的浮窗会锁住包目录，导致 `ERR_PNPM_EPERM` 让插件永远无法更新） |
| `restartDelayMs` | number | `2000` | 异常退出后重新拉起的延迟。`0` 表示不再重启 |
| `maxRestarts` | number | `5` | 连续重启次数上限，超过后停止并记录一次错误 |
| `scale` | number | `1` | 桌宠**初始**缩放比例，0.5–2（常用 `0.75` / `1` / `1.25` / `1.5`）。之后在菜单或页面面板里改的值会记住并覆盖它 |
| `controlPanel` | boolean | `true` | 是否注册页面控制接口 `/dsh-desktop-pet`。关掉后浮窗照常工作，只是页面里没有控制按钮 |

配置由 `lib/index.js` 的 Schemastery `Config` schema 校验；没有硬编码的可调项。非法值在加载期响亮失败，而不是静默取默认值。

正常退出（`code 0`）被视为用户主动关闭桌宠，**不会被自动重启**；只有异常退出才计入 `maxRestarts`。页面上的「显示桌宠」是它回来的路——那是一次显式启动，会清零重启计数。

浮窗进程还在 `127.0.0.1:52118` 上开了一个控制端口（`status` / `show` / `hide` / `toggle` / `snap` / `scale:<比例>` / `quit`），一行一条命令。它顺便充当单实例锁——桌宠在每次桌面端启动时都会被拉起，没有锁就会越堆越多。Host 插件是它唯一的客户端。

## Development

```sh
npm install --ignore-scripts   # 迭代时跳过 electron 二进制的大下载
npm test
```

`tests/lifecycle.test.js` 用桩上下文驱动真实插件：断言 effect 被注册（disabled 时不注册）、激活会拉起子进程而 dispose 会杀掉它、崩溃会重启而正常退出不会、运行时缺失会被记录而不是吞掉、控制路由挂在 Web 服务上并且缺席时插件照常工作。

`client.js` 是**单文件自包含**的客户端 bundle（页面里只允许 `require('react')`，入口是 `window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名），没有构建步骤：改完 `pnpm pack` 重装即可。

## License

[Apache License 2.0](LICENSE) © 2026 dsh-desktop-pet contributors.
