import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 插件根目录（src 的上一级）
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 运行时状态：{ sessionId }，桌宠说的话发到哪个会话；重启后继续用同一个
const STATE_PATH = path.join(ROOT, 'data', 'state.json')

// 热路径缓存：session/event 是全量订阅，一次回复能进来上千条事件，
// 每条都 readFileSync+parse 一次不划算。写 state 时失效即可。
let cache = { at: 0, value: null }
const CACHE_MS = 800

export function loadStateCached() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value
  const v = loadState()
  cache = { at: Date.now(), value: v }
  return v
}

export function loadState() {
  try {
    // 去掉 BOM，否则 JSON.parse 会报错
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8').replace(/^﻿/, ''))
  } catch {
    return {}
  }
}

export function saveState(patch) {
  cache = { at: 0, value: null }   // 先失效缓存，别让调用方读到旧值
  const next = { ...loadState(), ...patch }
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  // 先写临时文件再改名，避免写到一半断电把文件写坏
  const tmp = STATE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, STATE_PATH)
}

// 简单日志：写进 data/dafei.log，超过 1MB 就从头写
const LOG_PATH = path.join(ROOT, 'data', 'dafei.log')

let logSize = -1
let logSizeAt = 0

export function log(...args) {
  const line = `[${new Date().toLocaleString()}] ${args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    // 体积每 60 秒才 stat 一次；超 1MB 轮转成 .1（不要清空 —— 出事那次的现场正好在里面）
    if (Date.now() - logSizeAt > 60000 || logSize < 0) {
      try { logSize = fs.statSync(LOG_PATH).size } catch { logSize = 0 }
      logSizeAt = Date.now()
    }
    if (logSize > 1024 * 1024) {
      try { fs.renameSync(LOG_PATH, LOG_PATH + '.1') } catch { }
      logSize = 0
    }
    fs.appendFileSync(LOG_PATH, line)
    logSize += Buffer.byteLength(line)
  } catch {}
}
