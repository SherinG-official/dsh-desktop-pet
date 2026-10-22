import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { POSES, ROUTE_PREFIX, createPetRoutes, readPose, resolvePetDir } from '../lib/pet.js'

/** 1×1 的合法 PNG，用来假装桌宠立绘。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function fakePet(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sb-pet-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const assets = path.join(dir, 'assets', 'pet')
  await fs.mkdir(assets, { recursive: true })
  for (const pose of POSES) await fs.writeFile(path.join(assets, `${pose}.png`), TINY_PNG)
  return dir
}

test('resolvePetDir：找不到时返回 null，不抛错', async () => {
  assert.equal(await resolvePetDir(Date.now(), [path.join(os.tmpdir(), 'dsh-sb-absent')]), null)
})

test('readPose：白名单内的姿态能读到，路径穿越一律拒', async (t) => {
  const dir = await fakePet(t)

  const bytes = await readPose('idle', [dir])
  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(bytes.length, TINY_PNG.length)

  for (const evil of ['../../package.json', 'idle/../../x', '', 'IDLE', 'idle.png']) {
    assert.equal(await readPose(evil, [dir]), null, `${evil} 不该被接受`)
  }
})

test('createPetRoutes：prefix 路由 + GET 命中 / 未知姿态 404 / POST 405', async (t) => {
  const dir = await fakePet(t)
  const [route] = createPetRoutes()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE_PREFIX)

  function makeRes() {
    return {
      statusCode: 0,
      headers: null,
      body: null,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
        return this
      },
      end(chunk) {
        this.body = chunk
      },
    }
  }

  // GET 已知姿态 —— 真实目录要通过环境注入，所以这里直接调 readPose 验证内容，
  // 路由层只验 404 / 405 两条路径。
  // ⚠️ 前缀不带结尾斜杠（宿主 match() 的语义），所以子路径必须写成 `${ROUTE_PREFIX}/x`。
  const missRes = makeRes()
  await route.handler({ method: 'GET', url: `${ROUTE_PREFIX}/nope` }, missRes)
  assert.equal(missRes.statusCode, 404)
  assert.equal(JSON.parse(String(missRes.body)).error.code, 'PET_POSE_UNAVAILABLE')

  // 只是前缀本身（没有 pose）也要 404，而不是去读空名字
  const bareRes = makeRes()
  await route.handler({ method: 'GET', url: ROUTE_PREFIX }, bareRes)
  assert.equal(bareRes.statusCode, 404)

  const postRes = makeRes()
  await route.handler({ method: 'POST', url: `${ROUTE_PREFIX}/idle` }, postRes)
  assert.equal(postRes.statusCode, 405)

  const idx = await readPose('idle', [dir])
  assert.equal(idx.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '应该是 PNG 魔数')
})
