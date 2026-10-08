# dsh-desktop-pet

A desktop pet for DeepSeek Harness: a floating, always-on-top window that shows live token usage and account balance while you work. Hide it and a small medallion takes its place — the medallion is both the way back and a standing readout of context pressure and balance. The harness page carries a set of controls too, which is how the pet comes back after being quit.

[中文](README-zh.md) · [Español](README-es.md) · [हिन्दी](README-hi.md) · [Português](README-pt.md)

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.0-rc.2` (desktop profile) |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows (the window host is Electron) |

## What it does

Owns the lifecycle of the pet window as a Host plugin.

A floating window cannot be made from inside the plugin surface: a Client module (`dsh.client`) runs in the harness page, and a Host plugin runs in Node with no Electron APIs. So the window stays its own process and this plugin is what manages it — start on activate, stop on unload, restart after a crash.

That process owns **two windows, exactly one of which is on screen**:

| Window | On screen when |
|---|---|
| the mascot | normally |
| the standby medallion | the pet is hidden |

The medallion is not decoration, it is the fix for a one-way door: the desktop shell has **no** "show the pet" switch, so hiding used to be permanent — `visible: false` was remembered and nothing could undo it. The medallion closes that gap and wears the two numbers worth watching: **context pressure** (the ring around the face, and the figure in the tag) and **account balance**.

The same trap had a second entrance: "退出桌宠" in the pet's own menu is a **clean exit** (code 0), which the plugin deliberately does not restart — it means "I am done with this thing". That used to leave the pet unreachable until the whole desktop app was restarted. So there is a control plane outside the window process:

```
harness page ──HTTP──> Host plugin ──TCP 127.0.0.1:52118──> window process
```

The Host plugin registers one JSON route on the web server, `/dsh-desktop-pet` (query parameter `action`: `status` / `show` / `hide` / `toggle` / `scale` / `start` / `stop` / `restart` / `icon`). **`show` and `toggle` start the window when there is none**, so quitting the pet is no longer the end of the road.

The window itself reads its own data and needs nothing from the harness:

| Shown | Source |
|---|---|
| token usage | the engine's own `tokenUsage` projection rows under `<DSH home>/storages/session_projcache/sessions/*.json` |
| balance | the official `GET https://api.deepseek.com/user/balance`, key read from `~/.dsh/.credentials.yaml` in the window process only |

Because the plugin registers through a single `ctx.effect()`, toggling it off in the harness actually stops the pet, and hot-reloading the plugin leaves no orphan process behind.

## Using it

| Gesture | What happens |
|---|---|
| Drag | Moves the pet. The position is remembered; a click does **not** throw it back to a corner |
| Click | Pats it — one squash-and-stretch, nothing else |
| Double-click | Opens / raises the DeepSeek Harness window |
| Right-click | Menu: open Harness, refresh usage and balance, **pet size** (75% / 100% / 125% / 150%), hide the pet, snap to the bottom-right corner, quit the pet |
| Right-click → hide | The pet disappears and the medallion appears where it was standing |
| Click the medallion | The pet returns and the medallion disappears |
| Drag the medallion | Moves it; the spot is remembered too |
| Right-click the medallion | Menu: call the pet back, open Harness, refresh, pet size, quit |

The first time it appears the medallion says "点我唤回桌宠" in a little bubble for five seconds, and never introduces itself again.

**Controls in the page** (the `dsh.client` module, `client.js`):

| Where | What |
|---|---|
| the small round button left of the composer | the pet's face. Click = show / hide; click while the pet is not running = start it. A green dot means it is up; it dims when it is not |
| Settings → 桌宠 | the full panel: run state and pid, show / hide / restart process / quit process, and size 75% / 100% / 125% / 150% |

Both go through the HTTP route above, so what they show and what the window does can never disagree.

Pet size is a **whole-window scale** (`setZoomFactor`, so art, text, borders and hit testing all scale together and no layout offset can drift), anchored at the bottom centre so the pet's feet stay put. Choosing a size from the menu or the panel takes effect immediately and is remembered; the `scale` config key only sets the initial value.

State lives in `<DSH home>/desktop/pet-window.json`: position, visibility, scale, and the medallion's position.

## Install

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-desktop-pet-0.3.1.tgz
```

Adding a **directory** path does not register the bundle — it must be a tarball (or an npm/git source). Restart the app afterwards: both the bundle plugin and the `dsh.client` module are scanned and loaded at start-up.

pnpm will **not** reinstall a tarball whose version is unchanged, even if its contents changed: the `file:` dependency is considered up to date from the integrity recorded in the lockfile. To pick up new code, `dsh plugin --profile desktop remove dsh-desktop-pet` first, then add it again.

The window host is `electron`, installed as a normal dependency. pnpm's build-script gate must allow it — the harness leaves the decision in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  electron: true
```

If pnpm's side-effects cache leaves that copy incomplete (no `electron.exe`), drop a standalone runtime into `<DSH home>/desktop-pet-runtime` instead: the plugin prefers it, so the profile's copy can stay broken without taking the pet down.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Start the pet window when the plugin activates |
| `command` | string | `''` | Executable that hosts the window. Empty prefers the electron under `<DSH home>/desktop-pet-runtime`, then walks the directories around the package |
| `args` | string[] | `[]` | Arguments for `command`. Empty runs the packaged window entry |
| `cwd` | string | `''` | Working directory for the window process. Empty uses `<DSH home>/desktop-pet` — deliberately never the user profile (its `NTUSER.DAT` lock takes file watchers down) and never inside the package (a running window holds its own directory, and pnpm then fails with `ERR_PNPM_EPERM`, permanently blocking updates) |
| `restartDelayMs` | number | `2000` | Delay before restarting after an abnormal exit. `0` disables restarts |
| `maxRestarts` | number | `5` | Consecutive restarts allowed before giving up and logging an error |
| `scale` | number | `1` | **Initial** size of the pet, 0.5–2 (typically `0.75` / `1` / `1.25` / `1.5`). A size chosen from the menu or the panel is remembered and overrides it |
| `controlPanel` | boolean | `true` | Whether to register the page control route `/dsh-desktop-pet`. Turned off, the window still works — the page just has no buttons |

Configuration is validated by the Schemastery `Config` schema in `lib/index.js`; no tunable is hardcoded. An invalid value fails loudly at load instead of silently defaulting.

A clean exit (`code 0`) is treated as the user closing the pet on purpose and is **not** restarted automatically; only abnormal exits count against `maxRestarts`. 「显示桌宠」 in the page is the way back — it is a deliberate start, and it resets the restart counter.

The window process also listens on `127.0.0.1:52118` for one-line commands (`status`, `show`, `hide`, `toggle`, `snap`, `scale:<n>`, `quit`). That listener doubles as the single-instance lock: the pet is spawned on every app start, so without it they would pile up. The Host plugin is its only client.

## Development

```sh
npm install --ignore-scripts   # skip the electron binary download while iterating
npm test
```

`tests/lifecycle.test.js` drives the real plugin through a stub context: it asserts the effect is registered (and not registered when disabled), that activation starts a child and dispose kills it, that a crash restarts while a clean exit does not, that a missing runtime is reported rather than swallowed, and that the control route attaches to a web server while the plugin still works without one.

`client.js` is a **single self-contained** client bundle — only `react` may be required from it, and the entry must be `window.__ModuleLoader__.load({ id, factory })` with `id` equal to the package name. There is no build step: edit it, `pnpm pack`, reinstall.

## License

[Apache License 2.0](LICENSE) © 2026 dsh-desktop-pet contributors.
