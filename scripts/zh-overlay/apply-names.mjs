#!/usr/bin/env node
// 中文动作名补丁：把 names-zh.json 里审校过的简体中文名写进 catalogue/i18n/zh.json，
// 然后由 scripts/catalogue/build.mjs 重新生成 App 用的文件。
//
//   node scripts/zh-overlay/apply-names.mjs           写入并重新生成
//   node scripts/zh-overlay/apply-names.mjs --dry-run 只打印统计
//
// 规则：只动 name，不动 description / instructions。
//   原版当前名 == 审校前名        → 换成审校后名
//   原版当前名 == 审校后名        → 已经一样，跳过
//   原版自己改过这个名字           → 按审校的术语规则（TERMS）统一原版的新名字；
//                                    统一后与审校名相同就用审校名，否则保留（统一后的）原版名并列入冲突清单
// 换完不许出现新的重名（两个动作同一个中文名，搜索和别名会分不清）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const I18N = path.join(ROOT, 'catalogue/i18n/zh.json')
const DATA = path.join(ROOT, 'scripts/zh-overlay/names-zh.json')
const CONFLICTS = path.join(ROOT, 'scripts/zh-overlay/conflicts.json')
const dryRun = process.argv.includes('--dry-run')

// 审校准则里能机械套用的几条（docs/dev/EXERCISE_NAMES_ZH_CN_REVIEW.md）。
const TERMS = [
  [/\s*v\.\s*(\d+)/g, '（变式$1）'], [/杠杆式|杠杆/g, '器械'], [/稳定球/g, '健身球'], [/悬挂训练带|悬挂带/g, '悬吊带'],
  [/后三角肌/g, '三角肌后束'], [/史密斯(?!机)/g, '史密斯机'], [/插片式/g, '挂片式'], [/EZ杠铃|EZ杠/g, 'EZ曲杆'],
]
export const normalizeTerms = s => TERMS.reduce((a, [re, to]) => a.replace(re, to), String(s))

export function applyNames(i18n, names) {
  const stats = { replaced: 0, same: 0, normalized: 0, conflict: 0, missing: 0 }
  const conflicts = {}
  for (const [id, [before, after]] of Object.entries(names)) {
    const cur = i18n[id]?.name
    if (!i18n[id]) { stats.missing++; continue }
    if (cur === after) stats.same++
    else if (cur === before || cur == null) { i18n[id] = { ...i18n[id], name: after }; stats.replaced++ }
    else {
      const norm = normalizeTerms(cur)
      if (norm === after) { i18n[id] = { ...i18n[id], name: after }; stats.normalized++ }
      else {
        if (norm !== cur) i18n[id] = { ...i18n[id], name: norm }
        conflicts[id] = { upstream: cur, kept: norm, reviewed: after, before }; stats.conflict++
      }
    }
  }
  return { stats, conflicts }
}

export function duplicateGroups(i18n) {
  const by = new Map()
  for (const [id, v] of Object.entries(i18n)) if (v?.name) by.set(v.name, [...(by.get(v.name) || []), id])
  return [...by].filter(([, ids]) => ids.length > 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = fs.readFileSync(I18N, 'utf8')
  const i18n = JSON.parse(raw)
  const { names } = JSON.parse(fs.readFileSync(DATA, 'utf8'))
  const dupBefore = new Set(duplicateGroups(i18n).map(([n]) => n))
  const { stats, conflicts } = applyNames(i18n, names)
  const newDups = duplicateGroups(i18n).filter(([n]) => !dupBefore.has(n))
  console.log(`zh names: ${stats.replaced} replaced, ${stats.same} already equal, ${stats.normalized} matched after term rules, ${stats.conflict} kept upstream (conflict), ${stats.missing} unknown id`)
  if (newDups.length) {
    console.error('new duplicate names:\n' + newDups.map(([n, ids]) => `  ${n}: ${ids.join(', ')}`).join('\n'))
    process.exit(1)
  }
  if (dryRun) process.exit(0)
  // 保持原文件的格式：一行一个动作，与原版生成器写出的一致。
  const indent = /^\{\n( +)"/.exec(raw)?.[1] ?? '  '
  fs.writeFileSync(I18N, JSON.stringify(i18n, null, indent.length) + '\n')
  fs.writeFileSync(CONFLICTS, JSON.stringify(conflicts, null, 1) + '\n')
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/catalogue/build.mjs')], { stdio: 'inherit' })
}
