#!/usr/bin/env node
/**
 * l2d-arm.mjs —— 自己生成手臂曲线（抬手 → 保持 → 收回），不依赖官方 motion3
 *
 * 每个手势只有一套「稳态关节值」（`dict/l2d-arm-poses.json`，由 `gen-arm-poses.mjs` 量出来），
 * 本模块负责：
 *   1) 用 smoothstep 把默认值推到稳态（默认 1.1s 抬起）、保持、再用 2.0s 收回；
 *   2) `Movement1/2/3` 三个互换开关**只允许一个是 1**，且同一时刻只做一次升降，避免两套手臂绑骨同时半开（残影）；
 *   3) 手掌/手指细分（Param11 / Param27–32）一起推到位，否则抬手扫过身体时会丢姿态。
 *
 * 用法：
 *   import { synthArm, ARM_IDS } from './l2d-arm.mjs'
 *   const arm = synthArm('hand', 36.7587, { rise: 1.1, fall: 2.0, fps: 60 })
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DICT = path.resolve(process.env.L2D_DICT || path.join(REPO, 'dict'))

let _params = null
let _poses = null
export function params() {
  if (!_params) _params = JSON.parse(fs.readFileSync(path.join(DICT, 'l2d-params.json'), 'utf8'))
  return _params
}
export function poses() {
  if (!_poses) _poses = JSON.parse(fs.readFileSync(path.join(DICT, 'l2d-arm-poses.json'), 'utf8')).poses
  return _poses
}

export const MOVEMENT_IDS = ['Movement1', 'Movement2', 'Movement3']
export const ARM_IDS = [
  ...MOVEMENT_IDS,
  'Param11', 'Param27', 'Param28', 'Param29', 'Param30', 'Param31', 'Param32',
  'Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
  'Param55', 'Param56', 'Param57', 'Param58', 'Param59', 'Param60', 'Param61', 'Param62',
  'ShoulderX',
]
const ARM_SET = new Set(ARM_IDS)

const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function defaultValue(id) {
  const p = params().parameters?.[id] || params()[id]
  if (!p) return 0
  return Number(p.default ?? 0)
}

/**
 * 生成一条曲线：默认值 → 稳态 → 默认值，升降都按 smoothstep 采样
 * @returns {{Id:string, Segments:number[]}}
 */
function rampCurve(id, target, duration, { rise, holdAt, fall, fps }) {
  const d0 = defaultValue(id)
  const d1 = Number(target ?? d0)
  const t1 = Math.max(0.02, rise)
  const t2 = Math.min(duration - 0.02, Math.max(t1 + 0.05, holdAt))
  const f = Math.max(0.02, Math.min(fall, duration - t2 - 0.001))
  const seg = [0, Number(d0.toFixed(6))]
  const step = 1 / fps
  const push = (t, v) => seg.push(0, Number(t.toFixed(5)), Number(v.toFixed(6)))

  if (Math.abs(d1 - d0) < 1e-6) {
    push(duration, d0)
    return { Id: id, Segments: seg }
  }
  for (let t = step; t < t1; t += step) push(t, d0 + (d1 - d0) * smooth(t / t1))
  push(t1, d1)
  if (t2 > t1 + 1e-3) push(t2, d1)
  for (let t = step; t < f; t += step) push(t2 + t, d1 + (d0 - d1) * smooth(t / f))
  push(Math.min(duration, t2 + f), d0)
  if (seg[seg.length - 2] < duration - 1e-4) push(duration, d0)
  return { Id: id, Segments: seg }
}

/**
 * @param {'hand'|'point'|'grass'} poseKey
 * @param {number} duration 段时长（秒）
 * @param {{rise?:number, fall?:number, fps?:number, fadeOutHold?:number}} opts
 *        rise 抬起时长；fall 收回时长；fadeOutHold 保持段结束时刻（缺省 duration-fall）
 */
export function synthArm(poseKey, duration, opts = {}) {
  const all = poses()
  const pose = all[poseKey]
  if (!pose) throw new Error(`没有这个手势的姿态常量：${poseKey}（现有 ${Object.keys(all).join(', ')}）`)
  const fps = Number(opts.fps ?? 60)
  const rise = Number(opts.rise ?? 1.1)
  const fall = Number(opts.fall ?? 2.0)
  const holdAt = Number(opts.fadeOutHold ?? duration - fall)
  const active = MOVEMENT_IDS.find((m) => Number(pose.joints[m] ?? 0) > 0.5) || 'Movement2'

  const curves = []
  for (const id of ARM_IDS) {
    if (MOVEMENT_IDS.includes(id)) {
      const target = id === active ? 1 : 0
      curves.push(rampCurve(id, target, duration, { rise, holdAt, fall, fps }))
      continue
    }
    if (!(id in pose.joints)) continue
    curves.push(rampCurve(id, pose.joints[id], duration, { rise, holdAt, fall, fps }))
  }
  return {
    arm: poseKey,
    active,
    curves,
    meta: { duration: Number(duration.toFixed(4)), fps, rise, fall, holdAt: Number(holdAt.toFixed(3)) },
  }
}

export function isArmId(id) {
  return ARM_SET.has(id)
}

/** 把手臂曲线并进一份 motion（同 Id 覆盖，重算 Meta） */
export function mergeArm(motion, arm, { fade = 0 } = {}) {
  const byId = new Map(motion.Curves.map((c) => [c.Id, c]))
  for (const c of arm.curves) byId.set(c.Id, { Target: 'Parameter', Id: c.Id, Segments: c.Segments })
  const curves = [...byId.values()]
  let segs = 0
  let pts = 0
  for (const c of curves) {
    const n = (c.Segments.length - 2) / 3
    segs += n
    pts += n + 1
  }
  return {
    Version: 3,
    Meta: {
      Duration: arm.meta.duration,
      Fps: arm.meta.fps,
      Loop: false,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: segs,
      TotalPointCount: pts,
      UserDataCount: 0,
      TotalUserDataSize: 0,
      FadeInTime: fade,
      FadeOutTime: fade,
    },
    Curves: curves,
  }
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  const a = synthArm(process.argv[2] || 'hand', Number(process.argv[3] || 10))
  console.log(JSON.stringify({ arm: a.arm, active: a.active, curves: a.curves.map((c) => c.Id), meta: a.meta }, null, 1))
}
