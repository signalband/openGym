// 把 Hub 传来的「人话」训练 / 计划变成 openGym 状态里的条目。纯函数，不做网络请求。
//
// 单位：openGym 整个档案只有一个单位（S.unit）。健身房器械 kg、lb 混着标，所以每组可以各写各的单位，
// 这里用 App 自己的 convertWeight 换算成档案单位（kg 取到 0.25、lb 取到 0.5，和 App 切换单位时一致），
// 预览里同时给出原值，让本人看清楚换算结果。写了重量却没写单位直接报错，不按默认单位猜。
import { createHash } from 'node:crypto'
import { convertWeight } from '../../frontend/src/lib/units.js'
import { completedVolumeOf, isWarmupRow } from '../../frontend/src/lib/workout-model.js'
import { buildIndex, describe, resolveExercise, rememberAliases } from './catalog.js'

export class InputError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400 }
}

const UNITS = new Set(['kg', 'lb'])
const num = (v, name, { min = 0, max = Infinity, int = false } = {}) => {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new InputError('invalid_input', `${name} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max}`)
  return n
}

// requestId → 稳定条目 id：同一个请求重试不会多出一条训练。
export const stableId = (prefix, requestId) => prefix + createHash('sha256').update(String(requestId)).digest('hex').slice(0, 16)

function weightIn(profileUnit, weight, unit, fallbackUnit, where) {
  const w = num(weight, `${where}.weight`, { max: 2205 })
  if (w == null) return { w: null, original: null }
  const u = unit || fallbackUnit
  if (!u) throw new InputError('unit_required', `${where}: weight ${w} has no unit; pass unit "kg" or "lb" on the set or once for the whole request`)
  if (!UNITS.has(u)) throw new InputError('invalid_input', `${where}.unit must be "kg" or "lb"`)
  return { w: convertWeight(w, u, profileUnit), original: { weight: w, unit: u } }
}

// 认动作：全部认出才往下走；有没认出的就整体返回 needs_choice，什么都不写。
function resolveAll(exercises, index) {
  if (!Array.isArray(exercises) || !exercises.length) throw new InputError('invalid_input', 'exercises must be a non-empty array')
  if (exercises.length > 30) throw new InputError('invalid_input', 'at most 30 exercises')
  const results = exercises.map((item, i) => {
    if (!item || typeof item !== 'object') throw new InputError('invalid_input', `exercises[${i}] must be an object`)
    if (!item.exercise && !item.exerciseId) throw new InputError('invalid_input', `exercises[${i}] needs exercise (a name) or exerciseId`)
    if (item.remember && !(item.exercise && item.exerciseId)) throw new InputError('invalid_input', `exercises[${i}]: remember needs both exercise (the user's name for it) and exerciseId (the chosen exercise)`)
    return resolveExercise(item, index)
  })
  const unresolved = results.filter(r => !r.ok)
  if (unresolved.length) {
    return {
      choice: {
        status: 'needs_choice',
        message: 'Some exercise names did not match exactly. Nothing was saved. Show the candidates to the user, then resend the same request with exerciseId (and remember: true to save their name as an alias).',
        unresolved: unresolved.map(r => ({ input: r.input, candidates: r.candidates })),
        resolved: results.filter(r => r.ok).map(({ ok, ...r }) => r),
      }
    }
  }
  return { resolved: results }
}

const aliasPairs = (exercises, resolved) => exercises
  .map((item, i) => (item.remember ? { exerciseId: resolved[i].exerciseId, alias: String(item.exercise).trim() } : null))
  .filter(Boolean)

/** at：带时区偏移的 ISO 时间。日期取那个时区里的日子（openGym 的 w.d 是本地日期）。 */
function parseAt(at, name) {
  const m = typeof at === 'string' && /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(at)
  const ms = m ? Date.parse(at) : NaN
  if (!m || !Number.isFinite(ms)) throw new InputError('invalid_input', `${name} must be an ISO date-time with a time zone offset, e.g. 2026-11-12T19:30:00+08:00`)
  return { ms, day: m[1] }
}

/**
 * 记一次已完成的训练。input:
 *   { requestId, at, end?, durationMin?, name?, unit?, note?,
 *     exercises: [{ exercise?, exerciseId?, remember?, note?, sets: [{ reps, weight?, unit?, count?, warmup? }] }] }
 * 返回 { choice } 或 { workout, preview, aliases }，并不改 state——apply 在 applyWorkout。
 */
export function planWorkout(state, input) {
  if (!input?.requestId) throw new InputError('invalid_input', 'requestId is required')
  const index = buildIndex(state)
  const { choice, resolved } = resolveAll(input.exercises, index)
  if (choice) return { choice }
  const profileUnit = state.unit === 'lb' ? 'lb' : 'kg'
  const start = parseAt(input.at, 'at')
  let endMs = null
  if (input.end) {
    endMs = parseAt(input.end, 'end').ms
    if (endMs < start.ms) throw new InputError('invalid_input', 'end is before at')
  } else if (input.durationMin != null) endMs = start.ms + num(input.durationMin, 'durationMin', { min: 1, max: 1440 }) * 60000

  let setCount = 0
  const entries = [], previewEx = []
  input.exercises.forEach((item, i) => {
    const r = resolved[i]
    if (!Array.isArray(item.sets) || !item.sets.length) throw new InputError('invalid_input', `exercises[${i}].sets must be a non-empty array`)
    const sets = [], shown = []
    item.sets.forEach((s, j) => {
      const where = `exercises[${i}].sets[${j}]`
      const reps = num(s.reps, `${where}.reps`, { max: 500, int: true })
      const count = num(s.count ?? 1, `${where}.count`, { min: 1, max: 20, int: true })
      const { w, original } = weightIn(profileUnit, s.weight, s.unit, input.unit, where)
      for (let k = 0; k < count; k++) {
        sets.push({ w: w ?? 0, r: reps ?? 0, done: true, ...(s.warmup ? { phase: 'warmup' } : {}) })
      }
      shown.push({ reps, count, weight: w, unit: profileUnit, ...(original && original.unit !== profileUnit ? { entered: original } : {}), ...(s.warmup ? { warmup: true } : {}) })
    })
    setCount += sets.length
    const work = sets.filter(s => !isWarmupRow(s))
    const topW = Math.max(0, ...work.map(s => s.w || 0)) || null
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, 280) : ''
    entries.push({ id: r.exerciseId, sets, topW, ...(note ? { note } : {}) })
    previewEx.push({ input: r.input, exerciseId: r.exerciseId, name: r.name, match: r.match, sets: shown })
  })
  // 没写结束时间：按每组 40 秒 + 90 秒休息估（同 Hub 力量日志的估法）。
  if (endMs == null) endMs = start.ms + setCount * 130000
  const id = stableId('hub-', input.requestId)
  const name = String(input.name || '').trim().slice(0, 100) || 'Workout'
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) : ''
  const workout = {
    id, d: start.day, start: start.ms, end: endMs,
    routineIds: [], routineId: null, name, entries, prs: [],
    ...(note ? { note } : {}),
    src: 'hub',
  }
  workout.vol = entries.reduce((a, e) => a + e.sets.reduce((b, s) => b + (isWarmupRow(s) ? 0 : completedVolumeOf(s)), 0), 0)
  return {
    workout,
    aliases: aliasPairs(input.exercises, resolved),
    preview: { kind: 'workout', id, date: start.day, name, profileUnit, durationMin: Math.round((endMs - start.ms) / 60000), sets: setCount, volume: workout.vol, exercises: previewEx },
  }
}

/** 把 planWorkout 的结果写进 state（原地）。同一 requestId 已写过就不再写。 */
export function applyWorkout(state, plan) {
  state.workouts = Array.isArray(state.workouts) ? state.workouts : []
  if (state.workouts.some(w => w && w.id === plan.workout.id)) return { duplicate: true, remembered: [] }
  const w = structuredClone(plan.workout)
  // 刷新的个人最佳（按最重的正式组），和 App 导入一样顺手更新下次的推荐重量。
  const best = {}
  for (const old of state.workouts) for (const e of old?.entries || []) best[e.id] = Math.max(best[e.id] || 0, e.topW || 0)
  w.prs = w.entries.filter(e => e.topW && e.topW > (best[e.id] || 0) && best[e.id] != null).map(e => e.id)
  state.workouts = [...state.workouts, w].sort((a, b) => (a.d === b.d ? (a.start || 0) - (b.start || 0) : a.d < b.d ? -1 : 1))
  state.exWeights = { ...(state.exWeights || {}) }
  for (const e of w.entries) {
    if (e.topW > 0) {
      const cur = state.exWeights[e.id]
      if (!cur || w.d >= cur.d) state.exWeights[e.id] = { w: e.topW, d: w.d }
    }
  }
  const remembered = rememberAliases(state, plan.aliases)
  return { duplicate: false, remembered, prs: w.prs }
}

/**
 * 新建一个训练计划（openGym 的 routine）。input:
 *   { requestId, name, unit?, exercises: [{ exercise?, exerciseId?, remember?, sets, reps, weight?, unit?, restSec?, note? }] }
 */
export function planRoutine(state, input) {
  if (!input?.requestId) throw new InputError('invalid_input', 'requestId is required')
  const name = String(input.name || '').trim().slice(0, 60)
  if (!name) throw new InputError('invalid_input', 'name is required')
  const index = buildIndex(state)
  const { choice, resolved } = resolveAll(input.exercises, index)
  if (choice) return { choice }
  const profileUnit = state.unit === 'lb' ? 'lb' : 'kg'
  const ex = [], previewEx = []
  input.exercises.forEach((item, i) => {
    const r = resolved[i], where = `exercises[${i}]`
    const sets = num(item.sets, `${where}.sets`, { min: 1, max: 20, int: true })
    const reps = num(item.reps, `${where}.reps`, { min: 1, max: 500, int: true })
    if (sets == null || reps == null) throw new InputError('invalid_input', `${where} needs sets and reps`)
    const { w, original } = weightIn(profileUnit, item.weight, item.unit, input.unit, where)
    const restSec = num(item.restSec, `${where}.restSec`, { min: 0, max: 3600, int: true })
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, 280) : ''
    ex.push({ id: r.exerciseId, sets, mode: 'reps', reps, weight: w ?? 0, ...(restSec ? { restSec } : {}), ...(note ? { note } : {}) })
    previewEx.push({ input: r.input, exerciseId: r.exerciseId, name: r.name, match: r.match, sets, reps, weight: w, unit: profileUnit, ...(original && original.unit !== profileUnit ? { entered: original } : {}), ...(restSec ? { restSec } : {}) })
  })
  const id = stableId('hubr-', input.requestId)
  return {
    routine: { id, name, emoji: '🏋️', ex },
    aliases: aliasPairs(input.exercises, resolved),
    preview: { kind: 'routine', id, name, profileUnit, exercises: previewEx },
  }
}

export function applyRoutine(state, plan) {
  state.routines = Array.isArray(state.routines) ? state.routines : []
  if (state.routines.some(r => r && r.id === plan.routine.id)) return { duplicate: true, remembered: [] }
  state.routines = [...state.routines, structuredClone(plan.routine)]
  return { duplicate: false, remembered: rememberAliases(state, plan.aliases) }
}

/** 给 Agent 回读用：最近的训练和全部计划，名字用中文。 */
export function summarize(state, { limit = 5 } = {}) {
  const index = buildIndex(state)
  const nameOf = id => describe(index.byId(id))?.name || id
  const workouts = (state.workouts || []).filter(Boolean).slice(-limit).reverse().map(w => ({
    id: w.id, date: w.d, name: w.name, fromHub: w.src === 'hub', sets: (w.entries || []).reduce((n, e) => n + (e.sets || []).length, 0), volume: w.vol ?? null,
    exercises: (w.entries || []).map(e => ({ exerciseId: e.id, name: nameOf(e.id), sets: (e.sets || []).map(s => ({ weight: s.w, reps: s.r, ...(isWarmupRow(s) ? { warmup: true } : {}) })) })),
  }))
  const routines = (state.routines || []).filter(Boolean).map(r => ({
    id: r.id, name: r.name, exercises: (r.ex || []).map(e => ({ exerciseId: e.id, name: nameOf(e.id), sets: e.sets, reps: e.reps, weight: e.weight ?? null, ...(e.restSec ? { restSec: e.restSec } : {}) })),
  }))
  return { unit: state.unit === 'lb' ? 'lb' : 'kg', workouts, routines }
}
