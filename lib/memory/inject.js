/**
 * 把「工作组记忆」注入系统提示。
 *
 * ## 为什么可以这么做（M0 验证结论，别删）
 *
 * `@deepseek-ai/dsh-system-prompt` 在组装时是这么求值的：
 *
 * ```js
 * text: typeof section.text === "function" ? section.text(context) : section.text
 * ```
 *
 * 而 `@deepseek-ai/dsh-agent` 组装的 context 是：
 *
 * ```js
 * { agent, scope: agent, ...(signal === void 0 ? {} : { signal }) }
 * ```
 *
 * 所以：**拿得到会话身份（`context.agent.id`），但求值处没有 `await`** ——
 * 回调必须是同步函数，返回字符串。这也是为什么 store 把状态常驻内存。
 *
 * ## 组外零影响
 *
 * 没有归属、或所有归属组的记忆都是空的时候，返回空串。空 section 会被组装阶段
 * 丢弃，所以组外会话的系统提示一个字节都不变。
 */

import { LIMITS, renderMemoryBlock } from './model.js'

/** 段名：改名会让「同一个 name 覆盖」失效，别乱改。 */
export const MEMORY_SECTION_NAME = 'workbench:memory'

/**
 * 段位置：工具说明（1000–1200）之后、运行环境（10000）之前。
 * 记忆是补充材料，不是行为规则，放这里不打断「策略 → 工具」的阅读顺序。
 */
export const MEMORY_SECTION_ORDER = 1500

/**
 * 注册记忆段。
 *
 * @param {{ systemPrompt: { section: (section: unknown) => () => void } }} ctx
 * @param {ReturnType<import('./store.js').createMemoryStore>} store
 * @param {{ order?: number, name?: string, log?: (message: string) => void }} [options]
 * @returns {() => void} Cordis 的 effect disposer
 */
export function installMemorySection(ctx, store, options = {}) {
  const { order = MEMORY_SECTION_ORDER, name = MEMORY_SECTION_NAME, log = () => {} } = options

  const dispose = ctx.systemPrompt.section({
    name,
    order,
    // ⚠️ 同步函数：不能 async、不能 await、不能在这里做 IO。
    text(scope) {
      try {
        const sessionId = scope?.agent?.id ?? scope?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') return ''

        const groups = store.groupsOfSession(sessionId)
        if (groups.length === 0) return ''

        return renderMemoryBlock(groups, {
          limit: LIMITS.injectTotal,
          revision: store.revision,
        }).text
      } catch (error) {
        // 注入失败只该让这一轮少一段提示，绝不能让整个 prompt 组装炸掉。
        log(`工作组记忆注入失败，本轮跳过：${String(error?.message ?? error)}`)
        return ''
      }
    },
  })

  log(`工作组记忆段已注册：${name} @ order ${order}`)
  return dispose
}
