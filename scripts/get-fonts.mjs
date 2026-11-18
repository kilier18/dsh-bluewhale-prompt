#!/usr/bin/env node
/**
 * get-fonts.mjs —— 下载字幕字体到 fonts/（默认霞鹜文楷，SIL OFL 1.1）
 *   node scripts/get-fonts.mjs [--all]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts')
const ALL = process.argv.includes('--all')
const VER = 'v1.530'
const files = ['LXGWWenKai-Medium.ttf', ...(ALL ? ['LXGWWenKai-Light.ttf', 'LXGWWenKai-Regular.ttf'] : [])]

fs.mkdirSync(DIR, { recursive: true })
for (const f of files) {
  const out = path.join(DIR, f)
  if (fs.existsSync(out) && fs.statSync(out).size > 1_000_000) { console.log(`已存在 ${f}`); continue }
  const url = `https://github.com/lxgw/LxgwWenKai/releases/download/${VER}/${f}`
  console.log(`下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) { console.error(`失败 ${res.status} ${f}`); process.exitCode = 1; continue }
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(out, buf)
  console.log(`  → ${out}  ${(buf.length / 1048576).toFixed(1)}MB`)
}
