import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  LIMITS,
  groupsOfSession,
  renderMemoryBlock,
  sessionsIndex,
  validateSessionId,
  validateGroupName,
  validateMemory,
} from '../lib/memory/model.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createMemoryRoutes } from '../lib/memory/routes.js'
import { installMemorySection } from '../lib/memory/inject.js'

const HEADER = { 'x-dsh-plugin': 'session-board' }
const SID = 'session-11111111-2222-3333-4444-555555555555'
const SID2 = 'session-66666666-7777-8888-9999-000000000000'

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    text: '',
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(text) {
      this.text = text
      this.body = JSON.parse(text)
    },
  }
}

function makeReq(method, body, headers, url = '/api/session-board/memory') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = headers ?? (method === 'GET' ? {} : HEADER)
  return req
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wb-memory-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'memory.json')
  const store = createMemoryStore({ file })
  const routes = createMemoryRoutes(store)
  const handler = routes[0].handler

  async function call(method, suffix = '', body, headers) {
    const res = makeRes()
    await handler(makeReq(method, body, headers, `/api/session-board/memory${suffix}`), res)
    return res
  }

  return { dir, file, store, routes, handler, call }
}

/* ---------------------------------- model --------------------------------- */

test('model: 会话 id 必须是 session- 前缀，子代理一律拒绝', () => {
  assert.equal(validateSessionId(SID).ok, true)
  for (const bad of ['subagent-1', 'child-2', 'delegate-3']) {
    const result = validateSessionId(bad)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'SESSION_ID_SUBAGENT')
  }
  assert.equal(validateSessionId('abc').error.code, 'SESSION_ID_PREFIX')
  assert.equal(validateSessionId('  ').error.code, 'SESSION_ID_REQUIRED')
})

test('model: 名字与记忆的上限是硬拒绝，不是静默截断', () => {
  assert.equal(validateGroupName('  化学   实验室  ').value, '化学 实验室')
  assert.equal(validateGroupName('').ok, false)
  assert.equal(validateGroupName('x'.repeat(LIMITS.groupName + 1)).ok, false)

  const memory = validateMemory('x'.repeat(LIMITS.memoryFile))
  assert.equal(memory.ok, true)
  const tooLong = validateMemory('x'.repeat(LIMITS.memoryFile + 1))
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.error.code, 'GROUP_MEMORY_TOO_LONG')
})

test('model: groupsOfSession 按 order 再按名字排序，sessionsIndex 反查', () => {
  const state = {
    version: 1,
    revision: 3,
    groups: [
      { id: 'g2', name: '乙', order: 20, memory: '', sessions: [SID], color: '', createdAt: 0, updatedAt: 0 },
      { id: 'g1', name: '甲', order: 10, memory: '', sessions: [SID, SID2], color: '', createdAt: 0, updatedAt: 0 },
    ],
  }
  assert.deepEqual(groupsOfSession(state, SID).map((g) => g.id), ['g1', 'g2'])
  assert.deepEqual(groupsOfSession(state, SID2).map((g) => g.id), ['g1'])
  assert.deepEqual(groupsOfSession(state, 'session-nope'), [])
  assert.deepEqual(sessionsIndex(state), { [SID]: ['g2', 'g1'], [SID2]: ['g1'] })
})

test('model: 渲染是确定性的，空记忆不占上下文，超限截断并注明', () => {
  const groups = [
    { id: 'g1', name: '甲', memory: '约定 A' },
    { id: 'g2', name: '乙', memory: '   ' },
    { id: 'g3', name: '丙', memory: '约定 C' },
  ]
  const a = renderMemoryBlock(groups, { revision: 7 })
  const b = renderMemoryBlock(groups, { revision: 7 })
  assert.equal(a.text, b.text)
  assert.match(a.text, /## 工作组：甲/)
  assert.match(a.text, /workbench-memory:g1 r7/)
  assert.ok(!a.text.includes('工作组：乙'), '空记忆的组不该出现')
  assert.equal(a.groups, 2)

  assert.equal(renderMemoryBlock([]).text, '')
  assert.equal(renderMemoryBlock([{ id: 'g1', name: '甲', memory: '' }]).text, '')

  const big = [
    { id: 'a', name: 'A', memory: 'x'.repeat(100) },
    { id: 'b', name: 'B', memory: 'y'.repeat(100) },
  ]
  const cut = renderMemoryBlock(big, { limit: 150, revision: 1 })
  assert.equal(cut.truncated, true)
  assert.equal(cut.groups, 1)
  assert.match(cut.text, /记忆已截断/)
})

/* ---------------------------------- store --------------------------------- */

test('store: 建组 → 落盘 → 重开能读回，revision 递增', async (t) => {
  const { file, store, dir } = await setup(t)
  const created = await store.createGroup({ name: '化学实验室', color: '#4F8CC9' })
  assert.equal(created.ok, true)
  assert.equal(created.revision, 1)
  assert.equal(created.value.color, '#4f8cc9')

  const reopened = createMemoryStore({ file })
  const state = await reopened.ready()
  assert.equal(state.groups.length, 1)
  assert.equal(state.groups[0].name, '化学实验室')
  assert.equal(created.value.id.length > 0, true)
  await fs.rm(dir, { recursive: true, force: true })
})

test('store: 一个会话最多挂 3 个工作组', async (t) => {
  const { store } = await setup(t)
  const ids = []
  for (const name of ['A', 'B', 'C', 'D']) {
    const group = await store.createGroup({ name })
    ids.push(group.value.id)
  }
  for (let i = 0; i < 3; i += 1) {
    const added = await store.addSession(ids[i], SID)
    assert.equal(added.ok, true)
    assert.equal(added.value.changed, true)
  }
  const fourth = await store.addSession(ids[3], SID)
  assert.equal(fourth.ok, false)
  assert.equal(fourth.error.code, 'GROUPS_PER_SESSION_LIMIT')

  // 重复加入同一组是幂等的
  const again = await store.addSession(ids[0], SID)
  assert.equal(again.ok, true)
  assert.equal(again.value.changed, false)
})

test('store: 记忆超长被拒绝，且状态不变', async (t) => {
  const { store } = await setup(t)
  const group = await store.createGroup({ name: 'A' })
  const id = group.value.id
  const before = store.revision

  const bad = await store.updateGroup(id, { memory: 'x'.repeat(LIMITS.memoryFile + 1) })
  assert.equal(bad.ok, false)
  assert.equal(store.revision, before)
  assert.equal(store.snapshot().groups[0].memorySize, 0)

  const good = await store.updateGroup(id, { memory: '约定 A' })
  assert.equal(good.ok, true)
  assert.equal(store.snapshot().groups[0].memorySize, '约定 A'.length)
  assert.equal(store.groupsOfSession(SID).length, 0)

  // 记忆文件是独立 .md：写进去之后能读到，路径也随组返回。
  await store.addSession(id, SID)
  const groups = store.groupsOfSession(SID)
  assert.equal(groups[0].memory, '约定 A')
  assert.match(groups[0].memoryPath, /memory[\\/]grp_.*\.md$/)
})

test('store: 删组只删组与归属，不碰会话', async (t) => {
  const { store } = await setup(t)
  const group = await store.createGroup({ name: 'A' })
  await store.addSession(group.value.id, SID)
  const removed = await store.deleteGroup(group.value.id)
  assert.equal(removed.ok, true)
  assert.equal(store.snapshot().groups.length, 0)
  assert.deepEqual(store.groupsOfSession(SID), [])
})

test('store: 并发建组串行落盘，一个都不丢', async (t) => {
  const { store } = await setup(t)
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) => store.createGroup({ name: `组 ${index}` })),
  )
  assert.equal(results.every((result) => result.ok), true)
  assert.equal(store.snapshot().groups.length, 5)
  assert.equal(store.revision, 5)
})

test('store: 坏记录被丢弃，好记录照常读回', async (t) => {
  const { file, store, dir } = await setup(t)
  await store.createGroup({ name: '好的' })
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.groups.push({ id: '', name: '坏 id' }, { id: 'g_bad', name: '' }, 'not-an-object')
  await fs.writeFile(file, JSON.stringify(raw), 'utf8')

  const reopened = createMemoryStore({ file })
  const state = await reopened.ready()
  assert.equal(state.groups.length, 1)
  assert.equal(state.groups[0].name, '好的')
  await fs.rm(dir, { recursive: true, force: true })
})

/* ---------------------------------- inject -------------------------------- */

test('inject: 组外返回空串、组内返回记忆块，且必须是同步字符串', async (t) => {
  const { store } = await setup(t)
  const group = await store.createGroup({ name: '化学实验室' })
  await store.updateGroup(group.value.id, { memory: 'Origin 出图必须传 inline:false' })
  await store.addSession(group.value.id, SID)

  let captured = null
  const ctx = {
    systemPrompt: {
      section(section) {
        captured = section
        return () => {}
      },
    },
  }
  const dispose = installMemorySection(ctx, store, { log: () => {} })
  assert.equal(typeof dispose, 'function')
  assert.equal(captured.name, 'workbench:memory')
  assert.equal(captured.order, 1500)

  const inside = captured.text({ agent: { id: SID } })
  assert.equal(typeof inside, 'string', 'text 必须是同步字符串，不能是 Promise')
  assert.match(inside, /## 工作组：化学实验室/)
  assert.match(inside, /inline:false/)

  assert.equal(captured.text({ agent: { id: SID2 } }), '')
  assert.equal(captured.text({}), '')
  assert.equal(captured.text(undefined), '')
})

/* ---------------------------------- routes -------------------------------- */

test('routes: 一条 prefix 路由，路径不带结尾斜杠', async (t) => {
  const { routes } = await setup(t)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/session-board/memory')
  assert.ok(!routes[0].path.endsWith('/'))
})

test('routes: 建组 → 加会话 → 读状态 → 反查 → 移出 → 删组', async (t) => {
  const { call } = await setup(t)

  const created = await call('POST', '/groups', { name: '化学实验室' })
  assert.equal(created.statusCode, 200)
  assert.equal(created.body.ok, true)
  const id = created.body.value.group.id

  const added = await call('PUT', `/groups/${id}/sessions/${SID}`)
  assert.equal(added.body.value.membership.changed, true)

  const state = await call('GET')
  assert.equal(state.body.value.groups.length, 1)
  assert.deepEqual(state.body.value.sessionsIndex, { [SID]: [id] })

  const mine = await call('GET', `/session/${SID}`)
  assert.equal(mine.body.value.groups[0].name, '化学实验室')

  const removed = await call('DELETE', `/groups/${id}/sessions/${SID}`)
  assert.equal(removed.body.value.membership.changed, true)

  const deleted = await call('DELETE', `/groups/${id}`)
  assert.equal(deleted.body.value.deleted.deleted, id)
  const after = await call('GET')
  assert.equal(after.body.value.groups.length, 0)
})

test('routes: 无自定义头 403、方法错 405、路径未知 404、子代理会话被拒', async (t) => {
  const { call } = await setup(t)

  const forbidden = await call('POST', '/groups', { name: 'A' }, {})
  assert.equal(forbidden.statusCode, 403)
  assert.equal(forbidden.body.error.code, 'FORBIDDEN')

  const wrongMethod = await call('DELETE', '/groups')
  assert.equal(wrongMethod.statusCode, 405)

  const missing = await call('GET', '/nope')
  assert.equal(missing.statusCode, 404)

  const created = await call('POST', '/groups', { name: 'B' })
  const id = created.body.value.group.id
  const subagent = await call('PUT', `/groups/${id}/sessions/${'subagent-123'}`)
  assert.equal(subagent.body.ok, false)
  assert.equal(subagent.body.error.code, 'SESSION_ID_SUBAGENT')
})
