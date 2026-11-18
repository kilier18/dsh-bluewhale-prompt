#!/usr/bin/env node
/**
 * l2d-compile.mjs —— 自然语言动作 plan → 参数轨道 IR（不依赖 Python，可直接嵌插件）
 *
 * 端口自 jingyu-live2d-agent 的 compiler.py（语义原语 → 参数轨道），
 * 差异：手势的「退出」不依赖原生 exit 片段（我们那套 动作-* 是坏的），
 *      改为「采样作者动作的 rise 段 → 保持 → 合成 0.35s smoothstep 退出」。
 *
 * 用法（CLI）：
 *   node l2d-compile.mjs plan.json [-o ir.json] [--params l2d-params.json]
 * 模块：
 *   import { compilePlan, CompileError } from './l2d-compile.mjs'
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PARAMS = path.join(HERE, '..', 'dict', 'l2d-params.json')
const LIB_DIR = process.env.L2D_LIB || path.resolve('.motions-lib')
const DRIVER_VERSION = '0.1.0'
const EPS = 0.015
const EXIT_FADE = 0.35
const SMOOTH = (x) => x * x * (3 - 2 * x)

export class CompileError extends Error {}

// ────────────────────────────── 参数表 ──────────────────────────────
let CACHE = null
export function loadParams(file = DEFAULT_PARAMS) {
  if (CACHE && CACHE.__file === file) return CACHE
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  j.__file = file
  CACHE = j
  return j
}

const P = (params, id) => {
  const p = params.parameters[id]
  if (!p) return null
  return p
}
const clamp = (params, id, v) => {
  const p = P(params, id)
  if (!p) return v
  return Math.min(p.max, Math.max(p.min, v))
}
const def = (params, id) => (P(params, id)?.default ?? 0)

// ────────────────────────────── 曲线工具 ──────────────────────────────
function holdTrack(pid, value, at, duration, params, meta = {}) {
  const d = def(params, pid)
  const v = clamp(params, pid, value)
  const fade = Math.min(meta.fade ?? 0.42, duration * 0.28)
  const pts = [[0, d], [fade, v], [Math.max(fade, duration - fade), v], [duration, d]]
  return track(pid, at, duration, pts, {
    label: meta.label ?? 'hold',
    action: meta.action,
    owner: meta.owner ?? 'semantic',
    stage: meta.stage ?? 'motion',
    ...(meta.expression ? { expression: meta.expression } : {}),
  })
}

function track(pid, start, duration, points, meta = {}) {
  const pts = points
    .map(([t, v]) => [Math.round(t * 1e5) / 1e5, Math.round(v * 1e6) / 1e6])
    .sort((a, b) => a[0] - b[0])
  return { id: pid, start, duration, points: pts, ...meta }
}

function waves(pid, amp, at, duration, count, params, meta = {}) {
  const sym = meta.symmetric !== false
  const d = def(params, pid)
  const n = Math.max(1, Math.round(count))
  const w = duration / n
  const pts = [[0, d], [duration * 0.12, clamp(params, pid, d - amp * 0.16)]]
  for (let i = 0; i < n; i++) {
    const st = i * w
    pts.push([st, d])
    pts.push([st + w * 0.32, clamp(params, pid, d + amp * (1 - 0.1 * (i % 3)))])
    pts.push([st + w * 0.76, clamp(params, pid, d - amp * (sym ? 0.85 : 0.18))])
  }
  pts.push([duration, d])
  return track(pid, at, duration, pts, meta)
}

// ────────────────────────────── 作者动作采样 ──────────────────────────────
const clipCache = new Map()
export function loadClip(name, libDir = LIB_DIR) {
  if (clipCache.has(name)) return clipCache.get(name)
  const file = path.join(libDir, `${name}.motion3.json`)
  if (!fs.existsSync(file)) throw new CompileError(`找不到动作片段：${name}（${file}）`)
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const curves = new Map()
  for (const c of j.Curves) curves.set(c.Id, parseSegments(c.Segments))
  const out = { name, duration: j.Meta?.Duration ?? 0, curves }
  clipCache.set(name, out)
  return out
}

function parseSegments(s) {
  const pts = [[s[0], s[1]]]
  let i = 2
  while (i < s.length) {
    const ty = s[i]
    if (ty === 0 || ty === 2 || ty === 3) {
      pts.push([s[i + 1], s[i + 2]])
      i += 3
    } else if (ty === 1) {
      pts.push([s[i + 5], s[i + 6]])
      i += 7
    } else break
  }
  return pts
}

function sampleAt(pts, t) {
  if (!pts.length) return 0
  if (t <= pts[0][0]) return pts[0][1]
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i]
    if (t <= t1) {
      const [t0, v0] = pts[i - 1]
      if (t1 === t0) return v1
      const k = SMOOTH((t - t0) / (t1 - t0))
      return v0 + (v1 - v0) * k
    }
  }
  return pts[pts.length - 1][1]
}

// ────────────────────────────── 表情（exp3） ──────────────────────────────
const DEFAULT_EXPR = path.join(HERE, '..', 'dict', 'l2d-expressions.json')
let EXPR_CACHE = null
export function loadExpressions(file = DEFAULT_EXPR) {
  if (EXPR_CACHE && EXPR_CACHE.__file === file) return EXPR_CACHE
  if (!fs.existsSync(file)) throw new CompileError(`缺表情缓存 ${file}，先跑 node pull-exp3.mjs`)
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  j.__file = file
  EXPR_CACHE = j
  return j
}

// ────────────────────────────── 各 kind ──────────────────────────────
const HAND_JOINTS = ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
  'Param55', 'Param56', 'Param57', 'Param58', 'Param59', 'Param60', 'Param61', 'Param62', 'ShoulderX']

function kLook(a, params, out) {
  const dir = normalDir(a.dir)
  const s = num(a.strength, 1)
  const dur = num(a.duration, 1.6)
  const at = num(a.at, 0)
  out.push(holdTrack('ParamEyeBallX', dir.x * 0.75 * s, at, dur, params, { label: '眼球横向', action: 'look' }))
  out.push(holdTrack('ParamEyeBallY', dir.y * 0.6 * s, at, dur, params, { label: '眼球纵向', action: 'look' }))
  out.push(holdTrack('AngleX', dir.x * 28 * s, at + Math.min(0.09, dur * 0.1), Math.max(0.2, dur - 0.09), params, { label: '头转向', action: 'look', fade: 0.55 }))
  out.push(holdTrack('AngleY', -dir.y * 18 * s, at + 0.12, Math.max(0.2, dur - 0.12), params, { label: '头俯仰', action: 'look', fade: 0.55 }))
}

function kNod(a, params, out, shake = false) {
  const s = num(a.strength, 1)
  const count = Math.min(4, Math.max(1, num(a.count, 2)))
  const dur = Math.max(0.9, Math.min(3, num(a.duration, 0.55 * count * 2)))
  const at = num(a.at, 0)
  if (shake) {
    out.push(waves('AngleX', 20 * s, at, dur, count, params, { label: '摇头', action: 'shake_head' }))
  } else {
    out.push(waves('AngleY', -15 * s, at, dur, count, params, { label: '点头', action: 'nod' }))
    out.push(waves('PositionY', -3 * s, at + 0.05, Math.max(0.4, dur - 0.05), count, params, { label: '点头起伏', action: 'nod' }))
  }
}

function kTilt(a, params, out) {
  const dir = Math.sign(num(a.dir, 1)) || 1
  const s = num(a.strength, 1)
  const dur = num(a.duration, 2.2)
  const at = num(a.at, 0)
  out.push(holdTrack('PositionZ', -dir * 9 * s, at, dur, params, { label: '歪头纵深', action: 'tilt', fade: 0.7 }))
}

function kSmile(a, params, out) {
  const s = num(a.strength, 1)
  const dur = num(a.duration, 2.4)
  const at = num(a.at, 0)
  out.push(holdTrack('ParamMouthForm', 0.8 * s, at, dur, params, { label: '嘴角', action: 'smile' }))
  out.push(holdTrack('EyeSmile', 0.65 * s, at, dur, params, { label: '眼弯', action: 'smile' }))
  out.push(holdTrack('MouthSmile_L', 0.55 * s, at, dur, params, { label: '嘴形左', action: 'smile' }))
  out.push(holdTrack('MouthSmile_R', 0.55 * s, at, dur, params, { label: '嘴形右', action: 'smile' }))
}

function kBlink(a, params, out) {
  const count = Math.min(4, Math.max(1, num(a.count, 1)))
  const dur = num(a.duration, 0.6 * count)
  const at = num(a.at, 0)
  const w = Math.min(0.32, (dur / count) * 0.65)
  const pts = [[0, 1]]
  for (let i = 0; i < count; i++) {
    const st = (i * dur) / count
    pts.push([st + w * 0.45, 0], [st + w, 1])
  }
  pts.push([dur, 1])
  for (const pid of ['ParamEyeLOpen', 'ParamEyeROpen']) {
    out.push(track(pid, at, dur, pts, { label: '眨眼', action: 'blink', owner: 'semantic', stage: 'motion' }))
  }
}

function kTalk(a, params, out) {
  const s = num(a.strength, 1)
  const dur = num(a.duration, 2)
  const at = num(a.at, 0)
  const pts = []
  const n = Math.max(2, Math.round(dur * 8))
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * dur
    const v = (0.15 + 0.48 * Math.abs(Math.sin(2.31 * i))) * s
    pts.push([t, clamp(params, 'ParamMouthOpenY', v)])
  }
  out.push(track('ParamMouthOpenY', at, dur, pts, { label: '说话嘴型', action: 'talk', owner: 'semantic', stage: 'motion' }))
}

function kPose(a, params, out) {
  const dur = num(a.duration, 2)
  const at = num(a.at, 0)
  for (const [pid, v] of Object.entries(a.params || a.values || {})) {
    if (params.physicsOutputs.includes(pid)) throw new CompileError(`pose 不能写物理输出参数 ${pid}`)
    if (!P(params, pid)) throw new CompileError(`pose 里有模型没有的参数 ${pid}`)
    out.push(holdTrack(pid, num(v, 0), at, dur, params, { label: '定格', action: 'pose' }))
  }
}

// 2026-11-18：身体大幅度动作。胸腔/位移参数（ParamBodyAngle*）是整套手臂物理链的输入，
// 写它 = 真的扭腰/前伸，比 PositionX 平移明显得多（PositionX 只是整张贴图横移）。
function kBody(a, params, out) {
  const at = num(a.at, 0)
  const dur = num(a.duration, 3)
  const fade = num(a.fade, 0.8)
  const add = (pid, v) => {
    if (!v) return
    if (!P(params, pid)) return
    out.push(holdTrack(pid, num(v, 0), at, dur, params, { label: '身体·' + pid, action: 'body', fade }))
  }
  add('ParamBodyAngleZ', a.twist)     // 扭腰（+ 左扭 / - 右扭）
  add('ParamBodyAngleX', a.lean)      // 前倾 / 后仰
  add('ParamBodyAngleY', a.side)      // 左右侧倾
  add('ParamBodyAngleRX', a.shiftX)   // 身体位移横
  add('ParamBodyAngleRZ', a.shiftZ)   // 身体位移纵深
  add('Param138', a.jitter)           // 身体抖动
  if (!out.length) throw new CompileError('body 至少要给 twist/lean/side/shiftX/shiftZ 之一')
}

// 扭腰律动：一圈一圈地扭，用来撑副歌
function kTwist(a, params, out) {
  const at = num(a.at, 0)
  const dur = num(a.duration, 6)
  const amp = num(a.amplitude, 12)
  const count = Math.min(6, Math.max(1, num(a.count, 3)))
  if (!P(params, 'ParamBodyAngleZ')) throw new CompileError('模型没有 ParamBodyAngleZ')
  out.push(waves('ParamBodyAngleZ', amp, at, dur, count, params, { label: '扭腰', action: 'twist', symmetric: true }))
  if (a.lean !== undefined) out.push(holdTrack('ParamBodyAngleX', num(a.lean, 0), at, dur, params, { label: '身体前倾', action: 'twist', fade: 0.9 }))
}

function kSway(a, params, out) {
  // 身体摇晃：不换手势，只让重心/侧身/前倾缓慢摆（唱歌长时保持时的「底噪」）
  // 2026-11-18b：加大幅度到官方表演量级；lean/bias 给「一直偏向一侧」的撒娇式姿态
  const dur = num(a.duration, 8)
  const at = num(a.at, 0)
  const s = num(a.strength, 1)
  const lean = num(a.lean, 0)      // 静态前倾偏移（负=后仰）
  const bias = num(a.bias, 0)      // 静态侧倾偏移（AngleZ）
  const period = Math.max(3, Math.min(18, num(a.period, 8)))
  const cycles = Math.max(1, Math.round(dur / period))
  const add = (pid, amp, label, symmetric, off = 0) => {
    const tr = waves(pid, amp, at, dur, cycles, params, { label, action: 'sway', symmetric })
    if (off) for (const pt of tr.points) pt[1] = clamp(params, pid, pt[1] + off)
    out.push(tr)
  }
  add('PositionX', 10 * s, '摇晃·重心', true)
  add('LeanInput', 8 * s, '摇晃·前倾', false, lean)
  // 侧身/扭身：AngleZ 是这张皮上唯一能看出「转身」的通道（ParamBodyAngle* 实测无效）
  add('AngleZ', 15 * s, '摇晃·侧身', true, bias)
}

// 2026-11-18c：撒娇式的「低头 + 重心后甩 + 身体侧倾 + 位移」合成一段语义动作，
// 与 sway 的常驻摇晃相加（ADDITIVE 参数会被合并成一条曲线），因此不必互相避让。
function kLean(a, params, out) {
  const dur = num(a.duration, 3)
  const at = num(a.at, 0)
  const s = num(a.strength, 1)
  const head = num(a.head, -18)
  const side = num(a.side, -12)
  const weight = num(a.weight, -16)
  const shiftX = num(a.shiftX, -12)
  const depth = num(a.depth, -8)
  const fade = Math.min(num(a.fade, 0.55), dur * 0.34)
  const mk = (pid, value, label) => {
    const tr = holdTrack(pid, value * s, at, dur, params, { label, action: 'lean', blend: 'add' })
    tr.fade = fade
    out.push(tr)
  }
  mk('AngleX', head, '倾斜·低头')
  mk('AngleZ', side, '倾斜·侧身')
  mk('LeanInput', weight, '倾斜·重心')
  if (shiftX) mk('PositionX', shiftX * 0.8, '倾斜·位移')
  if (depth) mk('PositionZ', depth, '倾斜·纵深')
}

function kExpression(a, params, out, opts) {
  const lib = loadExpressions(opts.expressionsFile)
  const name = a.name || a.source
  const e = lib[name]
  if (!e) throw new CompileError(`未知表情「${name}」（可用：${Object.keys(lib).join('、')}）`)
  const s = num(a.strength, 1)
  const dur = num(a.duration, 3)
  const at = num(a.at, 0)
  const layer = a.layer || 'exclusive'
  for (const p of e.parameters) {
    if (!P(params, p.id)) continue
    const base = def(params, p.id)
    const blend = p.blend || 'Add'
    let v
    if (blend === 'Multiply') v = base * (1 + (num(p.value, 1) - 1) * s)
    else if (blend === 'Overwrite') v = base + (num(p.value, 0) - base) * s
    else v = base + num(p.value, 0) * s
    out.push(holdTrack(p.id, v, at, dur, params, {
      label: `表情·${name}`, action: 'expression', owner: 'expression', stage: 'expression',
      expression: { blend, value: num(p.value, 0), layer, strength: s },
      fade: Math.min(e.fadeIn || 1, dur * 0.3),
    }))
  }
  if (!out.length) throw new CompileError(`表情「${name}」没有任何可用参数`)
}

function kTrajectory(a, params, out) {
  const frames = Array.isArray(a.frames) ? a.frames : []
  if (frames.length < 2) throw new CompileError('trajectory 至少要 2 帧')
  const dur = num(a.duration, frames[frames.length - 1].time ?? 2)
  const at = num(a.at, 0)
  const keys = new Set()
  for (const f of frames) for (const k of Object.keys(f.params || f.values || {})) keys.add(k)
  for (const pid of keys) {
    if (params.physicsOutputs.includes(pid)) throw new CompileError(`trajectory 不能写物理输出参数 ${pid}`)
    if (!P(params, pid)) throw new CompileError(`trajectory 里有模型没有的参数 ${pid}`)
    const pts = [[0, def(params, pid)]]
    for (const f of frames) {
      const v = (f.params || f.values || {})[pid]
      if (v == null) continue
      pts.push([num(f.time, 0), clamp(params, pid, num(v, 0))])
    }
    pts.push([dur, def(params, pid)])
    out.push(track(pid, at, dur, pts, { label: '轨迹', action: 'trajectory', owner: 'semantic', stage: 'motion' }))
  }
}

function kGesture(a, params, out, opts) {
  const gname = a.name || a.gesture
  const g = params.gestures[gname]
  if (!g) throw new CompileError(`未知手势 ${gname}（可选：${Object.keys(params.gestures).join('/')}）`)
  const at = num(a.at, 0)
  const dur = Math.max(g.rise + EXIT_FADE + 0.3, num(a.duration, 4.5))
  const s = num(a.strength, 1)
  const clip = loadClip(g.clip, opts.libDir)
  const FPS = 45
  const nRise = Math.max(2, Math.round(g.rise * FPS))
  const holdEnd = dur - EXIT_FADE
  // accents 折进同一条轨道（不另起 track，否则同参数撞车）
  const accents = (a.accents || []).map((acc) => {
    const accStart = num(acc.at, 0)
    const accDur = Math.max(0.2, num(acc.duration, 1))
    if (accStart < g.rise - 0.01 || accStart + accDur > holdEnd + 0.01) {
      throw new CompileError(`accent 越界：应落在手势进入(${g.rise}s)之后、退出(${EXIT_FADE}s)之前`)
    }
    const map = {}
    for (const [k, v] of Object.entries(acc.values || acc.params || {})) {
      const pid = g.joints[k] || k
      if (!Object.values(g.joints).includes(pid) && !HAND_JOINTS.includes(pid)) {
        throw new CompileError(`accent 参数 ${k} 不属于手势 ${gname}`)
      }
      map[pid] = num(v, 0)
    }
    return { start: accStart, dur: accDur, values: map }
  })
  // 参与采样：手势关节 + 三个 Movement 开关
  const pids = new Set([...Object.values(g.joints), g.movement, 'Movement1', 'Movement2', 'Movement3'])
  for (const pid of pids) {
    if (!P(params, pid)) continue
    const src = clip.curves.get(pid)
    const base = def(params, pid)
    const pts = []
    for (let i = 0; i <= nRise; i++) {
      const t = (i / nRise) * g.rise
      const raw = src ? sampleAt(src, t) : base
      // 强度缩放：以 default 为锚（和上游 amplitude 语义一致）
      let v = base + (raw - base) * s
      if (pid.startsWith('Movement')) v = raw > 0.5 ? 1 : 0
      pts.push([t, clamp(params, pid, v)])
    }
    const peak = pts[pts.length - 1][1]
    if (pid.startsWith('Movement')) {
      pts.push([holdEnd, peak], [dur, 0])
    } else {
      const mine = accents.filter((x) => pid in x.values).sort((x, y) => x.start - y.start)
      let cursor = g.rise
      for (const acc of mine) {
        const v = clamp(params, pid, base + (acc.values[pid] - base) * s)
        pts.push([Math.max(cursor, acc.start), peak])
        pts.push([acc.start + 0.18, v], [acc.start + acc.dur - 0.18, v])
        cursor = acc.start + acc.dur
      }
      pts.push([Math.max(cursor, holdEnd), peak])
      pts.push([holdEnd + EXIT_FADE * 0.5, clamp(params, pid, base + (peak - base) * 0.45)], [dur, base])
    }
    out.push(track(pid, at, dur, pts, { label: `手势·${g.label || gname}`, action: 'gesture', owner: 'native-gesture', stage: 'motion' }))
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────
export function compilePlan(plan, opts = {}) {
  const params = opts.params || loadParams(opts.paramsFile)
  if (!plan || typeof plan !== 'object') throw new CompileError('plan 必须是对象')
  const version = plan.version ?? 1
  if (version !== 1) throw new CompileError(`不支持的 plan.version=${version}`)
  const actions = plan.actions
  if (!Array.isArray(actions) || actions.length < 1) throw new CompileError('plan.actions 不能为空')
  if (actions.length > 64) throw new CompileError(`plan.actions 最多 64 段，收到 ${actions.length}`)

  const tracks = []
  const steps = []
  const warnings = []

  actions.forEach((a, idx) => {
    const kind = a.kind
    const at = num(a.at, 0)
    const duration = num(a.duration, 1)
    if (at < 0) throw new CompileError(`第 ${idx + 1} 段 at 不能为负`)
    if (duration < 0.2 || duration > 59) throw new CompileError(`第 ${idx + 1} 段 duration 必须在 0.2..59 之间（收到 ${duration}）`)
    steps.push({ index: idx, kind, at, duration })
    const before = tracks.length
    switch (kind) {
      case 'look': kLook(a, params, tracks); break
      case 'nod': kNod(a, params, tracks, false); break
      case 'shake_head': kNod(a, params, tracks, true); break
      case 'tilt': kTilt(a, params, tracks); break
      case 'sway': kSway(a, params, tracks); break
      case 'lean': kLean(a, params, tracks); break
      case 'smile': kSmile(a, params, tracks); break
      case 'blink': kBlink(a, params, tracks); break
      case 'talk': kTalk(a, params, tracks); break
      case 'pose': kPose(a, params, tracks); break
      case 'body': kBody(a, params, tracks); break
      case 'twist': kTwist(a, params, tracks); break
      case 'trajectory': kTrajectory(a, params, tracks); break
      case 'gesture': kGesture(a, params, tracks, opts); break
      case 'expression': kExpression(a, params, tracks, opts); break
      default:
        throw new CompileError(`未知 action.kind=${kind}（可用：look/nod/shake_head/tilt/sway/smile/blink/talk/pose/trajectory/gesture/expression）`)
    }
    if (tracks.length === before) throw new CompileError(`第 ${idx + 1} 段 ${kind} 没有产生任何参数`)
  })

  // 2026-11-18c：肢体层（头/身/重心）默认「相加」而不是报冲突——
  // sway 是常驻底噪，lean/pose/look 只是往上叠一个偏移，符合真人动作的叠加关系。
  const ADDITIVE = new Set(['AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput', 'ShoulderX'])
  {
    const groups = new Map()
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      if (!ADDITIVE.has(t.id) || t.stage === 'expression') continue
      if (!groups.has(t.id)) groups.set(t.id, [])
      groups.get(t.id).push(i)
    }
    const drop = new Set()
    for (const [pid, idxs] of groups) {
      if (idxs.length < 2) continue
      const list = idxs.map((i) => tracks[i])
      const t0 = Math.min(...list.map((t) => t.start))
      const t1 = Math.max(...list.map((t) => t.start + t.duration))
      const step = 1 / 60
      const pts = []
      for (let t = t0; t <= t1 + 1e-9; t += step) {
        let v = 0
        for (const tr of list) {
          const local = t - tr.start
          if (local < -1e-9 || local > tr.duration + 1e-9) continue
          const f = tr.points[0][0]
          if (local < f) continue            // 起点前不贡献，避免凭空跳变
          v += samplePoints(tr.points, local)
        }
        pts.push([Math.round(t * 1e5) / 1e5, clamp(params, pid, v)])
      }
      const merged = {
        id: pid, start: t0, duration: t1 - t0, points: pts,
        action: 'mix', label: `叠加·${pid}`, owner: 'semantic', stage: 'motion',
      }
      for (const i of idxs) drop.add(i)
      tracks.push(merged)
    }
    if (drop.size) {
      const kept = tracks.filter((_, i) => !drop.has(i))
      tracks.length = 0
      tracks.push(...kept)
    }
  }

  // 2026-11-18c：速率限制（rate limit）——叠加出来的曲线可能出现瞬时跳变（各源轨起点/波谷错位），
  // 这里按「真人关节角速度上限」把相邻点的大跳变削平，观感上就是顺滑过渡而不是抽搐。
  {
    const LIMIT = { AngleX: 130, AngleY: 130, AngleZ: 130, PositionX: 220, PositionY: 220, PositionZ: 220, LeanInput: 110, ShoulderX: 150 }
    for (const tr of tracks) {
      const lim = LIMIT[tr.id]
      if (!lim || !tr.points || tr.points.length < 3) continue
      for (let i = 1; i < tr.points.length; i++) {
        const [t0, v0] = tr.points[i - 1]
        const [t1, v1] = tr.points[i]
        const maxD = lim * Math.max(t1 - t0, 1e-4)
        if (v1 - v0 > maxD) tr.points[i][1] = v0 + maxD
        else if (v0 - v1 > maxD) tr.points[i][1] = v0 - maxD
      }
    }
  }

  // 冲突检测：同一参数、都非 overlay、时间重叠 > EPS
  const byId = new Map()
  for (const t of tracks) {
    if (!byId.has(t.id)) byId.set(t.id, [])
    byId.get(t.id).push(t)
  }
  for (const [pid, list] of byId) {
    list.sort((x, y) => x.start - y.start)
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]
      const b = list[i]
      const overlap = Math.min(a.start + a.duration, b.start + b.duration) - Math.max(a.start, b.start)
      if (overlap <= EPS) continue
      // 表情可叠在语义动作上（overlay），但表情之间、语义之间不许撞
      const exprCount = (a.stage === 'expression' ? 1 : 0) + (b.stage === 'expression' ? 1 : 0)
      if (exprCount === 1) continue
      throw new CompileError(`「${a.label}」与「${b.label}」同时控制 ${pid}（重叠 ${overlap.toFixed(2)}s）`)
    }
  }

  // 手势间距：手臂动作之间必须留出「手放下」的空档，否则像换姿势瞬移
  const HAND_GAP_MIN = num(plan.handGapMin, 1.2)
  const spans = actions
    .filter((a) => a.kind === 'gesture')
    .map((a) => {
      const g = params.gestures[a.name || a.gesture] || {}
      const dur = Math.max((g.rise || 1) + EXIT_FADE + 0.3, num(a.duration, 4.5))
      return { at: num(a.at, 0), end: num(a.at, 0) + dur, name: a.name || a.gesture }
    })
    .sort((x, y) => x.at - y.at)
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i].at - spans[i - 1].end
    if (gap < HAND_GAP_MIN - 1e-6) {
      warnings.push(`手势「${spans[i - 1].name}」→「${spans[i].name}」只隔 ${gap.toFixed(2)}s（建议 ≥${HAND_GAP_MIN}s，让手先回到身侧）`)
    }
  }

  const duration = Math.round((Math.max(...tracks.map((t) => t.start + t.duration)) + 0.7) * 1e4) / 1e4
  if (duration > 60) throw new CompileError(`总时长 ${duration}s 超过 60s`)

  return {
    version: 1,
    driverVersion: DRIVER_VERSION,
    intent: plan.intent ?? '',
    summary: plan.summary ?? '',
    duration,
    tracks,
    steps,
    warnings: [...new Set(warnings)].sort(),
    sourcePlan: plan,
    policy: {
      returnToIdle: true,
      easing: 'smoothstep',
      parameterLimits: 'moc3-core',
      exitFade: EXIT_FADE,
    },
  }
}

function samplePoints(pts, t) {
  if (!pts || !pts.length) return 0
  if (t <= pts[0][0]) return pts[0][1]
  const last = pts[pts.length - 1]
  if (t >= last[0]) return last[1]
  let lo = 0, hi = pts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid][0] <= t) lo = mid; else hi = mid
  }
  const [ta, va] = pts[lo]
  const [tb, vb] = pts[hi]
  const k = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta)
  return va + (vb - va) * k
}

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
function normalDir(dir) {
  if (Array.isArray(dir)) {
    const x = Math.max(-1, Math.min(1, num(dir[0], 0)))
    const y = Math.max(-1, Math.min(1, num(dir[1], 0)))
    return { x, y }
  }
  const s = String(dir || 'center')
  return { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, center: { x: 0, y: 0 } }[s] || { x: 0, y: 0 }
}

// ────────────────────────────── CLI ──────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('l2d-compile.mjs')) {
  const args = process.argv.slice(2)
  const iPlan = args.findIndex((a) => !a.startsWith('-'))
  const planFile = args[iPlan]
  const oIdx = args.indexOf('-o')
  const outFile = oIdx >= 0 ? args[oIdx + 1] : planFile.replace(/\.json$/, '') + '.ir.json'
  const pIdx = args.indexOf('--params')
  const paramsFile = pIdx >= 0 ? args[pIdx + 1] : DEFAULT_PARAMS
  try {
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    const ir = compilePlan(plan, { paramsFile })
    fs.writeFileSync(outFile, JSON.stringify(ir, null, 1), 'utf8')
    const ids = new Set(ir.tracks.map((t) => t.id))
    console.log(JSON.stringify({
      ok: true, out: outFile, duration: ir.duration,
      tracks: ir.tracks.length, params: ids.size, actions: ir.steps.length,
      warnings: ir.warnings,
    }, null, 2))
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2))
    process.exit(1)
  }
}
