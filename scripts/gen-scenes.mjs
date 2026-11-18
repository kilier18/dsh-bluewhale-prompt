#!/usr/bin/env node
// gen-scenes.mjs —— 给每个「会话场景」生成一条复合动作（作者身体片段的活跃窗口 + 作者手臂原片）
//
// 为什么这样做：官方 44 条动作里，`表演-*` 是作者已经编好的复合表演（重心 + 头 + 表情 + 手臂），
// 直接播放最自然；缺的只是「从哪一秒开始」和「手臂用哪条原片」。所以每个场景 =
//     body 片段的 bestWindow（字典算的活跃窗口）+ 手臂原片的 rise/hold/fall 三段重映射。
// 手臂只用三条：抚胸（通用）/ 食指（讲话、点子）/ 狗尾草（摸鱼、装傻、搞怪）。
//
// 用法：
//   node scripts/gen-scenes.mjs --lib .motions-lib --out .tmp/scenes [--only greet,shy]
// 产物：out/场景-<key>.motion3.json + out/scenes.json（名字、时长、用了哪条身体/手臂）
import fs from 'node:fs'
import path from 'node:path'
import { compose } from './l2d-compose.mjs'
import { bestWindow } from '../src/l2d-dict.js'

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const LIB = path.resolve(opt('lib', '.motions-lib'))
const OUT = path.resolve(opt('out', '.tmp/scenes'))
const ONLY = (opt('only', '') || '').split(',').filter(Boolean)

/**
 * 场景表。
 * arm: hand=抚胸（通用） / point=食指（讲话·点子） / grass=狗尾草（摸鱼·装傻·搞怪）
 * keepKeys: 保留作者片段里的换脸键（脸红这类叠加型可以用，整脸换层的不行）
 */
const SCENES = {
  greet:   { body: '表演-04-俏皮', dur: 6.0, arm: 'hand' },
  bye:     { body: '表演-09-沉稳', dur: 5.0, arm: 'hand' },
  explain: { body: '表演-10-决意', dur: 9.0, arm: 'point' },
  agree:   { body: '表演-04-俏皮', dur: 4.0, arm: 'hand' },
  deny:    { body: '情绪-生气-2', dur: 4.5, arm: 'point' },
  confuse: { body: '表演-01-疑惑', dur: 6.0, arm: 'hand' },
  idea:    { body: '情绪-心动-1', dur: 5.0, arm: 'point' },
  shy:     { body: '情绪-害羞-1', dur: 6.0, arm: 'hand', keepKeys: true },
  sing:    { body: '情绪-温柔-1', dur: 3.0, arm: 'hand' },
  think:   { body: '表演-01-疑惑', dur: 8.0, arm: 'hand' },
  listen:  { body: '表演-09-沉稳', dur: 8.0, arm: 'hand' },
  cheer:   { body: '表演-11-淘气', dur: 6.0, arm: 'hand' },
  tired:   { body: '表演-02-脆弱', dur: 7.0, arm: 'hand' },
  wow:     { body: '情绪-惊讶-1', dur: 3.6, arm: 'hand' },
  comfort: { body: '情绪-温柔-1', dur: 5.0, arm: 'hand' },
  upset:   { body: '情绪-难过-1', dur: 6.0, arm: 'hand' },
  // 摸鱼 / 装傻 / 搞怪：这三类才用狗尾草
  slack:   { body: '表演-08-狗尾草', dur: 7.0, arm: 'grass' },
  silly:   { body: '表演-11-淘气', dur: 6.0, arm: 'grass' },
  tease:   { body: '表演-13-造型', dur: 6.0, arm: 'grass' },
}

const ARM_CLIP = { hand: '正常说话-抚胸', point: '正常说话-食指', grass: '正常说话-狗尾草' }
const RISE = 1.1 // 作者原片抬手段
const FALL = 2.0 // 作者原片放手段
const HOLD_END = 22.0 // 作者原片保持段的终点

const clip = (name) => path.join(LIB, `${name}.motion3.json`)
const missing = []
for (const [key, s] of Object.entries(SCENES)) {
  for (const n of [s.body, ARM_CLIP[s.arm]]) {
    if (!fs.existsSync(clip(n))) missing.push(`${key}: ${n}`)
  }
}
if (missing.length) {
  console.error('✗ 缺动作原件（先用 scripts/pull-motions.mjs 拉）：\n  ' + missing.join('\n  '))
  process.exit(1)
}

fs.mkdirSync(OUT, { recursive: true })
const report = []
const keys = Object.keys(SCENES).filter((k) => !ONLY.length || ONLY.includes(k))

const round2 = (v) => Math.round(v * 100) / 100

for (const key of keys) {
  const s = SCENES[key]
  const w = bestWindow(s.body, s.dur)
  const at = Math.max(0, Math.min(w.at, Math.max(0, s.dur - 0.5)))
  const dur = round2(s.dur)
  const armName = ARM_CLIP[s.arm]

  // 手臂三段：抬手 1:1，保持段拉伸到 dur-FALL，放手 1:1
  const holdTo = round2(Math.max(RISE + 1.0, dur - FALL))
  const armMap = [
    { src: [0, RISE], at: 0, to: RISE },
    { src: [RISE, HOLD_END], at: RISE, to: holdTo },
    { src: [HOLD_END, 24.0], at: holdTo, to: dur },
  ]

  const name = `场景-${key}`
  const spec = {
    base: clip(s.body),
    baseStart: at,
    duration: dur,
    arms: clip(armName),
    armMap,
    keepKeys: Boolean(s.keepKeys),
  }
  let obj
  try {
    obj = compose(spec, LIB)
  } catch (e) {
    console.error(`✗ ${key}: ${e.message}`)
    continue
  }
  const json = JSON.stringify(obj)
  fs.writeFileSync(path.join(OUT, `${name}.motion3.json`), json, 'utf8')
  const stat = { curves: obj.Curves.length, bytes: Buffer.byteLength(json) }
  report.push({
    key,
    name,
    dur,
    body: s.body,
    bodyAt: round2(at),
    bodyScore: w.score,
    arm: armName,
    ...stat,
  })
  console.log(`✓ ${name}  ${dur}s  ${s.body}@${round2(at)}s + ${armName}  ${stat.curves} 曲线 ${stat.bytes} B`)
}

fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(report, null, 1), 'utf8')
console.log(`\n共 ${report.length} 条 → ${OUT}`)
console.log('下一步：node .tmp/push-dir.mjs "<out 目录>"  然后改 src/posemap.js 的 SCENES')
