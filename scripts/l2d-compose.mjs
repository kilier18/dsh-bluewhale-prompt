#!/usr/bin/env node
/**
 * l2d-compose.mjs —— 手臂用「作者原片段时间重映射」，其余用打底片段，绝不自己填关节数值
 *
 * 与 l2d-merge.mjs 的区别：merge 是整段搬、超过了就保持末帧；compose 允许把作者片段的
 * 某个窗口**拉长/压缩**映射到时间轴任意位置 —— 这样「抚胸保持 33 秒」仍然 100% 是作者曲线，
 * 只是播得更慢（手臂微动幅度不变，速度变缓，正好符合“别一直动”的观感）。
 *
 * spec:
 * {
 *   "duration": 36.7587, "fps": 60,
 *   "base": "唱歌.motion3.json",          // 口型/头/眼/呼吸
 *   "arms": "正常说话-抚胸.motion3.json",  // 手臂来源（作者原版）
 *   "armMap": [
 *     { "src": [0, 1.1],   "at": 0.55, "to": 1.75 },   // 抬手
 *     { "src": [1.1, 22.0], "at": 1.75, "to": 34.5 },  // 保持（拉伸 1.5×）
 *     { "src": [22.0, 24.0], "at": 34.5, "to": 36.6 }  // 放手
 *   ]
 * }
 */
import fs from 'node:fs'
import path from 'node:path'

const round4 = (v) => Math.round(v * 1e4) / 1e4
const round6 = (v) => Math.round(v * 1e6) / 1e6

// 语义层独占的参数（其余一律从作者原片整条搬过来，含 Param11/27-32 这些手部细分）
const SEMANTIC = new Set([
  'AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput',
  'ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamBrowLY', 'ParamBrowRY', 'BrowInnerUp',
  'EyeSmile', 'MouthSmile_L', 'MouthSmile_R', 'CheeckPuff', 'JawOpen', 'ParamBreath',
  'LCry', 'RCry', 'SweatBurst1', 'SweatBurst2', 'SweatBurst3', 'SweatBurst4',
  'ShockL', 'ShockR', 'TongueOut', 'Mouthpucker', 'MouthFunnel', 'MouthX',
  'MouthPressLipOpen', 'MouthPuckerWiden', 'MouthRollUpper', 'MouthRollLower',
  'REyeSquint', 'LEyeSquint', 'NoseNeer', 'Startwinkle', 'Divider22', 'Paramshuiyin7',
])
const isSemantic = (pid) => SEMANTIC.has(pid) || /^key\d+$/.test(pid)
const MOUTH = 'ParamMouthOpenY'

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

export function compose(spec, baseDir = '.') {
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p))
  const duration = Number(spec.duration)
  const fps = Number(spec.fps ?? 60)
  const dt = 1 / fps
  const n = Math.max(1, Math.round(duration * fps))
  const base = load(abs(spec.base))
  const baseStart = Number(spec.baseStart ?? 0)
  const keepKeys = spec.keepKeys === true
  const arms = spec.arms ? load(abs(spec.arms)) : null
  const map = (spec.armMap || []).map((w) => ({
    src0: w.src[0],
    src1: w.src[1],
    at: w.at,
    to: w.to ?? w.at + (w.src[1] - w.src[0]),
  }))

  const armValue = (pid, t) => {
    if (!arms) return null
    const pts = arms.curves.get(pid)
    if (!pts) return null
    for (const w of map) {
      if (t >= w.at - 1e-9 && t <= w.to + 1e-9) {
        const k = (t - w.at) / Math.max(1e-6, w.to - w.at)
        return sample(pts, w.src0 + (w.src1 - w.src0) * k)
      }
    }
    if (map.length) {
      // 窗口之间 / 之前 / 之后：一律"保持最近一个已播窗口的末值"
      // 这样 [抬手+保持] [放手] 两段之间不会掉落，抬手落手都是作者原生 1:1 时长
      if (t < map[0].at) return sample(pts, map[0].src0)
      let prev = map[0]
      for (const w of map) {
        if (w.at <= t + 1e-9) prev = w
      }
      return sample(pts, prev.src1)
    }
    return sample(pts, t)
  }

  const ids = new Set([...base.curves.keys()].filter((pid) => keepKeys || !/^key\d+$/.test(pid)))
  if (arms) for (const pid of arms.curves.keys()) if (!isSemantic(pid)) ids.add(pid)

  const curves = []
  for (const pid of ids) {
    const series = []
    for (let i = 0; i <= n; i++) {
      const t = Math.min(duration, i * dt)
      let v = null
      if (!isSemantic(pid) && arms) v = armValue(pid, t)
      if (v == null) v = sample(base.curves.get(pid), Math.min(duration + baseStart, baseStart + t))
      if (v == null) v = sample(arms?.curves.get(pid), t)
      series.push(v ?? 0)
    }
    // Movement 二值化只用于「自己合成的换手」；作者原片的 0→1 斜坡本身就是抬手过程，必须保留
    if (spec.binarizeMovements && /^Movement[123]$/.test(pid)) {
      for (let i = 0; i < series.length; i++) series[i] = series[i] > 0.5 ? 1 : 0
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

if (process.argv[1] && process.argv[1].endsWith('l2d-compose.mjs')) {
  const args = process.argv.slice(2)
  const specFile = args.find((a) => !a.startsWith('-'))
  const oi = args.indexOf('-o')
  const out = oi >= 0 ? args[oi + 1] : specFile.replace(/\.json$/, '') + '.motion3.json'
  try {
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
    const motion = compose(spec, path.dirname(path.resolve(specFile)))
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
