# dsh-desktop-pet

Mascote de desktop para o DeepSeek Harness: uma janela flutuante sempre visivel que mostra o uso de tokens e o saldo ao vivo. Se voce esconder a mascote, um pequeno medalhao ocupa o lugar dela: e ao mesmo tempo o botao para traze-la de volta e um leitor fixo da pressao de contexto e do saldo.

[English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [हिन्दी](README-hi.md)

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.0-rc.2` (desktop profile) |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows (the window host is Electron) |

## What it does

Gerencia o ciclo de vida da janela da mascote como plugin de Host.

Uma janela flutuante nao pode ser criada pela superficie de plugins: um modulo Client roda na pagina do harness e um plugin de Host roda em Node sem APIs do Electron. A janela continua sendo um processo separado e este plugin a administra: inicia ao ativar, encerra ao descarregar e reinicia apos uma falha.

A janela le os proprios dados: uso de tokens das linhas de projecao `tokenUsage` do motor, e saldo de `GET https://api.deepseek.com/user/balance`.

Esse processo tem **duas janelas e apenas uma visivel por vez**: a mascote e o medalhao que a substitui enquanto ela esta oculta. O medalhao nao e enfeite: o shell do desktop nao tem nenhum interruptor para mostrar a mascote de novo, entao esconder era uma porta de mao unica. O medalhao resolve isso e ainda mostra o anel de pressao de contexto e o saldo.

A mesma armadilha tinha uma segunda entrada: sair pelo menu da mascote e uma **saida limpa** (code 0) que o plugin, de proposito, nao reinicia. Antes isso deixava a mascote inalcancavel ate reiniciar o aplicativo inteiro. Por isso existe um plano de controle fora do processo da janela: o plugin de Host registra uma rota JSON (`/dsh-desktop-pet`) no servidor web, e `show` ou `toggle` **iniciam a janela quando nao ha nenhuma**.

## Using it

| Gesto | Resultado |
|---|---|
| Arrastar | Move a mascote. A posicao e lembrada; um clique **nao** a joga de volta ao canto |
| Clique | Um remelexo e nada mais |
| Clique duplo | Abre a janela do DeepSeek Harness |
| Clique direito | Menu: abrir o Harness, atualizar, **tamanho** (75% / 100% / 125% / 150%), ocultar, mover para o canto, sair |
| Clique no medalhao | A mascote volta e o medalhao some |
| Arrastar o medalhao | Move o medalhao; a posicao tambem e lembrada |
| Botao redondo ao lado do campo de texto | O rosto da mascote: mostrar / ocultar, e iniciar quando nao esta rodando |
| Configuracoes → 桌宠 | Painel completo: estado, pid, mostrar / ocultar / reiniciar / sair, e tamanho |

O tamanho e um escalonamento da janela inteira (`setZoomFactor`), ancorado no centro inferior para os pes nao pularem. O estado fica em `<DSH home>/desktop/pet-window.json`.

## Install

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-desktop-pet-0.3.1.tgz
```

Instalar a partir de um **caminho de diretorio** nao registra o bundle: precisa ser um tarball (ou npm/git). Reinicie o aplicativo depois; tanto o bundle quanto o modulo `dsh.client` carregam na inicializacao. O host da janela e o `electron`, instalado como dependencia normal, e o portao de build do pnpm deve permiti-lo em `pnpm-workspace.yaml` (`allowBuilds: electron: true`).

O pnpm **nao** reinstala um tarball cuja versao nao mudou, mesmo que o conteudo tenha mudado: vale a integridade registrada no lockfile. Para pegar codigo novo, remova o plugin e adicione de novo.

## Configuration

| Chave | Tipo | Padrao | Descricao |
|---|---|---|---|
| `enabled` | boolean | `true` | Iniciar a janela quando o plugin ativa |
| `command` | string | `''` | Executavel host; vazio prefere `<DSH home>/desktop-pet-runtime` |
| `args` | string[] | `[]` | Argumentos para `command` |
| `cwd` | string | `''` | Diretorio de trabalho; vazio usa `<DSH home>/desktop-pet`, nunca o perfil do usuario nem o diretorio do plugin |
| `restartDelayMs` | number | `2000` | Atraso antes de reiniciar apos saida anormal |
| `maxRestarts` | number | `5` | Reinicios consecutivos permitidos |
| `scale` | number | `1` | Tamanho **inicial** da mascote, 0.5–2 |
| `controlPanel` | boolean | `true` | Registrar a rota de controle `/dsh-desktop-pet` no servidor web |

A configuracao e validada pelo schema Schemastery; nenhum valor ajustavel esta fixado no codigo. Uma saida limpa (`code 0`) e tratada como fechamento deliberado e **nao** e reiniciada sozinha; o botao 「显示桌宠」 da pagina e o caminho de volta.

O processo tambem escuta em `127.0.0.1:52118` (`status`, `show`, `hide`, `toggle`, `snap`, `scale:<n>`, `quit`), o que serve tambem como trava de instancia unica.

## Development

```sh
npm install --ignore-scripts
npm test
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-desktop-pet contributors.
