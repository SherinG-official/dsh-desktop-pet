# dsh-desktop-pet

Mascota de escritorio para DeepSeek Harness: una ventana flotante siempre visible que muestra el uso de tokens y el saldo en vivo. Si la ocultas, un pequeno medallon ocupa su lugar: es a la vez el boton para recuperarla y un indicador permanente de la presion de contexto y del saldo.

[English](README.md) · [中文](README-zh.md) · [हिन्दी](README-hi.md) · [Português](README-pt.md)

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.0-rc.2` (desktop profile) |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows (the window host is Electron) |

## What it does

Gestiona el ciclo de vida de la ventana de la mascota como plugin de Host.

Una ventana flotante no puede crearse desde la superficie de plugins: un modulo Client se ejecuta en la pagina del harness y un plugin de Host se ejecuta en Node sin APIs de Electron. La ventana sigue siendo un proceso aparte y este plugin la administra: la inicia al activarse, la detiene al descargarse y la reinicia tras un fallo.

La ventana lee sus propios datos: uso de tokens desde las filas de proyeccion `tokenUsage` del motor, y saldo desde `GET https://api.deepseek.com/user/balance`.

Ese proceso tiene **dos ventanas y solo una visible a la vez**: la mascota, y el medallon que la sustituye mientras esta oculta. El medallon no es decorativo: el shell de escritorio no tiene ningun interruptor para volver a mostrar la mascota, asi que ocultarla era una puerta de un solo sentido. El medallon lo arregla y ademas muestra el anillo de presion de contexto y el saldo.

La misma trampa tenia otra entrada: salir desde el menu de la mascota es una **salida limpia** (code 0) que el plugin, a proposito, no reinicia. Antes eso dejaba la mascota inalcanzable hasta reiniciar toda la aplicacion. Por eso hay un plano de control fuera del proceso de la ventana: el plugin de Host registra una ruta JSON (`/dsh-desktop-pet`) en el servidor web, y `show` o `toggle` **arrancan la ventana cuando no hay ninguna**.

## Using it

| Gesto | Resultado |
|---|---|
| Arrastrar | Mueve la mascota. La posicion se recuerda; un clic **no** la devuelve a la esquina |
| Clic | Una sacudida y nada mas |
| Doble clic | Abre la ventana de DeepSeek Harness |
| Clic derecho | Menu: abrir Harness, refrescar, **tamano** (75% / 100% / 125% / 150%), ocultar, mover a la esquina, salir |
| Clic en el medallon | La mascota vuelve y el medallon desaparece |
| Arrastrar el medallon | Lo mueve; la posicion tambien se recuerda |
| Boton redondo junto al cuadro de texto | La cara de la mascota: mostrar / ocultar, y arrancarla si no esta corriendo |
| Ajustes → 桌宠 | Panel completo: estado, pid, mostrar / ocultar / reiniciar / salir, y tamano |

El tamano es un escalado de toda la ventana (`setZoomFactor`), anclado en el centro inferior para que los pies no salten. El estado vive en `<DSH home>/desktop/pet-window.json`.

## Install

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-desktop-pet-0.3.1.tgz
```

Instalar desde una **ruta de directorio** no registra el bundle: debe ser un tarball (o npm/git). Reinicia la aplicacion despues; tanto el bundle como el modulo `dsh.client` se cargan al arrancar. El anfitrion de la ventana es `electron`, instalado como dependencia normal, y la puerta de compilacion de pnpm debe permitirlo en `pnpm-workspace.yaml` (`allowBuilds: electron: true`).

pnpm **no** reinstala un tarball cuya version no cambia aunque su contenido cambie: usa la integridad del lockfile. Para recoger codigo nuevo, quita el plugin y vuelve a anadirlo.

## Configuration

| Clave | Tipo | Por defecto | Descripcion |
|---|---|---|---|
| `enabled` | boolean | `true` | Iniciar la ventana al activar el plugin |
| `command` | string | `''` | Ejecutable anfitrion; vacio prefiere `<DSH home>/desktop-pet-runtime` |
| `args` | string[] | `[]` | Argumentos para `command` |
| `cwd` | string | `''` | Directorio de trabajo; vacio usa `<DSH home>/desktop-pet`, nunca el perfil de usuario ni el directorio del plugin |
| `restartDelayMs` | number | `2000` | Retardo antes de reiniciar tras una salida anormal |
| `maxRestarts` | number | `5` | Reinicios consecutivos permitidos |
| `scale` | number | `1` | Tamano **inicial** de la mascota, 0.5–2 |
| `controlPanel` | boolean | `true` | Registrar la ruta de control `/dsh-desktop-pet` en el servidor web |

La configuracion la valida el esquema Schemastery; ningun valor ajustable esta fijado en el codigo. Una salida limpia (`code 0`) se considera un cierre deliberado y **no** se reinicia sola; el boton 「显示桌宠」 de la pagina es el camino de vuelta.

El proceso escucha ademas en `127.0.0.1:52118` (`status`, `show`, `hide`, `toggle`, `snap`, `scale:<n>`, `quit`), lo que a la vez sirve de cerrojo de instancia unica.

## Development

```sh
npm install --ignore-scripts
npm test
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-desktop-pet contributors.
