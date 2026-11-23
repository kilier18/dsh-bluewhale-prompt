#!/usr/bin/env node
// 量音画偏移：录制文件音轨 vs 母带，能量包络互相关
//   node scripts/sync-offset.mjs <录制.mp4> <母带.mp3>   → 打印偏移秒数（画面比声音晚多少秒）
//
// 口径（踩过的坑都在这）：
//   · 必须做 z-score（减均值 / 除标准差）。只按峰值归一化时，副歌那种“响”的位置会压过真正的起点，
//     实测因此把 1.50s 算成 19.03s，整条片子被裁掉 19 秒。
//   · 包络 50ms 一格、只用母带前 30s，搜索 0~25s。
//   · 取“达到峰值 95% 的最早 lag”而不是最大值本身 —— 副歌常与某段旋律相似，会出现等高的假峰。
import { spawnSync } from 'node:child_process'

const [rec, song] = process.argv.slice(2)
if (!rec || !song) { console.error('用法: sync-offset.mjs <录制> <母带>'); process.exit(2) }

const SR = 8000, HOP = 400                 // 50ms 一格
const FFMPEG = process.env.FFMPEG || 'D:/AI/RVCover/bin/ffmpeg.exe'
const MAXLAG = 25                          // 秒
const SONGWIN = 30                         // 用母带前 30s 做相关

const decode = (f) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 512 * 1024 * 1024 })
  if (!r.stdout || !r.stdout.length) throw new Error('解码失败: ' + f)
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
  let mean = 0
  for (let i = 0; i < n; i++) mean += e[i]
  mean /= n || 1
  let sd = 0
  for (let i = 0; i < n; i++) { const d = e[i] - mean; sd += d * d }
  sd = Math.sqrt(sd / (n || 1)) || 1
  for (let i = 0; i < n; i++) e[i] = (e[i] - mean) / sd
  return e
}

const a = env(decode(rec))
const b = env(decode(song))
const win = Math.min(b.length, Math.round(SONGWIN * 1000 / 50))
const maxLag = Math.min(Math.round(MAXLAG * 1000 / 50), a.length - win)

const scores = []
for (let lag = 0; lag <= maxLag; lag++) {
  let s = 0
  for (let i = 0; i < win; i += 2) s += a[lag + i] * b[i]
  scores.push([lag / 20, s / (win / 2)])   // 秒, 平均相关
}
const peak = Math.max(...scores.map(x => x[1]))
const top = [...scores].sort((x, y) => y[1] - x[1]).slice(0, 5)
console.error('候选（秒 / 相关）: ' + top.map(([s, c]) => `${s.toFixed(2)}/${c.toFixed(2)}`).join('  '))
if (peak < 0.25) console.error('⚠ 相关偏低，这段录音里可能没有干净的人声/歌声，偏移量不可信')

// 取达到峰值 95% 的最早 lag（多数情况下就是真正的起点）
const cands = scores.filter(([, c]) => c >= peak * 0.95).map(([s]) => s)
const offset = Math.min(...cands)
if (top[0][0] - offset > 2) console.error(`⚠ 峰值在 ${top[0][0].toFixed(2)}s，但按“最早 95%”取 ${offset.toFixed(2)}s`)
console.log(offset.toFixed(3))
