// 和 openGym 服务端说话：同手机 App 一样用配对得到的 Bearer 令牌，走公开的 /api/data 同步接口。
// 不直接改 state-<uid>.json：服务端的版本号、合并与「写入方不打时间戳就由服务端打」都在 PUT /api/data 里，
// 绕过它会和正在同步的手机打架。
import fs from 'node:fs'
import path from 'node:path'

const TIMEOUT_MS = 15000

export class UpstreamError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

export function createClient({ baseUrl, tokenFile, pairCode = '', fetchImpl = fetch }) {
  if (!baseUrl) throw new Error('OPENGYM_URL is required')
  let token = null

  const loadToken = () => {
    try { token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || null } catch { token = null }
    return token
  }
  const saveToken = t => {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    const tmp = tokenFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ token: t, savedAt: new Date().toISOString() }), { mode: 0o600 })
    fs.renameSync(tmp, tokenFile)
    token = t
  }

  async function request(method, p, body, { auth = true } = {}) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    let res
    try {
      res = await fetchImpl(baseUrl + p, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      })
    } catch (e) {
      throw new UpstreamError(502, 'opengym_unreachable', `openGym server unreachable: ${e.name === 'AbortError' ? 'timeout' : e.message}`)
    } finally { clearTimeout(timer) }
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }

  // 启动时：没有令牌就用一次性配对码换；有就 GET /api/me，过半有效期时服务端会给新令牌，存下来。
  async function ensureAuth() {
    if (!token && !loadToken()) {
      if (!pairCode) throw new UpstreamError(503, 'not_paired', 'bridge is not paired with the openGym server (set OPENGYM_PAIR_CODE once)')
      const r = await request('POST', '/api/pair/redeem', { code: pairCode }, { auth: false })
      if (r.status !== 200 || !r.data?.token) throw new UpstreamError(503, 'not_paired', `pairing failed (${r.status}); mint a fresh code`)
      saveToken(r.data.token)
    }
    const me = await request('GET', '/api/me')
    if (me.status === 401) throw new UpstreamError(503, 'not_paired', 'openGym refused the bridge token; pair again')
    if (me.status !== 200 || !me.data?.user?.id) throw new UpstreamError(502, 'opengym_error', `GET /api/me answered ${me.status}`)
    if (typeof me.data.token === 'string' && me.data.token) saveToken(me.data.token)
    return me.data.user
  }

  async function read() {
    const r = await request('GET', '/api/data')
    if (r.status === 401) { token = null; throw new UpstreamError(503, 'not_paired', 'openGym refused the bridge token; pair again') }
    if (r.status !== 200) throw new UpstreamError(502, 'opengym_error', `GET /api/data answered ${r.status}`)
    return { state: r.data?.state || null, rev: r.data?.rev || 0 }
  }

  /**
   * 读 → 改 → 带 baseRev 写；中间有手机写过（409）就用新文档重来，最多 4 次。
   * fn(state) 原地改 state，返回 { write: boolean, ...result }。
   */
  async function mutate(fn) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, rev } = await read()
      if (!state) throw new UpstreamError(409, 'no_state', 'this openGym profile has never synced; open the app paired to the server once first')
      const result = await fn(state)
      if (!result.write) return { ...result, rev }
      const wid = state._wid
      state._ts = Date.now()
      const r = await request('PUT', '/api/data', { state, baseRev: rev, ...(wid ? { baseWid: wid } : {}) })
      if (r.status === 200) return { ...result, rev: r.data?.rev ?? rev + 1 }
      if (r.status === 409) continue
      if (r.status === 401) { token = null; throw new UpstreamError(503, 'not_paired', 'openGym refused the bridge token; pair again') }
      throw new UpstreamError(502, 'opengym_error', `PUT /api/data answered ${r.status}${r.data?.error ? ': ' + r.data.error : ''}`)
    }
    throw new UpstreamError(409, 'conflict', 'the profile kept changing while writing; try again')
  }

  return { ensureAuth, read, mutate, hasToken: () => !!(token || loadToken()) }
}
