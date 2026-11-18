#!/usr/bin/env node
// 音频 → 唱歌动作（一个 motion3 里塞口型 + 头摆 + 眨眼 + 呼吸）
//   node l2d-song.mjs <音频> [--out x.motion3.json] [--fps 25]
//
// 设计：
//   口型 ParamMouthOpenY  ← 逐帧 RMS（95 分位归一化 + 伽马）
//   头摆 AngleX/AngleZ    ← 低频能量包络 × 慢速正弦（副歌大、主歌小）
//   抬头 AngleY           ← 能量越低越低头（唱歌时跟着乐句起伏）
//   身体 LeanInput        ← 小幅前后
//   眨眼 EyeLOpen/ROpen   ← 每 3~6 秒随机一次（0.12 秒闭合）
//   呼吸 ParamBreath      ← 0.25Hz 正弦
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RVC = 'D:/AI/RVCover'
const FFMPEG = path.join(RVC, 'bin/ffmpeg.exe')

const argv = process.argv.slice(2)
let src = '', out = '', fps = 25
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--out') out = argv[++i]
  else if (a === '--fps') fps = Number(argv[++i])
  else if (!a.startsWith('-')) src = a
}
if (!src || !fs.existsSync(src)) { console.error('用法: node l2d-song.mjs <音频> [--out x] [--fps 25]'); process.exit(1) }
if (!out) out = path.join(path.dirname(src), path.basename(src).replace(/\.[^.]+$/, '') + '.song.motion3.json')

// ---------- 解码 ----------
const raw = path.join(path.dirname(out), '.tmp-song.raw')
const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-f', 'f32le', raw],
  { encoding: 'utf8', timeout: 180000 })
if (r.status !== 0) { console.error('ffmpeg:', (r.stderr || '').slice(0, 300)); process.exit(1) }
const buf = fs.readFileSync(raw); try { fs.unlinkSync(raw) } catch { }
const n = Math.floor(buf.length / 4)
const pcm = new Float32Array(n)
for (let i = 0; i < n; i++) pcm[i] = buf.readFloatLE(i * 4)

const SR = 16000, dur = n / SR
const hop = Math.floor(SR / fps)
const F = Math.max(1, Math.floor(n / hop))
const T = i => +(i / fps).toFixed(4)

// ---------- 逐帧 RMS ----------
const rms = new Float32Array(F)
for (let f = 0; f < F; f++) {
  const s = f * hop, e = Math.min(n, s + hop)
  let acc = 0
  for (let i = s; i < e; i++) acc += pcm[i] * pcm[i]
  rms[f] = Math.sqrt(acc / Math.max(1, e - s))
}
const sorted = Array.from(rms).sort((a, b) => a - b)
const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1e-6
const norm = Float32Array.from(rms, v => Math.min(1, v / p95))
const smooth = (arr, w) => {
  const o = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0
    for (let k = -w; k <= w; k++) { const j = i + k; if (j >= 0 && j < arr.length) { s += arr[j]; c++ } }
    o[i] = s / Math.max(1, c)
  }
  return o
}
const mouth = Array.from(smooth(norm, 1), v => Math.min(1, Math.pow(v, 0.65)))
// 低频能量（决定头部动作幅度）：0.8 秒窗口
const energy = smooth(norm, Math.round(fps * 0.4))
const mouthArr = Array.from(mouth)

// ---------- 曲线 ----------
const curve = (id, pts, fadeIn = 0.2, fadeOut = 0.5) => ({ id, pts, fadeIn, fadeOut })
const curves = []

// 1) 口型
curves.push(curve('ParamMouthOpenY', mouthArr.map((v, i) => [T(i), +v.toFixed(3)])))

// 2) 左右转头 AngleX：慢速 sin，幅度随能量（±3 ~ ±11）
//    + 一个更慢的漂移，避免机械感
const axRnd = seed => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff }
const rnd = axRnd(20261117)
const drift = Array.from({ length: 6 }, () => rnd() * 2 - 1)
curves.push(curve('AngleX', mouthArr.map((_, i) => {
  const e = 0.35 + energy[i] * 0.65
  const slow = Math.sin(i / fps * 0.62 + drift[0] * 3) * 0.6 + Math.sin(i / fps * 0.21 + drift[1]) * 0.4
  return [T(i), +(slow * 10 * e).toFixed(3)]
}), 0.5, 0.8))

// 3) 歪头 AngleZ：副歌偏向一侧
curves.push(curve('AngleZ', mouthArr.map((_, i) => {
  const e = energy[i]
  const s = Math.sin(i / fps * 0.37 + drift[2] * 4) * 0.7 + Math.sin(i / fps * 0.13) * 0.3
  return [T(i), +(s * 7 * (0.3 + e * 0.7) + e * 3.5).toFixed(3)]
}), 0.5, 0.8))

// 4) 抬头/低头 AngleY：能量高 → 抬头（正），能量低 → 略低
curves.push(curve('AngleY', mouthArr.map((_, i) => {
  const e = energy[i]
  const sway = Math.sin(i / fps * 0.45 + drift[3] * 5) * 2.2
  return [T(i), +(-3 + e * 7 + sway).toFixed(3)]
}), 0.5, 0.8))

// 5) 身体前后 LeanInput
curves.push(curve('LeanInput', mouthArr.map((_, i) => {
  const e = energy[i]
  const s = Math.sin(i / fps * 0.29 + drift[4] * 6)
  return [T(i), +(-1.5 + s * 2.5 * (0.4 + e)).toFixed(3)]
}), 0.5, 0.8))

// 6) 呼吸
curves.push(curve('ParamBreath', mouthArr.map((_, i) => [T(i), +(0.5 + Math.sin(i / fps * 2 * Math.PI * 0.25) * 0.5).toFixed(3)]), 0.5, 0.5))

// 7) 眨眼（两条曲线一起）
const blinks = []
{
  let tSec = 1.2 + rnd() * 2
  while (tSec < dur - 0.6) { blinks.push(tSec); tSec += 2.6 + rnd() * 3.4 }
}
const eyeOpen = new Float32Array(F).fill(1)
for (const bt of blinks) {
  const f0 = Math.round(bt * fps), nf = Math.max(2, Math.round(0.11 * fps))
  for (let k = 0; k <= nf; k++) {
    const f = f0 + k
    if (f >= 0 && f < F) eyeOpen[f] = Math.min(eyeOpen[f], k === 0 || k === nf ? 0.55 : 1 - Math.sin((k / nf) * Math.PI))
  }
}
curves.push(curve('ParamEyeLOpen', Array.from(eyeOpen, (v, i) => [T(i), +v.toFixed(3)]), 0.03, 0.03))
curves.push(curve('ParamEyeROpen', Array.from(eyeOpen, (v, i) => [T(i), +v.toFixed(3)]), 0.03, 0.03))

// 8) 眉/嘴型：跟着能量轻微上扬（唱歌时的表情）
curves.push(curve('ParamMouthForm', mouthArr.map((_, i) => [T(i), +(0.35 + energy[i] * 0.5).toFixed(3)]), 0.4, 0.6))
curves.push(curve('ParamBrowLY', mouthArr.map((_, i) => [T(i), +(1 + energy[i] * 3).toFixed(3)]), 0.4, 0.6))
curves.push(curve('ParamBrowRY', mouthArr.map((_, i) => [T(i), +(1 + energy[i] * 3).toFixed(3)]), 0.4, 0.6))

// ---------- 打包 ----------
let totalSeg = 0, totalPt = 0
const outCurves = curves.map(c => {
  const segs = [c.pts[0][0], c.pts[0][1]]
  for (let i = 1; i < c.pts.length; i++) segs.push(0, c.pts[i][0], c.pts[i][1])
  totalSeg += c.pts.length            // Linear 段数 = 点数（首点算在头里）
  totalPt += c.pts.length + 1
  return {
    Target: 'Parameter',
    Id: c.id,
    Segments: segs,
    FadeInTime: c.fadeIn,
    FadeOutTime: c.fadeOut,
  }
})

const motion = {
  Version: 3,
  Meta: {
    Duration: +(dur + 0.4).toFixed(3),
    Fps: fps,
    Loop: false,
    AreBeziersRestricted: true,
    CurveCount: outCurves.length,
    TotalSegmentCount: totalSeg,
    TotalPointCount: totalPt,
    UserData: '',
    FadeInTime: 0.12,
    FadeOutTime: 0.6,
  },
  Curves: outCurves,
  UserData: '',
}
fs.writeFileSync(out, JSON.stringify(motion))
console.log(JSON.stringify({
  ok: true, out, duration: +dur.toFixed(2), fps, frames: F,
  curves: outCurves.length, curveIds: outCurves.map(c => c.Id),
  segments: totalSeg, points: totalPt,
  sizeKB: +(fs.statSync(out).size / 1024).toFixed(0),
  blinks: blinks.length,
}, null, 1))