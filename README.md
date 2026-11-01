# dsh-fairy-zzz-for-jediliu

> Fairy Ⅲ · 《绝区零》H.D.D 皮肤 —— **个人定制分支**
>
> 派生自 [dsh-fairy-zzz](https://github.com/AssassinVIX/fairy-zzz-plugin)（MIT，作者 AssassinVIX），在其上做了独立的改造与收敛。

---

## 一、这是什么

把 DeepSeek Harness 的 Web 界面换成《绝区零》Fairy 的 H.D.D 终端：开机动画 → 居中问好 → 收成常驻眼徽；并用本地 GPT-SoVITS 把回复念出来。

本仓库是**个人定制版**：包名、路由、存储键、slot 命名空间全部独立，可与上游插件并存而不冲突。

## 二、血缘与上游

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/AssassinVIX/fairy-zzz-plugin |
| 上游包名 | `dsh-fairy-zzz` |
| 本分支包名 | `dsh-fairy-zzz-for-jediliu` |
| 许可证 | MIT（继承上游） |
| 眼徽 SVG | Apache-2.0，改编自 Fairy-DSH（详见 `NOTICE-fairy-dsh.md`） |

上游原版说明保留在 [`docs/upstream-README.md`](docs/upstream-README.md)，便于对照。

## 三、本分支改了什么

### 1. 彻底改名，可与上游共存

改名不是改一个字段，而是一条链。本分支同步了全部标识点：

```
package.json name         dsh-fairy-zzz  →  dsh-fairy-zzz-for-jediliu
cordis.patch.yml 条目 id  fairy-zzz-skin →  dsh-fairy-zzz-for-jediliu-skin
服务端插件 name            fairy-zzz      →  dsh-fairy-zzz-for-jediliu
客户端注册 id              dsh-fairy-zzz  →  dsh-fairy-zzz-for-jediliu
HTTP 路由前缀              /fairy-zzz/*   →  /dsh-fairy-zzz-for-jediliu/*
localStorage 键            fairy.zzz.*    →  dsh-fairy-zzz-for-jediliu.*
```

漏掉任何一处，启动时会报 `duplicate factory registration` 并连带停用整个插件组合——这是本分支踩过并且修好的坑。

### 2. 动态问候语音（每天 17:00）

- 插件装载后与每 30 分钟检查一次：**17:00 之后**若当日台词不存在，就用模型生成 5 个时段（morning/noon/afternoon/evening/night）的短句，每句 ≤ 20 字，并避开前一天的句子。
- 台词写入 `greet-gen/<YYYY-MM-DD>/<slot>.wav` 与 `texts.json`。
- 前端取用顺序：**今日文件 → 最近一份 → 内置 `assets/voice/`**。整条回落链保证「生成失败也有声音」。

### 3. 朗读摘要（长文本压缩）

`POST /dsh-fairy-zzz-for-jediliu/summarize` 把长回复压成一句中文结论（≤40 字）再朗读；短文本直接读全文。摘要使用自己的 API Key，与主对话互不影响。

### 4. 标记化朗读（推荐用法）

回复最后一行写：

```
【读·摘要】技术类回复的一句话结论
【读·吐槽】日常闲聊的一句话吐槽
```

插件**优先朗读这一行**，不受字数上限与技术词限制；没有标记时才回落到「≤80 字 + 非技术词」的启发式判断。这样朗读内容由回复作者显式控制，不必猜。

### 5. 自动朗读（观察式）

宿主不向消息组件传递文本，因此本分支改为**观察 DOM 中最新一条回复**：

- 启动时先记录基线，刷新页面不会把历史消息重读一遍；
- 文本连续稳定 **3 次（约 4.5 秒）** 才朗读，避开流式输出中途；
- 同一条回复在流式里变长时不重复朗读（防回声）；
- 批量挂载超过 3 条时不触发（防页面刷新时连读）。

### 6. 眼徽可纵向拖动

Dock 相的眼徽支持**上下拖动**（X 轴锁死），用于避开正文；偏移存 `localStorage`，并夹在 ±40vh 内。

### 7. 安全与资源收敛

| 项 | 处理 |
| --- | --- |
| `POST /summarize` | 内存级限流 **20 次/分钟**，超限 429（防本机脚本刷爆额度） |
| `POST /engine` | 启停引擎改为 POST（原 GET 可被跨站简单请求触发） |
| 静态文件 | `resolve` + `startsWith` 守卫，`../` 与 `%5c` 均无法逃出 `assets/` |
| TTS 缓存 | 超 100MB 或 200 条时按最旧清理 |
| 问候语音 | 只保留最近 7 天 |
| 独立 agent 预设 | **已删除**：本皮肤只负责视觉与语音，不替换宿主工具集 |

### 8. 语音播放统一管理

问候音与朗读音统一由 `stopSpeech()` 控制：朗读开始会先停掉问候音，避免两路音频叠放产生回声。

## 四、安装

```bash
# 以本地 link 方式安装到指定 profile
dsh plugin --profile desktop add "link:/path/to/dsh-fairy-zzz-for-jediliu"
```

或把它放进 profile 的 `node_modules`，并在 `package.json` 的 `dsh.profile.bundles` 中加入 `dsh-fairy-zzz-for-jediliu`。

安装后重启 DSH；皮肤会在整页刷新时加载。

## 五、配置

### 语音引擎目录

在插件目录下放置 `voice-home.txt`，内容为本地 GPT-SoVITS 引擎目录（一个包含 `fairy_server.py`、`python\python.exe`、`GPT-SoVITS` 的文件夹）：

```
/path/to/your/tts
```

也可以在 DSH 的「设置 → Fairy」里填写，插件会自动写入同一文件。**未配置引擎时皮肤照常工作**，只是不朗读。

### 朗读摘要的模型

`~/.dsh/fairy-tts.json`：

```json
{ "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" }
```

不配置则摘要不可用，朗读回落到「直接读原文/标记行」。

## 六、隐私与网络

- **唯一的出网请求**：`/summarize` 与动态问候生成时调用 `baseUrl` 指定的模型接口（默认 DeepSeek）；其余网络请求全部指向 `127.0.0.1`。
- 密钥只从本地配置文件读取，**不写日志、不回传、不写进仓库**。
- 语音合成在本机完成，音频只落在插件目录的 `cache/` 与 `greet-gen/`。
- 仓库内**不含**任何机器相关路径、账号信息或预生成音频。

## 七、致谢与许可

- 上游：[AssassinVIX/fairy-zzz-plugin](https://github.com/AssassinVIX/fairy-zzz-plugin)（MIT）
- 眼徽几何与动效：Fairy-DSH（Apache-2.0，见 `NOTICE-fairy-dsh.md`）
- 本分支代码同样以 MIT 发布，见 `LICENSE`
