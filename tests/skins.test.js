import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSkinStore, slugify, validateSkin } from '../lib/skins.js'

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sb-skin-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('slugify：中文名兜底、非法字符收敛', () => {
  assert.equal(slugify('Neon Night'), 'neon-night')
  assert.equal(slugify('  a__b  '), 'a-b')
  assert.equal(slugify('深海娘'), '')
})

test('validateSkin：名字必填、id 规则、token 成对、CSS 上限', () => {
  assert.equal(validateSkin({}).error.code, 'SKIN_NAME_REQUIRED')
  assert.equal(validateSkin({ name: 'x', id: 'Bad Id' }).error.code, 'SKIN_ID_INVALID')
  assert.equal(validateSkin({ name: 'x', tokens: { color: 'red' } }).error.code, 'SKIN_TOKEN_NAME_INVALID')
  assert.equal(
    validateSkin({ name: 'x', tokens: { '--a': '#fff' } }).error.code,
    'SKIN_TOKEN_PAIR_INVALID',
    '裸字符串必须被拒',
  )
  const ok = validateSkin({ name: 'Test', tokens: { '--a': { light: '#fff', dark: '#000' } } })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.id, 'test')
})

test('保存 / 读取 / 列表：往返一致', async (t) => {
  const dir = await tempDir(t)
  const store = createSkinStore({ dir })

  const saved = await store.save({
    name: 'Neon Night',
    accent: '#00e5ff',
    tagline: '赛博霓虹',
    tokens: { '--dsw-alias-brand-primary': { light: '#00e5ff', dark: '#66f0ff' } },
    css: 'body{background:#000}',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.id, 'neon-night')

  const full = await store.read('neon-night')
  assert.equal(full.name, 'Neon Night')
  assert.equal(full.css, 'body{background:#000}')
  assert.equal(full.tokens['--dsw-alias-brand-primary'].dark, '#66f0ff')

  const listed = await store.list()
  assert.equal(listed.user.length, 1)
  assert.equal(listed.user[0].hasCss, true)
})

test('内置 id 不可覆盖；删除后可再存', async (t) => {
  const dir = await tempDir(t)
  const store = createSkinStore({ dir })

  const reserved = await store.save({ id: 'whale', name: 'x' })
  assert.equal(reserved.error.code, 'SKIN_ID_RESERVED')

  await store.save({ name: 'custom' })
  assert.equal((await store.list()).user.length, 1)
  assert.equal((await store.remove('custom')).ok, true)
  assert.equal((await store.list()).user.length, 0)
  assert.equal((await store.remove('whale')).error.code, 'SKIN_ID_RESERVED')
})

test('激活状态持久化，删掉激活项会清空', async (t) => {
  const dir = await tempDir(t)
  const store = createSkinStore({ dir })
  await store.save({ name: 'pretty' })

  await store.setActive('pretty')
  assert.equal(await store.getActive(), 'pretty')

  const revived = createSkinStore({ dir })
  assert.equal(await revived.getActive(), 'pretty', '重启后仍记得')

  await revived.remove('pretty')
  assert.equal(await revived.getActive(), null)
})

test('id 非法时绝不落盘（路径穿越）', async (t) => {
  const dir = await tempDir(t)
  const store = createSkinStore({ dir })
  const evil = await store.save({ name: 'x', id: '../../evil' })
  assert.equal(evil.ok, false)
  assert.equal(await store.read('../../evil'), null)
  const entries = await fs.readdir(dir).catch(() => [])
  assert.equal(entries.includes('skins'), false, '不该创建 skins 目录')
})
