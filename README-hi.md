# dsh-desktop-pet

DeepSeek Harness ke liye desktop pet: ek floating window jo kaam ke dauraan token usage aur account balance live dikhati hai. Chhupa dene par uski jagah ek chhota medallion aa jata hai — wahi wapas laane ka button hai aur wahi context pressure aur balance ka standing readout.

[English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md)

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.0-rc.2` (desktop profile) |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows (the window host is Electron) |

## What it does

Host plugin ke roop mein pet window ke lifecycle ko sambhalta hai.

Plugin surface se floating window nahi banayi ja sakti: Client module harness page me chalta hai aur Host plugin Node me bina Electron APIs ke. Isliye window apna alag process rehti hai aur yeh plugin use chalata hai — activate par shuru, unload par band, crash ke baad restart.

Window apna data khud padhti hai: token usage engine ki `tokenUsage` projection rows se, aur balance `GET https://api.deepseek.com/user/balance` se.

Us process ke paas **do windows hain, ek samay me sirf ek dikhti hai**: mascot, aur chhupne par uski jagah lene wala medallion. Medallion sirf saja nahi hai — desktop shell me mascot ko dobara dikhane ka koi switch nahi hai, isliye chhupana ek one-way door tha. Medallion usi ko band karta hai aur saath hi context pressure ring aur balance dikhata hai.

Usi jaal ka doosra darwaza: mascot ke menu se 「退出桌宠」 ek **clean exit** (code 0) hai jise plugin jaan-boojh kar restart nahi karta. Pehle iska matlab tha ki poori app restart karne tak mascot wapas nahi aata tha. Isliye window process ke bahar ek control plane hai: Host plugin web server par `/dsh-desktop-pet` JSON route register karta hai, aur `show` ya `toggle` **koi window na ho to nayi khada kar deta hai**.

## Using it

| Gesture | Result |
|---|---|
| Drag | Mascot hilta hai; position yaad rehti hai, click use corner me **nahi** phenkta |
| Click | Ek squash animation, bas |
| Double-click | DeepSeek Harness window khulti hai |
| Right-click | Menu: Harness kholein, refresh, **size** (75% / 100% / 125% / 150%), chhupayein, corner me le jayein, band karein |
| Medallion par click | Mascot wapas, medallion gayab |
| Medallion drag | Uska position bhi yaad rehta hai |
| Input box ke paas wala gol button | Mascot ka chehra: dikhayein / chhupayein, aur band ho to shuru karein |
| Settings → 桌宠 | Poora panel: state, pid, dikhayein / chhupayein / restart / band, aur size |

Size poore window ka scale hai (`setZoomFactor`), neeche-ke-chaukath par anchored. State `<DSH home>/desktop/pet-window.json` me rehti hai.

## Install

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-desktop-pet-0.3.1.tgz
```

**Directory path** se install karne par bundle register nahi hota — tarball (ya npm/git) chahiye. Uske baad app restart karein; bundle aur `dsh.client` module dono startup par load hote hain. Window host `electron` hai, normal dependency ke roop me, aur pnpm ka build gate ise `pnpm-workspace.yaml` me allow karna hoga (`allowBuilds: electron: true`).

pnpm ek hi version ke tarball ko dobara install **nahi** karta, chahe uska content badal gaya ho — lockfile ki integrity hi maayne rakhti hai. Nayi code ke liye plugin ko pehle remove karein, phir add.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Plugin activate hone par window shuru karein |
| `command` | string | `''` | Host executable; khaali chhodne par `<DSH home>/desktop-pet-runtime` ko tarjeeh |
| `args` | string[] | `[]` | `command` ke arguments |
| `cwd` | string | `''` | Working directory; khaali chhodne par `<DSH home>/desktop-pet`, user profile ya plugin directory kabhi nahi |
| `restartDelayMs` | number | `2000` | Abnormal exit ke baad restart se pehle deri |
| `maxRestarts` | number | `5` | Lagataar restart ki seema |
| `scale` | number | `1` | Mascot ka **shuruaati** size, 0.5–2 |
| `controlPanel` | boolean | `true` | Web server par `/dsh-desktop-pet` control route register karein |

Config Schemastery schema se validate hoti hai; koi tunable hardcoded nahi hai. Clean exit (`code 0`) ko user ka jaan-boojh kar band karna maana jata hai aur use apne aap restart **nahi** kiya jata; page ka 「显示桌宠」 button wapas laane ka raasta hai.

Process `127.0.0.1:52118` par bhi sunta hai (`status`, `show`, `hide`, `toggle`, `snap`, `scale:<n>`, `quit`), jo single-instance lock ka bhi kaam karta hai.

## Development

```sh
npm install --ignore-scripts
npm test
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-desktop-pet contributors.
