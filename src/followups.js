// 后续消息：桌宠说完一句后，会话里又冒出来的话（提醒到点补的一句、aurabot 主动搭话等）
// 桌宠是「问一句等一句」，这些话不在它等的那一轮里，所以插件先存起来，等桌宠来取
//   桌宠发来一句话 → 打开 WINDOW_MS 的窗口，清掉旧的待说
//   窗口里，同一个会话结束的一轮，只要不是有人打字发起的（桌宠和 DSH 窗口都算打字，来源 kind=user），回复就存进待说
//   桌宠 5 秒后每 2 秒问一次 GET /dafei/pending，有的话发一个通知请求（内容含 PENDING_MARK），插件把待说整段交给它念
import { loadState, loadStateCached, saveState, log } from './state.js'
import { motionForTool, motionForTurnEnd } from './posemap.js'

export const PENDING_MARK = '[dafei-pending]'
const WINDOW_MS = 75 * 1000

// 整体暂停推送。
// 原因：airi 的 onBeforeSend 里有 `if (holdsVoice(context)) currentMotion = {group:'Think'}`，
// 只要它取到 pending 发一条消息，就会用 FORCE 顶掉正在演的动作（唱歌/长表演被秒杀）。
// 录制或演示长动作前调 POST /dafei/pause {on:true} 把这条路掐掉。
let paused = false

export function createFollowups(ctx, { prepare, speak }) {
  let until = 0
  let pending = []
  const turns = new Map() // turn → { typed, texts }

  function open() {
    until = Date.now() + WINDOW_MS
    pending = []
  }

  let lastStarted = null

  // ── 纯动作通道（不带文字，不念，只演）────────────────────────
  const MOTION_GAP = 2200 // 两个动作之间至少隔这么久，免得打架
  const MOTION_REPEAT = 12000 // 同一个动作这么久内不重复
  let lastMotionAt = 0
  let motionSeen = new Map()

  function pushMotion(motion) {
    if (paused) return false
    if (!motion) return false
    const now = Date.now()
    if (now - lastMotionAt < MOTION_GAP) return false
    if (now - (motionSeen.get(motion) || 0) < MOTION_REPEAT) return false
    lastMotionAt = now
    motionSeen.set(motion, now)
    if (motionSeen.size > 40) motionSeen = new Map()
    pending.push(`<|ACT {"motion":"${motion}"}|>`)
    log('⤷ 动作：' + motion)
    return true
  }

  // 自动朗读：开关在托盘（state.voiceEnabled，见 voice.js），关掉就一句都不念
  // 录制保护期间（paused）也不念，避免动作被 Think 顶掉
  function autoSpeak(text) {
    if (paused || !speak) return
    try {
      speak(text)
    } catch (e) {
      log('✗ 自动朗读出错：', e)
    }
  }

  // 会话漂移自愈：DSH 重启后经常给你开一个新会话 id，而 data/state.json 还绑着旧 id，
  // 于是插件一个事件都收不到（语音不响、动作不发，全静悄悄）。
  // 判据：绑定的会话 5 分钟没有任何事件，而现在这个会话冒出一条"用户打字"的消息 → 跟过去。
  let lastSeenAt = 0
  const FOLLOW_AFTER_MS = 5 * 60 * 1000
  const PIN_GUARD_MS = 10 * 60 * 1000

  function onEvent(session, e) {
    if (!e || !session?.id) return
    const bound = loadStateCached().sessionId
    if (session.id !== bound) {
      const pinnedAt = loadStateCached().pinnedAt || 0
      if (
        Date.now() - pinnedAt > PIN_GUARD_MS && // 刚手动选过的会话，10 分钟内不许被抢
        e.type === 'user/message' &&
        e.data?.source?.kind === 'user' &&
        (lastSeenAt === 0 || Date.now() - lastSeenAt > FOLLOW_AFTER_MS)
      ) {
        try {
          saveState({ sessionId: session.id })
          log('⇄ 自动跟随活跃会话：' + session.id + '（原来绑的 ' + bound + ' 已经没动静了）')
          lastSeenAt = Date.now()
        } catch (err) {
          log('✗ 自动跟随会话失败：', err)
        }
      }
      return
    }
    lastSeenAt = Date.now()
    if (e.type === 'turn/start') lastStarted = e.data?.turn ?? lastStarted
    // user/message 有时不带轮次编号，算在刚开始的那一轮（和 dsh.js 一样）
    const turn = e.data?.turn ?? (e.type === 'user/message' ? lastStarted : undefined)
    if (turn === undefined || turn === null) return
    let t = turns.get(turn)
    if (!t) {
      t = { typed: false, texts: [], tools: 0 }
      turns.set(turn, t)
      if (turns.size > 50) turns.delete(turns.keys().next().value)
    }
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') t.typed = true
    else if (e.type === 'assistant/message' && !e.data?.interrupted) {
      const blocks = e.data?.message?.content || []
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      if (text) t.texts.push(text)
      // Agent 在干活：工具名 → 动作（crosspet 那套路子，工具是事实，动作是反应）
      for (const b of blocks) {
        if (b.type !== 'tool-call' || !b.name) continue
        t.tools += 1
        pushMotion(motionForTool(b.name))
      }
    } else if (e.type === 'turn/end') {
      const ended = t
      turns.delete(turn)
      // 一轮干完：工具多就给个笑，出错就难过（不管是不是打字发起的）
      if (ended.tools >= 3) pushMotion(motionForTurnEnd({ toolCount: ended.tools, failed: e.data?.reason?.kind === 'failed' }))
      // 语音回复：这一轮最后一句 → 桌宠念（不管是不是打字发起的，桌宠问话也算）
      const said = ended.texts.at(-1)
      if (said) autoSpeak(said)
      if (ended.typed || e.data?.reason?.kind !== 'completed' || !ended.texts.length || Date.now() > until) return
      const reply = prepare(ended.texts.at(-1))
      if (!reply) return
      pending.push(reply)
      log('⤷ 后续消息，等桌宠来取：' + reply)
    }
  }

  const off = ctx.on('session/event', onEvent, { global: true })

  return {
    open,
    // 外部注入（POST /dafei/act、Agent 工具）想让桌宠念/演的内容，走同一条待说通道
    push(text) {
      if (paused) return false
      const t = prepare(text)
      if (!t) return false
      pending.push(t)
      log('⤷ 主动动作，等桌宠来取：' + t)
      return true
    },
    /**
     * 原样塞进去，不过 prepare（不过 cleanForSpeech）。
     * 场景序列要用它：<|DELAY n|> 在 clean 阶段会被当"不念的东西"删掉，
     * 但 airi 侧 onSignal 是真 await sleep(n*1000)，所以延迟必须保留下来。
     */
    pushRaw(text) {
      if (paused) return false
      const t = String(text || '').trim()
      if (!t) return false
      pending.push(t)
      log('⤷ 场景序列，等桌宠来取：' + t.slice(0, 200))
      return true
    },
    count: () => pending.length,
    isPaused: () => paused,
    /** 暂停/恢复所有推送；暂停时顺手把已攒的清掉 */
    setPaused(v) {
      paused = !!v
      if (paused) pending = []
      log(paused ? '⏸ 推送已暂停（保护正在演的长动作）' : '▶ 推送已恢复')
      return paused
    },
    clear() {
      const n = pending.length
      pending = []
      log('⤷ 清空待说 ' + n + ' 条')
      return n
    },
    // 桌宠这一句的回复已经正常交出去了：待说里同样的话删掉，免得念两遍
    forget(reply) {
      const bare = (s) => String(s || '').replace(/<\|[\s\S]*?\|>/g, '').trim()
      const before = pending.length
      pending = pending.filter((p) => bare(p) !== bare(reply))
      if (pending.length < before) log('⤷ 待说里有和这一句一样的话，删掉')
    },
    take() {
      const all = pending.join('')
      pending = []
      return all
    },
    dispose: () => off?.(),
  }
}
