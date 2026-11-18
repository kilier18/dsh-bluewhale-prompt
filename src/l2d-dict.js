/**
 * l2d-dict.js —— 「动作语义字典」的运行时入口。
 *
 * 为什么要有这个文件：桌宠能做的动作只有动作库里那几十条官方 motion3，
 * 而「自然」的关键不在动作多，而在**挑哪一条、从第几秒开始、手臂用哪条原片**。
 * 这些判断全在 `dict/l2d-motion-dict.json` 里（由 `scripts/l2d-dict.py` 从 OPFS
 * 现网动作机械拆解生成），本模块只负责读它、查它、按意图给出建议。
 *
 * 数据来源与再生成：
 *   1. `node scripts/pull-motions.mjs`  ← 通过 CDP 从桌宠 OPFS 拉官方 motion3 到临时目录
 *   2. `python scripts/l2d-dict.py --lib <临时目录> --out dict/l2d-motion-dict.json`
 *
 * 注意：这里所有数字都是原作者曲线里的实测值，**不要在代码里手写关节数值**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DICT_PATH = path.resolve(HERE, '..', 'dict', 'l2d-motion-dict.json')
const MAP_PATH = path.resolve(HERE, '..', 'dict', 'l2d-motion-mapping.json')

/** 内置兜底规则：字典缺失时也要能跑（只是没有窗口建议）。 */
const FALLBACK = {
  version: 0,
  tiers: {
    steady: '稳态：PositionX ≤10，适合讲话与长段铺底',
    cozy: '黏人档：PositionX ≤19 或 LeanInput ≤−20，适合主歌与撒娇',
    bomb: '炸场档：PositionX ≥20，只用于副歌爆点',
  },
  motions: [],
}

let cache = null
let mapCache = null

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function dict() {
  if (!cache) cache = readJson(DICT_PATH, FALLBACK)
  return cache
}

/** 意图 → 资产 的对照表（dict/l2d-motion-mapping.json）。 */
export function mapping() {
  if (!mapCache) mapCache = readJson(MAP_PATH, { version: 0, tiers: {}, mapping: [] })
  return mapCache
}

export const tiers = () => ({ ...(mapping().tiers || {}), ...(dict().tiers || {}) })

/** 字典里每条动作的索引（按名字）。 */
export function motion(name) {
  return (dict().motions || []).find((m) => m.name === name) || null
}

/** 动作库白名单：`Animation/表演-14-撒娇.motion3.json` → true */
export function motionAllowed(file) {
  if (typeof file !== 'string') return false
  const m = /^Animation\/(.+)\.motion3\.json$/.exec(file)
  if (!m) return false
  if (!(dict().motions || []).length) return true // 字典缺失时不拦
  return Boolean(motion(m[1]))
}

/** 全部动作名。 */
export function motionNames() {
  return (dict().motions || []).map((m) => m.name)
}

/** 按档位 / 是否唱歌可用 / 是否带手臂过滤动作。 */
export function motions({ tier, singOk, withArms } = {}) {
  return (dict().motions || []).filter((m) => {
    if (tier && m.tier !== tier) return false
    if (singOk === true && (m.faceswapDanger || []).length) return false
    if (withArms === true && !(m.arms || []).length) return false
    return true
  })
}

/** 语义意图列表。 */
export function intents() {
  return mapping().mapping || []
}

/** 模糊匹配意图：先精确、再包含。 */
export function recipe(intent) {
  const list = intents()
  if (!intent) return null
  return (
    list.find((r) => r.intent === intent) ||
    list.find((r) => r.intent.includes(intent) || intent.includes(r.intent)) ||
    null
  )
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

/**
 * 给某条动作挑「最活跃的 dur 秒窗口」。
 * 优先用字典里预算好的 bestWindows（4/6/10/14/20s），其它时长按 activity 现算。
 * 返回 { at, score, source: 'preset'|'computed'|'whole' }
 */
export function bestWindow(name, dur = 6, { step = 0.5 } = {}) {
  const m = motion(name)
  if (!m) return { at: 0, score: 0, source: 'missing' }
  const preset = (m.bestWindows || {})[String(Math.round(dur))]
  if (preset && preset.length) {
    return { at: preset[0].at, score: preset[0].score, source: 'preset' }
  }
  const prof = m.activity || []
  if (!prof.length) return { at: 0, score: 0, source: 'whole' }
  if (dur >= m.dur) return { at: 0, score: avg(prof), source: 'whole' }
  const need = Math.max(1, Math.round(dur / step))
  if (need >= prof.length) return { at: 0, score: avg(prof), source: 'whole' }
  let bestAt = 0
  let bestScore = -1
  for (let i = 0; i + need <= prof.length; i++) {
    const sc = avg(prof.slice(i, i + need))
    // 同等活跃度下优先靠后一些，避免一开场就满动作、结尾反而空
    const bias = (i / (prof.length - need || 1)) * 0.02
    if (sc + bias > bestScore) {
      bestScore = sc + bias
      bestAt = i * step
    }
  }
  return { at: bestAt, score: round2(bestScore), source: 'computed' }
}

/** 意图 → 可直接执行的编排建议（含窗口与手臂原片的三段映射）。 */
export function suggestion(intent, dur) {
  const r = recipe(intent)
  if (!r) return null
  const body = motion(r.body)
  if (!body) return null
  const hinted = Array.isArray(r.window) ? r.window[1] - r.window[0] : 0
  const want = clamp(Number(dur) || hinted || body.dur, 1, body.dur)
  const win = bestWindow(r.body, want)
  const at = Number.isFinite(win.at) ? win.at : 0
  return {
    intent: r.intent,
    tier: r.tier,
    body: r.body,
    bodyAt: round2(at),
    duration: round2(want),
    score: win.score,
    arm: r.arm,
    armMap: armMap(r.arm, want, body),
    face: r.face,
    note: r.note,
    beats: beatsIn(r.body, at, want),
  }
}

/**
 * 手臂原片的「抬手 / 保持 / 放手」三段映射。
 * 官方片段的 hold 段很长（1.1–22s），这里按目标时长截取，保证 1:1 不被拉伸。
 */
export function armMap(armName, dur, bodyMotion) {
  const a = motion(armName)
  if (!a) return []
  // 官方说话类原片固定节奏：0–1.1 抬手，1.1–22.0 保持，22.0–24.0 放手
  const rise = 1.1
  const fall = 2.0
  const total = Number(dur) || (bodyMotion ? bodyMotion.dur : 6)
  if (total <= rise + fall + 0.6) {
    return [{ src: [0, rise], at: 0, to: rise }, { src: [22.0, 24.0], at: total - fall, to: total }]
  }
  return [
    { src: [0, rise], at: 0, to: rise },
    { src: [1.1, 22.0], at: rise, to: total - fall },
    { src: [22.0, 24.0], at: total - fall, to: total },
  ]
}

/** 取某条动作在 [at, at+dur] 里的节拍（身体 + 头部）。 */
export function beatsIn(name, at = 0, dur = 6) {
  const m = motion(name)
  if (!m) return []
  const from = Number(at) || 0
  const to = from + (Number(dur) || 6)
  const mid = (from + to) / 2
  const all = [...(m.beats.body || []), ...(m.beats.head || [])].map((b) => ({
    t: b.t,
    p: b.p,
    v: b.v,
    // 窗口中心到节拍中心的距离，用来挑「最相关」的几拍
    d: Math.abs((b.t[0] + b.t[1]) / 2 - mid),
  }))
  const inside = all.filter((b) => b.t[1] > from && b.t[0] < to)
  const out = (inside.length ? inside : all).sort((a, b) => a.d - b.d).slice(0, 6)
  return out.sort((a, b) => a.t[0] - b.t[0])
}

/** 给 LLM 看的紧凑说明（等价于 dict/DICT.prompt.md 的运行时版）。 */
export function describe({ rules = true, limit = 0 } = {}) {
  const d = dict()
  const lines = []
  lines.push(`# 动作语义字典 v${d.version || 0}（${(d.motions || []).length} 条动作）`)
  if (rules) {
    lines.push('', '## 铁律')
    RULES.forEach((r, i) => lines.push(`${i + 1}. ${r}`))
  }
  lines.push('', '## 幅度三档')
  for (const [k, v] of Object.entries(tiers())) lines.push(`- ${k}：${v}`)
  lines.push('', '## 意图 → 资产')
  for (const r of intents()) {
    lines.push(`- ${r.intent}｜${r.tier}｜${r.body}｜${r.window[0]}–${r.window[1]}s｜手臂 ${r.arm}｜${r.note || ''}`)
  }
  lines.push('', '## 动作清单')
  const list = limit ? d.motions.slice(0, limit) : d.motions
  for (const m of list) {
    const arms = (m.arms || []).map((g) => `Mv${g}`).join('+') || '无手臂'
    const hold = Object.entries(m.holds || {})
      .map(([g, sec]) => `Mv${g} 保持 ${sec}s`)
      .join('、')
    const px = m.body && m.body.PositionX ? `PosX ${m.body.PositionX.join('..')}` : ''
    const lean = m.body && m.body.LeanInput ? `Lean ${m.body.LeanInput.join('..')}` : ''
    const danger = (m.faceswapDanger || []).length ? `｜换脸键 ${m.faceswapDanger.join(',')}（唱歌禁用）` : ''
    lines.push(
      `- ${m.name}｜${m.dur}s｜${m.tier}｜${arms}｜换手 ${m.switches} 次${hold ? '｜' + hold : ''}｜${px}｜${lean}${danger}`,
    )
  }
  return lines.join('\n')
}

export const RULES = [
  '身体层只用 PositionX/Y/Z、LeanInput、ShoulderX；ParamBodyAngle*、Chest*、Param138 在本模型上无效，禁用。',
  '没有「胸腔扭腰」这回事：官方所谓的扭 = PositionX ±14 + PositionZ ±13（表演-05-重心）。',
  '手臂只从 正常说话-抚胸 / 正常说话-食指 / 正常说话-狗尾草 三条原片整条搬（含 Param11/27–32 手指串），禁止自己拧关节。',
  '一条编排换手 ≤2 次、每次保持 ≥8s；Movement1/2/3 是换手开关，作者是 0.8s 斜坡，禁止二值化。',
  'AngleZ 只允许一个来源：tilt 会同时写 AngleZ + PositionZ，不能再和写这两个参数的 pose / sway 共存。',
  '烘焙 FadeInTime / FadeOutTime 必须是 0；收尾 0.9s 内回中立。',
  '表情只用叠加型：脸红 key7、爱心眼 key4、兔牙 key9；key1/3/5/6/10 是整脸换层，会顶掉嘴部动画。',
  '微笑打成 0.4s 脉冲；头比身体晚 0.1–0.3s 跟随，同时动会显得假。',
  '挑窗口看活跃度：用 bestWindow()／字典的 bestWindows，别凭感觉取开头。',
  '单条编排 ≤64 个 action，单段 0.2–20s（expression 到 59s），总长 ≤60s。',
]

function avg(arr) {
  if (!arr.length) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

const round2 = (v) => Math.round(Number(v) * 100) / 100
