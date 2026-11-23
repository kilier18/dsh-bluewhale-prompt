#!/usr/bin/env node
/**
 * gen-arm-poses.mjs —— 从 `正常说话-*` 原片里量出「手势保持段」的关节角度常量
 *
 * 为什么只量常量、不存曲线：手臂美术（三套绑骨）只有三个合法姿态。把保持段的稳态值量出来，
 * 之后由 `l2d-arm.mjs` 自己生成「抬起 → 保持 → 收回」的曲线，就再也不依赖官方片段了。
 *
 * 用法：
 *   node scripts/gen-arm-poses.mjs [--lib .motions-lib] [--out dict/l2d-arm-poses.json] [--at 12]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 ? argv[i + 1] : d
}
const LIB = path.resolve(opt('lib', process.env.L2D_LIB || path.join(REPO, '.motions-lib')))
const OUT = path.resolve(opt('out', path.join(REPO, 'dict', 'l2d-arm-poses.json')))
const AT = Number(opt('at', 12))

const CLIPS = {
  hand: '正常说话-抚胸.motion3.json',
  point: '正常说话-食指.motion3.json',
  grass: '正常说话-狗尾草.motion3.json',
}
const KEYS = [
  'Movement1', 'Movement2', 'Movement3',
  'Param11', 'Param27', 'Param28', 'Param29', 'Param30', 'Param31', 'Param32',
  'Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
  'Param55', 'Param56', 'Param57', 'Param58', 'Param59', 'Param60', 'Param61', 'Param62',
  'ShoulderX',
]

function points(seg) {
  const out = [[seg[0], seg[1]]]
  let i = 2
  while (i < seg.length) {
    const t = seg[i]
    if (t === 0) { out.push([seg[i + 1], seg[i + 2]]); i += 3 }
    else if (t === 1) { out.push([seg[i + 5], seg[i + 6]]); i += 7 }
    else break
  }
  return out
}
function valueAt(p, t) {
  if (t <= p[0][0]) return p[0][1]
  for (let i = 0; i + 1 < p.length; i++) {
    const [t0, v0] = p[i]
    const [t1, v1] = p[i + 1]
    if (t <= t1) return t1 - t0 < 1e-9 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
  }
  return p[p.length - 1][1]
}

const poses = {}
for (const [key, file] of Object.entries(CLIPS)) {
  const p = path.join(LIB, file)
  if (!fs.existsSync(p)) {
    console.error(`⚠ 缺原片 ${p}（先用 scripts/pull-motions.mjs 拉动作）`)
    continue
  }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  const curves = new Map(j.Curves.map((c) => [c.Id, points(c.Segments)]))
  const pose = {}
  for (const k of KEYS) if (curves.has(k)) pose[k] = Number(valueAt(curves.get(k), AT).toFixed(4))
  poses[key] = { clip: file.replace('.motion3.json', ''), at: AT, joints: pose }
  console.log(key, '→', Object.keys(pose).length, '个关节')
}
const out = {
  __note:
    '手势保持段的稳态关节值（从官方原片的保持中点量出来）。曲线由 scripts/l2d-arm.mjs 自己生成，不再复用官方 motion3。',
  generatedBy: 'scripts/gen-arm-poses.mjs',
  sampledAt: AT,
  poses,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8')
console.log('写出', OUT, fs.statSync(OUT).size, 'B')
