// 工具/事件 → 桌宠动作。抄 crosspet 的「Agent 事件 → pose」思路：
// 工具名是事实，模型输出的 <|ACT|> 是表演欲，两者分开。
// 这里只用「原子-*」（鲸语编译器烘出来的最小颗粒，幅度够、能看见）。
// 旧的「动作-*」头部动作幅度太小、容易被待机吃掉，不再用。

const RULES = [
  // 分身子代理：挑个眉，表示有人在替我干活
  [/^(subagent|subagent_fork|workflow|send_message|interrupt_agent|list_agents)/i, 'Animation/原子-挑眉.motion3.json'],
  // 写文件 / 改代码：竖食指，像在指点
  [/^(write|edit|ops_write_file|ops_edit_file|ops_replace|office)/i, 'Animation/原子-竖食指.motion3.json'],
  // 跑命令：前倾盯屏幕
  [/^(bash|pwsh|ops_bash|ops_move|ops_copy|ops_remove|job_)/i, 'Animation/原子-前倾.motion3.json'],
  // 读东西：低头看
  [/^(read|ops_inspect_local_file|ops_read_files|ops_read_pdf|ops_read_docx|ops_read_table|ops_stat)/i, 'Animation/原子-低头看.motion3.json'],
  // 搜索 / 抓网页：看一边
  [/^(grep|glob|ops_grep|ops_glob|web_search|web_fetch|bili_search|bili_subtitle|modlens)/i, 'Animation/原子-看右.motion3.json'],
  // 浏览器 / B站：眯眼笑
  [/^(bsk_|bili_)/i, 'Animation/原子-眯眼笑.motion3.json'],
  // 上下文管理：眨个眼，几乎无感
  [/^(compress|decompress|search_context|acp_|session_)/i, 'Animation/原子-眨眼.motion3.json'],
  // 插件 / 配置类：点个头
  [/^(plugin_manager|config_|schedule_|remote_|purge_)/i, 'Animation/原子-点头.motion3.json'],
]

/** 工具名 → 动作文件路径；没有匹配就是 null（不动） */
export function motionForTool(name) {
  if (!name) return null
  const n = String(name).replace(/^mcp__[^_]+__/, '') // mcp__server__tool → tool
  for (const [re, motion] of RULES) if (re.test(n)) return motion
  return null
}

/** 一轮结束时的收尾动作：工具多 = 干得漂亮，否则轻轻点头 */
export function motionForTurnEnd({ toolCount = 0, failed = false } = {}) {
  if (failed) return 'Animation/情绪-难过-1.motion3.json'
  if (toolCount >= 8) return 'Animation/情绪-开心-1.motion3.json'
  if (toolCount >= 3) return 'Animation/原子-连连点头.motion3.json'
  return null
}

// ── 场景序列 ─────────────────────────────────────────────────────
// 一个场景 = 一串 [动作, 播多久] 的原子动作。
// airi 侧 <|DELAY n|> 是真 await sleep(n*1000)，所以 n 就填这个动作本身的时长，
// 播完刚好接下一个；最后一个不用 DELAY。
// 时长都是实测的（motion3 的 Meta.Duration）。

export const SCENES = {
  // 打招呼
  greet: [['原子-看向你', 2.7], ['原子-微笑', 3.3]],
  // 再见
  bye: [['原子-微笑', 3.3], ['原子-单眼眨', 1.3], ['原子-看右', 2.9]],
  // 讲解 / 回答：指点 + 点头 + 说话 + 前倾
  explain: [['原子-竖食指', 4.5], ['原子-点头', 2.2], ['原子-说话', 4.2], ['原子-前倾', 3.5], ['原子-挑眉', 2.7]],
  // 简短肯定
  agree: [['原子-连连点头', 3.1], ['原子-微笑', 3.3]],
  // 否认
  deny: [['原子-摇头', 2.2], ['原子-挑眉', 2.7]],
  // 疑问 / 没听懂
  confuse: [['原子-疑惑', 3.3], ['原子-歪头左', 3.3]],
  // 想到点子了
  idea: [['原子-挑眉', 2.7], ['原子-眯眼笑', 3.3], ['原子-竖食指', 4.5]],
  // 害羞
  shy: [['原子-脸红', 3.7], ['原子-低头看', 2.7], ['原子-眯眼笑', 3.3]],
  // 唱歌：说话（嘴在动）+ 表情 + 歪头，循环三轮
  sing: [['原子-说话', 4.2], ['原子-眯眼笑', 3.3], ['原子-歪头左', 3.3],
         ['原子-说话', 4.2], ['原子-爱心眼', 3.7], ['原子-歪头右', 3.3],
         ['原子-说话', 4.2], ['原子-微笑', 3.3]],
  // 想事情
  think: [['原子-抬眼看', 2.7], ['原子-挑眉', 2.7], ['原子-看左', 2.9]],
  // 听你说
  listen: [['原子-看向你', 2.7], ['原子-点头', 2.2], ['原子-歪头左', 3.3]],
  // 兴奋 / 恭喜
  cheer: [['原子-爱心眼', 3.7], ['原子-眯眼笑', 3.3], ['原子-连连点头', 3.1]],
  // 累了
  tired: [['原子-低头看', 2.7], ['原子-眨眼', 1.2], ['原子-前倾', 3.5]],
  // 惊讶
  wow: [['原子-挑眉', 2.7], ['原子-圈圈眼', 3.7], ['原子-前倾', 3.5]],
  // 安慰
  comfort: [['原子-微笑', 3.3], ['原子-低头看', 2.7], ['原子-看右', 2.9]],
  // 不满
  upset: [['原子-鼓脸', 3.1], ['原子-摇头', 2.2], ['原子-黑脸', 3.7]],
}

/** 场景名 → [[动作路径, 秒], …]；没有就 null */
export function sceneSteps(name) {
  const list = SCENES[String(name || '').trim().toLowerCase()]
  if (!list) return null
  return list.map(([m, d]) => [`Animation/${m}.motion3.json`, d])
}

/** 场景名 → 一整串带 DELAY 的标记文本（直接丢给 followups.pushRaw） */
export function sceneText(name) {
  const steps = sceneSteps(name)
  if (!steps) return null
  return steps
    .map(([file, d], i) => `<|ACT {"motion":"${file}"}|>` + (i < steps.length - 1 ? `<|DELAY ${d}|>` : ''))
    .join('')
}