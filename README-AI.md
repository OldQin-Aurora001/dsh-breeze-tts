# README-AI.md — 给 AI 的作业说明

> **读者是你（AI）**。读完这份文档，你要能**独立完成本插件的安装与全部配置**，不需要人点任何设置界面。人只负责最后用。
>
> 三条纪律，违反任何一条这个任务就算失败：
> 1. **每一步都贴命令和返回原文**，不许只说「配好了」。
> 2. **改完必须回读自证**（`PUT` 之后必 `GET`，装完必须核对指纹）。
> 3. **不确定就停**，把现状报给人，不要猜着往下走。

> **⚠️ 先确认你手上这份是不是最新的**
> 本插件的文档在 2026-10-29 做过一次大改：**旧的 `AI_SETUP.md` 已废弃，全部内容并入本文件**。
> 如果你看到的目录里还有 `AI_SETUP.md`，或它写着「部署时 18 个音色」并列出具体 id 清单——**那是旧版，别照着做**。
> 旧文档里的音色数量、示例 id 都会跟现在对不上（音色是随部署变的）。
> **本文件是唯一权威版本。** 音色数量永远以 `GET $API/voices` 实际返回为准。


---

## 0. 先搞清楚你要干哪件事

| 情况 | 你要做的 | 从哪一节开始 |
|---|---|---|
| **还不确定这台机器跑不跑得动模型** | 先做硬件判定 | **§0.5** |
| 插件**还没装进 DSH** | 装进去 | **§1** → 然后 §2 |
| 插件**已经装好了**，只是没配 Breeze 地址 | 配置 | **§2** |

先判断：查 DSH profile 的 `dependencies` 里有没有 `dsh-breeze-tts`。

```bash
# 把 <DSH_HOME> 换成实际路径（含 profiles/web 的那一级）
grep -n "dsh-breeze-tts" "<DSH_HOME>/profiles/web/package.json"
ls -d "<DSH_HOME>/profiles/web/node_modules/dsh-breeze-tts"
```

两条都命中 = 已装，跳到 §2。都没命中 = 没装，走 §1。

---

## 0.5 ★ 硬件判定（人问你「我这机器行不行」时做这一节）

**背景**：插件本身不吃硬件（几百 KB 的客户端）。**所有门槛都在 Breeze TTS 服务那头。**
**完整数据（官方原文、两版对照、官方没给的数字）在 [`HARDWARE.md`](HARDWARE.md)** —— 遇到细节去查那份，别凭印象答。

### 0.5.1 两版一句话结论（先记住，别搞混）

| | **C++ 版（推荐）** | **PyTorch 版** |
|---|---|---|
| 显卡 | **NVIDIA / AMD / Intel 都行**（走 Vulkan） | **只要 NVIDIA CUDA** |
| 系统 | Windows x64 / Linux x64 | **只声明 Linux** |
| 显存 | **~4 GB**（Q8_0）／~3 GB（Q4_K） | **7.7 GiB 起，官方建议 12 GB** |
| 无显卡 | 自动退回 CPU | **没有 CPU 路径** |
| 插件音色下拉 | ✅ 可用（有 `/v1/voices`） | ❌ **不可用**（无该接口） |

> **⇒ 除非人明确说「我有 12 GB 以上 NVIDIA 卡而且跑 Linux」，否则一律推 C++ 版。**

### 0.5.2 五步判定（每步都把输出原文贴给人）

**第 1 步 · 系统架构**

```powershell
$env:PROCESSOR_ARCHITECTURE        # Windows，应为 AMD64
```
```bash
uname -m                            # Linux，应为 x86_64
```

- `AMD64` / `x86_64` ⇒ 继续
- `ARM64` / `aarch64`（含 Apple Silicon）⇒ **停**。告诉人「官方无 ARM 支持、无预编译包，装不了」

**第 2 步 · 显卡厂商**

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
```

| 输出里出现 | 判定 |
|---|---|
| `NVIDIA` | ✅ 走 C++ 版（如人坚持 PyTorch 版，还需确认是 Linux） |
| `AMD` / `Radeon` | ✅ **只能走 C++ 版**（Vulkan，**不需要 ROCm**）；❌ PyTorch 版不支持 AMD |
| `Intel` | ✅ 只能走 C++ 版（Vulkan） |
| 只有 `Microsoft Basic Display Adapter` / 无独显 | ⚠️ C++ 版 CPU 模式，**先说清「会明显慢于实时」再谈装** |

**第 3 步 · 量显存，定档位**

```powershell
nvidia-smi --query-gpu=memory.total --format=csv,noheader      # NVIDIA，最准
```
```powershell
# AMD / Intel：AdapterRAM 字段不可靠（超 4 GB 会显示错、核显算共享内存）⇒ 只作参考
Get-CimInstance Win32_VideoController | Select-Object Name, @{N='VRAM_GB';E={[math]::Round($_.AdapterRAM/1GB,1)}}
```

按**官方近似值**选档：

| 实测显存 | 选哪档 | 模型文件 |
|---|---|---|
| ≥ 7 GB | F16 | 5.9 GB |
| **≥ 4 GB** | **Q8_0（推荐默认）** | 3.3 GB |
| ≥ 3.5 GB | Q6_K | 2.9 GB |
| **≥ 3 GB** | **Q4_K（官方称「最小安全选择」）** | 2.4 GB |
| < 3 GB 或无独显 | 先试 Q4_K；不行就如实说「这台机器跑不动」 | — |

> ⚠️ **不要推荐 `-dd` 实验档做长文朗读**：官方原文说它「past roughly **45 seconds** of continuous generation」会变闷变薄，「Fine for short lines, **not for narration**」。

**第 4 步 · 确认 Vulkan（C++ 版 GPU 模式必需）**

```powershell
Test-Path "$env:SystemRoot\System32\vulkan-1.dll"
```
```bash
dpkg -l libvulkan1 2>/dev/null | tail -1 || echo "NOT INSTALLED"
```

- 有 ⇒ 继续
- 无 ⇒ **先让人更新显卡驱动**（通常驱动会带上 vulkan-1.dll）；更新后仍无 ⇒ **GPU 模式不可用**，只能 CPU 模式（慢）

**第 5 步 · CPU 指令集（唯一的硬门槛）**

官方要求 **AVX2**（「any x64 CPU from roughly 2013 onwards has」）。

```powershell
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, MaxClockSpeed
```
```bash
grep -o 'avx2' /proc/cpuinfo | head -1
```

- **最可靠的判据不是查型号，是直接起一次服务**：起得来、不报 `illegal instruction` ⇒ 指令集够。
- 唯一无法绕过的失败：**缺 AVX2 ⇒ 完全跑不了，没有回退路径。**

### 0.5.3 给结论时必须说清三件事

1. **走哪档**：`C++ 版 Q8_0` / `C++ 版 Q4_K` / `只能 CPU 模式` / **`跑不了`** —— 给确定的答案，别给「也许行」。
2. **预计快慢**：有独显 ⇒「大概 1.5 倍实时的量级（官方 RTX 3060 基准），比它弱的卡更慢」；只有 CPU ⇒「明显低于实时，长文朗读会一句一停」。
3. **验到哪一步**：命令 + 输出原文。

### 0.5.4 硬禁用（这几条踩了就是错）

- ❌ **不许凭「你有 NVIDIA 卡应该没问题」下结论** ⇒ 必须量到显存数字
- ❌ **不许编官方没给的数字**：RAM 下限、磁盘需求、CPU-only 速度、最低显卡型号、AVX-512 有无 —— **官方都没给，照实说「官方没给」**
- ❌ **不许推 PyTorch 版给 AMD / Windows / 小显存用户**
- ❌ **不许把「能装插件」和「能跑模型」混为一谈** —— 这两个门槛差着一个数量级

### 0.5.5 该劝阻的情况（直接说，别迁就）

| 情况 | 说什么 |
|---|---|
| ARM / Apple Silicon | 「官方无支持，装不了，别浪费时间」 |
| AMD 想装 PyTorch 版 | 「PyTorch 版只要 CUDA，你的卡跑不了；而且它没有 `/v1/voices`，插件音色下拉会是空的。走 C++ 版，走 Vulkan，不用装 ROCm」 |
| 无独显 + 想用 Auto Read | 「能跑但明显慢于实时。AI 每句都念的体验会很差——会一句一停。你确认要装我再动手」 |
| 2013 年前的老 CPU | 「缺 AVX2，跑不了，且没有回退路径」 |

---

## 1. 安装（只在「还没装」时做）

### 1.0 先查冲突，别自己动手卸

**必须**先确认这两个旧插件没装：

```bash
grep -n "dsh-plugin-local-ai-tts\|dsh-breeze-voices" "<DSH_HOME>/profiles/web/package.json"
```

- **零命中** → 继续 §1.1
- **有命中** → **停下来问人**。本插件是这两个的合并版，同时装会抢路由、功能互相打架。卸载是**有数据后果**的动作（可能连带删掉旧配置），必须由人拍板，你不许自己卸。

### 1.1 把插件放到纯 ASCII 路径

**中文路径会把 pnpm 装坏**（这是实测过的坑，不是洁癖）。目标路径必须全是 ASCII 字符，例如：

```
F:/dsh-plugins/dsh-breeze-tts
```

移动完**打印新路径**，后面的步骤都用新路径：
（Windows 下用 `move`，Linux/macOS 下用 `mv`）

### 1.2 改 profile 的 package.json

`<DSH_HOME>/profiles/web/package.json` 要改**两个地方**，缺一个插件都不会加载：

**① `dependencies` 里加一条 file: 依赖**

```json
"dsh-breeze-tts": "file:F:/dsh-plugins/dsh-breeze-tts"
```

> ⚠️ `file:` 后面的路径用**正斜杠**，不要反斜杠。

**② `dsh.profile.bundles` 数组里加包名**

```json
"dsh": {
  "profile": {
    "bundles": [
      ..., 
      "dsh-breeze-tts"
    ]
  }
}
```

> ⚠️ 只加 `dependencies` 不加 `bundles` ⇒ 包装进去了但**不会被激活**，界面上什么都不会出现。这是最常见的「装了没反应」。

**改之前先备份** `package.json`（复制一份加 `.bak` 后缀），改完用 `git diff` 或人工比对确认只动了这两处。

### 1.3 装依赖

```bash
cd "<DSH_HOME>/profiles/web" && pnpm install
```

> ⚠️ **跑 pnpm 前确认 `package.json` 和 lock 文件齐全且已备份**。如果这个 profile 之前是用 npm 装的，`pnpm install` 可能重写 lock、改变 `node_modules` 布局。有风险就先问人。

### 1.4 核对指纹（这一步不许省）

装完必须验证 `node_modules` 里的文件跟源目录**逐字节一致**，防止装了个旧件：

```bash
cd "<DSH_HOME>/profiles/web/node_modules/dsh-breeze-tts"
sha256sum package.json cordis.patch.yml lib/client.js lib/index.mjs lib/coexistence.mjs lib/local-runtime/*.mjs
```

Linux/macOS 用 `sha256sum`，Windows 用 `certutil -hashfile <文件> SHA256`。

然后跟**源目录**的同名文件比，**全部一致才算装对**。不一致 → 停下报人，不要自己覆盖。

### 1.5 重启 DSH，然后看日志

重启后 **必须**检查启动日志里有没有插件加载错误：

```bash
grep -i "breeze-tts\|did not activate\|duplicate exact route" <DSH 启动日志路径>
```

- 看到 `1 entry did not activate` → **插件零路由加载，页面还在但功能全死**。九成是 `duplicate exact route` 引起的（DSH webServer 按 path 判重，不看 method）。停下报人。
- 干净无报错 → 进 §2 配置。

**验证界面**：让用户打开 DSH → 设置 → 插件，应看到「**Breeze 语音**」，里面两个 tab。

---

## 2. 配置（插件已装好之后）

### 2.1 三个必知事实

1. **Breeze 服务默认地址**：`http://127.0.0.1:8080`。健康检查：`GET <breeze>/health` → `{"status":"ok","sample_rate":24000,"ws_port":8081}`。
2. **本插件接口前缀**：`/dsh-breeze-tts-api`，挂在 **DSH 宿主端口**上。
   - DSH 默认端口是 `127.0.0.1:3104`，但**每个实例的端口可能不同** ⇒ 先确认实际端口，不要想当然。
   - 找端口：看 DSH 启动命令的 `--port` 参数，或 `netstat -ano | findstr LISTENING` 里找 DSH 进程。
3. **音色数量以接口返回为准**。`GET /dsh-breeze-tts-api/voices` 返回的数组有多长就是多少个。**不要假设任何音色 id 存在**——先用接口列出来。

下文用 `$API` 代表 `http://127.0.0.1:<DSH端口>/dsh-breeze-tts-api`。

### 2.2 鉴权矩阵（先看懂再动手）

| 你的请求来自 | `remoteAccess` | `requireLocalToken` | 读接口 | 写接口 |
|---|---|---|---|---|
| 本机（在 `trustedLocalCidrs` 内） | 任意 | `false` | ✅ 免 token | ✅ 免 token |
| 本机 | 任意 | **`true`**（穿透模式） | ❌ 要 Bearer | ❌ 要 Bearer |
| 非本机 | `false` | 任意 | ❌ **403** | ❌ 403 |
| 非本机 | `true` | `false` | ✅ 免 token | ❌ 要 Bearer |
| 非本机 | `true` | `true` | ❌ 要 Bearer | ❌ 要 Bearer |

- **默认出厂态**：`remoteAccess=false`、`requireLocalToken=false` ⇒ **本机调用全部免 token**，这是最简单的情况。
- **`trustedLocalCidrs` 不是「放行名单」，是「视为本机名单」**：在里面 = 免 token **并且** 能拿到 token。往里加 IP 等于把对方当本机，慎重。

### 2.3 八条接口（可直接复制）

#### ① 读配置

```bash
curl -s $API/config
```

字段含义：

| 字段 | 含义 |
|---|---|
| `endpoint` | **Breeze 服务地址**（两个 tab 共用的唯一源） |
| `voice` | 当前默认音色 id（空 = 未设） |
| `engine` | 引擎（`generic` = 通用 HTTP TTS） |
| `speech` | 朗读 tab 的全部设置（autoRead / voice / provider / localRuntime / rvc / notify…） |
| `remoteAccess` | 是否允许非本机访问（默认 `false`） |
| `trustedLocalCidrs` | 视为本机的地址列表（默认 `["127.0.0.1","::1"]`） |
| `requireLocalToken` | 穿透模式：`true` = 本机写也要 token |
| `accessMode` | 工坊调用通道（`direct` / `proxy`） |
| `allowLanFiles` | 是否允许 `rvc-files` 读私网地址（默认 `false`） |
| `token` | 管理 token（**仅 本机 且 `requireLocalToken=false` 时返回**） |
| `updatedAt` | 最后写入时间 |

> `pairCode` **永远不会**出现在这个返回里（故意的，它是文件通道专用的）。

#### ② 写配置（局部 merge，不要整包覆盖）

```bash
curl -s -X PUT $API/config \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"http://127.0.0.1:8080\"}"
```

只传要改的字段。**可写字段白名单**：

```
endpoint  voice  engine  speech  remoteAccess
trustedLocalCidrs  requireLocalToken  clientMigrated
accessMode  allowLanFiles
```

**★ 白名单外的字段：静默忽略，不报错。** 唯一例外是 `pairCode`（见下，它会 400）。
「忽略」和「400」是两种行为，别混。

**★ `speech` 是【一层深合并】**（2026-10-29 修过，此前是整块替换、会丢配置）：

```bash
# 只改 localRuntime，别的子键（autoRead / voice / rvc / notify…）都保留
curl -s -X PUT $API/config -H "Content-Type: application/json" \
  -d '{"speech":{"localRuntime":{"voice":"xuning"}}}'
```

- 第一层（`autoRead`／`voice`／`provider`／`localRuntime`／`localProcess`／`rvc`／`notify`…）**按键合并**
- **要删掉某个子键，显式给 `null`**：`{"speech":{"notify":null}}`
- **只合并这一层**。再往下（比如 `rvc` 里面的字段）是**整块替换**——要给就把那一块给全
- 顶层字段（`endpoint`／`token`／自己手加的备注字段）**不会被碰**

> **⚠️ 历史坑（2026-10-29 之前的版本有，现已修）**：以前 `speech` 是**整块替换**。
> 传 `{"speech":{"localRuntime":{...}}}` 会把 `autoRead`／`voice`／`rvc`／`notify` **全删掉**，
> **而且返回 200、没有任何警告**，配好一切的机器会被打回出厂。实测 `speech` 7 键 → 2 键。
> **如果你连的是旧版插件，写 `speech` 必须整块传全。** 判断办法：传一个子集，再 `GET /config` 看其他子键还在不在。

> ⚠️ **`pairCode` 写不进来**：`PUT /config` 带 `pairCode` 会直接返回 **400** 并让你去改文件。这是设计如此，不是 bug。

> **★ 关于 `updatedAt`**：`GET /config` 返回的 `updatedAt` 现在与磁盘一致（2026-10-29 修过）。
> 旧版会一直回**启动那一刻**的时间，看起来像"没落盘"。**验落盘别只看这个字段**，还要看你自己改的那个值有没有变。
>
> **★ GET 会先重载磁盘**：你直接改 `config.json`（`pairCode` 就是走文件通道的），下一次 `GET /config` 就能看见，不用重启。
> 但注意 `pairCode` **永远不回显**（安全设计），所以别拿它验"能不能读到"——换个字段验。


#### ③ 健康检查（Breeze 通不通）

```bash
curl -s $API/health
```

返回 `{"ok":true,"sample_rate":24000,"ws_port":8081}` 或 `{"ok":false,"reason":"..."}`。`reason` 直接告诉你卡在哪。

#### ④ 列音色

```bash
curl -s $API/voices
```

返回音色数组（每项含 `id` / `seconds` / `saved`）。**Breeze 的 voices 接口不返回中文 `name`**，插件用 `id` 兜底显示。

#### ⑤ 试听（返回 wav 二进制）

**★ 先看这条，能省你半小时**：下面这个 `-d "{\"input\":...}"` 的写法**只在 Bash 里成立**。
**Windows PowerShell / cmd 里照抄一定坏**——报 `Expected property name or '}' in JSON at position 1`，
因为 PowerShell 的转义符是反引号 `` ` `` 不是反斜杠，`\"` 会被当成字面的 `\"` 送进 JSON，第二个字符就不合法了。

**三种正确的写法，按你的 shell 挑一个**：

```bash
# ① Bash / Git Bash / WSL —— 反斜杠转义（本文档默认写法）
curl -s -X POST $API/speak-preview -H "Content-Type: application/json" \
  -d "{\"input\":\"你好，这是一段试听。\",\"voice\":\"kexin\"}" -o test.wav
```

```powershell
# ② Windows PowerShell —— 单引号包住（单引号内不解析），最省事
curl.exe -s -X POST http://127.0.0.1:8080/dsh-breeze-tts-api/speak-preview `
  -H "Content-Type: application/json" `
  -d '{"input":"你好，这是一段试听。","voice":"kexin"}' -o test.wav
```

```powershell
# ③ 通用最稳：先写文件再 --data-binary（任何 shell、任何编码都成立）
#    PowerShell 5.1 注意别加 BOM，用 -Encoding ascii 或 .NET 的 UTF8Encoding($false)
$body = '{"input":"你好，这是一段试听。","voice":"kexin"}'
[System.IO.File]::WriteAllText("$env:TEMP\body.json", $body, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8080/dsh-breeze-tts-api/speak-preview `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\body.json" -o test.wav
```

> **★ 写文件的两条坑**：
> - **别用 `Set-Content -Encoding UTF8`（PowerShell 5.1）**——它会加 BOM，服务端报 400 `Unexpected token '\uFEFF'`。
>   用 `-Encoding ascii`，或者像上面那样用 `UTF8Encoding($false)` 显式无 BOM。
>   （插件侧现在**已经能容忍 BOM** 了，2026-10-29 修过；但别的工具不一定，写文件时还是别加。）
> - **中文别内联进命令行参数**：cmd 的代码页是 936(GBK)，中文在传参路上就可能坏掉。
>   **一旦请求里有中文，就走 --data-binary 文件通道**，这是最不容易出错的。

字段：`input`（必填）、`voice`、`instructions`、`seed`、`cfg_scale`。
成功 = wav 二进制（WAV 头已在 host 侧修好）；失败 = JSON `{error}`。

> **★ 为什么强调"修好"**：Breeze 服务**直接返回的 wav，头部长度字段是坏的**（`RIFF` 与 `data` 两处都写 `0xFFFFFFFF`）。
> 从**插件**走的音频，host 已经用 `fixWavHost()` 补好了，是正常的。
> 但如果你**绕过插件直接 `curl` 打 8080**，拿到的文件用 `wave` 读会算出**上万秒**的荒唐时长（实测某 2.40 秒的片段被算成 89478 秒）。
> ⇒ 手动 curl 时别相信"时长"，要按**文件字节数**算：`时长 ≈ (文件大小 − 44) ÷ 48000`（24 kHz × 16 bit × 单声道 = 48000 B/s）。
> 要修就自己改两处：`RIFF size` = 总长−8，`data size` = 总长−(data 起点+8)。

#### ⑥ 造音色（声音描述 → 合成 → 注册）

```bash
curl -s -X POST $API/voices/design \
  -H "Content-Type: application/json" \
  --data-binary @body.json
```

其中 `body.json`（**UTF-8 无 BOM**）：
```json
{"name":"myvoice","text":"你好，我回来了。","instructions":"A soft young voice, gentle and warm.","seed":42,"cfg_scale":1.0}
```

- **★ 这里故意不写 `-d` 内联**：body 里有中文和引号，内联在 Windows 上大概率坏（见 ⑤ 那三条坑）。
- `name` 正则：`^[A-Za-z0-9_-]{1,64}$` —— **中文名会被拒（400）**
- `text` 必填，会同时作为转录文本（与工坊 UI 行为一致）
- 成功返回 `{"id":"myvoice",...}`

#### ⑥-b ★ `instructions` 怎么写（附官方示例地址）

**去哪看人家真实的音色长什么样**（官网页面上可以直接点开听）：
👉 **https://breezeblue.ai** —— 首页有七个分类的真人示例音色：Conversational／Narration／Characters／Social／Education／Ads & Promo／Entertainment。
**没有人人可用的「音色库」页面**（`/gallery`、`/voices`、`/samples`、`/demo` 全是 404）⇒ **别让人去找一个不存在的列表页**，示例就在首页。

**官方仓库给的 `instructions` 原句（照抄可用，塞进 JSON 时引号要转义）**：

| 场景 | 原句 | 出处 |
|---|---|---|
| 英文·音色设计 | `A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.` | 官方原文 |
| 中文·音色设计 | `一位温柔自信的年轻女性，声音清晰，语气亲切，表达轻快而富有感染力。` | 官方原文 |
| 英文·语气控制 | `Speak slowly with a restrained, serious tone.` | 官方原文 |
| 中文·语气控制 | `用克制、严肃的语气慢慢说。` | **对照上句自拟**（官方只给了英文版，中文这句是按同义翻的，不是官方原文） |

**写法要点**（从上面几句反推出来的，官方也是这么写的）：
- **一句话，别写成一串参数。** 描述"这个人是谁 + 声音什么样 + 怎么说"，不要写成 `pitch=low, speed=0.8` 这种。
- **覆盖五件事就够**：年龄／性别／音色质感（清晰·沙哑·明亮）／语气情绪／表达方式（语速·停顿·距离感）。
- **中文文本配中文指令，英文文本配英文指令**——官方原文：`Match the instruction language to the target text.`（指令语言要跟要读的文本一致）。**给人念中文却写英文指令，效果会打折。**
- **强度靠 `cfg_scale` 调**，不是靠把话说得更重：默认 `1.0`；要它更听指令就 `2`～`4`；`>3` 容易发刺、发糙。官方建议音色设计／语气控制用 `4`。

**★ 一个真会静默失效的坑（2026-10-29 在本机 C++ v0.1.3 实测，官方 README 没写）**：

`/v1/audio/speech` **两条调用路径的字段名不一样，写错不报错、HTTP 照样 200，只是安静地把你的指令丢掉**：

| 你发的是 | 字段名要用 | 写错的后果 |
|---|---|---|
| **JSON**（`-H "Content-Type: application/json"`） | **`instructions` 复数** | 用单数 ⇒ **指令被完全忽略**（输出与不加指令逐字节相同） |
| **表单**（`--form-string` / multipart，官方 README 示例用的这种） | **`instruction` 单数** | 用复数 ⇒ **同样被忽略** |

实测数据（同一段文字、同一 `seed`、`cfg_scale=4`、指令都是 "Speak very slowly…"）：

```
JSON + instruction(单数)  → 53,804 B   ← 和"完全不加指令"一字节不差 = 被丢掉
JSON + instructions(复数) → 153,644 B  ← 真生效（说了慢慢说，时长翻 3 倍）
表单 + instruction(单数)  → 153,600 B  ← 真生效（官方写法，对）
表单 + instructions(复数) →  53,760 B  ← 被丢掉
```

⇒ **走 JSON 就写复数 `instructions`。** 本文档和插件走的就是 JSON＋复数，是对的。
⇒ **怎么确认指令真的生效了？看输出时长／字节数有没有变。** 字节数跟"不加指令"一样 ⇒ 指令被丢了，别以为成功。

**还可以在文本里塞表情事件**（跟 `instructions` 是两回事，这个是写在 `text` 里的）：
- 英文用圆括号：`(laugh)` `(sigh)` `(cough)` `(clears throat)`
- 中文用方括号：`[笑]` `[叹气]` `[咳嗽]` `[清嗓子]`
- 注意：这类事件**通常要 `cfg_scale` 到 2～3 才真的触发**（默认 1.0 多半只是平读）。
- 用 curl 发表单时，以 `(` 开头的值要用 `--form-string`，别用 `-F`（会被 curl 当成分组语法）。


#### ⑦ 克隆音色（参考音频 + 逐字转录）

```bash
curl -s -X POST $API/voices \
  -F "ref_audio=@/path/to/ref.wav" \
  -F "ref_text=这段音频里说的每一个字" \
  -F "name=myclone"
```

- 必须是 `multipart/form-data`
- **`ref_text` 必须与音频内容逐字一致**，错一个字效果就崩
- 音频文件路径是 **DSH 所在机器**上的路径（host 侧读取）
- **★ 端点是 `POST $API/voices`，不是 `$API/voices/clone`。** 两者指向的不是同一个东西：

  | 路径 | 是谁的 | 说明 |
  |---|---|---|
  | `POST $API/voices` | **Breeze 本机服务**的真接口 | 直连 8080 时用这个 |
  | `POST $API/voices/clone` | **插件**对外暴露的代理路由 | 只存在于 `/dsh-breeze-tts-api/` 下面（`lib/index.mjs:2032`） |

  写成 `$API/voices/clone` 会拿到 **404**，看起来像"功能不存在"，其实只是名前缀放错了。
  （本条是 2026-10-29 实测踩出来的：照旧版文档写，连试两次 404。）

#### ⑧ 删音色

```bash
curl -s -X DELETE $API/voices/<音色id>
```

#### 附：配对码（跨机首次接入用）

```bash
# 在 DSH 本机生成（写接口，本机免 token；穿透模式下要 token）
curl -s -X POST $API/pair/new
# → {"code":"123456","expiresInSec":300}

# 在另一台机器上兑换（这条不挂鉴权，故意的）
curl -s -X POST $API/pair -H "Content-Type: application/json" -d "{\"code\":\"123456\"}"
# → {"token":"..."}
```

- 码 6 位数字，**5 分钟有效**，用一次就焚
- 连错 5 次该码作废；全局连错 3 次**锁 10 分钟**（`423`）
- 也可以由人/你在 `config.json` 里手写 `pairCode`（文件通道），兑换后 host 会自动删字段

> **本表列的是 AI 该用的 8 条主干。** 包内实际注册 **19 条**路由（含界面自用的 RVC、通知、诊断、装包等），
> **别把"没列在这里"当成"不存在"**——要确认就用 `GET /dsh-breeze-tts-api/config` 或看启动日志。
>
> **其中最容易被漏掉的一条**：`/dsh-breeze-tts-api/local-runtime`（界面朗读/试听走的内部 RPC，POST，`level=write`）。
> 它要求 `clientId` 且必须先 `configure` 再 `status`，**不建议 AI 直接调**——要朗读用 ⑤`speak-preview` 就够了。

---

## 3. 五个典型任务配方

### 配方 A：「帮我看看现在连不连得上」

1. `GET $API/health` → `ok:true` = 通；`ok:false` 看 reason：
   - `cannot reach Breeze at ...` → Breeze 没起 / 地址错。先 `curl <breeze>/health` 直接探 Breeze 本体
   - `Breeze HTTP xxx` → Breeze 活着但接口报错，带着 status 去查 Breeze 日志
2. 基础地址不对 → `PUT $API/config` 改 `endpoint`，**再 `GET /config` 回读确认**

### 配方 B：「帮我把默认音色设成 XXX」

1. `GET $API/voices` 确认这个 id **确实存在**（没有就先走配方 C）
2. `PUT $API/config` body `{"voice":"<id>"}`
3. **自证**：`GET $API/config` 回读 `voice` 字段 = 你设的值
4. 再 `POST $API/speak-preview` 合成一句，证明真的能出声

### 配方 C：「帮我造一个 XX 岁、XX 味的声音，名字叫 XXX」

1. `POST $API/voices/design`，`name` 用纯英文/数字/短横/下划线，`text` 给一句日常中文，`instructions` 写清特征（年龄 / 性别 / 语气 / 距离感 / 语速，中英文都认）
2. 返回 `{"id":"...",...}` = 成功
3. **自证**：`GET $API/voices` 列表里出现新 id；`POST $API/speak-preview` 用它合成一句确认效果
4. 不满意 → 改 `instructions` 描述词，或调 `seed`（同种子 + 同文本 = 同声音）/ `cfg_scale`（越高越贴描述）重造

### 配方 D：「帮我克隆这段音频，转录是『……』」

1. 确认音频文件在 **DSH 所在机器**上可读
2. `POST $API/voices`（**不是 `$API/voices/clone`，那个是插件代理路径，直连会 404**），
   `ref_audio` 给路径，`ref_text` **逐字**转录
3. **自证**：`GET $API/voices` 出现新 id + **真合一句听一下**（`saved: true` ≠ 能出声）
4. **注册前后做差集**：净增必须正好 1，且原有音色一个没少 —— 防 id 重名把别人的覆盖掉

> **★★ `ref_text` 必须是这段录音的真实逐字转录，绝不能拿别的批次的句子凑。**
> 服务**不会校验**转录对不对：写错了**照样 200、照样 `saved: true`**，只是音色被悄悄带偏。
> **本机没有 `/v1/audio/transcriptions` 接口（返回 404）**，转录得靠人给。
>
> **拿不到转录时，先量时长做排除**：`时长 ≈ (文件大小 − 44) ÷ 48000`。
> 跟你手上那句的预期时长差得多 ⇒ **就不是那句，停下来问人，别猜**。
> （2026-10-29 实例：`preview_xuning.wav` 只有 6.00 秒，而清单里那句念完 8.56 秒 ⇒ 排除，问到真实台词才注册。）

### 配方 E：「列出所有音色，把带 XXX 前缀的删掉」

1. `GET $API/voices` 拿全列表
2. 对匹配项逐个 `DELETE $API/voices/<id>`
3. **自证**：再 `GET $API/voices`，那批已不在列表

> ⚠️ 删音色**不可撤销**。删之前把完整列表贴给人看，确认要删哪些再动手。

---

## 4. 排错判据表

| 现象 | 判据 | 处置 |
|---|---|---|
| 所有接口 403 | 请求来自非本机（`remoteAddress` 不在 `trustedLocalCidrs`）且 `remoteAccess=false` | 到 DSH 本机上执行；或按 §6 开远程 |
| 写接口 401 | token 缺失/错误，或 `requireLocalToken=true` | 带 `Authorization: Bearer <token>`；token 从 `config.json` 读 |
| `GET /config` 看不到 token | 你不是本机请求，或 `requireLocalToken=true`（故意的，防穿透） | 本机直接读 `config.json` 文件；远程找人复制 |
| `health` `ok:false` 且 reason 是 `cannot reach` | Breeze 没起 / 地址错 | 探 Breeze 本体 → 修 `endpoint` |
| 造音色 400 | `name` 不合规 / `text` 空 | `name` 只用 `[A-Za-z0-9_-]`；`text` 必填 |
| 409 | Breeze 单并发，上一个请求没完 | 等 2 秒重试（插件 UI 侧已自动重试一次） |
| 试听 0 字节 / 坏文件 | 理论上不会（host 已修 WAV 头） | 把返回体前 44 字节发 hex 给维护者 |
| **装了但设置里什么都没有** | `dsh.profile.bundles` 没加，或启动日志有 `duplicate exact route` | 见 §1.2 ② / §1.5 |
| **配置一直不生效** | DSH 进程的 `homedir` 可能不是你以为的那个 | 见下方「配置路径坑」 |

### ★ 配置路径坑（Windows 上很容易栽）

配置文件实际位置 = `os.homedir() + /.dsh/dsh-breeze-tts/config.json`。

**如果 DSH 是计划任务以 SYSTEM 账户启动的**，则服务进程里的 `homedir` = `C:\Windows\System32\config\systemprofile`，而你用普通账户登录看到的 `homedir` = `C:\Users\<用户名>` ⇒ **你在正确的地方改了 `config.json`，服务却读不到**，表现为「改了没用」。

判据：

```bash
# 先确认服务进程实际用的是哪个 home
grep -i "breeze-tts" <DSH 启动日志>   # 首启会打印 "首启已建配置（含随机管理 token）: <完整路径>（token 本身不打印）"
```

拿日志里那条完整路径去改文件，别靠猜。

**另外**：内存里的配置只在**模块加载时读一次**，之后没有文件监听 ⇒ **手改 `config.json` 后必须重启 DSH**，否则不生效。（例外：`pairCode` 是每次兑换时现读磁盘的，改完立即能用。）

---

## 5. 自证方法（设完怎么证明设对了）

每一步都做，缺一步就不算完成：

1. **改配置** → `PUT` 后 `GET` 回读，**逐字段核对**你改的那个值
2. **设音色** → 回读 `voice` 字段 **+** `POST /speak-preview` 实际出了一段 wav
3. **造/克隆音色** → `GET /voices` 列表里出现新 id **+** 试听可用
4. **删音色** → `GET /voices` 里已消失
5. **装插件** → §1.4 指纹全一致 **+** §1.5 日志无报错 **+** 界面能看到「Breeze 语音」两个 tab

**最后把每一步的命令与返回原文整理给人**，不要只报结论。

---

## 6. 安全须知与禁止事项

### 安全

1. **默认仅本机可用**（`remoteAccess=false`）：非本机请求一律 403。**这是特性，不是故障。**
2. **开远程访问**：`PUT /config` 写 `{"remoteAccess":true}`，或改文件后重启。远程**写**接口必须带 `Authorization: Bearer <token>`。
3. **穿透警告**：frp / ngrok / cloudflared 这类**反向代理会把远程请求的来源伪装成 `127.0.0.1`**，绕过「本机」判定。**用穿透的必须把 `requireLocalToken` 设为 `true`**（此时本机写也要 token，且 `GET /config` 不再下发 token）。
   - VPN 类（Tailscale / ZeroTier）**不会**伪装 loopback，不必开逃生门。
4. **无 token 时不要把 DSH 端口暴露到公网。**
5. **`trustedLocalCidrs` 加 IP = 把对方当本机**（免 token 且能拿到 token）。慎重。

### 禁止

- ❌ **不要改插件源码**（要改行为先报维护者）
- ❌ **不要动别的 DSH 实例、别人家的配置**
- ❌ **不要把 token 写进任何会被提交或分享的文件**（token 只住在 `config.json` 里）
- ❌ **不要绕过鉴权矩阵**（例如用隧道伪装来源）
- ❌ **不要自己决定卸载旧插件**（§1.0，有人拍板才行）
- ❌ **不要凭记忆假设音色 id 存在**（先 `GET /voices`）
- ❌ **不要开完 `remoteAccess` / `requireLocalToken` 就不管**——测完**必须恢复出厂**（`false` / `false`）并重启，否则会留下安全口子，或者把所有客户端挡在 401 外面

---

## 7. 装完/测完的收尾清单

- [ ] `remoteAccess` = `false`（除非人明确要求常开）
- [ ] `requireLocalToken` = `false`（除非人在用穿透）
- [ ] `endpoint` 是正确地址，且 `GET /health` 返回 `ok:true`
- [ ] `GET /voices` 拿得到音色，`POST /speak-preview` 真的出了 wav
- [ ] `node_modules` 里的文件与源目录指纹一致
- [ ] DSH 启动日志无 `did not activate` / `duplicate exact route`
- [ ] 把每步的命令与返回原文整理成人能看懂的一段话交给用户

---

## 8. 还需要人做的事（你做不了的）

| 事项 | 为什么你做不了 |
|---|---|
| 装/起 Breeze TTS 服务 | 要下模型权重（几 GB）、可能要装 Vulkan 驱动 |
| 重启 DSH | 会中断用户当前会话 |
| 真听声音对不对 | 你听不到。你只能证明"出了 wav 文件"，证明不了"声音好听" |
| 公网暴露/穿透配置 | 涉及网络与安全决策 |
