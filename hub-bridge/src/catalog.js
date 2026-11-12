// 动作名 → openGym 动作 id。复用 App 自己的动作库（frontend/src/lib/exercises.js）、简体中文名
// （frontend/src/exercise-names/zh.js）和用户在 App 里设的别名（S.exAliases，lib/exercise-aliases.js），
// 所以这里认出来的动作和 App 里搜到的是同一个。
//
// 只有「id 精确 / 中文名、英文名、别名规范化后完全相同」才直接采用；其余一律返回候选让本人选，
// 不猜——猜错的动作会进 1RM、肌群统计和下次的推荐重量，比多问一句代价大得多。
import { CATALOGUE, EXIDX, canonicalExId, registerCustom, searchScore } from '../../frontend/src/lib/exercises.js'
import { exerciseAliases, normalizeAliases } from '../../frontend/src/lib/exercise-aliases.js'
import ZH from '../../frontend/src/exercise-names/zh.js'

// 全角括号、空格、标点和大小写都不算区别：「器械坐姿划船（坐姿划船机）」与「器械坐姿划船(坐姿划船机)」同名。
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·・,，.。、:：;；'"“”‘’!！?？\-_/\\()（）[\]【】{}]+/g, '')
}

const zhName = id => ZH[id] || null

// 一份状态对应一个索引：自定义动作和别名都在用户的状态里。
export function buildIndex(state) {
  const customEx = Array.isArray(state?.customEx) ? state.customEx.filter(e => e && e.id != null) : []
  registerCustom(customEx)
  const merged = state?.exMerged || {}
  const aliasMap = state?.exAliases && typeof state.exAliases === 'object' ? state.exAliases : {}
  const list = [...customEx, ...CATALOGUE].filter(e => !merged[e.id]?.into)
  // 规范化名 → Set<id>。本人设的别名单独一张表、优先查：本人明确选过的叫法要压过动作库里的同名动作
  // （动作库里「面拉」是绳索面拉，本人在健身房说的「面拉」可能是弹力带那个）。
  const byKey = new Map(), byUserAlias = new Map()
  const add = (map, key, id) => {
    if (!key) return
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(id)
  }
  for (const ex of list) {
    add(byKey, normalizeName(ex.n), ex.id)
    add(byKey, normalizeName(zhName(ex.id)), ex.id)
    const own = Object.hasOwn(aliasMap, ex.id)
    for (const a of exerciseAliases(ex, aliasMap)) add(own ? byUserAlias : byKey, normalizeName(a), ex.id)
  }
  return { list, byKey, byUserAlias, aliasMap, byId: id => EXIDX[canonicalExId(id)] || null }
}

export function describe(ex) {
  if (!ex) return null
  return {
    id: ex.id,
    name: zhName(ex.id) || ex.n,
    nameEn: ex.n,
    bodyPart: ex.bp || null,
    equipment: ex.eq || null,
    target: ex.tg || null,
    custom: !!ex.custom,
  }
}

// 中文按字符二元组算相似度；英文交给 App 的 searchScore。
const bigrams = s => {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}
function zhScore(query, name) {
  const q = normalizeName(query), n = normalizeName(name)
  if (!q || !n) return 0
  if (n === q) return 1000
  let score = 0
  if (n.includes(q)) score = 500 - (n.length - q.length) * 5
  const a = bigrams(q), b = bigrams(n)
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const dice = (2 * inter) / (a.size + b.size || 1)
  return Math.max(score, dice * 300)
}

export function candidatesFor(raw, index, limit = 5) {
  const ascii = /^[\x20-\x7e]+$/.test(raw)
  const scored = []
  for (const ex of index.list) {
    let s = 0
    if (ascii) s = searchScore(ex, raw)
    else {
      s = zhScore(raw, zhName(ex.id) || '')
      for (const a of exerciseAliases(ex, index.aliasMap)) s = Math.max(s, zhScore(raw, a))
    }
    if (s > 0) scored.push([s, ex])
  }
  // 同分时名字短的排前面：「器械坐姿划船」比「绳索单臂扭转坐姿划船」更像本人说的那个。
  scored.sort((x, y) => y[0] - x[0] || (zhName(x[1].id) || x[1].n).length - (zhName(y[1].id) || y[1].n).length)
  return scored.slice(0, limit).map(([, ex]) => describe(ex))
}

/**
 * item: { exercise?, exerciseId? }。返回
 *   { ok: true, exerciseId, name, match: 'id' | 'name' | 'alias' }，或
 *   { ok: false, input, candidates }（没认出、或一个名字对应多个动作）。
 * exerciseId 不存在直接抛错：那是调用方写错，不是要本人选。
 */
export function resolveExercise(item, index) {
  if (item.exerciseId) {
    const ex = index.byId(String(item.exerciseId))
    if (!ex) throw Object.assign(new Error(`unknown exerciseId "${item.exerciseId}"; search with /v1/exercises?q=`), { status: 400, code: 'unknown_exercise' })
    return { ok: true, input: item.exercise ?? ex.id, exerciseId: ex.id, name: zhName(ex.id) || ex.n, match: 'id' }
  }
  const raw = String(item.exercise || '').trim()
  const key = normalizeName(raw)
  const own = index.byUserAlias.get(key)
  if (own && own.size === 1) {
    const ex = index.byId([...own][0])
    if (ex) return { ok: true, input: raw, exerciseId: ex.id, name: zhName(ex.id) || ex.n, match: 'alias' }
  }
  const hits = own && own.size > 1 ? own : index.byKey.get(key)
  if (hits && hits.size === 1) {
    const id = [...hits][0], ex = index.byId(id)
    const isName = normalizeName(ex.n) === normalizeName(raw) || normalizeName(zhName(id)) === normalizeName(raw)
    return { ok: true, input: raw, exerciseId: ex.id, name: zhName(ex.id) || ex.n, match: isName ? 'name' : 'alias' }
  }
  const candidates = hits && hits.size > 1
    ? [...hits].map(id => describe(index.byId(id))).filter(Boolean).slice(0, 5)
    : candidatesFor(raw, index)
  return { ok: false, input: raw, candidates }
}

/**
 * 把本人在对话里选定的叫法记成动作别名（同 App 里「动作 → 别名」）：S.exAliases[id] 覆盖内置别名，
 * 所以先取当前有效列表再追加。叫法就是动作名本身时不存。返回实际新记下的 [{ exerciseId, alias }]。
 */
export function rememberAliases(state, pairs) {
  const out = []
  const map = { ...(state.exAliases || {}) }
  for (const { exerciseId, alias } of pairs) {
    const ex = EXIDX[exerciseId]
    if (!ex || !alias) continue
    const key = normalizeName(alias)
    if (key === normalizeName(ex.n) || key === normalizeName(zhName(ex.id))) continue
    const cur = exerciseAliases(ex, map)
    if (cur.some(a => normalizeName(a) === key)) continue
    const next = normalizeAliases([...cur, alias])
    if (next.length === cur.length) continue   // 已满 20 个
    map[exerciseId] = next
    out.push({ exerciseId, alias })
  }
  if (out.length) state.exAliases = map
  return out
}
