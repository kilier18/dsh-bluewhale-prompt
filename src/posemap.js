// 工具/事件 → 桌宠动作。抄 crosspet 的「Agent 事件 → pose」思路：
// 工具名是事实，模型输出的 <|ACT|> 是表演欲，两者分开。
//
// 2026-11-18 动作库重置后（见 手册/10-蓝鲸桌宠.md）只剩官方 5 组：
//   Main=[待机]  TrackingLost=[脱捕]  Talk=[正常说话-抚胸|食指|狗尾草]（24s 循环）
//   Outfit=12 个换装  Emotion=11 条 情绪-* + 15 条 表演-*
// 旧的「原子-*」「动作-*」「唱歌*」「手势-*」全部删掉，这里只用上面这些。
// 选短小的 情绪-*（2.6–8s）做工具反馈，长段 表演-*（18–37s）只给场景用。

const RULES = [
  // 分身子代理：有人在替我干活
  [/^(subagent|subagent_fork|workflow|send_message|interrupt_agent|list_agents)/i, 'Animation/情绪-调皮-1.motion3.json'],
  // 写文件 / 改代码：指一指（说话-食指 24s 循环，取前 4.5s 的抬手段）
  [/^(write|edit|ops_write_file|ops_edit_file|ops_replace|office)/i, 'Animation/正常说话-食指.motion3.json'],
  // 跑命令：抚胸盯屏幕
  [/^(bash|pwsh|ops_bash|ops_move|ops_copy|ops_remove|job_)/i, 'Animation/正常说话-抚胸.motion3.json'],
  // 读东西：温柔低头
  [/^(read|ops_inspect_local_file|ops_read_files|ops_read_pdf|ops_read_docx|ops_read_table|ops_stat)/i, 'Animation/情绪-温柔-1.motion3.json'],
  // 搜索 / 抓网页：心动（侧看）
  [/^(grep|glob|ops_grep|ops_glob|web_search|web_fetch|bili_search|bili_subtitle|modlens)/i, 'Animation/情绪-心动-1.motion3.json'],
  // 浏览器 / B站：开心
  [/^(bsk_|bili_)/i, 'Animation/情绪-开心-1.motion3.json'],
  // 上下文管理：害羞（短，几乎无感）
  [/^(compress|decompress|search_context|acp_|session_)/i, 'Animation/情绪-害羞-1.motion3.json'],
  // 插件 / 配置类：沉稳点头
  [/^(plugin_manager|config_|schedule_|remote_|purge_)/i, 'Animation/表演-09-沉稳.motion3.json'],
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
  if (toolCount >= 3) return 'Animation/情绪-惊讶-1.motion3.json'
  return null
}

// ── 场景序列 ─────────────────────────────────────────────────────
// 一个场景 = 一串 [动作, 播多久]。
// airi 侧 <|DELAY n|> 是真 await sleep(n*1000)，n 填这个动作要播多久（≤ 文件时长）。
// 括号里是 motion3 的 Meta.Duration 实测值。

export const SCENES = {
  // 2026-11-18：场景改成「一条复合动作」——由 scripts/gen-scenes.mjs 用官方表演片段
  // 的 bestWindow + 作者手臂原片三段重映射生成，已推 OPFS 为 Custom。
  // 手臂规则（用户 m02698）：抚胸=通用不挑场景；食指=讲话/讲解；狗尾草=摸鱼/装傻/搞怪。
  // 身体重心/摇摆/表情全部来自作者原片，不再手写。
  greet: [['场景-greet', 6.0]],
  bye: [['场景-bye', 5.0]],
  explain: [['场景-explain', 9.0]],
  agree: [['场景-agree', 4.0]],
  deny: [['场景-deny', 4.5]],
  confuse: [['场景-confuse', 6.0]],
  idea: [['场景-idea', 5.0]],
  shy: [['场景-shy', 6.0]],
  sing: [['场景-sing', 3.0]],
  think: [['场景-think', 8.0]],
  listen: [['场景-listen', 8.0]],
  cheer: [['场景-cheer', 6.0]],
  tired: [['场景-tired', 7.0]],
  wow: [['场景-wow', 3.6]],
  comfort: [['场景-comfort', 5.0]],
  upset: [['场景-upset', 6.0]],
  // 摸鱼 / 装傻 / 搞怪：狗尾草专用（用户 m02698）
  slack: [['场景-slack', 7.0]],
  silly: [['场景-silly', 6.0]],
  tease: [['场景-tease', 6.0]],
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
