#!/usr/bin/env node
// openGym hub-bridge：只在内网监听，给 Health Hub 的 opengym_* MCP 工具用。
//   GET  /health
//   GET  /v1/exercises?q=…          搜动作（中文名 / 英文名 / 别名）
//   GET  /v1/summary?limit=5       最近训练 + 全部计划
//   POST /v1/workouts              记一次训练   body: { ...训练, dryRun }
//   POST /v1/routines              建一个计划   body: { ...计划, dryRun }
// 写入两步：dryRun=true 只返回预览（认出的动作、换算后的重量），本人确认后 dryRun=false 才写。
// 鉴权：Authorization: Bearer $BRIDGE_TOKEN（Hub 与 bridge 共享的密钥）。
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createClient, UpstreamError } from './client.js'
import { InputError, planWorkout, applyWorkout, planRoutine, applyRoutine, summarize } from './build.js'
import { buildIndex, candidatesFor } from './catalog.js'

const MAX_BODY = 256 * 1024

export function createApp({ client, bridgeToken }) {
  if (!bridgeToken || bridgeToken.length < 24) throw new Error('BRIDGE_TOKEN must be set (24+ chars)')
  const expected = Buffer.from('Bearer ' + bridgeToken)
  const authorized = req => {
    const got = Buffer.from(String(req.headers.authorization || ''))
    return got.length === expected.length && timingSafeEqual(got, expected)
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new InputError('too_large', 'body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new InputError('invalid_json', 'body is not valid JSON')) } })
    req.on('error', reject)
  })

  // 写：先在最新文档上算；需要选择或只是预览就不写。
  async function write(body, plan, apply, key) {
    const dryRun = body.dryRun !== false
    let outcome
    const res = await client.mutate(state => {
      const p = plan(state, body)
      if (p.choice) { outcome = p.choice; return { write: false } }
      if (dryRun) { outcome = { status: 'preview', message: 'Nothing was saved yet. Show this preview to the user and, after they confirm, resend the same request with dryRun: false.', preview: p.preview }; return { write: false } }
      const applied = apply(state, p)
      outcome = { status: applied.duplicate ? 'already_saved' : 'saved', [key]: p.preview.id, preview: p.preview, remembered: applied.remembered, ...(applied.prs?.length ? { prs: applied.prs } : {}) }
      return { write: !applied.duplicate }
    })
    return { ...outcome, ...(outcome.status === 'saved' || outcome.status === 'already_saved' ? { rev: res.rev } : {}) }
  }

  const routes = {
    'GET /health': async () => ({ ok: true, paired: client.hasToken() }),
    'GET /v1/exercises': async (_req, url) => {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80)
      if (!q) throw new InputError('invalid_input', 'q is required')
      const { state } = await client.read()
      return { query: q, results: candidatesFor(q, buildIndex(state || {}), 10) }
    },
    'GET /v1/summary': async (_req, url) => {
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 5))
      const { state, rev } = await client.read()
      if (!state) throw new UpstreamError(409, 'no_state', 'this openGym profile has never synced; open the app paired to the server once first')
      return { rev, ...summarize(state, { limit }) }
    },
    'POST /v1/workouts': async req => write(await readBody(req), planWorkout, applyWorkout, 'workoutId'),
    'POST /v1/routines': async req => write(await readBody(req), planRoutine, applyRoutine, 'routineId'),
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://bridge')
    const route = routes[req.method + ' ' + url.pathname]
    if (!route) return send(res, 404, { error: 'not_found' })
    if (url.pathname !== '/health' && !authorized(req)) return send(res, 401, { error: 'unauthorized' })
    try {
      send(res, 200, await route(req, url))
    } catch (e) {
      if (e instanceof InputError || e instanceof UpstreamError || e.code === 'unknown_exercise') return send(res, e.status || 400, { error: e.code || 'error', message: e.message })
      console.error('[hub-bridge]', e)
      send(res, 500, { error: 'internal', message: 'internal error' })
    }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = createClient({
    baseUrl: process.env.OPENGYM_URL,
    tokenFile: process.env.TOKEN_FILE || '/data/token.json',
    pairCode: process.env.OPENGYM_PAIR_CODE || '',
  })
  const port = Number(process.env.PORT) || 8787
  createApp({ client, bridgeToken: process.env.BRIDGE_TOKEN }).listen(port, () => console.log(`[hub-bridge] listening on :${port}`))
  // 不阻塞启动：服务端可能和 bridge 同时重启、还没起来，失败就每 10 秒再试，直到成功。
  const firstAuth = () => client.ensureAuth()
    .then(u => console.log(`[hub-bridge] paired as profile ${u.name}`))
    .catch(e => { console.error('[hub-bridge] auth:', e.message); setTimeout(firstAuth, 10000).unref() })
  firstAuth()
  // 令牌有效期默认 90 天，过半时 /api/me 换新；每天问一次就不会过期。
  setInterval(() => client.ensureAuth().catch(e => console.error('[hub-bridge] auth:', e.message)), 24 * 3600 * 1000).unref()
}
