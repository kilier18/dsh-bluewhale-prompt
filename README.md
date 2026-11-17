# blue whale · 桌宠插件（本地改造版）

DeepSeek Harness（DSH）插件：让桌面上的 Live2D 桌宠「大肥鱼」和 DSH 里你选的那个会话说话——角色的回复带着表情和动作回到桌宠身上，桌宠还会**开口念出来**（Edge-TTS + RVC 鲸鱼娘音色）。附带一套**唱歌口型编排**工具链：一段干声 → 逐帧口型 + 表情动作 → OBS 录制 → 成片。

本仓库是 [yangzhenghaniirs-code/blue-whale](https://github.com/yangzhenghaniirs-code/blue-whale) v0.3.0 的**本地改造分支**，已经加了大量自己写的功能（语音、唱歌、会话自愈、桌面动作协议），**不再跟随上游同步**。上游原版用来「装上就能聊」，本仓库用来「定档自己这一套」。

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
  posemap.js          工具/事件 → 原子动作
  idle-motion.js      没有动作标记时补一个待机小动作
  outfit.js           换装用动作代替表情（表情会被下一个表情清掉）
  pet.js              随 DSH 启动/关闭桌宠
  sessions.js         读 DSH 存储列出会话（托盘「切换聊天」）
  state.js            插件状态（state.json）+ 日志 + 800ms 缓存
  vision.js           桌宠截屏 → DSH 模型写描述 → 当上下文给角色
  helpers.js          AIRI 的麦克风辅助请求（说完判定 / 转写修正）
  followups.js        后续消息投递 + 会话漂移自愈 + 自动朗读挂点
  voice.js            语音回复：Edge-TTS → RVC → 播放 + 原子-说话
  cookie-cleaner.js   清 DSH 越攒越多的登录 Cookie（否则请求头超 16KB 打不开）
locale/               中英文案
桌宠规则.md            表情动作规则（每句话附在 prompt 后面；改完不用重启）
```

**不在仓库里**：`桌宠/`（改造版 airi.exe + 496MB 的 app.asar，2.9GB），见下方「桌宠程序」。

## 功能

### 1. 桌宠 ↔ DSH 会话
桌宠说的话走 `POST /v1/chat/completions`（OpenAI 兼容），插件把它交给你选的 DSH 会话；回复生成时按 `rpcId` 认轮，2~3 秒回到桌宠嘴里。
托盘右键「切换聊天」可换会话；DSH 重启换了新会话号时，插件会**自动跟随**当前活跃会话（手动切过的 10 分钟内受保护）。

### 2. 表情动作协议
回复里写 `<|ACT {"motion":"Animation/原子-点头.motion3.json"}|>`，airi 会把标记当特殊 token 单独切块执行。动作库 105 条 / 7 组（Main / TrackingLost / Talk / Outfit / Emotion / Custom / AIRI）。
规矩写在 `桌宠规则.md`：主力只用 `原子-*`（1~5 秒、能两两自由组合）；举手类动作**不会自己落下**，必须显式贴收回（`原子-竖食指` → `动作-竖手指收回`；`原子-持草` → `动作-狗尾草收回`；`原子-抚胸` → `动作-手放下`）。

### 3. 语音回复（本仓库新增）
托盘「语音回复：开/关」→ `POST /dafei/voice`。

- 链路：Edge-TTS（`zh-CN-XiaoyiNeural`）→ 44.1k WAV → RVCover `/api/convert`（鲸鱼娘音色，f0=rmvpe）→ 播放 + `原子-说话`，约 20 秒/句。
- 念什么：回复里单起一行 `[说] 口语版` （或 `[说]…[/说]`）就念这一行；没写就从正文第一段截一句（默认 ≤60 字），**不会把长回复整段念出来**；写 `[沉默]` 就这轮不念。
- 队列：上一句还在念时新的一句排队（只留最新一条），念完自动接上；同一句 20 秒内不重念。
- 关掉开关 = 一行都不念，但 `POST /dafei/say` 手动调用仍然有效。

### 4. 唱歌口型（本仓库新增）
干声 → `l2d-song.mjs`（逐帧口型 + 头摆 + 眨眼 + 眉毛）→ `combo.py` 用**已有动作库**拼编排 → 推 OPFS → CDP 触发 → OBS 录 → ffmpeg 重挂音轨。

要点：只用库里的 `表演-*` / `情绪-*` 拼，不原创；段与段直连（不插空档）、按「收势姿态」挑窗口、`Movement1/2/3`（换手组）逐帧二值化否则手臂出现残影；`ParamMouthOpenY` 永远取音频口型。详见本地手册 `D:\DSH使用策略\手册\10-蓝鲸桌宠.md`。

## 装法

1. 需要 DSH 桌面版（已登录）**和** RVCover（`http://127.0.0.1:8765`，语音功能才需要）。
2. 把本目录放到 `C:\Users\pinn\Documents\blue-whale\`（路径可改，改完同步 `cordis.patch.yml`）。
3. 同步到 DSH 运行副本并重启：
   ```
   cp -r index.js src locale icon.png cordis.patch.yml 桌宠规则.md \
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

## 已知坑（精选）

- 动作 Segments 是 `[t0,v0,type,...]`：`type=0` 跟 2 个数、`type=1` 跟 6 个数，段数要逐段 `i+=3/7` 算；写成 `null` 会让 Live2D **整只冻住**（`Float32Array.map` 返回数组会被强转成数字 → NaN）。
- `Curves[].Target` 全是字面量 `Parameter`，真名在 `Id`；头部参数是 `AngleX/Y/Z` + `LeanInput`，不是 `ParamAngleX`。
- 推 OPFS 后必须 `Page.reload{ignoreCache:true}`，`window.__dafeiMotions` 只在模型加载时算一次。
- airi 手工带 CDP 重启前要清 `ELECTRON_RUN_AS_NODE`（bash 里它是 1，会秒退）。
- 动作被顶：`pages-*.js` 里 `holdsVoice(context)` → `setMotion(Think, FORCE)`，源头是 pending 轮询；录制前 `POST /dafei/pause {on:true}`。

## 文档

日常操作、补丁、唱歌链路全套在 `D:\DSH使用策略\手册\10-蓝鲸桌宠.md`（本机手册，不入库）。

## License

MIT，见 `LICENSE`。上游 blue whale / proj-airi / AIRI 相关部分的版权归原作者。
