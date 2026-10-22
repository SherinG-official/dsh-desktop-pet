/**
 * dsh-session-board 的 Host 入口 —— 薄 shim。
 *
 * 只做一件事：导出 name / inject，apply 转调 ./lib/index.js。
 * 真正的逻辑在 lib/ 下，按 模型(纯函数) / 持久化 / 路由 分层，方便单测。
 *
 * 注意：这里**不要**写 `export default`。loader 的 unwrapExports 会把
 * `exports.default ?? exports` 折叠掉，命名导出（含 inject）就丢了 —— 插件会
 * 在没有依赖的情况下立刻 apply，然后静默 no-op。
 */
export { name, inject, apply, resolveDataFile, resolveSkinDir } from './lib/index.js'
