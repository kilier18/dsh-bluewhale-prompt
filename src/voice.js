// 语音回复：文字 → Edge-TTS（微软免费端点）→ RVC（鲸鱼娘音色）→ 播放 + 正常说话-抚胸
//   开关：托盘「语音回复：开/关」→ POST /dafei/voice → state.voiceEnabled
//   关掉时：一行都不念（speak 直接返回 false），但 /dafei/say 手动调用仍然有效
//   Agent 想给「短的口语版」，在回复里单起一行写 `[说] 要说的话`（整行即口播）；
//   写 `[说]…[/说]` 也认。都没写就自动从正文第一段里截一句，保证不把长回复整段念出来
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadState, log, ROOT } from './state.js'
import { cleanForSpeech } from './clean-text.js'

// 朗读脚本（Edge-TTS → RVC → 播放 + 张嘴）
// 朗读脚本随插件一起发布：`scripts/dafei-voice.mjs`（仓库内相对路径解析，
// 可用环境变量 DAFEI_VOICE_SCRIPT 覆盖成别处的脚本）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const VOICE_SCRIPT =
  process.env.DAFEI_VOICE_SCRIPT || path.resolve(HERE, '..', 'scripts', 'dafei-voice.mjs')
export const RVC_ORIGIN = 'http://127.0.0.1:8765'
// 硬上限：超过就别念了，念出来也没人听得完
export const MAX_CHARS = 200
// 自动朗读的默认口播长度（约 10 秒）：桌宠只要「吭一声」，不要念稿
export const SPEAK_CHARS = 60

const MARKER = /<\|[\s\S]*?\|>/g
// 口播开标签：[说] / 【说】 / ［说］。**不要求闭合** ——
// 真实链路里 [/说] 有时会被上层吃掉，只剩开标签，
// 所以判据是「出现开标签 → 后面的那一段就是要念的话」。
const SAY_OPEN = /[\[［【]说[\]］】]/
const SAY_CLOSE = /[\[［【]\s*\/\s*说[\]］】]/
// 残留标记（吃掉的闭合标签、行内的 [说]）统一剥掉
const STRAY_SAY = /[\[［【]\s*\/?\s*说[\]］】]/g
// 「沉默」标记：这类回复一个字都不念
const SILENCE = /^\s*[\[［(（]沉默[\]］)）]\s*$/

export function voiceEnabled() {
  try {
    return loadState().voiceEnabled === true
  } catch {
    return false
  }
}

export function scriptOk() {
  return fs.existsSync(VOICE_SCRIPT)
}

export async function rvcOk() {
  try {
    const r = await fetch(RVC_ORIGIN + '/api/models', { signal: AbortSignal.timeout(1200) })
    return r.ok
  } catch {
    return false
  }
}

// RVC 状态缓存：没起的时候不要每轮都 spawn 一个必死的进程（还占着播放槽）
let rvcSeen = { ok: true, at: 0 }
let rvcWarnAt = 0
function rvcGate() {
  if (rvcSeen.at && !rvcSeen.ok && Date.now() - rvcSeen.at < 60 * 1000) {
    if (Date.now() - rvcWarnAt > 5 * 60 * 1000) {
      rvcWarnAt = Date.now()
      log('⚠ RVCover 没起（127.0.0.1:8765），这轮先不念')
    }
    return false
  }
  rvcOk().then((ok) => { rvcSeen = { ok, at: Date.now() } }).catch(() => {})
  return true
}

// 朗读脚本的 stdout 用 --log 追加进 data/voice.log（隐藏启动时看不到控制台）
const VOICE_LOG = path.join(ROOT, 'data', 'voice.log')

function rotateLog() {
  try {
    fs.mkdirSync(path.dirname(VOICE_LOG), { recursive: true })
    if (!fs.existsSync(VOICE_LOG)) return
    if (fs.statSync(VOICE_LOG).size <= 1024 * 1024) return
    // 轮转而不是清空：出问题时上一轮的日志还在
    fs.renameSync(VOICE_LOG, VOICE_LOG + '.1')
  } catch {}
}

// 同一句短时间内不重复念（自动朗读时用；手动的 /dafei/say 不去重）
let lastSpoken = { text: '', at: 0 }
const DEDUPE_MS = 20 * 1000

// 正在念的那一句：RVC 是单队列，两句同时进会互相顶，所以默认等上一句念完
let inflight = null
let inflightText = ''
let queued = ''          // 上一句还在念时，最多留一句待播（留多了就成了念稿）

/**
 * 后台合成并播放，立即返回（真正出声在 15~30 秒后）
 * @param {string} text 要念的话
 * @param {{play?:boolean, motion?:boolean, model?:string, voice?:string, pitch?:number|string, dedupe?:boolean, overlap?:boolean}} opts
 */
export function speak(text, opts = {}) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  if (!line) return { ok: false, error: '空文本' }
  if (!scriptOk()) return { ok: false, error: '朗读脚本不存在：' + VOICE_SCRIPT }
  if (!rvcGate()) return { ok: false, error: 'RVCover 没起' }

  const now = Date.now()
  if (opts.dedupe && lastSpoken.text === line && now - lastSpoken.at < DEDUPE_MS) {
    return { ok: false, error: '同一句刚念过' }
  }
  // 上一句还没念完：留一条待播，等它 exit 再补 —— 直接丢弃会让活跃对话里大半句话没声音
  if (inflight && !opts.overlap) {
    if (queued !== line) {
      queued = line
      log('⋯ 排到下一句（上一句还在念）：' + line.slice(0, 40))
    }
    return { ok: true, queued: true, text: line.slice(0, MAX_CHARS) }
  }

  const text200 = line.slice(0, MAX_CHARS)
  const args = [VOICE_SCRIPT, text200, '--log', VOICE_LOG]
  if (opts.play === false) args.push('--no-play')
  if (opts.motion === false) args.push('--no-motion')
  if (opts.model) args.push('--model', String(opts.model))
  if (opts.voice) args.push('--voice', String(opts.voice))
  if (opts.pitch !== undefined) args.push('--pitch', String(opts.pitch))

  rotateLog()
  let child
  try {
    // 关键：**不要** detached。Node 的 windowsHide(=CREATE_NO_WINDOW) 只有在不 detach 时
    // 才真正压住控制台窗口；detached 会让 Windows 给 node.exe 另开一个新控制台 —— 那就是一闪的黑框。
    // unref 让 DSH 退出时不被这个子进程拖住（子进程自己会念完、自己清场）。
    child = spawn(process.execPath, args, { windowsHide: true, stdio: 'ignore' })
  } catch (e) {
    log('✗ 朗读启动失败：', e)
    return { ok: false, error: 'spawn 失败: ' + (e && e.message) }
  }

  inflight = child
  inflightText = line
  const clear = () => {
    if (inflight !== child) return
    inflight = null
    inflightText = ''
    const next = queued
    queued = ''
    if (next) setTimeout(() => speak(next, { dedupe: false }), 50)
  }
  child.on('exit', clear)
  child.on('error', (e) => {
    log('✗ 朗读进程出错：', e)
    clear()
  })
  child.unref()

  lastSpoken = { text: line, at: now }
  log('◀ 朗读：' + text200.slice(0, 80))
  return { ok: true, started: true, text: text200 }
}

// 现在有没有在念（给 /dafei/voice 这类状态接口用）
// 暂停/录制保护：把排着队还没念的那句清掉（正在念的那句不掐，等它自己结束）
export function clearQueue() {
  const had = queued
  queued = ''
  if (had) log('⏹ 清掉队列里没念的那句：' + had.slice(0, 40))
  return !!had
}

export function speaking() {
  return {
    busy: !!inflight,
    text: inflight ? inflightText.slice(0, 60) : '',
    queued: queued ? queued.slice(0, 60) : '',
  }
}

// 统一清洗：标记 / 路径 / 文件名 / URL / markdown 符号 / 表情标记 —— 念出来都是噪音
function tidy(s) {
  return String(s ?? '')
    .replace(MARKER, ' ')
    .replace(STRAY_SAY, ' ')
    .replace(/[A-Za-z]:\\[^\s，。；、！？]+/g, ' ')                            // Windows 路径
    .replace(/(?:^|\s)(?:[\w./-]+[\\/])*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|log|py|exe|bat|cmd|ps1|md|wav|mp3|txt)\b/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\`*_>#|]/g, ' ')
    .replace(/\[\s*(doge|笑哭|滑稽|妙啊|打call|吃瓜|哦呼)\s*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 一行是不是「能念的散文」：标题/表格/代码/列表/协议标记都不念
function proseLine(line) {
  const s = line.trim()
  if (!s) return ''
  if (/^(```|~~~|#{1,6}\s|>|\||<\|)/.test(s)) return ''
  if (/^[-*+•]\s/.test(s)) return ''
  if (/^\d+[.)]\s/.test(s)) return ''
  if (/^[=\-_*]{3,}$/.test(s)) return ''
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  if (cjk < 2) return ''   // 一个中文字都没有 = 命令 / 路径 / 英文标识
  return s
}

/**
 * 从一条回复里取「适合念出来的一小段」：
 *   1) 有 [说]…[/说] 就用它；有行首 `[说] 要说的话` 就用这一行
 *   2) 否则 cleanForSpeech 去掉 markdown / 代码 / 链接 / 标记，取第一段散文的前 1~2 句
 */
export function spokenLine(reply, opts = {}) {
  const maxChars = opts.maxChars || SPEAK_CHARS
  const raw = String(reply ?? '')
  // 「沉默」：一个字都不念
  if (SILENCE.test(raw)) return ''

  // 1) Agent 指定了口播：从开标签往后取
  const open = SAY_OPEN.exec(raw)
  if (open) {
    let rest = raw.slice(open.index + open[0].length)
    const close = SAY_CLOSE.exec(rest)
    if (close) rest = rest.slice(0, close.index)
    else {
      // 没闭合：只取到本段结束（空行），单行口播自然不会跑偏
      const stop = rest.search(/\n\s*\n/)
      if (stop >= 0) rest = rest.slice(0, stop)
    }
    const said = tidy(cleanForSpeech(rest))
    const line = said && clampSentence(said, maxChars)
    if (line) return line
  }

  // 2) 没指定：从正文里挑第一句人话（逐行过滤必须在 cleanForSpeech **之前**，
  //    否则 ## / | / ``` 这些结构标记已经被抹掉了，认不出标题和表格）
  const kept = []
  let fence = false
  for (const rawLine of raw.split('\n')) {
    const l = rawLine.trim()
    if (/^(```|~~~)/.test(l)) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (!proseLine(l)) continue
    const cleaned = tidy(cleanForSpeech(l))
    // 一个字中文都没有的多半是命令/英文标识；「改好了。」这种短确认要念
    const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length
    if (cjk === 0) continue
    if (cjk < 2 && cleaned.length > 6) continue
    kept.push(cleaned)
    if (kept.join(' ').length >= maxChars) break
  }
  const text = kept.join(' ')
  if (!text) return ''
  return clampSentence(text, maxChars)
}

// 按句号累加到 ~24 字就停；超长按最后一个标点截断
function clampSentence(text, maxChars) {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [text]
  let out = ''
  for (const part of parts) {
    const s = part.trim()
    if (!s) continue
    if (out && (out + s).length > maxChars) break
    out += s
    if (out.length >= 24) break
  }
  if (!out) out = text

  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars)
    const at = Math.max(...['。', '！', '？', '，', '；', '、', '：'].map((c) => cut.lastIndexOf(c)))
    out = at > 10 ? cut.slice(0, at + 1) : cut + '…'
  }
  out = out.replace(/[，,、；;：:]+$/, '').trim()
  if (!out) return ''
  if (!/[。！？!?…]$/.test(out)) out += '。'
  return out
}