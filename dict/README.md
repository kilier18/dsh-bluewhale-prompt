# dict/ —— 动作语义字典

这套字典解决的问题：桌宠能演的动作只有官方那 44 条 motion3，**「自然」不靠动作多，靠挑得准**——
挑哪一条当身体层、从第几秒开始、手臂用哪条原片。字典把这些判断从「手感」变成「查表」。

所有数字都不是估的：`scripts/l2d-dict.py` 把每条 motion3 按 60Hz 采样，逐参数拆出幅度极值、
换手窗口（rise/hold/fall）、逐 0.5s 的活跃度曲线、最活跃窗口，再按实测极值分三档。

## 文件

| 文件 | 大小 | 给谁 | 内容 |
|---|---|---|---|
| `l2d-motion-dict.json` | 157 KB | 程序（`src/l2d-dict.js`） | 44 条动作的瘦身版：幅度区间、换手次数与保持时长、活跃度曲线、bestWindows、节拍、换脸键 |
| `l2d-motion-full.json` | 550 KB | 深挖 / 调参 | 全量：每条曲线的关键点、逐拍参数 from→to、`fits` 判定 |
| `l2d-motion-mapping.json` | 4.5 KB | 程序 | 18 条「意图 → 资产」对照表 + 三档定义 |
| `l2d-motion-dict.md` | 31 KB | 人 | 带解释的长文档（含 15 条表演的逐拍拆解） |
| `DICT.prompt.md` | 8 KB | LLM | 塞进上下文用的速查卡（`scripts/gen-prompt.mjs` 生成） |
| `l2d-params.json` | 35 KB | 程序 | moc3 core 509 个参数的 min/max/default、33 个可写语义参数、10 个物理输出、手势关节表 |
| `l2d-arm-poses.json` | 三种手势（抚胸/食指/狗尾草）**保持段的稳态关节值**，`scripts/l2d-arm.mjs` 用它自己生成抬手/收回曲线（2KB） |
| `l2d-expressions.json` | 4.6 KB | 程序 | 23 个 exp3 表情的原始参数与叠加方式 |

## 在插件里怎么用

```js
import { suggestion, recipe, bestWindow, motionAllowed, describe } from './src/l2d-dict.js'

suggestion('撒娇', 12)
// { intent:'撒娇', tier:'cozy', body:'表演-14-撒娇', bodyAt:13, duration:12, score:0.81,
//   arm:'正常说话-抚胸',
//   armMap:[{src:[0,1.1],at:0,to:1.1},{src:[1.1,22],at:1.1,to:10},{src:[22,24],at:10,to:12}],
//   beats:[...] }
```

HTTP（插件起着的时候，给别的 agent / 前端用）：

```
GET /dafei/dict                                 全量索引（意图表 + 动作清单 + 三档）
GET /dafei/dict?intent=撒娇&duration=12          编排建议（含手臂三段映射）
GET /dafei/dict?text=1&limit=20                  纯文本速查，可直接塞 prompt
```

`/dafei/act` 的动作白名单也从这本字典派生（`src/motions.js`），库里没有的动作直接 404，
不会再让桌宠静默失败。

## 怎么重新生成

动作库一变（换模型、增删动作）就要重跑，否则字典会指到不存在的文件：

```bash
# 1) 从桌宠 OPFS 拉官方动作原件（需要 airi 带 --remote-debugging-port=9222 启动）
node scripts/pull-motions.mjs --out .motions-lib

# 2) 拆解成字典（只依赖标准库）
python scripts/l2d-dict.py --lib .motions-lib \
    --out dict/l2d-motion-full.json \
    --mapping dict/l2d-motion-mapping.json \
    --md dict/l2d-motion-dict.md
mv dict/l2d-motion-full.slim.json dict/l2d-motion-dict.json

# 3) 重生成 agent 速查卡
node scripts/gen-prompt.mjs
```

`python` 要是机器上装的是坏的 Python 3.12（`No module named 'encodings'`），用任意可用的
3.11/3.12 解释器跑，脚本只 import 标准库。Windows 控制台是 GBK，记得带
`PYTHONIOENCODING=utf-8 PYTHONUTF8=1`。

## 铁律（写进 `src/l2d-dict.js` 的 `RULES`，改字典不动它）

1. 身体层只用 `PositionX/Y/Z`、`LeanInput`、`ShoulderX`；`ParamBodyAngle*`、`Chest*`、`Param138` 在本模型上无效。
2. 没有「胸腔扭腰」：官方的扭 = `PositionX ±14` + `PositionZ ±13`（`表演-05-重心`）。
3. 手臂只能整条搬作者原片（含 `Param11/27–32` 手指串），不要自己拧关节——手会别到背后。
4. `Movement1/2/3` 是换手开关，作者是 0.8s 斜坡，**不要二值化**（二值化就是把残影做出来）。
5. `AngleZ` 只许一个来源：`tilt` 已占 `AngleZ` + `PositionZ`，别再和写这两个参数的 `pose`/`sway` 共存。
6. 烘焙 `FadeInTime/FadeOutTime = 0`；收尾 0.9s 回中立。
7. 表情只用叠加型（脸红 `key7`、爱心眼 `key4`、兔牙 `key9`）；`key1/3/5/6/10` 是整脸换层，会顶掉嘴部动画。
8. 微笑打成 0.4s 脉冲；头比身体晚 0.1–0.3s 跟随。
9. 挑窗口看活跃度，不用片段开头。
10. 单条编排 ≤64 个 action，单段 0.2–20s，总长 ≤60s。

> 手臂姿态常量重生成：`node scripts/gen-arm-poses.mjs --lib .motions-lib`（从 `正常说话-*` 原片 t=12s 的保持中点量取）。
