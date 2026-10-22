import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../lib/store.js'

async function tempFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wb-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return path.join(dir, 'workbench.json')
}

test('新建 → revision 递增，第二次写生成 .bak', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })

  const first = await store.upsert({ title: '工作项 A' })
  assert.equal(first.ok, true)
  assert.equal(first.revision, 1)
  assert.equal(first.value.status, 'backlog')
  assert.equal(first.value.history[0].kind, 'create')

  const second = await store.upsert({ title: '工作项 B' })
  assert.equal(second.revision, 2)

  const main = JSON.parse(await fs.readFile(file, 'utf8'))
  const backup = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'))
  assert.equal(main.revision, 2)
  assert.equal(backup.revision, 1)
  assert.equal(backup.items.length, 1)
})

test('按 id 更新：只改传入字段，状态不被 upsert 绕过', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })

  const created = await store.upsert({ title: 'A', nextStep: '第一步', status: 'active' })
  const updated = await store.upsert({
    id: created.value.id,
    title: 'A',
    nextStep: '第二步',
    status: 'done', // 应被忽略
  })

  assert.equal(updated.ok, true)
  assert.equal(updated.value.nextStep, '第二步')
  assert.equal(updated.value.status, 'active')
  assert.equal(updated.value.closedAt, null)
})

test('setStatus：非法转移报 ILLEGAL_TRANSITION，未知 id 报 NOT_FOUND', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })
  const created = await store.upsert({ title: 'A' })

  const bad = await store.setStatus(created.value.id, 'done')
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'ILLEGAL_TRANSITION')

  const missing = await store.setStatus('wi_nope', 'active')
  assert.equal(missing.error.code, 'NOT_FOUND')

  const moved = await store.setStatus(created.value.id, 'active')
  assert.equal(moved.value.status, 'active')
})

test('sessionsOp：加/去重/移除，并记 history', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })
  const created = await store.upsert({ title: 'A' })

  const added = await store.sessionsOp(created.value.id, { add: ['session-a', 'session-a', 'session-b'] })
  assert.deepEqual(added.value.sessions, ['session-a', 'session-b'])

  const removed = await store.sessionsOp(created.value.id, { remove: ['a'] })
  assert.deepEqual(removed.value.sessions, ['session-b'])

  const bad = await store.sessionsOp(created.value.id, { add: ['..\\evil'] })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'SESSIONS_INVALID')
})

test('baseRevision 过期 → STALE_REVISION', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })
  await store.upsert({ title: 'A' })

  const stale = await store.upsert({ title: 'B' }, 0)
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'STALE_REVISION')

  const fresh = await store.upsert({ title: 'B' }, store.revision)
  assert.equal(fresh.ok, true)
})

test('并发 20 次写：串行排队，不丢写、不撞 id', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.upsert({ title: `并发 ${i}` })),
  )
  assert.ok(results.every((result) => result.ok), '存在失败的写')

  const snapshot = store.snapshot()
  assert.equal(snapshot.items.length, 20)
  assert.equal(snapshot.revision, 20)
  assert.equal(new Set(snapshot.items.map((item) => item.id)).size, 20)

  // 落盘内容与内存一致
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(onDisk.items.length, 20)
  assert.equal(onDisk.revision, 20)
})

test('主文件损坏 → 隔离并从 .bak 恢复', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })
  await store.upsert({ title: 'A' })
  await store.upsert({ title: 'B' }) // 此时 .bak 里有 1 条（revision 1）

  await fs.writeFile(file, '{ 这不是 JSON', 'utf8')

  const logs = []
  const revived = createStore({ file, log: (message) => logs.push(message) })
  await revived.ready()

  const snapshot = revived.snapshot()
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.items[0].title, 'A')
  assert.ok(logs.some((line) => line.includes('.bak')), `日志里应提到 .bak：${logs.join(' | ')}`)

  const files = await fs.readdir(path.dirname(file))
  assert.ok(files.some((name) => name.includes('.corrupt-')), '损坏文件应被隔离保留')
})

test('单条记录损坏：丢弃该条，其余照常打开', async (t) => {
  const file = await tempFile(t)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      revision: 3,
      items: [
        { id: 'wi_1', title: '好记录', status: 'active', sessions: [] },
        { id: 'wi_2', title: '', status: 'active' },
        { id: 'wi_3', title: '状态坏了', status: 'doing' },
      ],
    }),
    'utf8',
  )

  const store = createStore({ file })
  await store.ready()
  const snapshot = store.snapshot()
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.items[0].id, 'wi_1')
  assert.equal(snapshot.revision, 3)
})

test('remove：删掉后第二次报 NOT_FOUND', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })
  const created = await store.upsert({ title: 'A' })

  const deleted = await store.remove(created.value.id)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.value.deleted, created.value.id)
  assert.equal(store.snapshot().items.length, 0)

  const again = await store.remove(created.value.id)
  assert.equal(again.error.code, 'NOT_FOUND')
})

test('空文件/不存在：首次读是空态，不报错', async (t) => {
  const file = await tempFile(t)
  const store = createStore({ file })
  await store.ready()
  assert.deepEqual(store.snapshot(), { version: 1, revision: 0, items: [] })
})
