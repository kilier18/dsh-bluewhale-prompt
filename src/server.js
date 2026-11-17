// 给 AIRI 用的 OpenAI 兼容接口（AIRI 的意识模块填 http://127.0.0.1:端口/v1/）
//   GET  /v1/models            → 一个模型 "dsh"
//   POST /v1/chat/completions  → 支持普通 JSON 和 stream: true（SSE）
// 桌宠托盘「切换聊天」用：
//   GET  /dafei/sessions       → { current, sessions: [{ id, title, active }] }
//   POST /dafei/session        → { id } 切到那个会话；{ new: true } 下一句话新建会话
import http from 'node:http'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ask } from './dsh.js'
import { listSessions } from './sessions.js'
import { loadState, saveState, log } from './state.js'
import { cleanForSpeech, splitSentences } from './clean-text.js'
import { isChatRequest, lastUserText, extractSpeech } from './route.js'
import { withIdleMotion } from './idle-motion.js'
import { withOutfitMotions } from './outfit.js'
import { sceneText, sceneSteps, SCENES } from './posemap.js'
import { localHelperReply, forwardToDeepSeek } from './helpers.js'
import { isVisionRequest, describeImages } from './vision.js'
import { createFollowups, PENDING_MARK } from './followups.js'
import { petMessage } from './pet-rules.js'
import { speak, spokenLine, speaking, voiceEnabled, rvcOk, scriptOk, VOICE_SCRIPT, MAX_CHARS } from './voice.js'

const MODEL = 'dsh'
// aurabot 等插件让角色「不说话」时写的标记
const SILENCE = /^\s*[[［(（]沉默[\]］)）]\s*$/

export function createServer(ctx, cfg) {
  // 角色的原始回复 → 桌宠念的文字（带动作标记）；`|||` 是 aurabot 分条的写法，当成一句结束
  function speakable(raw) {
    if (!raw || SILENCE.test(raw)) return ''
    const spoken = withOutfitMotions(cleanForSpeech(String(raw).replace(/\s*\|\|\|\s*/g, '。\n')), cfg.outfitMotions)
    return withIdleMotion(spoken, cfg.idleMotions)
  }
  const followups = createFollowups(ctx, {
    prepare: speakable,
    // 每轮结束自动念一句（短口播）：托盘「语音回复」关掉时 voiceEnabled() 为假，直接静音
    speak: (raw) => {
      if (!voiceEnabled()) return
      if (!raw || SILENCE.test(raw)) return // 「沉默」不念
      const line = spokenLine(raw)
      if (!line) return
      speak(line, { dedupe: true })
    },
  })

  // 同一时间只让角色处理一句话，后来的排队
  let queue = Promise.resolve()
  const enqueue = (task) => {
    const result = queue.then(task, task)
    queue = result.catch(() => {})
    return result
  }

  async function chatReply(text) {
    if (!text) return cfg.fallbackReply
    const started = Date.now()
    log('← 收到：' + text)
    followups.open()
    try {
      const reply = speakable(await enqueue(() => ask(ctx, cfg, petMessage(text, cfg))))
      followups.forget(reply)
      log(`→ 回复（${((Date.now() - started) / 1000).toFixed(1)}s）：${reply}`)
      return reply || cfg.fallbackReply
    } catch (e) {
      // 报错只写日志，不返回给 AIRI
      log(`✗ 出错：[${e.code || 'ERROR'}]`, e)
      return cfg.fallbackReply
    }
  }

  async function visionReply(body) {
    const started = Date.now()
    try {
      const text = await describeImages(ctx, cfg, body)
      log(`👁 看图（${((Date.now() - started) / 1000).toFixed(1)}s）：${text.slice(0, 80)}`)
      return text
    } catch (e) {
      log('✗ 看图出错：', e)
      return ''
    }
  }

  async function helperReply(body) {
    const text = lastUserText(body)
    if (cfg.helperMode === 'deepseek' && cfg.deepseekApiKey) {
      try {
        return await forwardToDeepSeek(body, cfg)
      } catch (e) {
        log('✗ 辅助请求转发失败，改为本地回答：', e.message)
      }
    }
    return localHelperReply(body, text)
  }

  async function chatCompletions(req, res) {
    let body
    try {
      const raw = await readText(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return sendJson(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } })
    }

    // 桌宠来取后续消息（通知请求，内容含 PENDING_MARK）：直接交出存着的话，不发给角色
    const pendingRequest = lastUserText(body).includes(PENDING_MARK)
    if (pendingRequest) log(`⤷ 桌宠取走后续消息（${followups.count()} 条）`)
    const reply = pendingRequest
      ? followups.take()
      : isVisionRequest(body)
      ? await visionReply(body)
      : isChatRequest(body)
        ? await chatReply(extractSpeech(lastUserText(body)))
        : await helperReply(body)
    const id = 'chatcmpl-' + randomUUID()
    const created = Math.floor(Date.now() / 1000)

    if (!body.stream) {
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    }

    // 流式：角色一整轮说完才有回复，所以一句一句发出去
    if (res.destroyed) return
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.write(chunk({ role: 'assistant', content: '' }))
    for (const sentence of splitSentences(reply)) res.write(chunk({ content: sentence }))
    res.write(chunk({}, 'stop'))
    res.end('data: [DONE]\n\n')
  }

  async function switchSession(req, res) {
    let body = {}
    try {
      body = JSON.parse((await readText(req)) || '{}')
    } catch {}
    if (body.new) {
      saveState({ sessionId: null })
      return sendJson(res, 200, { ok: true, current: null })
    }
    const s = listSessions(cfg.workDir, cfg.allWorkspaces).find((x) => x.id === body.id)
    if (!s) return sendJson(res, 404, { ok: false, error: `找不到会话 ${body.id}` })
    // pinnedAt：手动选的会话先被人为锁定 10 分钟，别被"自动跟随"立刻改掉
    saveState({ sessionId: s.id, pinnedAt: Date.now() })
    log(`切换会话：${s.title}`)
    return sendJson(res, 200, { ok: true, current: s.id })
  }

  // Agent 主动让桌宠演/说：POST /dafei/act
  //   { motion?, emotion?, expression?, delay?, say? } → 进待说队列，桌宠下一次轮询就演
  async function actRoute(req, res) {
    let body = {}
    try { body = JSON.parse((await readText(req)) || '{}') } catch {}
    const parts = []
    if (body.motion) parts.push(`<|ACT ${JSON.stringify({ motion: String(body.motion) })}|>`)
    if (body.emotion) {
      const e = typeof body.emotion === 'string' ? { name: body.emotion } : body.emotion
      parts.push(`<|ACT ${JSON.stringify({ emotion: e })}|>`)
    }
    if (body.expression !== undefined) parts.push(`<|ACT ${JSON.stringify({ expression: body.expression })}|>`)
    if (body.delay) parts.push(`<|DELAY ${Number(body.delay)}|>`)
    if (body.say) parts.push(String(body.say))
    const text = parts.join('')
    if (!text) return sendJson(res, 400, { ok: false, error: '至少给 motion / emotion / expression / delay / say 之一' })
    followups.push(text)
    log('◀ Agent 主动动作：' + text)
    return sendJson(res, 200, { ok: true, queued: followups.count(), text })
  }

  // Agent 主动让桌宠演一段场景：POST /dafei/scene
  //   { name: 'explain' } → 把 SCENES[name] 拼成一串 ACT+DELAY 丢进待说队列
  //   和 /dafei/act 的区别：act 演单个动作，scene 按时间轴连演一串
  async function sceneRoute(req, res) {
    let body = {}
    try { body = JSON.parse((await readText(req)) || '{}') } catch {}
    const name = String(body.name || '').trim()
    if (!name) {
      return sendJson(res, 400, { ok: false, error: '需要 name', scenes: Object.keys(SCENES) })
    }
    const text = sceneText(name)
    if (!text) {
      return sendJson(res, 400, { ok: false, error: '没有这个场景：' + name, scenes: Object.keys(SCENES) })
    }
    followups.pushRaw(text)
    log('◀ Agent 场景：' + name + ' → ' + text.slice(0, 160))
    return sendJson(res, 200, { ok: true, scene: name, steps: sceneSteps(name).length, queued: followups.count(), text })
  }

  // 录制/演示长动作前暂停推送：POST /dafei/pause { on: true|false }
  //   根因：airi 的 onBeforeSend 里 `if (holdsVoice(context)) currentMotion = {group:'Think'}`，
  //   只要它从 /dafei/pending 取到内容发一条消息，就会用 FORCE 顶掉正在演的长动作。
  //   暂停期间 push / pushMotion / pushRaw 一律返回 false，pending 保持空 → airi 不会发消息 → 不打断。
  async function pauseRoute(req, res) {
    let body = {}
    try { body = JSON.parse((await readText(req)) || '{}') } catch {}
    const paused = followups.setPaused(!!body.on)
    return sendJson(res, 200, { ok: true, paused, count: followups.count() })
  }

  // ---- 语音回复 ------------------------------------------------------------------
  //   GET  /dafei/voice          → { enabled, rvcOk, scriptOk }
  //   POST /dafei/voice          → { enabled: true|false }  托盘开关用
  //   POST /dafei/say            → { text, model?, voice?, play?, motion? } 后台合成播放
  async function sayRoute(req, res) {
    let body = {}
    try { body = JSON.parse((await readText(req)) || '{}') } catch {}
    const text = String(body.text || '').trim()
    if (!text) return sendJson(res, 400, { ok: false, error: '需要 text' })
    // 上限用 speak 真正会念的长度：说 400 却只念 200 会被当成"我念了"
    if (text.length > MAX_CHARS) return sendJson(res, 400, { ok: false, error: `太长（上限 ${MAX_CHARS} 字），分句发` })
    if (!scriptOk()) {
      return sendJson(res, 503, { ok: false, error: '朗读脚本不存在：' + VOICE_SCRIPT })
    }
    if (!(await rvcOk())) {
      return sendJson(res, 503, { ok: false, error: 'RVCover 没启动（127.0.0.1:8765）' })
    }
    // 手动点的朗读不去重（自动朗读那条路才去重）；opts 只取白名单，别把整个请求体塞进去
    const opts = {}
    if (body.play === false) opts.play = false
    if (body.motion === false) opts.motion = false
    for (const k of ['model', 'voice', 'pitch']) if (body[k] !== undefined) opts[k] = body[k]
    const r = speak(text, opts)
    return sendJson(res, r.ok ? 200 : 500, r)
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()

    // 兼容 /v1/models、/v1//models、/models 等写法
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+/g, '/').replace(/\/$/, '')
    const api = path.replace(/^\/v1/, '')
    try {
      if (req.method === 'GET' && api === '/models') {
        return sendJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'dsh-dafei' }] })
      }
      if (req.method === 'POST' && api === '/chat/completions') return await chatCompletions(req, res)
      if (req.method === 'GET' && path === '/dafei/sessions') {
        return sendJson(res, 200, { current: loadState().sessionId || null, sessions: listSessions(cfg.workDir, cfg.allWorkspaces) })
      }
      if (req.method === 'POST' && path === '/dafei/session') return await switchSession(req, res)
      if (req.method === 'POST' && path === '/dafei/act') return await actRoute(req, res)
      if (req.method === 'POST' && path === '/dafei/scene') return await sceneRoute(req, res)
      // 录制长动作/唱歌前先 on:true，录完 off:false
      //   GET  /dafei/pause 也能查当前状态
      if (path === '/dafei/pause') {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, paused: followups.isPaused(), count: followups.count() })
        if (req.method === 'POST') return await pauseRoute(req, res)
      }
      if (req.method === 'GET' && path === '/dafei/pending') return sendJson(res, 200, { count: followups.count() })
      if (req.method === 'GET' && path === '/dafei/health') return sendJson(res, 200, { ok: true })

      // ---- 语音 ----
      if (req.method === 'GET' && path === '/dafei/voice') {
        return sendJson(res, 200, {
          enabled: loadState().voiceEnabled === true,
          rvcOk: await rvcOk(),
          scriptOk: fs.existsSync(VOICE_SCRIPT),
          ...speaking(),
        })
      }
      if (req.method === 'POST' && path === '/dafei/voice') {
        let body = {}
        try { body = JSON.parse((await readText(req)) || '{}') } catch {}
        const enabled = !!body.enabled
        saveState({ voiceEnabled: enabled })
        log('语音回复' + (enabled ? ' 已开启' : ' 已关闭'))
        return sendJson(res, 200, { ok: true, enabled })
      }
      if (req.method === 'POST' && path === '/dafei/say') return await sayRoute(req, res)
      sendJson(res, 404, { error: { message: `Not found: ${req.method} ${req.url}`, type: 'invalid_request_error' } })
    } catch (e) {
      log('✗ 处理请求出错：', e)
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error', type: 'server_error' } })
      else res.end()
    }
  })

  // 端口被占（比如旧特别版的桥还开着）就每 10 秒再试一次
  let retryTimer = null
  let closed = false
  const listen = () => server.listen(cfg.port, '127.0.0.1')
  server.on('listening', () => log(`角色接口已启动：http://127.0.0.1:${cfg.port}/v1`))
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE' || closed) return log('✗ 接口出错：', e)
    log(`端口 ${cfg.port} 被占用了，10 秒后再试（是不是旧的 dsh-bridge 还开着？）`)
    retryTimer = setTimeout(listen, 10000)
  })

  return {
    start: listen,
    stop() {
      closed = true
      followups.dispose()
      clearTimeout(retryTimer)
      server.closeAllConnections?.()
      return new Promise((r) => server.close(() => r()))
    },
  }
}

function readText(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
