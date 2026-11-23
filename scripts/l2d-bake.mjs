#!/usr/bin/env node
/**
 * l2d-bake.mjs —— 参数轨道 IR → Live2D .motion3.json（直接可推 OPFS 给 airi 播）
 *
 * 踩过的坑，全部体现在这里：
 *  - Segments 布局：首两点是裸 [t0, v0]，之后每段 [type, t, v]；type=0 线性。
 *  - **同参数多条轨道必须合成一条**（motion3 里一个参数只能有一条曲线，重复 Id 会让引擎只认一条）。
 *  - FadeInTime/FadeOutTime 固定 0：曲线本身已是 smoothstep，再让 airi 淡入 = 三重软化（起手慢的元凶）。
 *  - 表情叠加层（眼泪/汗滴…）默认不烘，免得把上一段的眼泪固化；--with-overlay 才带。
 *  - Meta.TotalSegmentCount / TotalPointCount 必须逐曲线累加。
 *  - --mouth：把音频驱动的 ParamMouthOpenY 直接从另一条 motion3 搬过来（不重采样，避免插值过冲）。
 *
 * 用法：
 *   node l2d-bake.mjs ir.json -o out.motion3.json [--fps 60] [--with-overlay] [--mouth clip.motion3.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_FPS = 60

const round4 = (v) => Math.round(v * 1e4) / 1e4
const round6 = (v) => Math.round(v * 1e6) / 1e6

export function loadParamsForBake(file = path.join(HERE, '..', 'dict', 'l2d-params.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const defaults = {}
  for (const [id, p] of Object.entries(j.parameters)) defaults[id] = p.default
  return { params: j, defaults }
}

function samplePoints(points, local, fallback) {
  if (!points.length) return fallback
  if (local <= points[0][0]) return points[0][1]
  const last = points[points.length - 1]
  if (local >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]
    if (local <= t1) {
      const [t0, v0] = points[i - 1]
      if (t1 === t0) return v1
      return v0 + (v1 - v0) * ((local - t0) / (t1 - t0))
    }
  }
  return last[1]
}

export function bakeMotion(ir, opts = {}) {
  const fps = opts.fps ?? DEFAULT_FPS
  const withOverlay = !!opts.withOverlay
  const { params, defaults } = opts.params ? { params: opts.params, defaults: opts.defaults } : loadParamsForBake(opts.paramsFile)
  const skip = new Set(withOverlay ? [] : params.overlay || [])
  const dt = 1 / fps
  const duration = ir.duration
  const n = Math.max(1, Math.round(duration * fps))

  // 1) 先按参数合并（同参数多段：时间窗内取该段，窗外回默认值）
  const byId = new Map()
  for (const t of ir.tracks) {
    if (skip.has(t.id) && t.owner !== 'expression') continue
    if (!byId.has(t.id)) byId.set(t.id, [])
    byId.get(t.id).push(t)
  }

  const curves = []
  for (const [id, list] of byId) {
    const base = defaults[id] ?? 0
    const valueAt = (time) => {
      for (const t of list) {
        if (time >= t.start - 1e-9 && time <= t.start + t.duration + 1e-9) {
          return samplePoints(t.points, time - t.start, base)
        }
      }
      return base
    }
    const seg = [0, round6(valueAt(0))]
    let points = 1
    let segments = 0
    let lastV = seg[1]
    for (let i = 1; i <= n; i++) {
      const time = Math.min(duration, i * dt)
      const v = round6(valueAt(time))
      if (Math.abs(v - lastV) < 1e-6 && i !== n) continue
      seg.push(0, round4(time), v)
      segments++
      points++
      lastV = v
    }
    if (segments === 0) {
      seg.push(0, round4(duration), round6(lastV))
      segments++
      points++
    }
    curves.push({ Target: 'Parameter', Id: id, Segments: seg, __points: points, __segments: segments })
  }

  // 2) 口型：直接搬源段（不重采样），裁到 duration
  if (opts.mouth) {
    const src = loadMouthSegments(opts.mouth)
    const seg = [src[0], src[1]]
    let points = 1
    let segments = 0
    let lastV = src[1]
    for (let i = 2; i < src.length; i += 3) {
      const t = src[i + 1]
      if (t > duration) break
      seg.push(0, round4(t), round6(src[i + 2]))
      lastV = src[i + 2]
      segments++
      points++
    }
    if (seg[seg.length - 2] < duration) {
      seg.push(0, round4(duration), round6(lastV))
      segments++
      points++
    }
    const idx = curves.findIndex((c) => c.Id === 'ParamMouthOpenY')
    const entry = { Target: 'Parameter', Id: 'ParamMouthOpenY', Segments: seg, __points: points, __segments: segments }
    if (idx >= 0) curves[idx] = entry
    else curves.push(entry)
  }

  // 3) Movement1/2/3 是「换手组」权重，必须逐帧二值化：否则淡出中间态 = 两套手臂绑骨同时半开 = 残影/多一条手
  binarizeMovements(curves, duration, fps)

  const totalSeg = curves.reduce((s, c) => s + c.__segments, 0)
  const totalPoint = curves.reduce((s, c) => s + c.__points, 0)
  const meta = {
    Duration: round4(duration),
    Fps: fps,
    Loop: false,
    AreBeziersRestricted: true,
    CurveCount: curves.length,
    TotalSegmentCount: totalSeg,
    TotalPointCount: totalPoint,
    UserDataCount: 0,
    TotalUserDataSize: 0,
    FadeInTime: 0,
    FadeOutTime: 0,
  }
  const clean = curves.map(({ __points, __segments, ...c }) => c)
  return { Version: 3, Meta: meta, Curves: clean }
}

function segToPoints(seg) {
  const pts = [[seg[0], seg[1]]]
  for (let i = 2; i < seg.length; i += 3) pts.push([seg[i + 1], seg[i + 2]])
  return pts
}

function binarizeMovements(curves, duration, fps) {
  const names = ['Movement1', 'Movement2', 'Movement3']
  const found = names.map((n) => curves.find((c) => c.Id === n)).filter(Boolean)
  if (found.length < 2) return
  const n = Math.max(1, Math.round(duration * fps))
  const dt = 1 / fps
  const series = found.map((c) => {
    const pts = segToPoints(c.Segments)
    const arr = []
    for (let i = 0; i <= n; i++) arr.push(samplePoints(pts, Math.min(duration, i * dt), 0))
    return arr
  })
  const bin = found.map(() => [])
  for (let i = 0; i <= n; i++) {
    let best = 0
    let bi = -1
    for (let k = 0; k < series.length; k++) {
      if (series[k][i] > best) {
        best = series[k][i]
        bi = k
      }
    }
    for (let k = 0; k < series.length; k++) bin[k].push(best <= 1e-6 ? 0 : k === bi ? 1 : 0)
  }
  found.forEach((c, k) => {
    const vals = bin[k]
    const seg = [0, vals[0]]
    let points = 1
    let segments = 0
    let last = vals[0]
    for (let i = 1; i <= n; i++) {
      if (vals[i] === last && i !== n) continue
      seg.push(0, round4(Math.min(duration, i * dt)), vals[i])
      segments++
      points++
      last = vals[i]
    }
    c.Segments = seg
    c.__points = points
    c.__segments = segments
  })
}

function loadMouthSegments(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const c = (j.Curves || []).find((x) => x.Id === 'ParamMouthOpenY')
  if (!c) throw new Error('口型源里没有 ParamMouthOpenY：' + file)
  return c.Segments
}

if (process.argv[1] && process.argv[1].endsWith('l2d-bake.mjs')) {
  const args = process.argv.slice(2)
  const irFile = args.find((a) => !a.startsWith('-'))
  const oi = args.indexOf('-o')
  const outFile = oi >= 0 ? args[oi + 1] : irFile.replace(/\.json$/, '') + '.motion3.json'
  const fi = args.indexOf('--fps')
  const fps = fi >= 0 ? Number(args[fi + 1]) : DEFAULT_FPS
  const mi = args.indexOf('--mouth')
  const mouth = mi >= 0 ? args[mi + 1] : null
  try {
    const ir = JSON.parse(fs.readFileSync(irFile, 'utf8'))
    const motion = bakeMotion(ir, { fps, withOverlay: args.includes('--with-overlay'), mouth })
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(motion), 'utf8')
    console.log(JSON.stringify({
      ok: true, out: outFile,
      duration: motion.Meta.Duration, fps,
      curves: motion.Meta.CurveCount,
      segments: motion.Meta.TotalSegmentCount,
      points: motion.Meta.TotalPointCount,
      bytes: fs.statSync(outFile).size,
      fadeIn: motion.Meta.FadeInTime, fadeOut: motion.Meta.FadeOutTime,
      mouth: mouth ? 'replaced' : 'none',
    }, null, 2))
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2))
    process.exit(1)
  }
}
