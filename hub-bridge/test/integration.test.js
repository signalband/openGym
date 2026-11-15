// 真服务端联调：起一个本仓库的 openGym api（临时数据目录、密码登录），像手机一样同步一份档案，
// 再让 bridge 用配对令牌写训练、建计划，最后用「手机」的身份读回来核对。
// 需要先 `cd api && npm ci`；没装依赖时跳过。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '../src/client.js'
import { createApp } from '../src/server.js'
import { mergeStates } from '../../frontend/src/lib/sync-merge.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const haveApi = fs.existsSync(path.join(ROOT, 'api/node_modules/@simplewebauthn'))
const PORT = 39000 + Math.floor(Math.random() * 500)
const BASE = `http://127.0.0.1:${PORT}`
const ORIGIN = BASE
const BRIDGE_TOKEN = 'test-bridge-token-0123456789abcdef'
let api, dataDir, bridge, bridgeBase, phoneToken

async function call(method, p, { body, token, cookie } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, data: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') }
}
const bridgeCall = async (method, p, body) => {
  const res = await fetch(bridgeBase + p, { method, headers: { Authorization: 'Bearer ' + BRIDGE_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, data: await res.json() }
}
const pairCode = async cookie => {
  const r = await call('POST', '/api/pair/create', { body: { current: 'correct horse battery' }, cookie })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return r.data.code
}

before(async () => {
  if (!haveApi) return
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-bridge-'))
  api = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'api'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), PASSWORD_LOGIN: '1', RP_ID: '127.0.0.1', ORIGIN, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  api.stdout.on('data', d => { log += d }); api.stderr.on('data', d => { log += d })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
    if (i === 99) throw new Error('api did not start:\n' + log)
  }
})
after(() => {
  api?.kill(); bridge?.close()
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

test('end to end against a real openGym server', { skip: !haveApi && 'api/node_modules missing (cd api && npm ci)' }, async () => {
  // 账号（密码登录）+ 手机配对 + 手机第一次同步
  const reg = await call('POST', '/api/register/password', { body: { name: 'aiden', password: 'correct horse battery' } })
  assert.equal(reg.status, 200, JSON.stringify(reg.data))
  const cookie = reg.cookie.split(';')[0]
  const phone = await call('POST', '/api/pair/redeem', { body: { code: await pairCode(cookie) } })
  phoneToken = phone.data.token
  const seed = { unit: 'kg', lang: 'zh', workouts: [], routines: [], customEx: [], exWeights: {}, bodyweight: [{ d: '2026-11-01', w: 70 }], _ts: Date.now() }
  let put = await call('PUT', '/api/data', { token: phoneToken, body: { state: seed, baseRev: 0, stamped: true } })
  assert.equal(put.status, 200, JSON.stringify(put.data))

  // bridge：配对码只用一次，令牌落盘
  const tokenFile = path.join(dataDir, 'bridge', 'token.json')
  const client = createClient({ baseUrl: BASE, tokenFile, pairCode: await pairCode(cookie) })
  const me = await client.ensureAuth()
  assert.equal(me.name, 'aiden')
  assert.ok(fs.existsSync(tokenFile))
  bridge = createApp({ client, bridgeToken: BRIDGE_TOKEN })
  await new Promise(r => bridge.listen(0, '127.0.0.1', r))
  bridgeBase = `http://127.0.0.1:${bridge.address().port}`

  assert.equal((await fetch(bridgeBase + '/v1/summary')).status, 401)

  const workout = {
    requestId: 'grok-msg-1', at: '2026-11-12T19:30:00+08:00', durationMin: 50, name: '背 + 肩',
    exercises: [
      { exercise: '坐姿划船', sets: [{ reps: 12, weight: 80, unit: 'lb', count: 4 }] },
      { exercise: '哑铃推肩', sets: [{ reps: 12, weight: 2.5, unit: 'kg', count: 4 }] },
    ],
  }
  // 1) 没认出 → 候选，不写
  let r = await bridgeCall('POST', '/v1/workouts', workout)
  assert.equal(r.status, 200)
  assert.equal(r.data.status, 'needs_choice')
  const pick = r.data.unresolved[0].candidates[0].id
  // 2) 选定 + 预览（默认 dryRun）
  workout.exercises[0] = { ...workout.exercises[0], exerciseId: pick, remember: true }
  r = await bridgeCall('POST', '/v1/workouts', workout)
  assert.equal(r.data.status, 'preview')
  assert.equal(r.data.preview.exercises[0].sets[0].weight, 36.25)
  const before = await call('GET', '/api/data', { token: phoneToken })
  assert.equal(before.data.state.workouts.length, 0, 'preview must not write')

  // 3) 手机在中间写了一次（体重），bridge 带旧版本也不会把它冲掉
  const mid = before.data.state
  mid.bodyweight = [...mid.bodyweight, { d: '2026-11-12', w: 69.5 }]
  mid._ts = Date.now()
  put = await call('PUT', '/api/data', { token: phoneToken, body: { state: mid, baseRev: before.data.rev, stamped: true } })
  assert.equal(put.status, 200)

  // 4) 确认写入
  r = await bridgeCall('POST', '/v1/workouts', { ...workout, dryRun: false })
  assert.equal(r.data.status, 'saved', JSON.stringify(r.data))
  assert.deepEqual(r.data.remembered.map(x => x.alias), ['坐姿划船'])
  // 5) 重发同一请求：不重复
  const again = await bridgeCall('POST', '/v1/workouts', { ...workout, dryRun: false })
  assert.equal(again.data.status, 'already_saved')

  // 6) 计划
  r = await bridgeCall('POST', '/v1/routines', {
    requestId: 'grok-msg-2', name: '背 + 肩', dryRun: false,
    exercises: [{ exercise: '坐姿划船', sets: 4, reps: 12, weight: 80, unit: 'lb', restSec: 60 }, { exercise: '哑铃推肩', sets: 4, reps: 12, weight: 2.5, unit: 'kg', restSec: 60 }],
  })
  assert.equal(r.data.status, 'saved', JSON.stringify(r.data))
  assert.deepEqual(r.data.preview.exercises.map(e => e.match), ['alias', 'name'])   // 别名生效

  // 手机读回：训练、计划、别名、体重都在
  const after = (await call('GET', '/api/data', { token: phoneToken })).data
  const S = after.state
  assert.equal(S.workouts.length, 1)
  assert.equal(S.workouts[0].d, '2026-11-12')
  assert.equal(S.workouts[0].entries[0].id, pick)
  assert.equal(S.workouts[0].entries[0].sets.length, 4)
  assert.equal(S.routines.length, 1)
  assert.equal(S.routines[0].ex[0].restSec, 60)
  assert.deepEqual(S.exAliases[pick], ['坐姿划船'])
  assert.equal(S.bodyweight.length, 2, 'the phone write in between survived')
  assert.ok(after.rev >= 4)

  // 手机拉取时用 App 自己的合并：手机本地那份（还没有这些条目）+ 服务端这份，新条目都留下
  const merged = mergeStates(mid, S)
  assert.equal(merged.workouts.length, 1)
  assert.equal(merged.routines.length, 1)
  assert.deepEqual(merged.exAliases?.[pick], ['坐姿划船'])

  const sum = await bridgeCall('GET', '/v1/summary')
  assert.equal(sum.data.workouts[0].fromHub, true)
  const search = await bridgeCall('GET', '/v1/exercises?q=' + encodeURIComponent('高位下拉'))
  assert.ok(search.data.results.length > 0 && search.data.results.every(x => x.name.includes('下拉')))
})
