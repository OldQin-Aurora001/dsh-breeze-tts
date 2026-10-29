# NOTICE — 来源、署名与许可

本插件（`dsh-breeze-tts`）由两个既有插件合并而来，并在其上新增了 AI 可设置通道。用了人家的东西，一个一个说清楚。

---

## 第一块：借的（逐项列全）

### ① localtts —— 合并代码的主体

| 项 | 值 |
|---|---|
| 插件名（npm 包名） | `@dsh-external/dsh-plugin-local-ai-tts` |
| GitHub 仓库 | **https://github.com/abbccdd/dsh-localtts** |
| 作者 | `abbccdd` |
| 使用版本 | `0.1.12-rc.5` |
| 固定 commit | `d17b68363166d2b442c77eb8b09248d3827a7250` |
| 许可证 | **MIT** |
| 借了什么 | Host/client 注册骨架、消息事件订阅与去重、Auto Read 开关、Edge TTS 合成、RVC 合成、长读分块播放、设置持久化、主题与翻译、诊断路由 |

### ② dsh-plugin-tts —— localtts 的上游（MIT 要求一并声明，不能漏）

| 项 | 值 |
|---|---|
| 插件名 | `dsh-plugin-tts` |
| GitHub 仓库 | **https://github.com/1624318455/dsh-plugin-tts** |
| 基线 commit | `ec0cf87ef52abb81ae91681a966aa3096365e631` |
| 许可证 | **MIT** |
| 版权行 | `Copyright (c) 2026 dsh-plugin-tts contributors` |
| 关系说明 | localtts 自身是它的衍生版本，按 MIT 要求须逐层声明 |

### ③ Breeze TTS 2 —— 只调服务，未抄代码（写全两层）

**③-1 模型与权重（官方）**

| 项 | 值 |
|---|---|
| 项目名 | Breeze TTS 2 |
| 官方 GitHub | **https://github.com/breezeblue-ai/breeze-tts** |
| 出品方 | BreezeBlue（上海微风蓝科技） |
| HuggingFace 权重 | `BreezeBlue/breeze-tts-2` |
| 许可证 | 代码 **Apache-2.0**；**模型权重、检查点、适配器、衍生模型、自托管输出 = BreezeBlue Research and Non-Commercial License** |

**③-2 实际运行的 C++ 服务端（本插件真正连接的对象）**

| 项 | 值 |
|---|---|
| 项目名 | **Breeze-TTS-2.cpp** |
| GitHub | **https://github.com/HoppouAI/Breeze-TTS-2.cpp** |
| 说明 | 基于 BreezeBlue/Breeze-TTS-2 权重的 **C++/GGUF/ggml 重写**，Vulkan 后端，Windows/Linux x64 |
| 模型下载 | **https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp**（须含 `audio_tokenizer/`） |
| 许可证 | 代码 **Apache-2.0**；MP3 编码器（`third_party/shine`）**LGPL-2.0**；权重沿用 BreezeBlue 非商业许可 |
| 借了什么 | **仅通过 HTTP API 调用其运行时服务（`/health`、`/v1/voices`、`/v1/audio/speech`），未复制、未修改、未分发其任何代码或模型权重** |

> ★ **两句强制声明**：
> 1. **本插件不包含 Breeze TTS 2 的模型权重，仅作为客户端调用用户自行部署的 Breeze 服务。**
> 2. **Breeze-TTS-2.cpp 的代码为 Apache-2.0，其捆绑的 MP3 编码器（third_party/shine）为 LGPL-2.0；模型权重适用 BreezeBlue Research and Non-Commercial 许可。上述许可均与本插件的 MIT 许可相互独立。**

---

## 第二块：咱们开发的

- **`dsh-breeze-voices` 插件本体**（全新开发，已并入本包）：三个 tab（声音设计 / 声音克隆 / 已有音色）、Breeze API 对接、音色注册流程、顶栏健康检测
- **试听无声问题的修复**：Web Audio 同步解锁 + `decodeAudioData` 播放 + `<audio>` 兜底（浏览器自动播放限制坑）
- **音色下拉的候选路由逻辑**：`listVoices()` 同时兼容 `/v1/voices` 与 `/v1/audio/voices`（内置进源码，替代外部补丁）
- **两个插件的合并与适配**：统一 factory、双 slot 注册、更新器拆除、原版共存检测警告
- **FR-5 AI 可设置通道**：host 侧配置存储（`~/.dsh/dsh-breeze-tts/config.json`）+ 8 个 REST 路由 + 鉴权矩阵（本机免 token / 远程 403·401 / 逃生门）+ host 版 WAV 头修复 + `AI_SETUP.md`
- 本 README / NOTICE 文档

---

## 第三块：署名

```
维护者：OldQin Family
落码实现：小牛总
AI 操作测试：宁宁
收口 / 验收：小枢

基于：
  - @dsh-external/dsh-plugin-local-ai-tts (MIT)
    https://github.com/abbccdd/dsh-localtts
  - dsh-plugin-tts (MIT)
    https://github.com/1624318455/dsh-plugin-tts
运行时服务（仅调用，未复制代码）：
  - Breeze-TTS-2.cpp (Apache-2.0；MP3 编码器 LGPL-2.0)
    https://github.com/HoppouAI/Breeze-TTS-2.cpp
  - Breeze TTS 2 模型权重 (BreezeBlue Research and Non-Commercial)
    https://github.com/breezeblue-ai/breeze-tts
    https://huggingface.co/BreezeBlue/breeze-tts-2
    （权重不随本插件分发）
```

---

## 第四块：LICENSE

本插件沿用 **MIT**（见 [LICENSE](LICENSE)）。`LICENSE` 文件内**原样保留**上游两份 MIT 原文与版权声明（`abbccdd/dsh-localtts`、`1624318455/dsh-plugin-tts`），这是 MIT 的强制法律要求；本插件自有贡献追加在文件末尾，不删改任何原有版权行。
