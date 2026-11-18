#!/usr/bin/env node
// 从字典生成「给 agent 看的速查卡」dict/DICT.prompt.md。
// 改完字典（pull-motions + l2d-dict.py）后跑一次，保证文档与数据同源：
//   node scripts/gen-prompt.mjs
import { writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, tiers, intents } from '../src/l2d-dict.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'dict', 'DICT.prompt.md')

const dict = JSON.parse(readFileSync(path.join(ROOT, 'dict', 'l2d-motion-dict.json'), 'utf8'))

const L = []
L.push('# 动作语义字典 · agent 速查卡')
L.push('')
L.push('> 这份文件由 `node scripts/gen-prompt.mjs` 从 `dict/l2d-motion-dict.json` 生成，别手改。')
L.push('> 数据来源：桌宠 OPFS 里 44 条官方 motion3 的逐帧实测（作者原曲线，不是估算）。')
L.push('')
L.push('## 怎么用（三步）')
L.push('')
L.push('1. **定档**：先确定这句话的情绪落在 `steady` / `cozy` / `bomb` 哪一档，再从该档挑一条动作当「身体层」。')
L.push('2. **挑窗口**：别用片段开头，用 `bestWindow(name, 时长)` 给的活跃窗口（字典里 `bestWindows` 已经预算好 4/6/10/14/20s）。')
L.push('3. **配手臂**：手臂只从 `正常说话-抚胸 / 正常说话-食指 / 正常说话-狗尾草` 三条原片整条搬，按 `armMap` 做时间重映射；一条编排换手 ≤2 次。')
L.push('')
L.push('在线查询（插件起着的时候）：')
L.push('')
L.push('```')
L.push('GET /dafei/dict                                    # 全量索引')
L.push('GET /dafei/dict?intent=撒娇&duration=12             # 直接给建议：动作、起始秒、手臂映射')
L.push('GET /dafei/dict?text=1&limit=20                     # 纯文本速查（可直接塞进 prompt）')
L.push('```')
L.push('')
L.push('## 幅度三档')
L.push('')
for (const [k, v] of Object.entries(tiers())) L.push(`- **${k}** —— ${v}`)
L.push('')
L.push('## 意图 → 资产（18 条）')
L.push('')
L.push('| 意图 | 档 | 身体层动作 | 官方窗口(s) | 手臂 | 表情 | 备注 |')
L.push('|---|---|---|---|---|---|---|')
for (const r of intents()) {
  L.push(`| ${r.intent} | ${r.tier} | ${r.body} | ${r.window[0]}–${r.window[1]} | ${r.arm} | ${r.face} | ${r.note || ''} |`)
}
L.push('')
L.push('## 动作清单（44 条，含实测幅度与手臂保持）')
L.push('')
L.push('```')
L.push(describe({ rules: false }))
L.push('```')
L.push('')
L.push('## 铁律')
L.push('')
L.push('```')
L.push(describe({ limit: 1 }).split('## 动作清单')[0])
L.push('```')
L.push('')

writeFileSync(OUT, L.join('\n'), 'utf8')
console.log('wrote', OUT, readFileSync(OUT, 'utf8').length, 'chars,', dict.motions.length, 'motions')
