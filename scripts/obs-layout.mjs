#!/usr/bin/env node
/**
 * obs-layout.mjs —— 一键把 OBS 画幅切到竖屏/方形，并把背景铺满、人物摆正
 *
 * 用法：
 *   node scripts/obs-layout.mjs --canvas 3:4                  # 1080×1440
 *   node scripts/obs-layout.mjs --canvas 9:16                 # 1080×1920（抖音/Reels/Shorts 原生）
 *   node scripts/obs-layout.mjs --canvas 3:4 --bg D:/x.png    # 顺便换背景图
 *   node scripts/obs-layout.mjs --canvas 16:9                 # 回横屏
 *
 * 画幅映射（短边固定 1080，录制即该尺寸）：
 *   16:9 1920×1080 / 4:3 1440×1080 / 1:1 1080×1080 / 3:4 1080×1440 / 9:16 1080×1920
 *
 * 干的三件事：改画幅 → 背景按 cover 铺满居中 → 窗口采集里的人物水平居中、脚踩底边。
 * 依赖：OBS 起着、obs-websocket 开着（`scripts/obs-cli.mjs` 用的同一套密码）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CLI = path.join(HERE, 'obs-cli.mjs')

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const CANVAS = { '16:9': [1920, 1080], '4:3': [1440, 1080], '1:1': [1080, 1080], '3:4': [1080, 1440], '9:16': [1080, 1920] }
const key = opt('canvas', '3:4')
if (!CANVAS[key]) { console.error(`不认识的画幅 ${key}；可选 ${Object.keys(CANVAS).join(' / ')}`); process.exit(1) }
const [W, H] = CANVAS[key]
const BG_SRC = opt('bgwin', '背景-临时卧室')
const CHAR_SRC = opt('charwin', '窗口采集')
// 竖屏按「人物高度」适配（按宽度适配会把头切掉）；横屏仍按宽度
const FILL = Number(opt('fill', key === '16:9' ? 0.62 : 0.94))   // 人物占画布 宽度(横屏)/高度(竖屏) 比例
const BOTTOM = Number(opt('bottom', 0.995))                      // 1 = 脚踩底边
// 窗口采集里角色本体的像素包围盒（这台机器 1920×1020 窗口实测：x 749–1145、y 195–1019）
const BODY_W = Number(opt('bodyw', 400))
const BODY_H = Number(opt('bodyh', 824))
const BODY_CX = Number(opt('bodycx', 947))
const BODY_BOTTOM = Number(opt('bodybottom', 1019))
const BG_FILE = opt('bg', '')

function obs(type, data = {}) {
  const out = execFileSync(process.execPath, [CLI, type, JSON.stringify(data)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const t = out.trim()
  if (t.startsWith('ERR')) throw new Error(`${type} 失败: ${t}`)
  if (!t || t === 'undefined' || t === 'null') return {}
  try { return JSON.parse(t) } catch { throw new Error(`${type} 返回不是 JSON（前 200 字）：${t.slice(0, 200)}`) }
}
const log = (...a) => console.log(...a)

// 1) 画幅
const before = obs('GetVideoSettings')
log(`原画幅 ${before.baseWidth}×${before.baseHeight}（输出 ${before.outputWidth}×${before.outputHeight}）`)
obs('SetVideoSettings', { baseWidth: W, baseHeight: H, outputWidth: W, outputHeight: H, fpsNumerator: 60, fpsDenominator: 1 })
const after = obs('GetVideoSettings')
log(`新画幅 ${after.baseWidth}×${after.baseHeight}（输出 ${after.outputWidth}×${after.outputHeight}，${after.fpsNumerator}/${after.fpsDenominator}fps）`)

const scene = obs('GetCurrentProgramScene').currentProgramSceneName || obs('GetCurrentProgramScene').sceneName
const itemIdOf = (name) => {
  const list = obs('GetSceneItemList', { sceneName: scene })
  const hit = (list.sceneItems || []).find((x) => x.sourceName === name)
  if (!hit) throw new Error(`场景「${scene}」里没有源「${name}」`)
  return hit.sceneItemId
}

// 2) 背景 cover
if (BG_FILE) { obs('SetInputSettings', { inputName: BG_SRC, inputSettings: { file: BG_FILE } }); log(`背景 → ${BG_FILE}`) }
try {
  const cur = obs('GetInputSettings', { inputName: BG_SRC })
  const file = cur.inputSettings?.file || ''
  if (!file) throw new Error('背景源不是图片或没设文件')
  const FF = process.env.FFPROBE || 'D:/AI/RVCover/bin/ffprobe.exe'
  let iw = 1920, ih = 1080
  try {
    const o = execFileSync(FF, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' }).trim()
    const [a, b] = o.split('x').map(Number); if (a && b) { iw = a; ih = b }
  } catch { log('读背景尺寸失败，按 1920×1080 处理') }
  const s = Math.max(W / iw, H / ih)
  obs('SetSceneItemTransform', {
    sceneName: scene, sceneItemId: itemIdOf(BG_SRC),
    sceneItemTransform: {
      positionX: Math.round((W - iw * s) / 2), positionY: Math.round((H - ih * s) / 2),
      scaleX: +s.toFixed(4), scaleY: +s.toFixed(4), boundsType: 'OBS_BOUNDS_NONE', alignment: 5,
    },
  })
  log(`背景 cover：${iw}×${ih} ×${s.toFixed(3)} → ${path.basename(file)}`)
} catch (e) { log('背景处理跳过：' + e.message) }

// 3) 人物
try {
  const id = itemIdOf(CHAR_SRC)
  const t = obs('GetSceneItemTransform', { sceneName: scene, sceneItemId: id }).sceneItemTransform
  const srcW = t.sourceWidth, srcH = t.sourceHeight
  // 竖屏(fill 是高度比) / 横屏(fill 是宽度比)
  const portrait = H > W
  const s = portrait ? (H * FILL) / BODY_H : (W * FILL) / BODY_W
  const posX = portrait ? Math.round(W / 2 - BODY_CX * s) : Math.round(W / 2 - (srcW * s) / 2)
  const posY = portrait ? Math.round(H * BOTTOM - BODY_BOTTOM * s) : Math.round(H - srcH * s * BOTTOM)
  obs('SetSceneItemTransform', {
    sceneName: scene, sceneItemId: id,
    sceneItemTransform: {
      positionX: posX, positionY: posY,
      scaleX: +s.toFixed(4), scaleY: +s.toFixed(4), boundsType: 'OBS_BOUNDS_NONE', alignment: 5,
    },
  })
  log(`人物：源 ${srcW}×${srcH} ×${s.toFixed(3)}，${portrait ? '占高' : '占宽'} ${Math.round(FILL * 100)}%，pos ${posX},${posY}`)
} catch (e) { log('人物调整跳过：' + e.message) }

// 4) 截图确认
try {
  const shot = obs('GetSourceScreenshot', { sourceName: scene, imageFormat: 'png', imageWidth: W, imageHeight: H })
  const data = String(shot.imageData).replace(/^data:image\/png;base64,/, '')
  const out = opt('out', path.join(REPO, '.work', `layout-${W}x${H}.png`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.from(data, 'base64'))
  log(`截图 → ${out}`)
} catch (e) { log('截图失败：' + e.message) }
