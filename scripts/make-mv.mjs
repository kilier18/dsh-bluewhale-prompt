#!/usr/bin/env node
/**
 * make-mv.mjs —— 一条命令从「歌 + 干声 + 歌词」到「带双语字幕的成片」
 *
 *   node scripts/make-mv.mjs --song 歌.mp3 --vocal 干声.wav [--lyrics 歌词.txt] --out 成片.mp4
 *        [--font "LXGW Marker Gothic"] [--size 60] [--width 0.32] [--margin 90] [--shift 0.2]
 *        [--seed 12345] [--seg 7] [--canvas 16:9|4:3|3:4|9:16] [--skip-sub] [--from <步骤>]
 *
 * 步骤（每步都可 --from 单跑）：
 *   mouth   干声 → 口型 motion3            scripts/l2d-song.mjs --fps 60
 *   song    口型 + 语义编舞 → 整首 motion3  scripts/gen-song.mjs --single 1
 *   push    推进 OPFS + 登记 Custom + reload scripts/push-custom.mjs
 *   record  OBS 录制                        scripts/sing-record.mjs
 *   sync    量音画偏移（能量包络互相关）→ mux
 *   sub     烧双语字幕                      scripts/add-lyrics.mjs
 *
 * 每次编舞都不同：--seed 不给就随机，并把用到的 seed 打印出来（可复现）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const get = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes(k)

const SONG = path.resolve(get('--song', ''))
const VOCAL = path.resolve(get('--vocal', ''))
const LYRICS = get('--lyrics', '') ? path.resolve(get('--lyrics', '')) : ''
const ODIR = get('--odir', 'F:/Users/pinn/Videos')   // 成品默认落这里
const OUT = path.resolve(get('--out', path.join(ODIR, `${path.basename(SONG).replace(/\.[^.]+$/, '')}-成片.mp4`)))
const FONT = get('--font', 'LXGW Marker Gothic')
const SIZE = get('--size', '60')
const WIDTH = get('--width', '0.32')
const MARGIN = get('--margin', '90')
const SHIFT = get('--shift', '0.2')
const SEG = get('--seg', '7')
const LEAD = get('--lead', '0.5')
const CANVAS = get('--canvas', '')
const FROM = get('--from', '')
const SKIP_SUB = has('--skip-sub')
// 直播 UI 里的歌词 MV：默认读 scripts/obs-defaults.json 的 mvSource，--mv 可覆盖
const OBS_DEFAULTS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'obs-defaults.json'), 'utf8')) } catch { return {} }
})()
const MV_SOURCE = get('--mv', OBS_DEFAULTS.mvSource || '')
const SEED = get('--seed', String(Math.floor(Math.random() * 1e6)))

// 出片档位：high=CPU x264 最高质量 / balanced=GPU 均衡（默认）/ fast=GPU 最快
const SPEED = get('--speed', 'balanced')
const ENC_ARGS = (() => {
  const pix = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart']
  if (SPEED === 'high') return ['-c:v', 'libx264', '-crf', get('--crf', '19'), '-preset', 'medium', ...pix]
  if (SPEED === 'fast') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', get('--cq', '32'), '-b:v', '0', ...pix]
  return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', get('--cq', '28'), '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1', ...pix]
})()

if (!SONG || !fs.existsSync(SONG)) { console.error('缺少 --song <音频文件>'); process.exit(1) }
if (!VOCAL || !fs.existsSync(VOCAL)) { console.error('缺少 --vocal <纯干声 wav>（口型必须用干声算，别用混音）'); process.exit(1) }

const FFMPEG = process.env.FFMPEG || 'D:/AI/RVCover/bin/ffmpeg.exe'
const WORK = path.join(REPO, '.work')
const REC = path.join(REPO, '.work', 'rec')
fs.mkdirSync(REC, { recursive: true })
fs.mkdirSync(path.dirname(OUT), { recursive: true })
// OBS 没起就拉起来（obs-websocket 4455 有任何 HTTP 响应即算活着）
async function ensureObs() {
  const alive = await fetch('http://127.0.0.1:4455/').then(() => true).catch(() => false)
  if (alive) return
  log('OBS 未运行，拉起…')
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Start-Process -FilePath 'F:\\steam\\steamapps\\common\\OBS Studio\\bin\\64bit\\obs64.exe' -ArgumentList '--disable-shutdown-check' -WorkingDirectory 'F:\\steam\\steamapps\\common\\OBS Studio\\bin\\64bit'"], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await fetch('http://127.0.0.1:4455/').then(() => true).catch(() => false)) { log('OBS 就绪'); return }
  }
  console.error('OBS 40s 内没起来'); process.exit(1)
}

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a)
const run = (cmd, args, opts = {}) => {
  log(`$ ${path.basename(cmd)} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + '…' : a)).join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) { console.error(`步骤失败（exit ${r.status}），已停止`); process.exit(r.status || 1) }
}

// 0) 时长
const dur = Number(spawnSync(process.execPath, [path.join(HERE, 'probe-duration.mjs'), SONG], { encoding: 'utf8' }).stdout.trim()) || 0
log(`歌长 ${dur.toFixed(2)}s，seed=${SEED}${CANVAS ? `，画幅 ${CANVAS}` : ''}`)

if (FROM === 'mouth' || !FROM) {
  run(process.execPath, [path.join(HERE, 'l2d-song.mjs'), VOCAL, '--fps', '60', '--out', path.join(WORK, 'mouth.motion3.json')])
}
if (FROM === 'song' || !FROM) {
  run(process.execPath, [path.join(HERE, 'gen-song.mjs'), '--single', '1',
    '--mouth', path.join(WORK, 'mouth.motion3.json'),
    '--duration', String(dur), '--seg', SEG, '--seed', SEED,
    '--mouth-lead', LEAD, '--out', path.join(WORK, 'song')])
}
if (FROM === 'push' || !FROM) {
  run(process.execPath, [path.join(HERE, 'push-custom.mjs'), '--dir', path.join(WORK, 'song')])
}
if (CANVAS && (FROM === 'push' || !FROM)) {
  run(process.execPath, [path.join(HERE, 'obs-layout.mjs'), '--canvas', CANVAS])
}

// 4) 找 Custom index
const listRaw = spawnSync(process.execPath, [path.join(HERE, 'list-custom.mjs')], { encoding: 'utf8' }).stdout
let idx = 0
try {
  const arr = JSON.parse(listRaw)
  const hit = arr.find((m) => /唱歌-整首/.test(m.f) && m.i === Math.max(...arr.filter((x) => /唱歌-整首/.test(x.f)).map((x) => x.i)))
  idx = hit ? hit.i : 0
} catch { log('警告：读不到 Custom 列表，按 index 0 试') }
log(`动作 index = ${idx}`)

if (FROM === 'record' || !FROM) {
  await ensureObs()
  const vis = spawnSync(process.execPath, [path.join(HERE, 'list-custom.mjs')], { encoding: 'utf8' })
  if (!vis.stdout || !vis.stdout.trim().startsWith('[')) {
    console.error('桌宠没响应：先把桌宠窗口显示出来（托盘「显示」），隐藏状态下 OBS 录不到画面'); process.exit(1)
  }
  run(process.execPath, [path.join(HERE, 'sing-record.mjs')], {
    env: { ...process.env, MOTION_INDEX: String(idx), DUR: dur.toFixed(2), SONG: `file:///${SONG.replace(/\\/g, '/')}`, OUTDIR: REC, MV_SOURCE },
  })
}

// 5) 偏移 + mux（--from record 之后也要走到这里，否则录完不出片）
if (FROM === 'sync' || FROM === 'record' || !FROM) {
  const rec = fs.readdirSync(REC).filter((f) => f.endsWith('.mp4')).map((f) => ({ f, t: fs.statSync(path.join(REC, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
  if (!rec) { console.error('录不到文件'); process.exit(1) }
  const RECPATH = path.join(REC, rec.f)
  const off = Number((spawnSync(process.execPath, [path.join(HERE, 'sync-offset.mjs'), RECPATH, SONG], { encoding: 'utf8', env: { ...process.env, FFMPEG } }).stdout || '0').trim())
  if (!Number.isFinite(off) || off < 0.3 || off > 5) {
    console.error(`⚠ 偏移 ${off}s 不在正常区间（0.3~5s），八成是量错了：先用 sync-offset.mjs 手工核对再 --from sync 重跑`)
    process.exit(3)
  }
  log(`音画偏移 ${off.toFixed(3)}s → 画面从 ${(off - 0.2).toFixed(3)}s 起，音轨延迟 200ms`)

  // 字幕先只生成 ASS（不编码）
  let assFile = ''
  if (!SKIP_SUB && LYRICS) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'add-lyrics.mjs'), '--video', RECPATH, '--lyrics', LYRICS,
      '--out', OUT, '--stack', '1', '--width', WIDTH, '--size', SIZE, '--margin', MARGIN, '--shift', SHIFT,
      '--font', FONT, '--ass-only'], { encoding: 'utf8' })
    const m = /ASS_ONLY (.+)$/m.exec(r.stdout || '')
    if (!m) { console.error('字幕生成失败\n' + (r.stdout || '') + (r.stderr || '')); process.exit(1) }
    assFile = m[1].trim()
    log(`字幕 → ${path.basename(assFile)}`)
  }

  // 一遍过：裁剪 + 字幕 + 音轨对齐 + 编码（不再分两次重编码）
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')
  const fonts = path.join(REPO, 'fonts')
  const sub = assFile
    ? `subtitles='${esc(assFile)}'${fs.existsSync(fonts) ? `:fontsdir='${esc(fonts)}'` : ''}:wrap_unicode=1`
    : ''
  const fg = `${sub ? `[0:v]${sub}[v];` : ''}[1:a]adelay=200|200,apad=pad_dur=3[a]`
  run(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.max(0, off - 0.2)), '-i', RECPATH, '-i', SONG,
    '-filter_complex', fg,
    '-map', sub ? '[v]' : '0:v', '-map', '[a]',
    ...ENC_ARGS, '-c:a', 'aac', '-b:a', '192k', '-t', String(dur + 1.0), OUT])
}
log(`完成：${OUT}  (${(fs.statSync(OUT).size / 1048576).toFixed(1)}MB)`)
