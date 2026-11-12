import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planWorkout, applyWorkout, planRoutine, applyRoutine, summarize } from '../src/build.js'
import { normalizeName } from '../src/catalog.js'

const base = () => ({ unit: 'kg', workouts: [], routines: [], customEx: [], exWeights: {}, exAliases: {} })
// 截图里的那组：同一张卡片上 kg 与 lb 混着。
const screenshot = (overrides = {}) => ({
  requestId: 'req-1', at: '2026-11-12T19:30:00+08:00', name: '背 + 肩',
  exercises: [
    { exercise: '坐姿划船', sets: [{ reps: 12, weight: 80, unit: 'lb', count: 4 }] },
    { exercise: '高位下拉', sets: [{ reps: 12, weight: 80, unit: 'lb', count: 4 }] },
    { exercise: '面拉', sets: [{ reps: 12, weight: 10, unit: 'lb', count: 4 }] },
    { exercise: '坐姿夹胸', sets: [{ reps: 12, weight: 50, unit: 'lb', count: 4 }] },
    { exercise: '哑铃推肩', sets: [{ reps: 12, weight: 2.5, unit: 'kg', count: 4 }] },
  ],
  ...overrides,
})

test('normalizeName ignores full-width brackets, spaces and case', () => {
  assert.equal(normalizeName('器械坐姿划船（坐姿划船机）'), normalizeName('器械坐姿划船 (坐姿划船机)'))
  assert.equal(normalizeName('Dumbbell  Seated-Shoulder Press'), 'dumbbellseatedshoulderpress')
})

test('names that do not match exactly come back as a choice, nothing is planned', () => {
  const p = planWorkout(base(), screenshot())
  assert.equal(p.choice.status, 'needs_choice')
  const unresolved = p.choice.unresolved.map(u => u.input)
  assert.deepEqual(unresolved, ['坐姿划船', '高位下拉', '坐姿夹胸'])
  for (const u of p.choice.unresolved) {
    assert.ok(u.candidates.length > 0 && u.candidates.length <= 5, u.input)
    assert.ok(u.candidates.every(c => c.id && c.name && c.nameEn))
  }
  // 「面拉」「哑铃推肩」是动作库里的原名，直接认出。
  assert.deepEqual(p.choice.resolved.map(r => [r.exerciseId, r.match]), [['0203', 'name'], ['0405', 'name']])
})

test('candidates for 坐姿划船 are rows, the shortest names first', () => {
  const p = planWorkout(base(), screenshot())
  const row = p.choice.unresolved[0].candidates
  assert.ok(row.every(c => c.name.includes('划船')), JSON.stringify(row.map(c => c.name)))
})

const chosen = () => screenshot({
  exercises: [
    { exercise: '坐姿划船', exerciseId: '1235', remember: true, sets: [{ reps: 12, weight: 80, unit: 'lb', count: 4 }] },
    { exercise: '高位下拉', exerciseId: '2330', remember: true, sets: [{ reps: 12, weight: 80, unit: 'lb', count: 4 }] },
    { exercise: '面拉', exerciseId: '5607', remember: true, sets: [{ reps: 12, weight: 10, unit: 'lb', count: 4 }] },
    { exercise: '坐姿夹胸', exerciseId: '3869', remember: true, sets: [{ reps: 12, weight: 50, unit: 'lb', count: 4 }] },
    { exercise: '哑铃推肩', sets: [{ reps: 12, weight: 2.5, unit: 'kg', count: 4 }] },
  ],
})

test('mixed lb/kg converts to the profile unit with the entered value kept in the preview', () => {
  const p = planWorkout(base(), chosen())
  assert.equal(p.preview.profileUnit, 'kg')
  assert.equal(p.preview.sets, 20)
  const row = p.preview.exercises[0]
  assert.deepEqual(row.sets[0], { reps: 12, count: 4, weight: 36.25, unit: 'kg', entered: { weight: 80, unit: 'lb' } })
  assert.equal(p.preview.exercises[4].sets[0].entered, undefined)   // already kg
  assert.equal(p.workout.d, '2026-11-12')
  assert.equal(p.workout.entries[0].sets.length, 4)
  assert.deepEqual(p.workout.entries[0].sets[0], { w: 36.25, r: 12, done: true })
})

test('a profile in lb keeps lb values and converts kg', () => {
  const p = planWorkout({ ...base(), unit: 'lb' }, chosen())
  assert.equal(p.preview.exercises[0].sets[0].weight, 80)
  assert.equal(p.preview.exercises[4].sets[0].weight, 5.5)
})

test('a weight without a unit is refused, not guessed', () => {
  const input = chosen()
  delete input.exercises[0].sets[0].unit
  assert.throws(() => planWorkout(base(), input), e => e.code === 'unit_required')
  // 训练级单位可以兜底
  assert.doesNotThrow(() => planWorkout(base(), { ...input, unit: 'lb' }))
})

test('applying writes the workout once, seeds next weights and remembers aliases', () => {
  const S = base()
  const p = planWorkout(S, chosen())
  const r1 = applyWorkout(S, p)
  assert.equal(r1.duplicate, false)
  assert.equal(S.workouts.length, 1)
  assert.equal(S.workouts[0].src, 'hub')
  assert.deepEqual(S.exWeights['1235'], { w: 36.25, d: '2026-11-12' })
  assert.deepEqual(r1.remembered.map(r => r.alias), ['坐姿划船', '高位下拉', '面拉', '坐姿夹胸'])
  assert.deepEqual(S.exAliases['1235'], ['坐姿划船'])
  // 同一 requestId 重发：不重复
  const r2 = applyWorkout(S, planWorkout(S, chosen()))
  assert.equal(r2.duplicate, true)
  assert.equal(S.workouts.length, 1)
  // 下次同样的叫法直接认出
  const next = planWorkout(S, screenshot({ requestId: 'req-2' }))
  assert.equal(next.choice, undefined)
  assert.deepEqual(next.preview.exercises.map(e => e.match), ['alias', 'alias', 'alias', 'alias', 'name'])
})

test('a heavier set than before is a PR; the very first session is not', () => {
  const S = base()
  applyWorkout(S, planWorkout(S, chosen()))
  const heavier = chosen()
  heavier.requestId = 'req-3'
  heavier.at = '2026-11-14T19:30:00+08:00'
  heavier.exercises[0].sets[0].weight = 90
  const r = applyWorkout(S, planWorkout(S, heavier))
  assert.deepEqual(r.prs, ['1235'])
})

test('a routine keeps targets, rest and converted weights', () => {
  const S = base()
  const p = planRoutine(S, {
    requestId: 'r-1', name: '背 + 肩',
    exercises: [
      { exerciseId: '1235', sets: 4, reps: 12, weight: 80, unit: 'lb', restSec: 60 },
      { exerciseId: '0405', sets: 4, reps: 12, weight: 2.5, unit: 'kg', restSec: 60 },
    ],
  })
  assert.deepEqual(p.routine.ex[0], { id: '1235', sets: 4, mode: 'reps', reps: 12, weight: 36.25, restSec: 60 })
  applyRoutine(S, p)
  assert.equal(applyRoutine(S, p).duplicate, true)
  assert.equal(S.routines.length, 1)
  const sum = summarize(S)
  assert.equal(sum.routines[0].exercises[1].name, '哑铃推肩')
})

test('bad input is refused with a code', () => {
  assert.throws(() => planWorkout(base(), { ...chosen(), at: '2026-11-12 19:30' }), e => e.code === 'invalid_input')
  assert.throws(() => planWorkout(base(), { ...chosen(), requestId: '' }), e => e.code === 'invalid_input')
  assert.throws(() => planWorkout(base(), { ...chosen(), exercises: [{ exerciseId: 'nope', sets: [{ reps: 1 }] }] }), e => e.code === 'unknown_exercise')
  assert.throws(() => planWorkout(base(), { ...chosen(), exercises: [{ exercise: 'x', remember: true, sets: [{ reps: 1 }] }] }), e => e.code === 'invalid_input')
})
