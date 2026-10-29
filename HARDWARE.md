# HARDWARE.md —— 硬件要求（先看这个，再决定要不要装）

> **这份文档两个读者共用**：人要看得懂「我这台机器行不行」，AI 要拿它**帮人判定**并给出具体命令。
> 数据来源：两个上游仓库的官方 README 原文（下文标注了哪些是官方原文、哪些是我们实测或推断）。

---

## 0. 先说一句最要紧的

**插件本身几乎不吃硬件**（它只是个网页客户端，几百 KB 的 JS）。
**所有硬件门槛都在 Breeze TTS 服务那头** —— 那才是真跑模型的进程。

所以「我这台机器能不能用」＝**「我这台机器能不能跑 Breeze 服务」**。

---

## 1. 三十秒决策表

对着你的机器找一行：

| 你的机器 | 走哪条路 | 结论 |
|---|---|---|
| **NVIDIA 独显，显存 ≥ 4 GB** | **C++ 版（Q8_0）** | ✅ 推荐，最省事 |
| **NVIDIA 独显，显存 3 GB 左右** | **C++ 版（Q4_K）** | ✅ 能跑，音质略降 |
| **AMD 显卡（含核显），显存/共享内存 ≥ 4 GB** | **C++ 版（Q8_0 或 Q4_K）** | ✅ **能跑** —— 它走 Vulkan，不需要 CUDA/ROCm |
| **Intel 显卡（含核显）** | **C++ 版** | ✅ 能跑，同上走 Vulkan |
| **没有独显 / 老机器，只有 CPU** | **C++ 版（Q4_K）** | ⚠️ 能跑但**明显慢于实时**，只适合短句，不适合长文朗读 |
| **CPU 是 2013 年之前的老 x64** | —— | ❌ **跑不了**，C++ 版要求 CPU 支持 **AVX2** |
| **Apple Silicon / ARM 机器** | —— | ❌ **官方无支持**（无预编译包、文档未提 ARM） |
| **Windows + NVIDIA + 想用 PyTorch 版** | —— | ❌ **跑不了**，PyTorch 版只声明 Linux |
| **AMD 显卡 + 想用 PyTorch 版** | —— | ❌ **跑不了**，PyTorch 版只有 CUDA |

> **一句话**：**绝大多数人走 C++ 版。** 它兼容面最宽（NVIDIA/AMD/Intel/纯 CPU 都行），而且**恰好是插件音色下拉框唯一能用的那一版**。

---

## 2. 两版硬件要求对照

### 2.1 C++ 版（`HoppouAI/Breeze-TTS-2.cpp`）—— **推荐**

| 项 | 要求 | 来源 |
|---|---|---|
| **显卡** | **NVIDIA / AMD / Intel 都行**，走 **Vulkan** 后端 | 官方原文 |
| **驱动** | 「nothing else to install beyond a current GPU driver」＝**只要一个较新的显卡驱动，不用装 CUDA / ROCm** | 官方原文 |
| **无显卡** | 「falls back to the CPU when there is no GPU」＝**自动退回 CPU** | 官方原文 |
| **CPU** | **必须支持 AVX2**（「any x64 CPU from roughly 2013 onwards has」） | 官方原文 |
| **系统** | **Windows x64 / Linux x64**（都有预编译包）；Linux 需装 Vulkan loader（Debian/Ubuntu 包名 `libvulkan1`） | 官方原文 |
| **macOS / ARM** | 文档未提及，**无预编译包** | 官方原文缺省 |

**显存按量化档（官方表格，逐字）：**

| 量化 | 模型文件 | 近似显存 | 定位 |
|---|---|---|---|
| **F16** | 5.9 GB | ~7 GB | Reference quality（参考音质） |
| **Q8_0** | 3.3 GB | **~4 GB** | **Recommended（推荐）** |
| **Q6_K** | 2.9 GB | ~3.5 GB | — |
| **Q4_K** | 2.4 GB | **~3 GB** | **Smallest safe choice（最小安全选择）** |
| Q8_0-dd4 / Q8_0-dd2 / Q4_K-dd2 | 2.3–3.4 GB | 未单独标注 | **实验性**，见下方警告 |

**速度基准（官方唯一给出的实测数字）：**

> 「roughly **1.5x realtime at Q8_0 on an RTX 3060**, **1.3x with guidance**」

⇒ 以 RTX 3060 为「中端卡」基准，Q8_0 约 **1.5 倍实时**（说 1 秒的话，约 0.67 秒算完），开着引导（`cfg_scale > 1`）降到 **1.3 倍**。
⇒ **比它弱的卡会更慢，但官方没给更弱的卡的曲线。**

> ⚠️ **`-dd` 实验档别用来做长文朗读**：官方原文说它「output holds up early and then drifts muffled and thin past roughly **45 seconds** of continuous generation. Fine for short lines, **not for narration**」。短句可以，长段会变闷变薄。

### 2.2 官方 PyTorch 版（`breezeblue-ai/breeze-tts`）—— **门槛高得多**

| 项 | 要求 | 来源 |
|---|---|---|
| **系统** | 「**Linux** and Python 3.10 or newer」 | 官方原文 |
| **显卡** | 「A **CUDA-capable NVIDIA GPU**」 | 官方原文 |
| **AMD / Intel / Apple** | 文档**完全没有提及** ROCm / MPS ⇒ **不支持** | 官方原文缺省 |
| **Windows** | 未声明支持 | 官方原文缺省 |
| **纯 CPU 推理** | **没有**面向用户的 CPU / offload 开关 | 官方原文缺省 |
| **显存（eager 默认）** | 约 **7.7 GiB** ⇒ 官方建议 **12 GB** 卡 | 官方原文 |
| **显存（`--fast-all`）** | **14.4 GiB** ⇒ 官方建议 **24 GB** 卡 | 官方原文 |
| **实测硬件** | 官方性能数字全部来自 **NVIDIA H100** | 官方原文 |

> ⚠️ **两个坑，比硬件更致命**：
> 1. **它没有 `/v1/voices` 接口** ⇒ 本插件的**音色下拉框会是空的**，只能手打音色 id。
> 2. 官方只声明 Linux ⇒ **Windows 用户基本走不通**。
>
> ⇒ **除非你已经有 12 GB 以上的 NVIDIA 卡、并且跑 Linux，否则不要选这一版。**

---

## 3. 几个常见情况，逐个说清

### 3.1 「我的是 AMD 卡，能跑吗？」

**能，但要选对版本。**

- **C++ 版：能。** 走 **Vulkan** 后端，官方原文明确写「works across **NVIDIA, AMD and Intel** GPUs」，且「nothing else to install beyond a current GPU driver」—— **不需要装 ROCm**。
- **PyTorch 版：不能。** 它只要 CUDA，文档里连 ROCm 都没提。

⇒ **AMD 用户请直接看 C++ 版**，这不成问题。

> 几点诚实提醒（官方没写、但我们该说）：
> - AMD 在 Windows 上的 Vulkan 驱动质量**因卡而异**，**核显和很老的卡**可能报错或明显变慢。**唯一可靠的判据是跑一次 `/health` 看它认不认卡**。
> - 核显会**共享系统内存**当显存，实际可用量比标称小，建议按 **Q4_K** 起步。

### 3.2 「我的是老机器，没独显，只有 CPU」

**能跑，但要有心理准备。**

- 官方说会自动退回 CPU，**但没给任何 CPU-only 的吞吐数字**（这点我们如实说，不编）。
- 参照：Q8_0 在 RTX 3060 上才 1.5 倍实时。**CPU 只会明显更慢** —— 大概率**低于实时**。
- ⇒ 实际体验：**短句（一两句）勉强能用；长段朗读会「说一句、等半天」，基本不可用。**

**先确认 CPU 有 AVX2**（2013 年后的 x64 基本都有）。**没有 AVX2 就完全跑不了，没有回退路径。**

### 3.3 「显存不够怎么办」

按这个顺序试：

1. **换低量化**：Q8_0（~4 GB）→ Q6_K（~3.5 GB）→ **Q4_K（~3 GB）**。Q4_K 是官方说的「最小安全选择」。
2. **别开 `cfg_scale > 1`**：官方说它「run the whole pipeline twice」＝**算力翻倍**，速度从 1.5x 掉到 1.3x。
3. **关掉别的吃显卡的程序**（浏览器硬件加速、游戏、本地大模型）。
4. 还不够 ⇒ **就是这台机器跑不动这一版**，考虑换机器或别部署。

### 3.4 「我要不要为了这个升级硬件」

看你的用法：

| 你的用法 | 最低够用 | 舒服 |
|---|---|---|
| 偶尔试听、造几个音色 | 任意 Vulkan 卡 + Q4_K | Q8_0 |
| AI 回复**每句都自动念**（Auto Read） | 约 4 GB（Q8_0） | 6 GB+ |
| **长文朗读**（几千字连着念） | 6 GB+ | 8 GB+ 且 Q8_0 |

> 判据：**要「边生成边播」不卡，需要服务端跑得比实时快**。跑不到 1x 实时，就会「念完一句停一下」。

---

## 4. 怎么查你自己的机器（可直接复制）

### 4.1 Windows

**① 看显卡型号和显存**

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, @{N='VRAM_GB';E={[math]::Round($_.AdapterRAM/1GB,1)}}
```

> ⚠️ `AdapterRAM` 是 32 位字段，**超过 4 GB 会显示错**（常见 4.0 或异常值）。**NVIDIA 卡请用下面这条更准**：

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
```

**② 看是不是 AMD / Intel**（上一条的 `Name` 里就有 `AMD` / `Radeon` / `Intel` 字样）

**③ 看 CPU 型号和年代**

```powershell
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed
```

> 拿到型号后看**代数**：Intel **第 4 代（Haswell，2013）之前**、AMD **推土机/FX 系列**要小心 —— 可能没有 AVX2。
> **最可靠的判据不是查型号，是直接跑一次服务**：起得来、不报 `illegal instruction`，就说明指令集够。

**④ 看 Vulkan 能不能用**

```powershell
Test-Path "$env:SystemRoot\System32\vulkan-1.dll"
```

> 返回 `True` ＝系统里有 Vulkan 运行时（通常随显卡驱动装上）。
> 返回 `False` ⇒ **先更新显卡驱动**；更新后还是没有 ⇒ 这块卡的驱动不支持 Vulkan，**C++ 版跑不了**。

**⑤ 系统架构**

```powershell
$env:PROCESSOR_ARCHITECTURE    # 应为 AMD64（＝x64）。ARM64 则官方无支持
```

### 4.2 Linux

```bash
# 显卡
lspci | grep -Ei 'vga|3d|display'
# NVIDIA 专用（有 nvidia-smi 就用这条，显存更准）
nvidia-smi --query-gpu=name,memory.total --format=csv 2>/dev/null

# CPU 是否有 AVX2（有输出就是有）
grep -o 'avx2' /proc/cpuinfo | head -1

# Vulkan loader 有没有装
dpkg -l libvulkan1 2>/dev/null | tail -1     # Debian/Ubuntu
vulkaninfo --summary 2>/dev/null | head -20  # 装了 vulkan-tools 才有

# 内存和磁盘（官方没给下限，但你自己心里要有数）
free -h
df -h .
```

---

## 5. 给 AI 的判定流程（人只要把这一节交给 AI 就行）

**AI 按下面五步走，每步都要把实测输出贴给人，不许只给结论。**

### 第 1 步：确认系统与架构

```powershell
$env:PROCESSOR_ARCHITECTURE   # Windows
```
```bash
uname -m && cat /etc/os-release | head -3   # Linux
```

- `AMD64` / `x86_64` ⇒ 继续
- `ARM64` / `aarch64`（含 Apple Silicon）⇒ **停**，告诉人：官方无 ARM 支持，无预编译包

### 第 2 步：识别显卡厂商

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
```

判定：

| 输出里出现 | 结论 |
|---|---|
| `NVIDIA` | ✅ 两版都能考虑（但 PyTorch 版还要 Linux） |
| `AMD` / `Radeon` | ✅ **只走 C++ 版**（Vulkan）；❌ PyTorch 版不行 |
| `Intel` | ✅ 只走 C++ 版（Vulkan） |
| 只有 `Microsoft Basic Display Adapter` / 无独显 | ⚠️ 走 C++ 版 CPU 模式，**先跟人说清楚会慢** |

### 第 3 步：量显存，定量化档

```powershell
nvidia-smi --query-gpu=memory.total --format=csv,noheader   # NVIDIA
```
AMD / Intel 用：

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, @{N='VRAM_GB';E={[math]::Round($_.AdapterRAM/1GB,1)}}
```
> ⚠️ 这条 AMD/Intel 上**只作参考**（`AdapterRAM` 字段不可靠，核显还会共享内存）。**拿不准就按 Q4_K 起步。**

按实测显存选档（官方近似值）：

| 实测显存 | 选哪档 |
|---|---|
| ≥ 7 GB | F16 |
| **≥ 4 GB** | **Q8_0（推荐默认）** |
| ≥ 3.5 GB | Q6_K |
| **≥ 3 GB** | **Q4_K（最小安全）** |
| < 3 GB | 先试 Q4_K；跑不起来就告诉人「这台机器跑不动」 |

### 第 4 步：确认 Vulkan（C++ 版必需）

```powershell
Test-Path "$env:SystemRoot\System32\vulkan-1.dll"
```
```bash
dpkg -l libvulkan1 2>/dev/null | tail -1 || echo "NOT INSTALLED"
```

- 有 ⇒ 继续
- 无 ⇒ **先让人更新显卡驱动**；更新后仍无 ⇒ **C++ 版 GPU 模式不可用**（可退 CPU 模式，但慢）

### 第 5 步：告诉人结论，并且一定要说清这三句

1. **「这台机器走 C++ 版 Q8_0 / Q4_K / 只能 CPU」** —— 给一个确定的档，别给「也许行」。
2. **「预计快/慢」** —— 有独显就说「约 1.5 倍实时的量级（官方 RTX 3060 基准）」；只有 CPU 就说「明显低于实时，长文朗读会一句一停」。
3. **「我验到哪一步了」** —— 命令和输出原文都贴出来。

> **禁止**：不许凭「你有 NVIDIA 卡应该没问题」下结论。**必须量到数字**。
> **禁止**：不许把官方没有的数字（RAM 下限、CPU 速度、最低显卡型号）编出来。官方没给就说「官方没给」。

### AI 该劝阻的情况

| 情况 | 该说什么 |
|---|---|
| ARM / Apple Silicon | 「官方无支持，装不了，别浪费时间」 |
| AMD 卡但人想装 PyTorch 版 | 「PyTorch 版只要 CUDA，你的卡跑不了。而且它没有 `/v1/voices`，插件的音色下拉会是空的。走 C++ 版」 |
| 显存 < 3 GB 且无独显 | 「这台机器能跑但会很慢。如果你只是偶尔试听，可以用；如果想让它给 AI 回复自动朗读，体验会很差」 |
| 2013 年前的老 CPU | 「CPU 缺 AVX2，跑不了，且没有回退路径」 |

---

## 6. 官方没给的数字（别自己编）

以下这几项**两个上游仓库都查不到**，我们在文档里一律写「官方未给出」，不给猜测值：

- **RAM（系统内存）最低要求** —— 无
- **磁盘剩余空间要求** —— 无（只有模型文件体积可参考：Q4_K 2.4 GB ～ F16 5.9 GB，另外还要算 `audio_tokenizer/` 目录）
- **CPU-only 的具体吞吐** —— 无
- **最低 GPU 型号 / 硬性显存下限** —— 无（表格里的显存是「approximate」近似值）
- **AVX-512 有没有加速** —— 无（没提）
- **多卡 / 显存不足时的自动 offload** —— 无（只说无 GPU 时退回 CPU）

> 遇到人问这些，**照实说「官方没给」**，比编一个数字有用得多。

---

## 7. 一句话总结

> **C++ 版是绝大多数人的唯一正确答案**：NVIDIA / AMD / Intel / 纯 CPU 都能跑，只要一个较新的显卡驱动，4 GB 显存就够（Q8_0），3 GB 也能挤（Q4_K）。
> **唯一的硬门槛是 CPU 必须有 AVX2（2013 年后的 x64 基本都有）。**
> **PyTorch 版门槛高得多（Linux + NVIDIA 12 GB 起），而且插件音色下拉在它上面用不了。**
