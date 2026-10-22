import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRoutes } from '../lib/routes.js'
import { createStore } from '../lib/store.js'

const HEADER = { 'x-dsh-plugin': 'session-board' }

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

function makeReq(method, body, headers) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.headers = headers ?? (method === 'GET' ? {} : HEADER)
  return req
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wb-routes-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const store = createStore({ file: path.join(dir, 'workbench.json') })
  const routes = createRoutes(store)
  const route = (suffix) => routes.find((entry) => entry.path === `/api/session-board${suffix}`)

  async function call(suffix, method, body, headers) {
    const res = makeRes()
    await route(suffix).handler(makeReq(method, body, headers), res)
    return res
  }

  return { store, routes, call, route }
}

test('路由表：全部 exact，路径不重叠', async (t) => {
  const { routes } = await setup(t)
  assert.equal(routes.length, 6)
  for (const entry of routes) assert.equal(entry.kind, 'exact')
  const paths = new Set(routes.map((entry) => entry.path))
  assert.equal(paths.size, routes.length)
})

test('GET /state：空库返回 revision 0 与空数组', async (t) => {
  const { call } = await setup(t)
  const res = await call('/state', 'GET')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { ok: true, value: { revision: 0, items: [] } })
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
})

test('非 GET 缺 x-dsh-plugin 头 → 403 FORBIDDEN', async (t) => {
  const { call } = await setup(t)
  const res = await call('/item/upsert', 'POST', { item: { title: 'A' } }, {})
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'FORBIDDEN')
})

test('POST /item/upsert：建项成功，封套是 ok/value', async (t) => {
  const { call } = await setup(t)
  const res = await call('/item/upsert', 'POST', { item: { title: '工作项 A', status: 'active' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.value.revision, 1)
  assert.equal(res.body.value.item.title, '工作项 A')
  assert.equal(res.body.value.item.status, 'active')
})

test('字段校验失败 → 400 + 具体错误码', async (t) => {
  const { call } = await setup(t)
  const res = await call('/item/upsert', 'POST', { item: { title: '   ' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'TITLE_REQUIRED')
})

test('非法状态转移 → 409 ILLEGAL_TRANSITION', async (t) => {
  const { call } = await setup(t)
  const created = await call('/item/upsert', 'POST', { item: { title: 'A' } })
  const id = created.body.value.item.id

  const res = await call('/item/status', 'POST', { id, status: 'done' })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.error.code, 'ILLEGAL_TRANSITION')

  const ok = await call('/item/status', 'POST', { id, status: 'active' })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.value.item.status, 'active')
})

test('未知 id → 404 NOT_FOUND；缺 id → 400 ID_REQUIRED', async (t) => {
  const { call } = await setup(t)
  const missing = await call('/item/status', 'POST', { id: 'wi_nope', status: 'active' })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.body.error.code, 'NOT_FOUND')

  const noId = await call('/item/status', 'POST', { status: 'active' })
  assert.equal(noId.statusCode, 400)
  assert.equal(noId.body.error.code, 'ID_REQUIRED')
})

test('方法不对 → 405 METHOD', async (t) => {
  const { call } = await setup(t)
  const res = await call('/state', 'POST', {})
  assert.equal(res.statusCode, 405)
  assert.equal(res.body.error.code, 'METHOD')
})

test('坏 JSON → 400 INVALID_BODY', async (t) => {
  const { route } = await setup(t)
  const req = Readable.from([Buffer.from('{ 不是 json', 'utf8')])
  req.method = 'POST'
  req.headers = HEADER
  const res = makeRes()
  await route('/item/upsert').handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'INVALID_BODY')
})

test('/item/sessions 与 /item/delete 打通', async (t) => {
  const { call } = await setup(t)
  const created = await call('/item/upsert', 'POST', { item: { title: 'A' } })
  const id = created.body.value.item.id

  const linked = await call('/item/sessions', 'POST', { id, add: ['session-x'] })
  assert.deepEqual(linked.body.value.item.sessions, ['session-x'])

  const deleted = await call('/item/delete', 'POST', { id })
  assert.equal(deleted.body.value.deleted, id)

  const state = await call('/state', 'GET')
  assert.equal(state.body.value.items.length, 0)
})

test('/health：只回文件名，不泄露绝对路径', async (t) => {
  const { call } = await setup(t)
  const res = await call('/health', 'GET')
  assert.equal(res.body.ok, true)
  assert.equal(res.body.value.file, 'workbench.json')
  assert.equal(res.body.value.backup, 'workbench.json.bak')
  assert.equal(JSON.stringify(res.body).includes(os.tmpdir().replace(/\\/g, '\\\\')), false)
})
