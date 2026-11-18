# blue whale · 桌宠插件（本地改造版）

DeepSeek Harness（DSH）插件：让桌面上的 Live2D 桌宠「大肥鱼」和 DSH 里你选的那个会话说话——角色的回复带着表情和动作回到桌宠身上，桌宠还会**开口念出来**（Edge-TTS + RVC 鲸鱼娘音色）。附带一套**唱歌口型编排**工具链：一段干声 → 逐帧口型 + 表情动作 → OBS 录制 → 成片。

本仓库是 [yangzhenghaniirs-code/blue-whale](https://github.com/yangzhenghaniirs-code/blue-whale) v0.3.0 的**本地改造分支**（当前 0.6.0），已经加了大量自己写的功能（语音、唱歌、会话自愈、桌面动作协议），**不再跟随上游同步**。上游原版用来「装上就能聊」，本仓库用来「定档自己这一套」。

## 这个仓库里有什么

```
index.js              插件入口：起 HTTP 服务、随 DSH 开关桌宠
cordis.patch.yml      DSH 配置补丁（端口 18100 / 自动启动桌宠 / 规则 prompt 模式）
src/
  server.js           OpenAI 兼容接口 + 托盘用的 /dafei/* 管理接口
  route.js            分拣 AIRI 的请求：聊天请求 vs 麦克风辅助请求
  dsh.js              直接调 DSH 会话（prompt + 按 rpcId 认轮），不走网络
  pet-rules.js        每句话前缀标签 + 附「桌宠规则.md」全文
  clean-text.js       markdown → 适合朗读的纯文字（保留 <|ACT|> 标记）
  posemap.js          工具/事件 → 动作 + 19 个 Agent 场景的复合动作表
  idle-motion.js      没有动作标记时补一个待机小动作
  outfit.js           换装用动作代替表情（表情会被下一个表情清掉）
  pet.js              随 DSH 启动/关闭桌宠
  sessions.js         读 DSH 存储列出会话（托盘「切换聊天」）
  state.js            插件状态（state.json）+ 日志 + 800ms 缓存
  vision.js           桌宠截屏 → DSH 模型写描述 → 当上下文给角色
  helpers.js          AIRI 的麦克风辅助请求（说完判定 / 转写修正）
  followups.js        后续消息投递 + 会话漂移自愈 + 自动朗读挂点
  voice.js            语音回复：Edge-TTS → RVC → 播放 + 正常说话-抚胸
  l2d-dict.js         动作语义字典的运行时入口（挑动作、挑窗口、给手臂映射）
  motions.js          动作白名单（从字典派生，库里没有的动作直接 404）
  cookie-cleaner.js   清 DSH 越攒越多的登录 Cookie（否则请求头超 16KB 打不开）
dict/                 动作语义字典（44 条官方动作的实测拆解 + 参数表 + 表情表，见 dict/README.md）
scripts/              字典/编排工具链：拉动作、拆字典、编译 plan、烘焙 motion3、合成手臂、生成场景动作
locale/               中英文案
桌宠规则.md            表情动作规则（每句话附在 prompt 后面；改完不用重启）
```

**不在仓库里**：`桌宠/`（改造版 airi.exe + 496MB 的 app.asar，2.9GB），见下方「桌宠程序」。

## 功能

### 1. 桌宠 ↔ DSH 会话
桌宠说的话走 `POST /v1/chat/completions`（OpenAI 兼容），插件把它交给你选的 DSH 会话；回复生成时按 `rpcId` 认轮，2~3 秒回到桌宠嘴里。
托盘右键「切换聊天」可换会话；DSH 重启换了新会话号时，插件会**自动跟随**当前活跃会话（手动切过的 10 分钟内受保护）。

### 2. 表情动作协议
回复里写 `<|ACT {"motion":"Animation/场景-explain.motion3.json"}|>`，airi 会把标记当特殊 token 单独切块执行。

动作库 = **官方 44 条**（Main / TrackingLost / Talk / Outfit / Emotion，含 11 条 `情绪-*`、15 条 `表演-*`）
\+ **场景复合动作 19 条**（`场景-*`，由 `scripts/gen-scenes.mjs` 生成后进 Custom 组）。
规矩写在 `桌宠规则.md`，核心三条：

- 日常用 `情绪-*`（2.6~8 秒）和 `场景-*`（3~9 秒，自带表情+重心+手臂），**不要动辄甩十几秒的表演**；
- 手臂只用 `正常说话-抚胸 / 食指 / 狗尾草` 三条 24 秒循环（抚胸=通用、食指=讲解、狗尾草=摸鱼搞怪），一次对话最多动一次，同一个姿势保持十几秒是正常的；
- 手臂不再需要「收回」动作：作者原片自带抬手→保持→放手的三段，`scripts/l2d-compose.mjs` 按 1:1 重映射。

### 3. 语音回复（本仓库新增）
托盘「语音回复：开/关」→ `POST /dafei/voice`。

- 链路：Edge-TTS（`zh-CN-XiaoyiNeural`）→ 44.1k WAV → RVCover `/api/convert`（鲸鱼娘音色，f0=rmvpe）→ 播放 + `原子-说话`，约 20 秒/句。
- 念什么：回复里单起一行 `[说] 口语版` （或 `[说]…[/说]`）就念这一行；没写就从正文第一段截一句（默认 ≤60 字），**不会把长回复整段念出来**；写 `[沉默]` 就这轮不念。
- 队列：上一句还在念时新的一句排队（只留最新一条），念完自动接上；同一句 20 秒内不重念。
- 关掉开关 = 一行都不念，但 `POST /dafei/say` 手动调用仍然有效。

### 4. 唱歌口型与编舞（本仓库新增，全自有）

一句话：**给歌和干声，出一条带口型、带编舞、带双语字幕的成片**。

```bash
node scripts/make-mv.mjs --song 歌.mp3 --vocal 干声.wav [--lyrics 歌词.lrc] \
  --font "LXGW Marker Gothic"          # 成品默认落 F:/Users/pinn/Videos/
```

内部顺序：口型(`l2d-song --fps 60`) → 编舞(`gen-song --single 1`) → 推 OPFS(`push-custom`) → OBS 录制(`sing-record`) → 量音画偏移(`sync-offset`，能量包络互相关) → **一遍过**编码（裁头 + 烧字幕 + 对齐音轨，NVENC）→ 成片。

分步也能跑：`--from mouth|song|push|record|sync` 从任一步续，`--skip-sub` 不出字幕。

- **一首歌一条 motion3、一次触发**。早期按段投递（`sing-play.mjs`）会因为页面时钟提前量让后半段口型对不上，已降级为历史方案，不要再用于出片。
- **身体/头/表情**全部来自我们自己的段落预设（`scripts/l2d-song-presets.json`：sway / pose / tilt / lean / look / blink / brow / squint），曲线由 `l2d-compile.mjs` 生成——**不套官方表演片段**。
- **手臂**由 `l2d-arm.mjs` 自己生成「首段抬手 → 中间段保持（不重抬）→ 末段收回」，姿态常量来自 `dict/l2d-arm-poses.json`（`gen-arm-poses.mjs` 从原片保持段量出的稳态关节值）。`Movement1/2/3` 只会有一个是 1，手掌细分（`Param11`、`Param27–32`）一并推到位，所以抬手不丢姿态、也不会「多一条手臂」。想退回官方原片重映射：`--arm clip`。
- **口型**从干声算，整首切片后连续（实测 41 段接缝 0 跳变）；静默段补轻微呼吸口型，但只在第一句人声之后补，前奏不会提前动嘴。`--mouth-lead 0.5` 默认补偿 `l2d-song` 包络平滑导致的半秒滞后。
- **表情禁忌**：整脸换层表情（`key1/3/5/6/10`：黑脸、＞＜、屑屑眼、圈圈眼、钢盆）会顶掉嘴部动画，唱歌别用；只用 `key4` 爱心眼、`key7` 脸红、`key9` 兔牙。
- **出片档位** `--speed high|balanced|fast`：默认 `balanced`（NVENC p5/cq28，比 CPU x264 crf19 快 3 倍、体积小 26%）；`high` 走 libx264 crf19 归档；`fast` 是 cq32 快出小样。
- 日常表演/场景仍走字典 + `gen-scenes.mjs`（见 §5）。详见本地手册 `D:\DSH使用策略\手册\11-唱歌口型与成片.md`。

### 5. 动作语义字典（本仓库新增）

桌宠能演的动作只有官方 44 条，「自然」不靠数量靠**挑得准**。`dict/` 把这套判断从手感变成查表：

```bash
GET /dafei/dict                                 # 18 条意图 → 动作/窗口/手臂 对照表 + 三档幅度 + 计数
GET /dafei/dict?intent=撒娇&duration=12          # 直接给编排建议（含 armMap 三段映射）
GET /dafei/dict?text=1&limit=20                  # 纯文本速查，可直接喂给任意 LLM
```

字典由 `scripts/l2d-dict.py` 从桌宠 OPFS 的现网 motion3 逐帧拆出来（幅度极值、换手窗口、
0.5s 活跃度曲线、最活跃窗口），所有数字都是作者原曲线的实测值。改动作库后重跑
`scripts/pull-motions.mjs` + `l2d-dict.py` 即可，插件代码不用动。

配套工具链（都能单独用，不依赖 DSH）：

| 脚本 | 作用 |
|---|---|
| `scripts/pull-motions.mjs` | 通过 CDP 从桌宠 OPFS 把动作原件拉到本地 |
| `scripts/l2d-dict.py` | 动作原件 → 字典（JSON / Markdown） |
| `scripts/gen-prompt.mjs` | 字典 → `dict/DICT.prompt.md`（给 LLM 的速查卡） |
| `scripts/l2d-compile.mjs` | 语义 plan（sway/nod/tilt/look/blink/gesture/expression…）→ 参数 IR，带冲突校验 |
| `scripts/l2d-bake.mjs` | IR → `motion3.json`（可 `--mouth` 挂音频口型） |
| `scripts/l2d-compose.mjs` | 把作者原片的手臂曲线按时间重映射叠到 IR 上（手臂绝不自拧） |

### 6. 场景复合动作（本仓库新增）

每个 Agent 场景配一条**复合动作**：官方表演片段最活跃窗口 + 作者手臂原片三段重映射，全部由脚本生成，不手搓。

```bash
node scripts/pull-motions.mjs --out .motions-lib          # 先从桌宠 OPFS 拉动作原件
node scripts/gen-scenes.mjs --lib .motions-lib --out .scenes
node <dsd>/tmp/push-dir.mjs .scenes                       # 推到桌宠 Custom 组（或用插件 /dafei/act 直接点）
```

19 个场景：`greet bye explain agree deny confuse idea shy sing think listen cheer tired wow comfort upset` + 摸鱼类 `slack silly tease`（狗尾草）。
`src/posemap.js` 的 `SCENES` 就是这张表，`POST /dafei/scene {name}` 直接演，`GET /dafei/scene` 看当前，
模型自己说话时也可以贴 `<|ACT {"motion":"Animation/场景-shy.motion3.json"}|>`。

手臂策略（跟着用户的偏好定）：抚胸不挑场景、默认用它；食指只在讲解/讲话时；狗尾草只给摸鱼装傻搞怪。
身体幅度靠 `PositionZ / PositionX / LeanInput / AngleZ`（实测排序，胸腔 `ParamBodyAngle*` 在这个模型上无效）。

## 装法

1. 需要 DSH 桌面版（已登录）**和** RVCover（`http://127.0.0.1:8765`，语音功能才需要）。
2. 把本目录放到 `C:\Users\pinn\Documents\blue-whale\`（路径可改，改完同步 `cordis.patch.yml`）。
3. 同步到 DSH 运行副本并重启：
   ```
   cp -r index.js src locale dict scripts icon.png cordis.patch.yml 桌宠规则.md \
     ~/.dsh/profiles/desktop/node_modules/dsh-bluewhale-prompt/
   ```
   重启 DSH（`D:\DSH\tools\restart-dsh.ps1`）后插件监听 `127.0.0.1:18100`。
4. 桌宠程序 `桌宠\airi.exe` 需要**改造版**（打 4 个补丁：隐藏修复 / 动作轮询间隔 / 预览通道 / 托盘语音开关）。补丁与回滚见手册；二进制太大不进仓库。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型列表（只有一个 `dsh`） |
| POST | `/v1/chat/completions` | 桌宠说话（支持 SSE） |
| GET | `/dafei/health` | `{ok:true}` |
| GET/POST | `/dafei/voice` | 语音开关；GET 回 `{enabled,rvcOk,scriptOk,busy,text,queued}` |
| POST | `/dafei/say` | 立刻念一段（不受开关限制） |
| POST | `/dafei/pause` | `{on:true}` 暂停动作抢占（录制长动作必用） |
| GET/POST | `/dafei/session` | 当前会话 / 切换 |
| GET | `/dafei/sessions` | 会话列表 |
| GET | `/dafei/pending` | 后续消息（airi 每 2 秒轮询） |
| GET | `/dafei/scene` | 当前场景 |
| GET | `/dafei/dict` | 动作语义字典：全量索引 / `?intent=&duration=` 编排建议 / `?text=1` 纯文本 |

## 已知坑（精选）

- 动作 Segments 是 `[t0,v0,type,...]`：`type=0` 跟 2 个数、`type=1` 跟 6 个数，段数要逐段 `i+=3/7` 算；写成 `null` 会让 Live2D **整只冻住**（`Float32Array.map` 返回数组会被强转成数字 → NaN）。
- `Curves[].Target` 全是字面量 `Parameter`，真名在 `Id`；头部参数是 `AngleX/Y/Z` + `LeanInput`，不是 `ParamAngleX`。
- 推 OPFS 后必须 `Page.reload{ignoreCache:true}`，`window.__dafeiMotions` 只在模型加载时算一次。
- airi 手工带 CDP 重启前要清 `ELECTRON_RUN_AS_NODE`（bash 里它是 1，会秒退）。
- 动作被顶：`pages-*.js` 里 `holdsVoice(context)` → `setMotion(Think, FORCE)`，源头是 pending 轮询；录制前 `POST /dafei/pause {on:true}`。
- 手臂「残影 / 手别到背后」：`Movement1/2/3` 是换手开关（作者是 0.8s 斜坡，二值化就出残影），手臂参数除 Movement 外还有 `Param11`、`Param27–32` 等手掌细分，少搬一条抬手时手就会丢姿态；手臂只能整条搬作者原片。
- 胸腔参数（`ParamBodyAngle*`、`ChestX1/Y1`、`Param138`）在这个模型上写不进变形器，幅度只能靠 `PositionX/Y/Z` + `LeanInput` + `AngleZ`。
- 整脸换层表情（`key1/3/5/6/10`：黑脸、＞＜、屑屑眼、圈圈眼、钢盆）会顶掉嘴部动画，唱歌别用；只用 `key4` 爱心眼、`key7` 脸红、`key9` 兔牙。

## 文档

日常操作、补丁、唱歌链路全套在 `D:\DSH使用策略\手册\10-蓝鲸桌宠.md`（本机手册，不入库）。

## 安全边界（0.3.1）

插件接口（`127.0.0.1:18100`）只给本机和桌宠用，**不要映射到公网**：

- CORS 只放行无 `Origin`、`null`、`file:` / `app:` / `chrome-extension:` 和本机 host，其余 403；所以浏览器里直接开 `http://127.0.0.1:18100/dafei/voice` 能看到 JSON，别的站点打不进来。
- 请求体上限 16MB（413）。
- `/dafei/act` 的 `motion` 只认 `Animation/<名字>.motion3.json`（禁 `../`），`emotion` / `expression` 走白名单正则，`say` 截 `MAX_CHARS`；推送暂停时返回 409。
- `POST /dafei/pause {on:true}` 除了停推送，还会清掉已排队的口播，录长动作才不会被下一句打断。

## License

MIT，见 `LICENSE`。上游 blue whale / proj-airi / AIRI 相关部分的版权归原作者。
