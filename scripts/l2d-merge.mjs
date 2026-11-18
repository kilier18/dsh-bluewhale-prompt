#!/usr/bin/env node
/**
 * l2d-merge.mjs —— 把「作者做好的 motion3」按参数分层拼成一条成品动作
 *
 * 为什么要有它：合成参数（自己填 accent 数值）会把手臂掰歪。这里的原则是
 * **一个参数只认一个作者来源**，我们只负责决定「谁在什么时间段说话」，绝不发明关节数值。
 *
 * 层类型：
 *   base    —— 打底：口型、头、呼吸、眨眼（一般是唱歌.motion3.json 或 待机.motion3.json）
 *   arms    —— 手臂层：Movement1/2/3 + Param36..43 + Param55..62 + ShoulderX，来自作者的手势片段
 *
 * 用法：
 *   node l2d-merge.mjs spec.json -o out.motion3.json
 *
 * spec：
 * {
 *   "duration": 36.7587,
 *   "fps": 60,
 *   "base": "唱歌.motion3.json",
 *   "mouth": "唱歌.motion3.json",
 *   "layers": [
 *     { "file": "正常说话-抚胸.motion3.json", "kind": "arms", "at": 0.8, "holdTo": 36.2, "fadeOut": 0.4 }
 *   ]
 * }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const round4 = (v) => Math.round(v * 1e4) / 1e4
const round6 = (v) => Math.round(v * 1e6) / 1e6

export const ARMS = new Set([
  'Movement1', 'Movement2', 'Movement3',
  'Param36', 'Param37', 'Param38', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
  'Param55', 'Param56', 'Param57', 'Param58', 'Param59', 'Param60', 'Param61', 'Param62',
  'ShoulderX', 'Param44', 'Param45', 'Param46',
])
export const MOUTH = 'ParamMouthOpenY'

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

function load(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const curves = new Map()
  for (const c of j.Curves) curves.set(c.Id, parseSegments(c.Segments))
  return { file, duration: j.Meta?.Duration ?? 0, curves }
}

function sample(pts, t) {
  if (!pts || !pts.length) return null
  if (t <= pts[0][0]) return pts[0][1]
  const last = pts[pts.length - 1]
  if (t >= last[0]) return last[1]
  // 二分找区间
  let lo = 0
  let hi = pts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid][0] <= t) lo = mid
    else hi = mid
  }
  const [t0, v0] = pts[lo]
  const [t1, v1] = pts[hi]
  if (t1 === t0) return v1
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
}

function smooth(x) {
  const k = Math.min(1, Math.max(0, x))
  return k * k * (3 - 2 * k)
}

export function mergeMotion(spec, baseDir = '.') {
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p))
  const duration = Number(spec.duration)
  const fps = Number(spec.fps ?? 60)
  const dt = 1 / fps
  const n = Math.max(1, Math.round(duration * fps))
  const base = load(abs(spec.base))
  const mouthSrc = spec.mouth ? load(abs(spec.mouth)) : null
  const layers = (spec.layers || []).map((l) => ({
    ...l,
    clip: load(abs(l.file)),
    kind: l.kind ?? 'arms',
  }))

  // 参数 → 负责的层（后声明的层覆盖先声明的，但同 kind 只取第一个）
  const owner = new Map()
  for (const l of layers) {
    const pids = l.kind === 'arms' ? [...ARMS] : (l.params || [])
    for (const pid of pids) {
      if (l.kind === 'arms' && owner.has(pid)) continue
      owner.set(pid, l)
    }
  }

  const allIds = new Set([...base.curves.keys()])
  for (const l of layers) for (const pid of l.clip.curves.keys()) if (owner.get(pid) === l) allIds.add(pid)
  if (mouthSrc) allIds.add(MOUTH)

  const curves = []
  for (const pid of allIds) {
    const l = owner.get(pid)
    const series = []
    for (let i = 0; i <= n; i++) {
      const t = Math.min(duration, i * dt)
      let v
      if (pid === MOUTH && mouthSrc) {
        v = sample(mouthSrc.curves.get(MOUTH), t)
      } else if (l) {
        // 层时间轴：动作从 at 开始，播到 clip.duration 或 holdTo 为止，之后保持末值
        const local = t - Number(l.at ?? 0)
        const clipDur = l.clip.duration
        const holdTo = l.holdTo != null ? Number(l.holdTo) : Number(l.at ?? 0) + clipDur
        const fadeOut = Number(l.fadeOut ?? 0)
        if (local < 0) {
          v = null // 层还没开始 → 用 base（若 base 没有这个参数则保持 null 到下一段）
        } else if (local <= clipDur) {
          v = sample(l.clip.curves.get(pid), Math.min(local, clipDur))
        } else if (t <= holdTo) {
          v = sample(l.clip.curves.get(pid), clipDur)
        } else {
          v = null
        }
        // 退场：holdTo..holdTo+fadeOut 线性回到 base 值
        if (v != null && fadeOut > 0 && t > holdTo) {
          const baseV = sample(base.curves.get(pid), t)
          const k = smooth((t - holdTo) / fadeOut)
          v = v + ((baseV ?? v) - v) * k
        }
        // 入场：at..at+0.35 从 base 值交叉淡入
        if (v != null && local >= 0 && local < 0.35) {
          const baseV = sample(base.curves.get(pid), t)
          if (baseV != null) {
            const k = smooth(local / 0.35)
            v = baseV + (v - baseV) * k
          }
        }
        if (v == null) v = sample(base.curves.get(pid), t)
      } else {
        v = sample(base.curves.get(pid), t)
      }
      series.push(v == null ? null : v)
    }
    // 空值补齐（前面用后一个非空值，后面用前一个）
    let firstIdx = series.findIndex((v) => v != null)
    if (firstIdx < 0) continue
    for (let i = 0; i < firstIdx; i++) series[i] = series[firstIdx]
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i] == null) series[i] = series[i + 1] ?? series[firstIdx]
    }
    // Movement 二值化（换手组权重不能有中间态，否则两套绑骨同时半开 = 残影）
    if (/^Movement[123]$/.test(pid)) {
      const mx = Math.max(...series)
      for (let i = 0; i < series.length; i++) series[i] = series[i] > 0.5 ? 1 : 0
      if (mx <= 0.5) series.fill(0)
    }
    const seg = [0, round6(series[0])]
    let points = 1
    let segments = 0
    let last = series[0]
    for (let i = 1; i <= n; i++) {
      const v = round6(series[i])
      if (Math.abs(v - last) < 1e-6 && i !== n) continue
      seg.push(0, round4(Math.min(duration, i * dt)), v)
      segments++
      points++
      last = v
    }
    if (!segments) {
      seg.push(0, round4(duration), round6(last))
      segments++
      points++
    }
    curves.push({ Target: 'Parameter', Id: pid, Segments: seg, __points: points, __segments: segments })
  }

  // Movement 三兄弟要同时二值化，保证任意时刻最多一组为 1
  const mv = curves.filter((c) => /^Movement[123]$/.test(c.Id))
  if (mv.length >= 2) {
    const pts = mv.map((c) => parseSegments(c.Segments))
    const series = mv.map((_, k) => {
      const arr = []
      for (let i = 0; i <= n; i++) arr.push(sample(pts[k], Math.min(duration, i * dt)) ?? 0)
      return arr
    })
    const bin = mv.map(() => [])
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
    mv.forEach((c, k) => {
      const v = bin[k]
      const seg = [0, v[0]]
      let points = 1
      let segments = 0
      let last = v[0]
      for (let i = 1; i <= n; i++) {
        if (v[i] === last && i !== n) continue
        seg.push(0, round4(Math.min(duration, i * dt)), v[i])
        segments++
        points++
        last = v[i]
      }
      c.Segments = seg
      c.__points = points
      c.__segments = segments
    })
  }

  const totalSeg = curves.reduce((s, c) => s + c.__segments, 0)
  const totalPoint = curves.reduce((s, c) => s + c.__points, 0)
  return {
    Version: 3,
    Meta: {
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
    },
    Curves: curves.map(({ __points, __segments, ...c }) => c),
  }
}

if (process.argv[1] && process.argv[1].endsWith('l2d-merge.mjs')) {
  const args = process.argv.slice(2)
  const specFile = args.find((a) => !a.startsWith('-'))
  const oi = args.indexOf('-o')
  const out = oi >= 0 ? args[oi + 1] : specFile.replace(/\.json$/, '') + '.motion3.json'
  try {
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
    const motion = mergeMotion(spec, path.dirname(path.resolve(specFile)))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(motion), 'utf8')
    console.log(JSON.stringify({
      ok: true, out,
      duration: motion.Meta.Duration,
      curves: motion.Meta.CurveCount,
      segments: motion.Meta.TotalSegmentCount,
      bytes: fs.statSync(out).size,
    }, null, 2))
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2))
    process.exit(1)
  }
}
