/**
 * `workgroup_note` —— 让会话自己把结论写回工作组记忆。
 *
 * 这是"不想手动维护记忆"的自动通道：agent 本来就有上下文，知道什么值得记，
 * 比自己写总结的机械摘录质量高得多。工具只做**追加**，不覆盖、不删除。
 *
 * 注册方式照本机已验证插件 dsh-origin-api：`ctx.get('tools')` + `defineTool`。
 * `@deepseek-ai/dsh-tools` 用**动态 import**：解析不到时只让这个工具缺席，
 * 不能把整个插件的 apply 拖垮。
 */

import { LIMITS } from './model.js'

const TOOL_NAME = 'workgroup_note'

function stamp(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 简单的文本输出契约（与 dsh-origin-api 的 textOutput 一致）。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      message: { type: 'string', required: true },
    },
  },
  render(_args, value) {
    const text = typeof value?.message === 'string' ? value.message : ''
    return [{ type: 'text', text: text === '' ? (value?.ok ? '完成。' : '未完成。') : text }]
  },
}

/**
 * 注册写记忆工具。
 * @param {object} ctx 插件 context（需已就绪 `tools` 服务）
 * @param {ReturnType<import('./store.js').createMemoryStore>} store
 * @param {(message: string) => void} log
 */
export async function registerMemoryTools(ctx, store, log = () => {}) {
  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    log(`工作记忆工具未注册（拿不到 dsh-tools）：${String(error?.message ?? error)}`)
    return null
  }

  const dispose = ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        '把一条阶段性结论追加到当前会话所属「工作组」的共享记忆（Markdown 文件）。' +
        '只追加、不覆盖；一个会话属于多个工作组时，可用 group 指定写哪一个（默认全部）。' +
        '在完成一个阶段性任务、定下约定或得出关键结论时调用一次即可，不要每轮都写。',
      parameters: {
        text: { type: 'string', description: '要记下的内容，建议一行、不超过 200 字。写结论，不要写流水账。' },
        group: { type: 'string', description: '可选：工作组名字。不填则写入当前会话所属的所有工作组。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        const groups = store.groupsOfSession(sessionId)
        if (groups.length === 0) {
          return { ok: false, message: '当前会话不属于任何工作组，没有可写入的记忆。' }
        }
        const wanted = typeof args?.group === 'string' && args.group.trim() !== ''
          ? groups.filter((entry) => entry.name === args.group.trim())
          : groups
        if (wanted.length === 0) {
          return {
            ok: false,
            message: `当前会话不在名为「${args.group}」的工作组里；可选：${groups.map((g) => g.name).join('、')}`,
          }
        }
        const text = String(args?.text ?? '').replace(/\s+/g, ' ').trim()
        if (text === '') return { ok: false, message: 'text 不能为空。' }
        if (text.length > 500) return { ok: false, message: 'text 太长（最多 500 字），请只写结论。' }

        const line = `- [模型] ${stamp()} ${text}`
        const done = []
        for (const group of wanted) {
          const result = await store.appendMemory(group.id, line)
          if (result?.ok === true) done.push(group.name)
        }
        if (done.length === 0) return { ok: false, message: '写入失败，请稍后重试。' }
        const total = store.snapshot().revision
        return {
          ok: true,
          message: `已写入 ${done.join('、')}（记忆文件上限 ${LIMITS.memoryFile} 字，超出后自动丢弃最旧条目）· revision ${total}`,
        }
      },
    }),
  )

  log(`工作记忆工具已注册：${TOOL_NAME}`)
  return dispose
}
