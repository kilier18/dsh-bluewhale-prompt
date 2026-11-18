// 动作库白名单 —— 从「动作语义字典」派生，不再手写清单。
//
// 字典（dict/l2d-motion-dict.json）由 `scripts/l2d-dict.py` 从桌宠 OPFS 现网动作拆解生成，
// 里面列的就是当前注册表里真实存在的 44 条官方动作（Main / TrackingLost / Talk / Outfit / Emotion）。
// 动作库一变，重新跑一次 pull + dict 即可，这个文件不用动。
//
// 生成的目的是：`POST /dafei/act` 里如果点了库里不存在的动作，直接 404 而不是让桌宠静默失败。

import { motionAllowed as allowedByDict, motionNames } from './l2d-dict.js'
import { SCENES } from './posemap.js'

/** 动作库里的全部文件名（`xxx.motion3.json`）。 */
export const MOTION_FILES = new Set(motionNames().map((n) => `${n}.motion3.json`))

// 场景复合动作（`场景-greet` …）由 `scripts/gen-scenes.mjs` 生成后推到 OPFS 的 Custom 组，
// 不在官方 44 条的字典里，所以这里单独并进来。别人装了插件但没生成场景时，
// airi 会因为找不到文件而静默跳过——`GET /dafei/dict` 里也不列它们，属于可选资产。
for (const key of Object.keys(SCENES)) MOTION_FILES.add(`场景-${key}.motion3.json`)

/** `Animation/表演-14-撒娇.motion3.json` → true；路径穿越、库里没有的都 false。 */
export function motionAllowed(file) {
  if (typeof file !== 'string') return false
  const name = file.replace(/^Animation\//, '')
  if (MOTION_FILES.has(name)) return true
  return allowedByDict(file)
}
