#!/usr/bin/env node
// 量音画偏移：录制文件音轨 vs 母带，能量包络互相关（旧的波形相关不可用，corr 只有 0.04）
//   node scripts/sync-offset.mjs <录制.mp4> <母带.mp3>   → 打印偏移秒数（正值=画面晚于声音）
import { spawnSync } from 'node:child_process'

const [rec, song] = process.argv.slice(2)
const SR = 8000, HOP = 40 // 200Hz 包络
const FFMPEG = process.env.FFMPEG || 'D:/AI/RVCover/bin/ffmpeg.exe'
const decode = (f) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  const buf = r.stdout
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4))
}
const env = (x) => {
  const n = Math.floor(x.length / HOP)
  const e = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < HOP; k++) { const v = x[i * HOP + k]; s += v * v }
    e[i] = Math.sqrt(s / HOP)
  }
  let mx = 0
  for (const v of e) mx = Math.max(mx, v)
  for (let i = 0; i < n; i++) e[i] /= mx || 1
  return e
}
const a = env(decode(rec))   // 录制
const b = env(decode(song))  // 母带
// 找 b 在 a 里的起点：只在 a 的前 4000 帧（20s）里滑
let bestLag = 0, best = -Infinity
const win = Math.min(b.length, 200 * 60) // 最多用 60s 做相关
for (let lag = 0; lag < Math.min(4000, a.length - win); lag += 1) {
  let s = 0
  for (let i = 0; i < win; i += 4) s += a[lag + i] * b[i]
  if (s > best) { best = s; bestLag = lag }
}
console.log((bestLag / 200).toFixed(3))
