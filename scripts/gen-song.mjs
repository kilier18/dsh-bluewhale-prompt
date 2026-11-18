#!/usr/bin/env node
/**
 * gen-song.mjs —— 一首歌 → 一串「自己编的」唱段动作（不再直接套官方表演片段）
 *
 * 和旧 combo.py / 直接 compose 官方片段的最大区别：
 *   1) 身体/表情全部来自我们自己的段落预设（`scripts/l2d-song-presets.json`：sway / pose / tilt /
 *      nod / look / blink / expression），只写语义，曲线由 `l2d-compile.mjs` 生成；
 *   2) 手臂只从 `正常说话-*` 三条原片里按 1:1 时间重映射（rise→hold→fall），不做任何关节自拧；
 *   3) 口型从音频口型 motion3 里**按段切片**并重基准，所以长歌切成 N 段播放时口型仍然对得上；
 *   4) 段落按权重循环铺满整首歌（4 分钟也没问题），每圈做确定性的强弱抖动，不会一模一样地复读。
 *
 * 用法：
 *   node scripts/gen-song.mjs --duration 36.7587 --out .songs/song-a \
 *        [--mouth 唱歌.motion3.json] [--seg 7] [--lib .motions-lib] [--fps 60]
 *   node scripts/gen-song.mjs --mouth 唱歌.motion3.json --out .songs/song-a     # 时长从口型文件读
 *
 * 产出：
 *   <out>/唱段-01.motion3.json …           每段一条，可直接推 OPFS 的 Custom 组
 *   <out>/song.json                        播放清单（段落名、起止秒、手臂、每段时长）
 *   <out>/plan-XX.json                     每段的语义 plan（可读、可改）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compilePlan } from './l2d-compile.mjs'
import { bakeMotion } from './l2d-bake.mjs'
import { compose } from './l2d-compose.mjs'
import { synthArm, mergeArm } from './l2d-arm.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 2026-11-18c：成品曲线速率限制。语义层叠加 + 多段拼接后，个别接缝会出现瞬时跳变（观感抽搐），
// 这里按关节角速度上限削平，写在 motion3 成品上，与编译顺序无关。
const RATE_LIMIT = { AngleX: 130, AngleY: 130, AngleZ: 130, PositionX: 220, PositionY: 220, PositionZ: 220, LeanInput: 110, ShoulderX: 150 }
function rateLimitCurves(motion) {
  for (const c of motion.Curves) {
    const lim = RATE_LIMIT[c.Id]
    if (!lim) continue
    const seg = c.Segments
    if (!Array.isArray(seg) || seg.length < 5) continue
    // 只处理全 linear（type 0）曲线
    let linear = true
    for (let i = 2; i < seg.length; i += 3) if (seg[i] !== 0) { linear = false; break }
    if (!linear) continue
    let pt = [seg[0], seg[1]]
    for (let i = 2; i < seg.length; i += 3) {
      const t = seg[i + 1], v = seg[i + 2]
      const dt = Math.max(t - pt[0], 1e-4)
      const maxD = lim * dt
      let nv = v
      if (nv - pt[1] > maxD) nv = pt[1] + maxD
      else if (pt[1] - nv > maxD) nv = pt[1] - maxD
      seg[i + 2] = Math.round(nv * 1e6) / 1e6
      pt = [t, nv]
    }
  }
}

const REPO = path.resolve(HERE, '..')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : dflt
}
const OUT = path.resolve(opt('out', path.join(REPO, '.songs', 'song')))
const LIB = path.resolve(opt('lib', process.env.L2D_LIB || path.join(REPO, '.motions-lib')))
const PRESETS = path.resolve(opt('presets', path.join(HERE, 'l2d-song-presets.json')))
const MOUTH = opt('mouth', '') ? path.resolve(opt('mouth', '')) : ''
const FPS = Number(opt('fps', 60))
const SEG = Number(opt('seg', 7))          // 目标段长（秒），长歌靠它切片
const FADE = Number(opt('fade', 0.12))     // 每段首尾淡入淡出（秒），段间接续用

const lib = JSON.parse(fs.readFileSync(PRESETS, 'utf8'))

// ---------- 动作曲线小工具（口型切片用） ----------

/** motion3 的 Segments：`[t0,v0, type,...]`，type=0 跟 2 个数，type=1 跟 6 个数 */
function parseSegments(seg) {
  const pts = [[seg[0], seg[1]]]
  let i = 2
  while (i < seg.length) {
    const type = seg[i]
    if (type === 0) {
      pts.push([seg[i + 1], seg[i + 2]])
      i += 3
    } else if (type === 1) {
      // 贝塞尔：只取端点（口型切片按 60fps 采样，端点足够）
      pts.push([seg[i + 5], seg[i + 6]])
      i += 7
    } else break
  }
  return pts
}

function sampleAt(pts, t) {
  if (!pts.length) return 0
  if (t <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1]
      const [t1, v1] = pts[i]
      const k = t1 - t0 < 1e-9 ? 0 : (t - t0) / (t1 - t0)
      return v0 + (v1 - v0) * k
    }
  }
  return pts[pts.length - 1][1]
}

/** 从口型文件里切 [t0,t1) 这一段，重基准到 0，按 fps 采样成 linear 段 */
function mouthSlice(mouthCurve, t0, t1, fps) {
  const pts = parseSegments(mouthCurve.Segments)
  const n = Math.max(1, Math.round((t1 - t0) * fps))
  const out = [0, Math.max(0, Math.min(1, sampleAt(pts, t0)))]
  for (let i = 1; i <= n; i++) {
    const t = Math.min(t1, t0 + i / fps)
    const v = Math.max(0, Math.min(1, sampleAt(pts, t)))
    out.push(0, Number((t - t0).toFixed(4)), Number(v.toFixed(5)))
  }
  return out
}

// ---------- 段落编排 ----------

const BLOCK = ['verse', 'prechorus', 'chorus', 'verse', 'bridge', 'chorus']
const INTRO = 'intro'
const OUTRO = 'outro'

/** 目标段长 → 段落序列（按 SEG 估算铺满全曲，首尾固定 intro/outro） */
function sectionPlan(total) {
  const est = (n) => SEG * Number(lib.presets[n]?.weight ?? 1)
  const names = []
  let used = 0
  if (lib.presets[INTRO]) {
    names.push(INTRO)
    used += est(INTRO)
  }
  const tail = lib.presets[OUTRO] ? est(OUTRO) : 0
  let k = 0
  while (used + tail < total - 0.5) {
    const n = BLOCK[k % BLOCK.length]
    names.push(n)
    used += est(n)
    k++
    if (k > 400) break
  }
  if (lib.presets[OUTRO]) names.push(OUTRO)
  return names
}

/** 每段的目标时长：按 weight 归一化，但夹在 4~9 秒，避免出现 30 秒一段 */
function segmentLengths(names, total) {
  const w = names.map((n) => Number(lib.presets[n]?.weight ?? 1))
  const sum = w.reduce((a, b) => a + b, 0)
  const raw = w.map((x) => (total * x) / sum)
  const clamped = raw.map((x) => Math.min(9, Math.max(3.2, x)))
  const cs = clamped.reduce((a, b) => a + b, 0)
  const scaled = clamped.map((x) => (x * total) / cs)
  // 让总时长精确等于 total（误差摊到最长的那段）
  const diff = total - scaled.reduce((a, b) => a + b, 0)
  const imax = scaled.indexOf(Math.max(...scaled))
  scaled[imax] += diff
  return scaled
}

/** 段内动作：预设里 at/duration 是相对秒，按段长缩放；同一段重复出现时做确定性抖动 */
function segmentActions(section, len, rep) {
  const p = lib.presets[section]
  if (!p) return []
  const baseLen = 8 // 预设是按 ~8 秒写的
  const k = len / baseLen
  const jitter = 1 + 0.1 * Math.sin(rep * 1.7)
  const acts = []
  for (const a of p.actions) {
    const at = Number((a.at * k).toFixed(3))
    if (at >= len - 0.2) continue
    const dur = Math.min(Number((a.duration ?? 1) * k), len - at)
    if (dur < 0.25) continue
    const out = { ...a, at, duration: Number(dur.toFixed(3)) }
    if (a.kind === 'sway') {
      out.strength = Number(((a.strength ?? 0.6) * jitter).toFixed(3))
      if (a.period) out.period = Number((a.period * (1 + 0.07 * Math.cos(rep * 1.3))).toFixed(2))
    }
    if ((a.kind === 'nod' || a.kind === 'tilt' || a.kind === 'smile') && a.strength != null) {
      out.strength = Number((a.strength * jitter).toFixed(3))
    }
    acts.push(out)
  }
  return acts
}

const ARM_CLIP = { hand: '正常说话-抚胸', point: '正常说话-食指' }
// 整首歌只用一个手势（抚胸通用），中途换手会破坏「长时间保持」并且必然出现换手硬切
const armFor = (_section) => 'hand'
const ARM_MODE = String(opt('arm', 'synth')) // synth = 自己生成手臂曲线（默认）；clip = 重映射官方原片

// ---------- 主流程 ----------

function readMouth(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const curve = (j.Curves || []).find((c) => c.Id === 'ParamMouthOpenY')
  if (!curve) throw new Error(`口型文件里没有 ParamMouthOpenY：${file}`)
  return { curve, duration: Number(j.Meta?.Duration ?? 0) }
}

const mouth = MOUTH ? readMouth(MOUTH) : null
const total = Number(opt('duration', 0)) || mouth?.duration
if (!total || total < 3) throw new Error('需要 --duration 或带口型的 --mouth 文件')

fs.mkdirSync(OUT, { recursive: true })
const names = sectionPlan(total)
const lens = segmentLengths(names, total)

const tmp = fs.mkdtempSync(path.join(OUT, '.tmp-'))
const manifest = { duration: Number(total.toFixed(4)), fps: FPS, seg: SEG, mouth: MOUTH || null, segments: [] }
let cursor = 0
let ok = 0
const warnings = []

names.forEach((section, i) => {
  const len = Number(lens[i].toFixed(4))
  const at = Number(cursor.toFixed(4))
  cursor += len
  const rep = Math.floor(i / BLOCK.length)
  const actions = segmentActions(section, len, rep)
  if (!actions.length) return

  const plan = { version: 1, title: `唱段 ${String(i + 1).padStart(2, '0')} · ${section}`, duration: len, actions }
  let ir
  try {
    ir = compilePlan(plan)
  } catch (e) {
    warnings.push(`段 ${i + 1}（${section}）编译失败：${e.message}`)
    return
  }
  const baked = bakeMotion(ir, { fps: FPS })
  const baseFile = path.join(tmp, `b${i}.motion3.json`)
  fs.writeFileSync(baseFile, JSON.stringify(baked), 'utf8')

  const arm = armFor(section)
  let motion
  if (ARM_MODE === 'clip') {
    const armFile = path.join(LIB, `${ARM_CLIP[arm]}.motion3.json`)
    if (!fs.existsSync(armFile)) {
      warnings.push(`缺手臂原片 ${armFile}（先跑 scripts/pull-motions.mjs）`)
      return
    }
    const spec = {
      duration: len,
      fps: FPS,
      base: baseFile,
      arms: armFile,
      armMap: [
        { src: [0, 1.1], at: 0, to: Math.min(1.1, len) },
        { src: [1.1, 22.0], at: Math.min(1.1, len), to: Math.max(Math.min(1.1, len) + 0.1, len - Math.min(2.0, len * 0.25)) },
        { src: [22.0, 24.0], at: Math.max(0, len - Math.min(2.0, len * 0.25)), to: len },
      ],
    }
    const specFile = path.join(tmp, `c${i}.json`)
    fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')
    try {
      motion = compose(spec, tmp)
    } catch (e) {
      warnings.push(`段 ${i + 1} 合成失败：${e.message}`)
      return
    }
  } else {
    // 自己生成手臂曲线：整首歌只在首段抬手、末段收回，中段一直保持（否则手一直在摆）
    const isFirst = i === 0
    const isLast = i === names.length - 1
    const rise = isFirst ? Math.min(1.4, Math.max(0.9, len * 0.25)) : 0.05
    const fall = isLast ? Math.min(2.2, Math.max(1.2, len * 0.3)) : 0.05
    const a = synthArm(arm, len, { rise, fall, fps: FPS, fromMix: isFirst ? 0 : 1, toMix: isLast ? 0 : 1 })
    motion = mergeArm(baked, a, { fade: 0 })
  }

  // 口型：按段切片，替换掉 compose 结果里的 ParamMouthOpenY（如果有）
  if (mouth) {
    const seg = mouthSlice(mouth.curve, at, at + len, FPS)
    motion.Curves = motion.Curves.filter((c) => c.Id !== 'ParamMouthOpenY')
    motion.Curves.push({ Target: 'Parameter', Id: 'ParamMouthOpenY', Segments: seg })
    // ⚠️ 必须重算 Meta：Cubism 按 CurveCount 读曲线，少 1 就等于把最后这条（口型）丢掉
    let segs = 0
    let points = 0
    for (const c of motion.Curves) {
      const n = Math.max(0, Math.round((c.Segments.length - 2) / 3))
      segs += n
      points += n + 1
    }
    motion.Meta.CurveCount = motion.Curves.length
    motion.Meta.TotalSegmentCount = segs
    motion.Meta.TotalPointCount = points
  }
  rateLimitCurves(motion)
  // 限速后重新统计段数/点数
  {
    let segs = 0, points = 0
    for (const c of motion.Curves) {
      const n = Math.max(0, Math.round((c.Segments.length - 2) / 3))
      segs += n
      points += n + 1
    }
    motion.Meta.CurveCount = motion.Curves.length
    motion.Meta.TotalSegmentCount = segs
    motion.Meta.TotalPointCount = points
  }
  motion.Meta.FadeInTime = FADE
  motion.Meta.FadeOutTime = FADE
  motion.Meta.Loop = false

  const name = `唱段-${String(i + 1).padStart(2, '0')}`
  const file = path.join(OUT, `${name}.motion3.json`)
  const json = JSON.stringify(motion)
  fs.writeFileSync(file, json, 'utf8')
  fs.writeFileSync(path.join(OUT, `plan-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify(plan, null, 1), 'utf8')
  manifest.segments.push({
    name,
    section,
    at,
    duration: len,
    arm: ARM_MODE === 'clip' ? ARM_CLIP[arm] : `synth:${arm}`,
    curves: motion.Curves.length,
    bytes: Buffer.byteLength(json),
  })
  ok++
})

fs.rmSync(tmp, { recursive: true, force: true })
fs.writeFileSync(path.join(OUT, 'song.json'), JSON.stringify(manifest, null, 1), 'utf8')

console.log(JSON.stringify({
  ok: true,
  out: OUT,
  duration: manifest.duration,
  segments: ok,
  totalBytes: manifest.segments.reduce((s, x) => s + x.bytes, 0),
  mouthSliced: Boolean(mouth),
  warnings,
}, null, 1))
