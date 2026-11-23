#!/usr/bin/env node
// 打印音频/视频时长（秒，保留 3 位）
import { spawnSync } from 'node:child_process'
const f = process.argv[2]
const r = spawnSync(process.env.FFMPEG || 'D:/AI/RVCover/bin/ffmpeg.exe', ['-hide_banner', '-i', f], { encoding: 'utf8' })
const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr || '')
if (!m) { console.error('读不到时长'); process.exit(1) }
const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
console.log(s.toFixed(3))
