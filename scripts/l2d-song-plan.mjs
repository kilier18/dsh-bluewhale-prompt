#!/usr/bin/env node
/**
 * l2d-song-plan.mjs —— 唱歌编排生成器（鲸语语义层）
 *
 * 作用：把「段落预设」拼成一首歌的完整 plan.json，全程只写语义
 * （sway / look / nod / tilt / smile / blink / pose / expression），
 * 不写任何一帧曲线，最后交给 l2d-compile → l2d-bake → l2d-compose。
 *
 * 用法：
 *   node l2d-song-plan.mjs --duration 36.7587 --out plan.json \
 *        [--presets D:/DSH/tools/l2d-song-presets.json] [--sections verse,prechorus,chorus,chorus,outro] \
 *        [--guard 1.3]
 *
 * --guard：开头这么多秒里不放身体动作（留白给抬手），避免"起手时身体和手臂互相拉扯"
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dflt
}
const duration = Number(opt('duration', 36.7587))
const out = opt('out', 'plan.json')
const presetsFile = opt('presets', 'D:/DSH/tools/l2d-song-presets.json')
const guard = Number(opt('guard', 1.3))
const sectionsArg = opt('sections', '')

const lib = JSON.parse(fs.readFileSync(presetsFile, 'utf8'))
const names = sectionsArg ? sectionsArg.split(',').map((s) => s.trim()).filter(Boolean) : lib.order
const weights = names.map((n) => {
  const p = lib.presets[n]
  if (!p) throw new Error(`没有预设「${n}」（有：${Object.keys(lib.presets).join('、')}）`)
  return Number(p.weight ?? 1)
})
const sum = weights.reduce((a, b) => a + b, 0)
const lengths = weights.map((w) => (duration * w) / sum)

const actions = []
let t0 = 0
names.forEach((name, i) => {
  const p = lib.presets[name]
  const len = lengths[i]
  for (const a of p.actions) {
    if (a.at >= len) continue
    const dur = Math.min(a.duration ?? 1, len - a.at)
    if (dur < 0.25) continue
    const start = t0 + a.at
    // guard：开头留白，身体类动作一律推迟
    if (start < guard && ['sway', 'pose', 'tilt', 'look'].includes(a.kind)) continue
    actions.push({ ...a, at: Number(start.toFixed(3)), duration: Number(dur.toFixed(3)) })
  }
  t0 += len
})


// 若末尾没有被 sway 覆盖，补一小段（否则最后会硬定住）
if (!actions.some((a) => a.kind === 'sway' && a.at + a.duration >= duration - 0.6)) {
  actions.push({ kind: 'sway', at: Number((duration - 1.2).toFixed(3)), duration: 1.2, strength: 0.25, period: 6 })
}

const plan = {
  version: 1,
  title: `唱歌编排 · ${names.join(' / ')}`,
  intent: '由 l2d-song-plan.mjs 按段落预设生成：只写语义，曲线交给编译器',
  duration: Number(duration.toFixed(4)),
  sections: names.map((n, i) => ({ name: n, at: Number((lengths.slice(0, i).reduce((a, b) => a + b, 0)).toFixed(3)), duration: Number(lengths[i].toFixed(3)) })),
  actions,
}
fs.writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8')
console.log(JSON.stringify({
  ok: true, out, duration, guard,
  sections: plan.sections.map((s) => `${s.name}@${s.at}+${s.duration}`),
  actions: actions.length,
  kinds: actions.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {}),
}, null, 1))
