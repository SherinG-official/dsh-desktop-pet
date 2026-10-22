import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMITS,
  STATUSES,
  applyPatch,
  canTransition,
  countByStatus,
  newId,
  pushHistory,
  sameSession,
  sessionKey,
  transition,
  validateDraft,
  validateStoredItem,
} from '../lib/model.js'

const NOW = 1792584080957 // 2026-10-21 20:01:20 +08:00

function makeItem(overrides = {}) {
  return {
    id: 'wi_20261021_abcd',
    title: '鸿蒙化学文件查看器 v1',
    status: 'backlog',
    nextStep: '',
    note: '',
    sessions: [],
    workspace: '',
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    history: [],
    ...overrides,
  }
}

test('newId：本地日期 + 4 位 base36，两次调用不重复', () => {
  const id = newId(NOW)
  assert.match(id, /^wi_20261021_[a-z0-9]{4}$/)
  const many = new Set(Array.from({ length: 200 }, () => newId(NOW)))
  assert.ok(many.size > 150, `200 次生成里重复太多：${many.size}`)
})

test('validateDraft：标题必填、超长、只接受白名单字段', () => {
  assert.equal(validateDraft({}).ok, false)
  assert.equal(validateDraft({}).error.code, 'TITLE_REQUIRED')
  assert.equal(validateDraft({ title: '   ' }).error.code, 'TITLE_REQUIRED')
  assert.equal(validateDraft({ title: 'x'.repeat(LIMITS.title + 1) }).error.code, 'TITLE_TOO_LONG')
  assert.equal(validateDraft({ title: 'x'.repeat(LIMITS.title) }).ok, true)

  const value = validateDraft({ title: ' 标题 ', note: 'n', 恶意字段: 1 })
  assert.equal(value.ok, true)
  assert.equal(value.value.title, '标题')
  assert.equal('恶意字段' in value.value, false)
})

test('validateDraft：nextStep 是单行字段，换行折成空格', () => {
  const value = validateDraft({ title: 't', nextStep: '  先接 .cdxml\n\n再写渲染器  ' })
  assert.equal(value.value.nextStep, '先接 .cdxml 再写渲染器')
  assert.equal(validateDraft({ title: 't', nextStep: 'x'.repeat(LIMITS.nextStep + 1) }).error.code, 'NEXT_STEP_TOO_LONG')
})

test('validateDraft：sessions 去重、字符集、数量上限', () => {
  const ok = validateDraft({ title: 't', sessions: ['session-a', 'session-a', 'session-b'] })
  assert.deepEqual(ok.value.sessions, ['session-a', 'session-b'])

  assert.equal(validateDraft({ title: 't', sessions: ['..\\evil'] }).error.code, 'SESSIONS_INVALID')
  assert.equal(validateDraft({ title: 't', sessions: [1] }).error.code, 'SESSIONS_INVALID')
  assert.equal(validateDraft({ title: 't', sessions: 'nope' }).error.code, 'SESSIONS_INVALID')
  const tooMany = Array.from({ length: LIMITS.sessions + 1 }, (_, i) => `session-${i}`)
  assert.equal(validateDraft({ title: 't', sessions: tooMany }).error.code, 'SESSIONS_TOO_MANY')
})

test('validateDraft：未知状态被拒', () => {
  assert.equal(validateDraft({ title: 't', status: 'doing' }).error.code, 'UNKNOWN_STATUS')
  for (const status of STATUSES) {
    assert.equal(validateDraft({ title: 't', status }).ok, true)
  }
})

test('sessionKey / sameSession：容忍 session- 前缀', () => {
  assert.equal(sessionKey('session-abc'), 'abc')
  assert.equal(sessionKey('abc'), 'abc')
  assert.equal(sameSession('session-abc', 'abc'), true)
  assert.equal(sameSession('', ''), false)
})

test('状态机：只允许图上那些边', () => {
  assert.equal(canTransition('backlog', 'active'), true)
  assert.equal(canTransition('backlog', 'done'), false)
  assert.equal(canTransition('active', 'backlog'), true)
  assert.equal(canTransition('review', 'done'), true)
  assert.equal(canTransition('done', 'active'), true) // reopen
  assert.equal(canTransition('done', 'review'), false)
  assert.equal(canTransition('paused', 'active'), true)
  assert.equal(canTransition('paused', 'done'), false)
  for (const status of STATUSES) assert.equal(canTransition(status, status), false)
})

test('transition：非法转移报错，done 写 closedAt，离开 done 清空', () => {
  const item = makeItem()
  const bad = transition(item, 'done', NOW + 1)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'ILLEGAL_TRANSITION')

  const active = transition(item, 'active', NOW + 10)
  assert.equal(active.value.status, 'active')
  assert.equal(active.value.updatedAt, NOW + 10)
  assert.equal(active.value.history.at(-1).kind, 'status')

  const review = transition(active.value, 'review', NOW + 20)
  const done = transition(review.value, 'done', NOW + 30)
  assert.equal(done.value.closedAt, NOW + 30)

  const reopened = transition(done.value, 'active', NOW + 40)
  assert.equal(reopened.value.closedAt, null)
})

test('transition：同状态幂等，不产生 history', () => {
  const item = makeItem()
  const same = transition(item, 'backlog', NOW + 99)
  assert.equal(same.ok, true)
  assert.equal(same.value, item)
  assert.equal(same.value.history.length, 0)
})

test('applyPatch：字段变更各留一条 history，无变化时原样返回', () => {
  const item = makeItem({ nextStep: '旧' })
  const changed = applyPatch(item, { nextStep: '新' }, NOW + 10)
  assert.equal(changed.value.nextStep, '新')
  assert.equal(changed.value.updatedAt, NOW + 10)
  assert.equal(changed.value.history.length, 1)
  assert.equal(changed.value.history[0].kind, 'nextStep')

  const noop = applyPatch(item, { nextStep: '旧' }, NOW + 20)
  assert.equal(noop.value, item)

  const sessions = applyPatch(item, { sessions: ['session-a', 'session-b'] }, NOW + 30)
  const kinds = sessions.value.history.map((entry) => entry.kind)
  assert.deepEqual(kinds, ['session+', 'session+'])

  const removed = applyPatch(sessions.value, { sessions: ['session-a'] }, NOW + 40)
  assert.equal(removed.value.history.at(-1).kind, 'session-')
})

test('pushHistory：最多 50 条，丢最旧', () => {
  let item = makeItem()
  for (let i = 0; i < LIMITS.history + 10; i += 1) {
    item = pushHistory(item, { at: NOW + i, kind: 'note', to: String(i) })
  }
  assert.equal(item.history.length, LIMITS.history)
  assert.equal(item.history.at(-1).to, String(LIMITS.history + 9))
  assert.equal(item.history[0].to, String(10))
})

test('validateStoredItem：坏记录返回 null，好记录归一', () => {
  assert.equal(validateStoredItem(null), null)
  assert.equal(validateStoredItem({ id: 'x' }), null)
  assert.equal(validateStoredItem({ id: 'x', title: 't', status: 'doing' }), null)

  const item = validateStoredItem({
    id: ' wi_1 ',
    title: 't',
    status: 'active',
    sessions: ['session-a', 'session-a'],
    createdAt: NOW,
    updatedAt: NOW + 5,
    history: [{ at: NOW, kind: 'create' }, { bad: true }],
  })
  assert.equal(item.id, 'wi_1')
  assert.deepEqual(item.sessions, ['session-a'])
  assert.equal(item.history.length, 1)
  assert.equal(item.closedAt, null)
})

test('countByStatus：只数合法状态', () => {
  const counts = countByStatus([makeItem(), makeItem({ status: 'active' }), makeItem({ status: 'done' })])
  assert.equal(counts.backlog, 1)
  assert.equal(counts.active, 1)
  assert.equal(counts.done, 1)
  assert.equal(counts.review, 0)
})
