#!/usr/bin/env node
/**
 * add-lyrics.mjs —— 给成片压歌词字幕（硬字幕，无需任何插件）
 *
 * 用法：
 *   node scripts/add-lyrics.mjs --video in.mp4 --lyrics song.lrc --out out.mp4
 *   node scripts/add-lyrics.mjs --video in.mp4 --lyrics plain.txt --audio mix.mp3 --out out.mp4
 *   node scripts/add-lyrics.mjs --video in.mp4 --lyrics song.srt --size 68 --color "#FFFFFF" --stroke 5
 *
 * 支持三种歌词格式（自动识别）：
 *   1. LRC    `[00:12.34]歌词`        —— 最推荐，逐句时间现成
 *   2. SRT    `00:00:12,340 --> 00:00:16,000` + 文本
 *   3. 纯文本  一行一句               —— 需要 --audio，按「人声段落 + 字数权重」自动分配时间
 *
 * 纯文本模式的时间分配：先从音频里取人声包络（> 阈值即有声），把有声音区间按句数切开，
 * 每句时长按其字数占比分配。够用但不精确；要精确请给 LRC。
 *
 * 常用参数：--size 字号(默认 62) --color 字色 --stroke 描边(默认 5) --margin 底部边距(默认 150)
 *           --align 2 底部居中 / 8 顶部居中 --maxlines 每屏最多几行(默认 2) --font 字体名
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const VIDEO = opt('video', '')
const LYRICS = opt('lyrics', '')
const AUDIO = opt('audio', '')
const OUT = opt('out', VIDEO ? VIDEO.replace(/\.(\w+)$/, '-字幕.$1') : '')
const FFMPEG = process.env.FFMPEG || 'D:/AI/RVCover/bin/ffmpeg.exe'
const FFPROBE = process.env.FFPROBE || 'D:/AI/RVCover/bin/ffprobe.exe'
const SIZE_OPT = opt('size', '')
const COLOR = opt('color', '#FFFFFF')
const STROKE = Number(opt('stroke', 5))
const MARGIN = Number(opt('margin', ''))   // 底部/顶部边距；不传则按画幅 9% 算
const ALIGN = opt('align', '2')
const MAXLINES = Number(opt('maxlines', 2))
const FONT = opt('font', 'LXGW WenKai')   // 默认霞鹜文楷（仓库 fonts/ 里自带，随插件分发）
const FONTS_DIR = opt('fontsdir', path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'fonts'))
const MARGIN_L = opt('marginl', '')
const MARGIN_R = opt('marginr', '')
// 「左下角三分之一」这类排版：--align 1 --width 0.34（占总宽比例）
const WIDTH_RATIO = opt('width', '')
const SHIFT = Number(opt('shift', 0))
const STACK = opt('stack', '') === '1'   // 双语叠行：时间戳相同(±gap)的多行合成一句，用 \\N 分两行
const STACK_GAP = Number(opt('gap', 0.25))   // 整条字幕整体平移（秒）：成片音频比画面晚多少就填多少

if (!VIDEO || !LYRICS) { console.error('需要 --video 与 --lyrics'); process.exit(1) }
if (!fs.existsSync(VIDEO) || !fs.existsSync(LYRICS)) { console.error('文件不存在'); process.exit(1) }

const ts2s = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms || 0) / 1000
const fmt = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.round((t - Math.floor(t)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

// ---------- 解析 ----------
const raw = fs.readFileSync(LYRICS, 'utf8').replace(/\r/g, '')
let lines = []   // {t, text}

const isLRC = /\[\d{1,2}:\d{2}([.:]\d{1,3})?\]/.test(raw)
const isSRT = /-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/.test(raw)

if (isLRC) {
  for (const ln of raw.split('\n')) {
    const stamps = [...ln.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    const text = ln.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const m of stamps) {
      if (/^\d{1,2}:\d{2}/.test(m[0].slice(1, -1)) && !/^\[(ti|ar|al|by|offset):/i.test(m[0])) {
        lines.push({ t: ts2s(0, m[1], m[2], m[3]), text })
      }
    }
  }
} else if (isSRT) {
  const blocks = raw.split(/\n{2,}/)
  for (const b of blocks) {
    const m = b.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/)
    if (!m) continue
    const text = b.split('\n').filter((x) => !/-->/.test(x) && !/^\d+$/.test(x.trim())).join('\n').trim()
    if (text) lines.push({ t: ts2s(m[1], m[2], m[3], m[4]), text })
  }
} else {
  const texts = raw.split('\n').map((s) => s.trim()).filter(Boolean)
  if (!AUDIO) { console.error('纯文本歌词需要 --audio 才能自动分配时间（或改用 LRC）'); process.exit(1) }
  const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', AUDIO], { encoding: 'utf8' }).trim())
  // 人声包络：8kHz 单声道 → 50ms RMS
  const WAV = path.join(os.tmpdir(), `lyr-${process.pid}.f32`)
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', AUDIO, '-ac', '1', '-ar', '8000', '-f', 'f32le', WAV])
  const pcm = fs.readFileSync(WAV)
  const n = Math.floor(pcm.length / 4)
  const buf = new Float32Array(pcm.buffer, pcm.byteOffset, n)
  const H = 400
  const frames = Math.floor(n / H)
  const env = []
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let j = 0; j < H; j++) s += buf[i * H + j] ** 2
    env.push(Math.sqrt(s / H))
  }
  fs.unlinkSync(WAV)
  const sorted = [...env].sort((a, b) => a - b)
  const thr = Math.max(0.004, sorted[Math.floor(sorted.length * 0.55)] * 0.5)
  const voiced = env.map((v) => v > thr)
  // 有声音区间的总时长，按字数分配
  const totalVoiced = voiced.reduce((a, b) => a + (b ? H / 8000 : 0), 0)
  const totalChars = texts.reduce((a, s) => a + Math.max(1, s.replace(/\s/g, '').length), 0)
  let cursorV = 0
  let idxFrame = 0
  for (const text of texts) {
    const share = (Math.max(1, text.replace(/\s/g, '').length) / totalChars) * totalVoiced
    // 找到下一个有声音帧作为起点
    while (idxFrame < voiced.length && !voiced[idxFrame]) idxFrame++
    const start = (idxFrame * H) / 8000
    let acc = 0
    let f = idxFrame
    while (f < voiced.length && acc < share) { if (voiced[f]) acc += H / 8000; f++ }
    cursorV = start + share
    idxFrame = f
    lines.push({ t: start, text })
  }
  if (lines.length) lines[0].t = Math.max(0, lines[0].t - 0.15)
}

lines.sort((a, b) => a.t - b.t)
if (SHIFT) for (const l of lines) l.t = Math.max(0, l.t + SHIFT)
if (!lines.length) { console.error('没解析出歌词行'); process.exit(1) }

const videoDur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO], { encoding: 'utf8' }).trim())

// ---------- 生成 ASS ----------
const ass = []
ass.push('[Script Info]')
ass.push('ScriptType: v4.00+')
ass.push('WrapStyle: 0')
ass.push('ScaledBorderAndShadow: yes')
const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', VIDEO], { encoding: 'utf8' }).trim().split('x').map(Number)
const VW = probe[0] || 1080, VH = probe[1] || 1080
ass.push(`PlayResX: ${VW}`)
ass.push(`PlayResY: ${VH}`)
ass.push('')
ass.push('[V4+ Styles]')
ass.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding')
const toAss = (hex, alpha = '00') => {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6)
  return `&H${alpha}${b}${g}${r}`.toUpperCase()
}
const SIZE = SIZE_OPT ? Number(SIZE_OPT) : Math.round(VH * 0.045)
const padL = Number(MARGIN_L !== '' ? MARGIN_L : Math.round(VW * 0.055))
const padR = Number(MARGIN_R !== '' ? MARGIN_R : (WIDTH_RATIO ? Math.round(VW * (1 - 0.055 - Number(WIDTH_RATIO))) : Math.round(VW * 0.055)))
const padV = Number(MARGIN !== '' ? MARGIN : Math.round(VH * 0.09))
ass.push(`Style: Lyric,${FONT},${SIZE},${toAss(COLOR)},${toAss('#8AD8FF')},${toAss('#000000')},${toAss('#000000','80')},1,0,0,0,100,100,1,0,1,${STROKE},2,${ALIGN},${padL},${padR},${padV},1`)
ass.push('')
ass.push('[Events]')
ass.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

// 双语叠行：把时间戳相近的行并成一条 cue（文件里日文在前、中文在后 → 日上中下）
let cues = lines.map((l) => ({ t: l.t, texts: [l.text] }))
if (STACK) {
  const grouped = []
  for (const l of lines) {
    const last = grouped[grouped.length - 1]
    if (last && Math.abs(l.t - last.t) <= STACK_GAP) last.texts.push(l.text)
    else grouped.push({ t: l.t, texts: [l.text] })
  }
  cues = grouped
}

for (let i = 0; i < cues.length; i++) {
  const start = cues[i].t
  const next = i + 1 < cues.length ? cues[i + 1].t : Math.min(videoDur, start + 4)
  const end = Math.max(start + 0.6, Math.min(next - 0.02, start + 6))
  const text = cues[i].texts.map((t) => t.trim()).filter(Boolean).join('\\N')
  ass.push(`Dialogue: 0,${fmt(start)},${fmt(end)},Lyric,,0,0,0,,${text}`)
}

const assFile = OUT.replace(/\.[^.]+$/, '.ass')
fs.writeFileSync(assFile, ass.join('\n'), 'utf8')
console.log(`歌词 ${lines.length} 行 → ${assFile}`)

// ---------- 压硬字幕 ----------
const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')
const vf = fs.existsSync(FONTS_DIR)
  ? `subtitles='${esc(assFile)}':fontsdir='${esc(FONTS_DIR)}'`
  : `subtitles='${esc(assFile)}'`
execFileSync(FFMPEG, [
  '-y', '-v', 'error', '-i', VIDEO,
  '-vf', vf,
  '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
  '-c:a', 'copy',
  OUT,
], { stdio: 'inherit' })
const info = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'default=nw=1', OUT], { encoding: 'utf8' })
console.log(info.trim())
console.log(`成片 → ${OUT}`)
