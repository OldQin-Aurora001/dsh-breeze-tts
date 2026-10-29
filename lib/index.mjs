// dsh-breeze-tts — Host half.（合并自 @dsh-external/dsh-plugin-local-ai-tts v0.1.12-rc.5，MIT，见 NOTICE.md）
// Registers webServer routes:
//   POST /dsh-breeze-tts-api/speak            { text, voice } -> { url | jobId+chunks } | { error }
//   GET  /dsh-breeze-tts-audio/<id>                              -> audio bytes
//   GET  /dsh-breeze-tts-api/rvc-next?job=<id>                   -> { url, more } | { done }
//   GET  /dsh-breeze-tts-api/rvc-files?baseUrl=&kind=            -> { files }
//   POST /dsh-breeze-tts-api/rvc-compact-index                   -> compact .index
//   GET  /dsh-breeze-tts-api/rvc-packs?registry=<url>            -> { packs } (voice-pack manifest)
//   GET  /dsh-breeze-tts-api/rvc-packs-installed                 -> { installed }
//   POST /dsh-breeze-tts-api/rvc-pack-install {registry, packId} -> download+sha256-verify+install
// Synthesis runs a zero-dependency Edge TTS worker via `node -e`
// (Sec-MS-GEC query-param protocol, mirroring node-edge-tts@1.2.10).
import { installLegacyWhenStandalone } from './coexistence.mjs';
import { registerLocalRuntime } from './local-runtime/service.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';

// 插件身份名。★ 必须与 package.json 的 name 一致（2026-10-29 发布包整理时发现此处仍叫
// 'local-ai-tts'，是合并改名时的漏项）。cordis 只用它作诊断标签（runtime.name /
// reflect.notify），不是路由键也不是配置键 ⇒ 改它不改行为，但会让排障日志指向错的插件。
export const name = 'dsh-breeze-tts';
export const inject = ['webServer'];

const WORKER_SRC = `// edge-tts-worker — zero-dependency Edge TTS synthesis (Node >= 22).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const CRLF = String.fromCharCode(13, 10);
function generateSecMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  const hash = crypto.createHash('sha256');
  hash.update(String(roundedTicks) + TRUSTED_CLIENT_TOKEN, 'ascii');
  return hash.digest('hex').toUpperCase();
}
function readStdin() {
  return new Promise(function (resolve, reject) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { data += c; });
    process.stdin.on('end', function () { resolve(data); });
    process.stdin.on('error', reject);
  });
}
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fail(msg) {
  console.error('ERR ' + msg);
  process.exit(1);
}
function synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume) {
  return new Promise(function (resolve, reject) {
    const secMsGec = generateSecMsGecToken();
    const url = WSS_BASE + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=1-' + CHROMIUM_FULL_VERSION;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) {
        try { ws.close(); } catch (e) {}
        reject('audio too small: ' + buf.length);
        return;
      }
      try {
        fs.writeFileSync(outPath, buf);
        try { ws.close(); } catch (e) {}
        resolve(buf.length);
      } catch (e) {
        reject('write ' + e.message);
      }
    }
    ws.onerror = function (e) {
      reject('websocket error: ' + (e && e.message ? e.message : String(e)));
    };
    ws.onclose = function (e) {
      if (!settled) reject('closed early code=' + e.code + ' reason=' + e.reason);
    };
    ws.onmessage = function (event) {
      if (settled) return;
      if (typeof event.data === 'string') {
        if (event.data.indexOf('Path:turn.end') >= 0) { finish(); return; }
        return;
      }
      const raw = Buffer.from(event.data);
      const marker = Buffer.from('Path:audio' + CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length);
        if (body.length > 0) chunks.push(body);
      } else if (raw.length > 0) {
        chunks.push(raw);
      }
    };
    ws.onopen = function () {
      const requestId = crypto.randomBytes(16).toString('hex');
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
      const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' + lang + '">' + '<voice name="' + xmlEscape(voice) + '">' + '<prosody rate="' + xmlEscape(rate) + '" pitch="' + xmlEscape(pitch) + '" volume="' + xmlEscape(volume) + '">' + xmlEscape(text) + '</prosody></voice></speak>';
      ws.send('Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF + JSON.stringify(speechConfig));
      ws.send('X-RequestId:' + requestId + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
    };
    setTimeout(function () {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (e) {}
        reject('timeout');
      }
    }, 60000);
  });
}
function findVoiceArgs() {
  const args = process.argv;
  const out = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-e') continue;
    if (a.indexOf('.cjs') >= 0 || a.indexOf('.mjs') >= 0 || a.indexOf('edge-tts-worker') >= 0) continue;
    out.push(a);
  }
  return out;
}
async function main() {
  const args = findVoiceArgs();
  const voice = args[0] || 'zh-CN-XiaoxuanNeural';
  const rate = args[1] || 'default';
  const pitch = args[2] || 'default';
  const volume = args[3] || 'default';
  const text = (await readStdin()).trim();
  if (!text) return fail('empty text');
  const vparts = String(voice).split('-');
  const lang = (vparts.length >= 2 ? vparts[0] + '-' + vparts[1] : 'zh-CN');
  const outPath = path.join(os.tmpdir(), 'dsh-local-ai-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.mp3');
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const size = await synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume);
      console.log('OK ' + outPath);
      console.log('SIZE ' + size);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (msg.indexOf('1006') < 0) break;
    }
  }
  return fail(String(lastErr));
}
main().catch(function (e) {
  console.error('ERR fatal: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});`;

/** Synthesize one text/voice pair; resolves with the absolute MP3 path. */
function synthesize(text, voice, prosody) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `dsh-local-ai-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
    const p = prosody || {};
    const argv = ['-e', WORKER_SRC, '--', voice,
      String(p.rate || 'default'),
      String(p.pitch || 'default'),
      String(p.volume || 'default')];
    const child = spawn(process.execPath, argv, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
    }, 65000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('TTS spawn failed: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('TTS worker exited ' + code + ': ' + (stderr.trim() || stdout.trim() || 'no output')));
        return;
      }
      const m = stdout.match(/^OK (.+)$/m);
      if (!m) {
        reject(new Error('TTS worker output unexpected: ' + stdout));
        return;
      }
      resolve(m[1]);
    });
    child.stdin.end(text);
  });
}

function writeJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// --- host-side i18n (focused, backward-compatible) ---
// The host runs in Node and doesn't know the UI language. Instead of baking a
// language in, errors/progress carry a stable `i18n: { code, params }` tag
// alongside the (zh) fallback text. The client renders `code` through its t()
// dictionary (zh/en); callers that don't understand the tag fall back to the
// plain message.
function hostErr(msg, code, params) {
  const e = new Error(msg);
  e.i18n = { code, params: params || {} };
  return e;
}
// write a localized error response: body keeps `error` (zh fallback) and adds
// optional `i18n` metadata for the client.
function writeErr(res, code, msg, i18n) {
  const value = { error: msg };
  if (i18n) value.i18n = i18n;
  writeJson(res, code, value);
}
// serialize a thrown route error (possibly a localized hostErr) to the client,
// carrying optional `i18n: { code, params }` metadata if present.
function writeRouteError(res, err) {
  const msg = String((err && err.message) || err);
  const value = { error: msg };
  if (err && err.i18n) value.i18n = err.i18n;
  writeJson(res, 500, value);
}

// Return a short, user-owned-path-aware "how to start the local RVC service"
// hint. We intentionally avoid hardcoding any machine-specific folder name:
// every user replaces <你的...> with their own path. Both Windows and
// macOS/Linux are shown so it is clear the feature is cross-platform.
function rvcStartupHint() {
  return [
    '便携运行时（免装 RVC WebUI）：',
    '  Windows：解压后双击「启动服务.bat」',
    '  macOS/Linux：解压后在终端运行 <你解压的目录>/start-rvc-server.sh',
    '已有 RVC WebUI：',
    '  Windows（PowerShell）：',
    '    <你的RVC目录>\\runtime\\python.exe <你的RVC目录>\\rvc-server.py --port 4892',
    '  macOS/Linux（终端）：',
    '    <你的RVC目录>/runtime/bin/python <你的RVC目录>/rvc-server.py --port 4892',
    '详细步骤见《RVC 指南》→「启动本地 RVC 服务」。'
  ].join('\n');
}

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// RVC provider: Edge TTS base audio -> local RVC inference server -> voice.
// The RVC server (rvc-server.py) exposes:
//   GET /health   POST /load {model,index}   POST /convert {audio_base64, params}
// ---------------------------------------------------------------------------

const RVC_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:4892',
  model: '',
  index: '',
  baseSource: 'edge',          // 'edge' | 'upload'
  baseAudioName: '',           // uploaded base audio filename (upload mode)
  baseAudioFile: '',          // uploaded base audio filename in base-audio/（A-3 甲方案：config 只存文件名，音频落盘）
  baseVoice: 'zh-CN-YunyangNeural',
  baseRate: 'default',
  basePitch: 'default',
  baseVolume: 'default',
  spkId: 0,
  f0File: '',
  f0Method: 'rmvpe',
  indexRate: 0.75,
  f0UpKey: 0,
  resampleSr: 40000,
  rmsMixRate: 0.25,
  protect: 0.33,
  filterRadius: 3
};

// A-3 甲方案（方案 §三-A3 + 阿枢对码 §三）：基准音频落盘后的文件名 → 绝对路径。
// 只接受 base-<12位hex>.wav 形态（内容 sha256 前 12 位，由 POST /base-audio 生成），
// 白名单正则从根上杜绝路径穿越（../../ 之类直接拒）。★ hash 形态必须与该路由一致：
// 若误用 hashText（base36 不定长 8-10 位）生成文件名，这里的 [0-9a-f]{12} 会把
// 所有文件名全拒 ⇒ 基准音频永远静默回退 Edge——正是今晚反复出现的静默失效模式。
function resolveBaseAudioPath(fileName) {
  if (!fileName || !/^base-[0-9a-f]{12}\.wav$/.test(String(fileName))) return '';
  return path.join(BREEZE_CFG_DIR, 'base-audio', String(fileName));
}

let rvcLoadedKey = '';   // model|index fingerprint of the server-side loaded voice

function rvcConfig(custom) {
  const c = custom || {};
  return {
    baseUrl: String(c.baseUrl || RVC_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: String(c.model || '').trim(),
    index: String(c.index || '').trim(),
    baseSource: String(c.baseSource || RVC_DEFAULTS.baseSource),
    baseAudioName: String(c.baseAudioName || '').trim(),
    baseAudioFile: String(c.baseAudioFile || '').trim(),
    baseVoice: String(c.baseVoice || RVC_DEFAULTS.baseVoice),
    baseRate: String(c.baseRate || RVC_DEFAULTS.baseRate),
    basePitch: String(c.basePitch || RVC_DEFAULTS.basePitch),
    baseVolume: String(c.baseVolume || RVC_DEFAULTS.baseVolume),
    spkId: Number(c.spkId ?? RVC_DEFAULTS.spkId),
    f0File: String(c.f0File || '').trim(),
    f0Method: String(c.f0Method || RVC_DEFAULTS.f0Method),
    indexRate: Number(c.indexRate ?? RVC_DEFAULTS.indexRate),
    f0UpKey: Number(c.f0UpKey ?? RVC_DEFAULTS.f0UpKey),
    resampleSr: Number(c.resampleSr ?? RVC_DEFAULTS.resampleSr),
    rmsMixRate: Number(c.rmsMixRate ?? RVC_DEFAULTS.rmsMixRate),
    protect: Number(c.protect ?? RVC_DEFAULTS.protect),
    filterRadius: Number(c.filterRadius ?? RVC_DEFAULTS.filterRadius)
  };
}

function rvcFingerprint(cfg) {
  return [
    // A-3 甲方案（阿枢对码 §3.3）：指纹输入从 base64（几 MB）改为文件名（几十字节）。
    // 指纹不再直接反映音频内容——但文件名本身就是内容 sha256 前 12 位，间接等价；
    // 换样本 ⇒ 新文件名 ⇒ 指纹变 ⇒ 旧缓存自然 miss 重新合成（一次性成本，非故障）。
    cfg.model, cfg.index, cfg.baseSource, cfg.baseAudioName, hashText(cfg.baseAudioFile),
    cfg.baseVoice, cfg.baseRate, cfg.basePitch, cfg.baseVolume,
    cfg.spkId, cfg.f0File, cfg.f0Method, cfg.indexRate, cfg.f0UpKey,
    cfg.resampleSr, cfg.rmsMixRate, cfg.protect, cfg.filterRadius
  ].join('|');
}

async function rvcJson(baseUrl, route, payload, timeoutMs) {
  let res;
  try {
    res = await fetch(baseUrl + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw hostErr(`无法连接本地 RVC 推理服务（${baseUrl}）：${String((e && e.message) || e)}`, "host.rvcUnreachable", { baseUrl });
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json body */ }
  if (!res.ok) {
    throw hostErr(`RVC ${route} 失败（HTTP ${res.status}）：${(data && data.message) || res.statusText}`, "host.rvcHttpFail", { route, status: res.status });
  }
  return data;
}

async function ensureRvcLoaded(cfg) {
  const key = cfg.model + '|' + cfg.index;
  if (key === rvcLoadedKey) return;
  await rvcJson(cfg.baseUrl, '/load', { model: cfg.model, index: cfg.index }, 180000);
  rvcLoadedKey = key;
}

async function rvcConvertBytes(cfg, audioBytes) {
  const data = await rvcJson(cfg.baseUrl, '/convert', {
    audio_base64: audioBytes.toString('base64'),
    params: {
      spk_id: cfg.spkId,
      f0_file: cfg.f0File || null,
      f0_method: cfg.f0Method,
      index_rate: cfg.indexRate,
      f0_up_key: cfg.f0UpKey,
      resample_sr: cfg.resampleSr,
      rms_mix_rate: cfg.rmsMixRate,
      protect: cfg.protect,
      filter_radius: cfg.filterRadius
    }
  }, 180000);
  if (!data || !data.audio_base64) throw hostErr('RVC /convert 返回异常', 'host.rvcConvertNoAudio');
  return Buffer.from(data.audio_base64, 'base64');
}

/** RVC chain: base audio (Edge TTS or user upload) -> local RVC conversion -> wav file path. */
async function synthesizeRvc(text, voice, custom) {
  const cfg = rvcConfig(custom);
  if (!cfg.model) throw hostErr('未配置 RVC 模型路径（设置 → 插件 → 语音 → RVC 配置）', 'host.noModelConfigured');
  let audioBytes;
  if (cfg.baseSource === 'upload' && cfg.baseAudioFile) {
    // A-3 甲方案：基准音频已落盘 base-audio/，config 只存文件名——按名读盘。
    const baseAudioPath = resolveBaseAudioPath(cfg.baseAudioFile);
    if (baseAudioPath && existsSync(baseAudioPath)) audioBytes = readFileSync(baseAudioPath);
    if (!audioBytes) {
      // 补-3（阿枢对码 §3.3）：静默回退显性化——用户以为用了自己的样本，其实没有。
      console.warn('[breeze-tts] baseAudioFile 指定了但文件不存在，已回退 Edge baseVoice：', cfg.baseAudioFile);
    }
  }
  if (!audioBytes) {
    const baseVoice = cfg.baseVoice || voice;
    const mp3Path = await synthesize(text, baseVoice, {
      rate: cfg.baseRate,
      pitch: cfg.basePitch,
      volume: cfg.baseVolume
    });
    audioBytes = readFileSync(mp3Path);
  }
  await ensureRvcLoaded(cfg);
  let wavBytes;
  try {
    wavBytes = await rvcConvertBytes(cfg, audioBytes);
  } catch (e) {
    // one retry with a fresh /load (the server may have unloaded the model)
    rvcLoadedKey = '';
    await ensureRvcLoaded(cfg);
    wavBytes = await rvcConvertBytes(cfg, audioBytes);
  }
  const wavPath = path.join(os.tmpdir(), `dsh-local-ai-tts-rvc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  writeFileSync(wavPath, wavBytes);
  return wavPath;
}

// ---------------------------------------------------------------------------
// TTS provider abstraction (M1, foundation).
// Each provider implements synthesizeShort(text, voice, prosody, custom) -> absPath
// (a single audio file). The /speak handler dispatches the "short, single-URL"
// path through the registry. Long RVC reads keep their dedicated chunked job path
// (provider-'rvc'); future providers (e.g. a local Piper backend) just register.
// ---------------------------------------------------------------------------
const providers = Object.create(null);
function registerProvider(name, impl) {
  providers[name] = impl;
}
registerProvider('edge-tts', {
  synthesizeShort(text, voice, prosody, custom) {
    return synthesize(text, voice, prosody || undefined);
  }
});
registerProvider('rvc', {
  synthesizeShort(text, voice, prosody, custom) {
    return synthesizeRvc(text, voice, custom);
  }
});
// Local Piper backend (M1+, optional). Needs a Piper binary + a .onnx model to be
// configured by the user; the /speak "short" path dispatches here through the same
// provider abstraction. Without a configured binary/model it fails with a clear,
// localized "not configured" error instead of crashing.
function piperConfig(custom) {
  const c = custom || {};
  return {
    binary: String(c.piperBinary || '').trim(),
    model: String(c.piperModel || '').trim(),
    voice: String(c.piperVoice || 'en_US-lessac-medium')
  };
}
async function synthesizePiper(text, voice, prosody, custom) {
  const cfg = piperConfig(custom);
  if (!cfg.binary || !cfg.model) {
    throw hostErr(
      '未配置本地 Piper（音色提供者 local-piper）：请在设置中填写 Piper 可执行文件与 .onnx 模型路径',
      'host.piperUnconfigured'
    );
  }
  const wavPath = path.join(os.tmpdir(), `dsh-local-ai-tts-piper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  await new Promise((resolve, reject) => {
    const p = spawn(cfg.binary, ['--model', cfg.model, '--output_file', wavPath], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.stdin.on('error', () => {});
    p.on('error', err => reject(hostErr(`Piper 启动失败：${err.message}`, 'host.piperSpawnFail')));
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(hostErr(`Piper 转换失败（exit ${code}）：${stderr.slice(0, 300) || '未知错误'}`, 'host.piperFail'));
    });
    try { p.stdin.end(String(text || '')); } catch (e) { reject(hostErr('Piper stdin 失败', 'host.piperFail')); }
  });
  return wavPath;
}
registerProvider('local-piper', {
  synthesizeShort(text, voice, prosody, custom) {
    return synthesizePiper(text, voice, prosody, custom);
  }
});
function getProvider(name) {
  if (!providers[name]) throw new Error('Unsupported provider; Local Runtime uses its dedicated sentence queue.');
  return providers[name];
}

// ---------------------------------------------------------------------------
// Adaptive chunked progressive playback.
// Long RVC reads are split into sentence-sized blocks and converted one by one
// into a queue. A one-shot probe calibrates chunk size + prewarm count from the
// local machine's convert/play speed ratio (convert_time / audio_seconds).
// ---------------------------------------------------------------------------

const PROBE_TEXT = '你好，这是语音合成性能检测。';

/** Heuristic speech duration in seconds (zh ~3.6 chars/s, latin ~12 chars/s). */
function estimateSpeechSeconds(text) {
  let cjk = 0, latin = 0, other = 0;
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) latin++;
    else other++;
  }
  return cjk / 3.6 + latin / 12 + other / 4;
}

function isLatinHeavy(text) {
  let latin = 0, cjk = 0;
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  return latin > 0 && latin > cjk * 2;
}

/**
 * Atomic tokens that must never be split: URLs, emails and decimals/versions.
 * They contain '.' which the sentence splitter would otherwise treat as a
 * sentence end (splitting "3.14" into "3"/"14"), and hard cuts could break
 * them mid-token. Each atom is swapped for a placeholder without sentence
 * punctuation before splitting, then restored on the final parts.
 */
const ATOM_RE = /https?:\/\/[^\s，。！？；,!?;]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d+(?:\.\d+)+/g;

/** Split text into chunks of <= maxChars, preferring sentence/segment boundaries. */
function splitText(text, maxChars) {
  const atoms = [];
  const guarded = String(text).replace(ATOM_RE, (tok) => {
    atoms.push(tok);
    return '\u0001' + (atoms.length - 1) + '\u0002';
  });
  const parts = [];
  const sentences = [];
  let m;
  const sre = /[^。！？；.!?;]+[。！？；.!?;]?/g;
  while ((m = sre.exec(guarded)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
  }
  if (!sentences.length) sentences.push(guarded.trim());
  const segRe = /[^，、,]+[，、,]?/g;
  let cur = '';
  const flush = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  const CUT_MIN = Math.max(4, Math.floor(maxChars * 0.5));
  // Boundary-aware hard cut: prefer the last whitespace / CJK punctuation in
  // the window, and never split an atomic placeholder (its tail \u0002 is a
  // good boundary; if we're inside one, cut before its \u0001 head).
  function safeEnd(seg, from) {
    const end = Math.min(seg.length, from + maxChars);
    for (let p = end; p > from + CUT_MIN; p--) {
      const ch = seg[p - 1];
      if (/\s/.test(ch) || '，、。！？；,!?;'.includes(ch) || ch === '\u0002') return p;
    }
    for (let p = end - 1; p > from; p--) {
      if (seg[p] === '\u0002') return p + 1;
      if (seg[p] === '\u0001') return p;
    }
    return end;
  }
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxChars) flush();
    if (s.length > maxChars) {
      const segs = [];
      while ((m = segRe.exec(s)) !== null) {
        const g = m[0].trim();
        if (g) segs.push(g);
      }
      for (const seg of segs) {
        if (cur && cur.length + seg.length > maxChars) flush();
        if (seg.length > maxChars) {
          for (let i = 0; i < seg.length; ) {
            flush();
            const end = safeEnd(seg, i);
            if (end <= i) break; // defensive: never loop forever on zero progress
            cur = seg.slice(i, end);
            flush();
            i = end;
          }
        } else {
          cur += seg;
        }
      }
    } else {
      cur += s;
    }
  }
  flush();
  const restored = parts.map((p) =>
    p.replace(/\u0001(\d+)\u0002/g, (_, idx) => atoms[Number(idx)] ?? ''),
  );
  // Orphan-tail fix: a tiny trailing chunk ("好。"/"OK.") reads like a stutter
  // on top of the previous chunk; merge it back when it fits.
  if (restored.length >= 2) {
    const last = restored[restored.length - 1];
    const prev = restored[restored.length - 2];
    if (last.length < 8 && prev.length + last.length <= maxChars) {
      const gap =
        /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(last) ? ' ' : '';
      restored[restored.length - 2] = prev + gap + last;
      restored.pop();
    }
  }
  return restored.filter((p) => p.length > 0);
}

function chunkTier(ratio) {
  if (ratio <= 0.4) return { chunkSec: 20, prewarm: 2 };
  if (ratio <= 0.6) return { chunkSec: 15, prewarm: 2 };
  if (ratio <= 0.9) return { chunkSec: 10, prewarm: 3 };
  return { chunkSec: 6, prewarm: 4 };
}

const FALLBACK_CAL = { ratio: null, chunkSec: 10, prewarm: 3, probeFailed: true, at: 0 };
const calibCache = new Map(); // rvcFingerprint -> { ratio, chunkSec, prewarm, at }
const CAL_TTL_MS = 10 * 60 * 1000;

// --- calibration persistence (~/.dsh/tts-rvc/calibration.json) -------------
// Probe results survive across dsh restarts, so the one-shot ~7s probe is paid
// only once per config+device (7-day validity; re-probes when the GPU changes).
const CAL_DIR = path.join(os.homedir(), '.dsh', 'local-ai-tts-rvc');
const CAL_FILE = path.join(CAL_DIR, 'calibration.json');
const CAL_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let calFileData = null;   // parsed file, lazily loaded
const deviceByUrl = new Map(); // baseUrl -> { gpu, at } (5-min session cache)

function loadCalFile() {
  if (calFileData !== null) return calFileData;
  try {
    if (existsSync(CAL_FILE)) calFileData = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
    else calFileData = { version: 1, entries: {} };
  } catch (e) {
    calFileData = { version: 1, entries: {} };
  }
  if (!calFileData.entries || typeof calFileData.entries !== 'object') calFileData.entries = {};
  return calFileData;
}

function saveCalFile() {
  try {
    mkdirSync(CAL_DIR, { recursive: true });
    writeFileSync(CAL_FILE, JSON.stringify(calFileData, null, 2));
  } catch (e) { /* best-effort persistence */ }
}

/** GPU name from the RVC server /health, cached 5 min per baseUrl (null = unknown). */
async function getRvcDevice(cfg) {
  const now = Date.now();
  const hit = deviceByUrl.get(cfg.baseUrl);
  if (hit && now - hit.at < 5 * 60 * 1000) return hit.gpu;
  let gpu = null;
  try {
    const r = await fetch(cfg.baseUrl + '/health', { signal: AbortSignal.timeout(8000) });
    const d = await r.json().catch(() => null);
    gpu = (d && typeof d.gpu_name === 'string' && d.gpu_name) || null;
  } catch (e) { /* offline/old server -> unknown device */ }
  deviceByUrl.set(cfg.baseUrl, { gpu, at: now });
  return gpu;
}

/**
 * Calibrate the local convert speed for a config: in-memory hit first, then the
 * persisted calibration file (skips the probe across restarts), then a live
 * probe. Probe results are persisted with the current GPU name so a device
 * change triggers a re-probe instead of reusing stale numbers.
 */
async function getCalibration(cfg) {
  const key = rvcFingerprint(cfg);
  const now = Date.now();
  const hit = calibCache.get(key);
  if (hit && (hit.probeFailed ? now - hit.at < 120000 : now - hit.at < CAL_TTL_MS)) return hit;

  // persisted entry -> adopt without probing (unless the device changed)
  const file = loadCalFile();
  const fileHit = file.entries[key];
  if (fileHit && !fileHit.probeFailed && now - fileHit.at < CAL_FILE_TTL_MS) {
    const dev = await getRvcDevice(cfg);
    if (!dev || !fileHit.device || fileHit.device === dev) {
      const cal = {
        ratio: fileHit.ratio, chunkSec: fileHit.chunkSec, prewarm: fileHit.prewarm,
        probeFailed: false, at: fileHit.at, fromDisk: true
      };
      calibCache.set(key, cal);
      return cal;
    }
  }

  // live probe
  const t0 = now;
  let ratio = null;
  try {
    const mp3Path = await synthesize(PROBE_TEXT, cfg.baseVoice || RVC_DEFAULTS.baseVoice, {
      rate: cfg.baseRate, pitch: cfg.basePitch, volume: cfg.baseVolume
    });
    const audioBytes = readFileSync(mp3Path);
    const estSec = estimateSpeechSeconds(PROBE_TEXT) || 1;
    await ensureRvcLoaded(cfg);
    await rvcConvertBytes(cfg, audioBytes);
    ratio = (Date.now() - t0) / 1000 / estSec;
  } catch (e) {
    ratio = null; // probe failure -> conservative defaults
  }
  const cal = ratio === null
    ? { ...FALLBACK_CAL, at: Date.now() }
    : { ratio, ...chunkTier(ratio), probeFailed: false, at: Date.now() };
  if (ratio !== null) {
    // persist only successful probes; keep any older good entry on failure
    cal.device = (await getRvcDevice(cfg)) || undefined;
    file.entries[key] = {
      ratio: cal.ratio, chunkSec: cal.chunkSec, prewarm: cal.prewarm,
      at: cal.at, device: cal.device || null
    };
    const keys = Object.keys(file.entries);
    if (keys.length > 100) {
      keys.sort((a, b) => (file.entries[a].at || 0) - (file.entries[b].at || 0));
      for (const k of keys.slice(0, keys.length - 100)) delete file.entries[k];
    }
    saveCalFile();
  }
  calibCache.set(key, cal);
  if (calibCache.size > 40) {
    const first = calibCache.keys().next().value;
    if (first !== undefined) calibCache.delete(first);
  }
  return cal;
}

// ---------------------------------------------------------------------------
// Voice packs: registry manifest + download + sha256-verified install.
// Packs install into ~/.dsh/tts-rvc/packs/<packId>/ (<packId>.pth + <packId>.index).
// ---------------------------------------------------------------------------

const PACK_FILE = 'installed.json';

function packsDir() {
  return process.env.DSH_LOCAL_AI_TTS_PACKS_DIR || path.join(os.homedir(), '.dsh', 'local-ai-tts-rvc', 'packs');
}

function installedPacks() {
  let data = {};
  try {
    data = JSON.parse(readFileSync(path.join(packsDir(), PACK_FILE), 'utf8'));
  } catch (e) {
    return {};
  }
  // reconcile: drop entries whose model file no longer exists (user deleted it)
  let changed = false;
  for (const [id, e] of Object.entries(data)) {
    if (!e || !e.modelPath || !existsSync(e.modelPath)) {
      delete data[id];
      changed = true;
    }
  }
  if (changed) saveInstalledPacks(data);
  return data;
}

function saveInstalledPacks(data) {
  try {
    mkdirSync(packsDir(), { recursive: true });
    writeFileSync(path.join(packsDir(), PACK_FILE), JSON.stringify(data, null, 2));
  } catch (e) { /* best-effort */ }
}

async function fetchManifest(registry, proxy) {
  const url = String(registry || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw hostErr('仓库地址必须是 http(s) URL', 'host.registryNotUrl', { url });
  const manifestUrl = url + '/manifest.json';
  const raw = await withRetry(
    () => proxy ? downloadViaProxy(manifestUrl, proxy, { timeoutMs: 60000 }) : fetchBytes(manifestUrl, 60000),
    '清单',
  );
  let data = null;
  try { data = JSON.parse(raw.toString('utf8')); } catch (e) { /* fall through */ }
  if (!data) throw hostErr('清单格式无效', 'host.manifestInvalid');
  if (!Array.isArray(data.packs)) throw hostErr('清单格式无效（缺少 packs 数组）', 'host.manifestNoPacks');
  return { url, data };
}

/** Minimal HTTP(S) download through an HTTP proxy (CONNECT tunnel), no deps. */
function downloadViaProxy(targetUrl, proxyUrl, opts = {}) {
  const { timeoutMs = 900000, onChunk = null } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const p = new URL(proxyUrl);
    const isHttps = u.protocol === 'https:';
    const port = u.port || (isHttps ? 443 : 80);
    const connectPath = u.hostname + ':' + port;
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const creq = httpRequest({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: connectPath,
      headers: { Host: connectPath, 'Proxy-Connection': 'Keep-Alive' }
    });
    const timer = setTimeout(() => { try { creq.destroy(); } catch (e) {} fail(new Error('代理连接超时')); }, 30000);
    creq.on('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) { try { socket.destroy(); } catch (e) {} fail(new Error('代理 CONNECT ' + res.statusCode)); return; }
      const wire = isHttps ? tls.connect({ socket, servername: u.hostname }) : socket;
      wire.on('error', fail);
      const req = (isHttps ? httpsRequest : httpRequest)({
        createConnection: () => wire,
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Host: u.host, Connection: 'close' }
      }, (r) => {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          r.resume();
          fail(new Error('HTTP ' + r.statusCode));
          return;
        }
        const chunks = [];
        const total = Number(r.headers['content-length']) || 0;
        let done = 0;
        r.on('data', (c) => {
          chunks.push(c);
          done += c.length;
          if (onChunk) onChunk(c, done, total);
        });
        r.on('end', () => { settled = true; resolve(Buffer.concat(chunks)); });
        r.on('error', fail);
      });
      req.on('error', fail);
      req.end();
    });
    creq.on('error', (e) => { clearTimeout(timer); fail(e); });
    creq.end();
  });
}

/** Simple fetch-body helper with AbortSignal timeout (direct connection). */
async function fetchBytes(url, timeoutMs) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Retry a network call a few times (slow/flaky connections self-heal). */
async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw hostErr(`${label} 下载失败：${String((lastErr && lastErr.message) || lastErr)}`, "host.downloadFailed", { label });
}

/** Resolve a possibly-relative manifest URL against the registry base. */
function resolvePackUrl(base, u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : base + '/' + s.replace(/^\/+/, '');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- pack-install progress (client polls GET /rvc-pack-progress?key=) -------
const packProgress = new Map(); // key -> { phase, done, total, startedAt, finished? }

function setPackProgress(key, patch) {
  if (!key) return;
  const p = packProgress.get(key) || { phase: '准备', phaseKey: 'prepare', done: 0, total: 0, startedAt: Date.now() };
  Object.assign(p, patch);
  packProgress.set(key, p);
}

/** Mark the install finished (entry stays a while so the client sees 100%). */
function finishPackProgress(key) {
  if (!key) return;
  const p = packProgress.get(key);
  if (p) p.finished = true;
}

/** Stream-download with incremental sha256 + progress; returns the full bytes. */
async function downloadStream(url, expectedSha256, expectedSize, label, onProgress, proxy) {
  return withRetry(async () => {
    const hash = createHash('sha256');
    let bytes;
    if (proxy) {
      bytes = await downloadViaProxy(url, proxy, {
        timeoutMs: 1200000,
        onChunk: (c, done, total) => {
          hash.update(c);
          if (onProgress) onProgress(done, total || done);
        },
      });
    } else {
      const r = await fetch(url, { signal: AbortSignal.timeout(1200000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const total = Number(r.headers.get('content-length')) || 0;
      if (!r.body) throw hostErr('下载流不可用', 'host.downloadStreamUnavailable');
      const reader = r.body.getReader();
      const chunks = [];
      let done = 0;
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        chunks.push(Buffer.from(value));
        hash.update(value);
        done += value.length;
        if (onProgress) onProgress(done, total || done);
      }
      bytes = Buffer.concat(chunks);
    }
    if (expectedSize && bytes.length !== expectedSize) {
      throw hostErr(`大小不符（期望 ${expectedSize}，实际 ${bytes.length}）`, "host.sizeMismatch", { expected: expectedSize, actual: bytes.length });
    }
    if (expectedSha256) {
      const actual = hash.digest('hex');
      if (actual !== String(expectedSha256).toLowerCase()) {
        throw hostErr(`sha256 校验失败（期望 ${expectedSha256}，实际 ${actual}）`, "host.sha256Mismatch");
      }
    }
    return bytes;
  }, label);
}

async function installPack(registry, packId, indexId, progressKey, proxy) {
  const { url: base, data } = await fetchManifest(registry);
  const pack = data.packs.find((p) => p && p.id === packId);
  if (!pack) throw hostErr(`仓库中没有音色包 ${packId}`, "host.packNotFound", { packId });
  const stem = String(packId).replace(/[^\w.-]/g, '_');
  const dir = path.join(packsDir(), stem);
  const model = pack.model;
  if (!model || !model.url) throw hostErr('音色包缺少模型文件', 'host.packNoModel');
  // index variants: `indexes` array (preferred) or legacy single `index`
  let indexes = Array.isArray(pack.indexes) && pack.indexes.length
    ? pack.indexes.slice()
    : (pack.index ? [{ id: 'default', name: '默认索引', ...pack.index }] : []);
  const chosen = indexes.find((i) => i.id === indexId) || indexes[0] || null;
  const modelUrl = resolvePackUrl(base, model.url);
  const indexUrl = chosen ? resolvePackUrl(base, chosen.url) : '';
  const installed = installedPacks();
  const current = installed[packId] || {};
  // installed files keep the pack id in their name so the browse picker can
  // tell voices apart (e.g. guanguanV1.pth / guanguanV1.index)
  const modelPath = path.join(dir, stem + '.pth');
  const indexPath = indexUrl ? path.join(dir, stem + '.index') : '';
  const variants = indexes.map((i) => ({ id: i.id, name: i.name || i.id, size: i.size || 0 }));
  const modelUpToDate = current.version === pack.version && current.modelSha256 === model.sha256 && existsSync(modelPath);
  const indexUpToDate = !indexUrl || (indexPath && existsSync(indexPath) && current.indexSha256 === chosen.sha256);
  if (modelUpToDate && indexUpToDate) {
    return { ok: true, skipped: true, name: pack.name, modelPath, indexPath, indexId: chosen ? chosen.id : '', variants };
  }
  mkdirSync(dir, { recursive: true });
  const totalBytes = (model.size || 0) + (chosen && indexUrl ? chosen.size || 0 : 0);
  let downloaded = 0;
  try {
    if (!modelUpToDate) {
      setPackProgress(progressKey, { phase: '模型', phaseKey: 'model', done: 0, total: totalBytes });
      const modelBytes = await downloadStream(modelUrl, model.sha256, model.size, '模型', (d) => {
        downloaded = d;
        setPackProgress(progressKey, { phase: '模型', phaseKey: 'model', done: downloaded });
      }, proxy);
      writeFileSync(modelPath, modelBytes);
      downloaded = model.size || downloaded;
    }
    if (indexUrl && !indexUpToDate) {
      setPackProgress(progressKey, { phase: '索引', phaseKey: 'index', done: downloaded });
      const indexBytes = await downloadStream(indexUrl, chosen.sha256, chosen.size, '索引', (d) => {
        setPackProgress(progressKey, { phase: '索引', phaseKey: 'index', done: downloaded + d });
      }, proxy);
      writeFileSync(indexPath, indexBytes);
    }
  } catch (e) {
    finishPackProgress(progressKey);
    // remove partial install so a retry starts clean
    try {
      rmSync(modelPath, { force: true });
      rmSync(indexPath, { force: true });
    } catch (e2) { /* best-effort cleanup */ }
    throw e;
  }
  finishPackProgress(progressKey);
  installed[packId] = {
    id: packId,
    name: pack.name || packId,
    version: pack.version || '1.0.0',
    license: pack.license || 'unknown',
    modelPath,
    indexPath,
    modelSha256: model.sha256 || '',
    indexSha256: chosen && chosen.sha256 ? String(chosen.sha256).toLowerCase() : '',
    indexId: chosen ? chosen.id : '',
    installedAt: Date.now()
  };
  saveInstalledPacks(installed);
  const size = (model.size || 0) + (chosen ? chosen.size || 0 : 0);
  return {
    ok: true, skipped: false, name: pack.name, modelPath, indexPath,
    indexId: chosen ? chosen.id : '', variants, size
  };
}

// ---------------------------------------------------------------------------
// Agent-event voice alerts (approval reminders).
// Approval requests/decisions are session events on the `session/event`
// firehose ('approval/asked' / 'approval/decided' in SessionEventMap —
// dsh-user-approval). The plugin Host subscribes via the sandbox-exposed
// `ctx.on`, buffers a small queue, and the client polls it incrementally
// (GET /dsh-breeze-tts-api/notify?s=N) to read the alert aloud. Dedup by (type, id)
// so a request is never announced twice, while its paired decision still is.
// ---------------------------------------------------------------------------
const notifyState = {
  queue: [],       // [{ seq, kind: 'approval'|'approval-decided', id, toolName, reason, outcome }]
  seen: new Set(), // per-(type,id) keys already ingested (dedup)
  seq: 0,
  cap: 20,
  seenCap: 200
};

function truncateForSpeech(s, max) {
  const t = String(s == null ? '' : s).trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Ingest one session event into the notification queue (pure, testable). */
function ingestSessionEvent(event) {
  if (!event || typeof event !== 'object') return;
  const type = String(event.type || '');
  if (type !== 'approval/asked' && type !== 'approval/decided') return;
  // Real SessionEvent shape: { type, seq, time, data: {...} } — the payload
  // (id/toolName/reason/outcome) lives under `data`; fall back to the top
  // level so flat test fixtures keep working.
  const d = event.data && typeof event.data === 'object' ? event.data : event;
  const id = String(d.id || '');
  // An approval request and its decision are PAIRED by the same id, so dedup
  // per (type, id), not per id — both deserve an announcement.
  const seenKey = type + ':' + id;
  if (!id || notifyState.seen.has(seenKey)) return;
  notifyState.seen.add(seenKey);
  if (type === 'approval/asked') {
    notifyState.queue.push({
      seq: ++notifyState.seq,
      kind: 'approval',
      id,
      toolName: truncateForSpeech(d.toolName, 40),
      reason: truncateForSpeech(d.reason, 80)
    });
  } else {
    // dsh-user-approval outcome vocabulary: allowed-once | rejected |
    // cancelled | unavailable — collapsed to granted/rejected/settled for the
    // localized client announcements.
    const outcome = String(d.outcome || '');
    notifyState.queue.push({
      seq: ++notifyState.seq,
      kind: 'approval-decided',
      id,
      outcome: outcome === 'allowed-once' || outcome === 'granted'
        ? 'granted'
        : outcome === 'rejected'
          ? 'rejected'
          : 'settled'
    });
  }
  if (notifyState.seen.size > notifyState.seenCap) notifyState.seen.clear(); // coarse reset; client also dedups by seq
  while (notifyState.queue.length > notifyState.cap) notifyState.queue.shift();
}

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;
  registerLocalRuntime(ctx, webServer, breezeGate); // FR-6/7/8：local-runtime 唯一入口也过 gate（B4）
  installLegacyWhenStandalone(ctx, webServer, applyLegacyProviders);
  registerBreezeRoutes(ctx, webServer); // FR-5: AI 可设置通道（方案 §六，与既有段零交叉）；B-1：传 ctx 接路由生命周期
}

function applyLegacyProviders(ctx) {
  const webServer = ctx.get('webServer');

  // Approval voice alerts: subscribe to the session/event firehose (the
  // sandbox exposes ctx.on; feature-detect so the smoke fake-ctx still works).
  if (typeof ctx.on === 'function') {
    ctx.effect(
      () =>
        ctx.on('session/event', (_session, event) => {
          try {
            ingestSessionEvent(event);
          } catch (e) { /* observer failures are logged-and-contained by design */ }
        }),
      'dsh-plugin-tts: session events (approval alerts)',
    );
  }

  const files = new Map();   // id -> absolute mp3 path
  const cache = new Map();   // voice|text -> url
  let seq = 0;

  // ★ 2026-10-29 加（外部复核 P1-5，我全包 grep 核实：unlink/rmSync 命中 0 处）：
  //   原来 files 满 300 只删【表项】，盘上文件一个不删 ⇒ 每读一段留一个 mp3/wav 在 %TEMP%，
  //   长期挂机的机器能涨到几百 MB 甚至 GB，用户不会想到是插件。
  //   现在删表项时顺手把盘上那份删掉。删失败不抛（文件可能被播放器占着）——
  //   删不掉就留着，下次启动清扫会兜底。
  const dropAudioFile = (id) => {
    const p = files.get(id);
    if (!p) return;
    try {
      if (typeof p === 'string' && p.startsWith(os.tmpdir())) rmSync(p, { force: true });
    } catch (_) { /* 被占用就留着，启动清扫兜底 */ }
  };

  // ★ 启动清扫：把上次进程遗留的临时音频清掉（进程被杀时 dropAudioFile 没机会跑）
  try {
    for (const n of readdirSync(os.tmpdir())) {
      if (/^dsh-local-ai-tts-|^dsh-breeze-tts-/.test(n)) {
        try { rmSync(path.join(os.tmpdir(), n), { force: true }); } catch (_) {}
      }
    }
  } catch (_) { /* 临时目录读不了就跳过 */ }

  // --- adaptive chunk job registry (rvc long reads) ---
  const jobs = new Map();    // jobId -> { id, voice, custom, parts, nextIdx, tail, done, finishedAt, created }
  let jobSeq = 0;

  function convertChunk(job) {
    const run = async () => {
      if (job.done || job.nextIdx >= job.parts.length) return { done: true };
      const text = job.parts[job.nextIdx];
      const audioPath = await job.sink(text);
      const id = 'c' + (++seq).toString(36) + '-' + hashText(text).slice(0, 6);
      files.set(id, audioPath);
      if (files.size > 300) {
        const first = files.keys().next().value;
        if (first !== undefined) { dropAudioFile(first); files.delete(first); }
      }
      job.nextIdx++;
      return { url: '/dsh-breeze-tts-audio/' + id, more: job.nextIdx < job.parts.length };
    };
    const p = job.tail.then(run, run);
    job.tail = p.catch(() => {}); // keep the chain alive even on per-chunk failure
    return p;
  }

  function nextJobChunk(jobId) {
    const job = jobs.get(jobId);
    if (!job) return Promise.resolve({ done: true, gone: true });
    if (job.nextIdx >= job.parts.length) {
      job.finishedAt = job.finishedAt || Date.now();
      return Promise.resolve({ done: true });
    }
    return convertChunk(job);
  }

  // Explicit cancel: the client abandons a chunked job early (user stops /
  // switches message). Stop scheduling further chunks and drop the job from the
  // registry immediately instead of waiting for the lazy 2/10-min GC, so the
  // local RVC GPU/memory is released promptly. The in-flight chunk (if any)
  // finishes writing a harmless temp file; no new chunks are started.
  function cancelJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.done = true;
    job.finishedAt = job.finishedAt || Date.now();
    jobs.delete(jobId);
    return true;
  }

  function cleanupJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > 120000) jobs.delete(id);
      else if (!job.finishedAt && now - job.created > 600000) jobs.delete(id);
    }
    if (jobs.size > 50) {
      const entries = [...jobs.entries()].sort((x, y) => {
        const a = x[1].finishedAt || Number.MAX_SAFE_INTEGER;
        const b = y[1].finishedAt || Number.MAX_SAFE_INTEGER;
        return a - b;
      });
      while (jobs.size > 50) jobs.delete(entries.shift()[0]);
    }
  }

  const speakDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/speak',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return; // FR-6/7/8 B4：烧 Edge TTS/GPU
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4194304) { // 1.1.0 §二.2：1MB→4MB（覆盖 60 秒降采样后音频；文本绰绰有余）
            writeJson(res, 413, { error: 'body too large' });
            return;
          }
        }
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* fall through */ }
        const text = String((parsed && parsed.text) || '').trim();
        if (!text) {
          writeJson(res, 400, { error: 'empty text' });
          return;
        }
        const voice = String((parsed && parsed.voice) || 'zh-CN-XiaoxuanNeural');
        const provider = String((parsed && parsed.provider) || 'edge-tts');
        if (!['edge-tts', 'rvc', 'local-piper'].includes(provider)) {
          writeErr(res, 400, 'Use the dedicated Local Runtime sentence queue; unknown providers cannot fall back to Edge.');
          return;
        }
        const custom = (parsed && parsed.custom) || null;
        const prosody = (parsed && parsed.prosody) || null;
        const cfg = provider === 'rvc' ? rvcConfig(custom) : null;
        const providerKey = provider === 'rvc'
          ? 'rvc|' + rvcFingerprint(cfg)
          : provider + '|' + JSON.stringify(prosody || {});
        const key = providerKey + '|' + voice + '|' + text;
        const hit = cache.get(key);
        if (hit) {
          // Harden: the cached URL may point to a file already evicted from the
          // `files` map or cleaned from the OS temp dir. Only reuse it if the
          // backing file still exists; otherwise re-synthesize (avoids a stale
          // URL that would 404 at play time).
          const hitId = String(hit).split('/').pop();
          const hitPath = files.get(hitId);
          if (hitPath && existsSync(hitPath)) {
            writeJson(res, 200, { url: hit });
            return;
          }
          cache.delete(key);
        }

        // ---- adaptive chunked progressive playback ----
        // Long reads stream progressively ("first chunk plays while the rest
        // synthesize") for BOTH RVC and plain Edge TTS, reusing one pipeline:
        // RVC uses the calibration-probed chunk size; Edge uses a fixed size
        // (Edge synthesis is the bottleneck, no local speed to probe).
        const chunkable =
          estimateSpeechSeconds(text) > 12 &&
          !(provider === 'rvc' && !!(cfg) && cfg.baseSource === 'upload');
        if (chunkable) {
          cleanupJobs();
          const cal = provider === 'rvc'
            ? await getCalibration(cfg)
            : { chunkSec: 20, prewarm: 2, ratio: 0 };
          const maxChars = Math.max(16, Math.round(cal.chunkSec * (isLatinHeavy(text) ? 12 : 3.6)));
          const parts = splitText(text, maxChars);
          if (parts.length > 1) {
            const jobId = 'j' + (++jobSeq).toString(36);
            const job = {
              id: jobId,
              voice,
              custom,
              sink: provider === 'rvc'
                ? t => synthesizeRvc(t, voice, custom)
                : t => synthesize(t, voice, prosody || undefined),
              parts,
              nextIdx: 0,
              tail: Promise.resolve(),
              done: false,
              finishedAt: null,
              created: Date.now()
            };
            jobs.set(jobId, job);
            const prewarm = Math.min(cal.prewarm, parts.length);
            const urls = [];
            for (let i = 0; i < prewarm; i++) {
              const r = await convertChunk(job);
              if (r && r.url) urls.push(r.url);
            }
            writeJson(res, 200, {
              jobId,
              chunks: urls,
              total: parts.length,
              ratio: cal.ratio,
              chunkSec: cal.chunkSec
            });
            return;
          }
        }

        const absPath = await getProvider(provider).synthesizeShort(
          text, voice, prosody, custom,
        );
        const id = 'a' + (++seq).toString(36) + '-' + hashText(text).slice(0, 6);
        files.set(id, absPath);
        if (files.size > 300) {
          const first = files.keys().next().value;
          if (first !== undefined) { dropAudioFile(first); files.delete(first); }
        }
        const url = '/dsh-breeze-tts-audio/' + id;
        cache.set(key, url);
        if (cache.size > 60) {
          const first = cache.keys().next().value;
          if (first !== undefined) cache.delete(first);
        }
        writeJson(res, 200, { url });
      } catch (e) {
        writeRouteError(res, e);
      }
    }
  });

  const audioDisposer = webServer.register({
    kind: 'prefix',
    path: '/dsh-breeze-tts-audio',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return; // FR-8：穿透模式无 token 401（client 走 fetch→blob→playBlob，不用 ?t=）
      try {
        const url = req.url || '/';
        const segs = url.split('?')[0].split('/').filter(Boolean);
        const id = segs[segs.length - 1] || '';
        const download = new URL(url, 'http://x').searchParams.get('download') === '1';
        const absPath = files.get(id);
        if (!absPath || !existsSync(absPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        const bytes = readFileSync(absPath);
        const headers = {
          'Content-Type': 'audio/mpeg',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff'
        };
        if (download) {
          // send as a downloadable attachment so users can keep the synthesized
          // audio (Edge base or RVC-converted) instead of only streaming it
          const filename = 'dsh-local-ai-tts-' + id + '.mp3';
          headers['Content-Disposition'] = "attachment; filename=\"" + filename + "\"";
        }
        res.writeHead(200, headers);
        res.end(bytes);
      } catch (e) {
        try {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('tts audio error');
        } catch (e2) { /* socket gone */ }
      }
    }
  });

  const filesDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-files',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return; // SSRF 敏感（配合 B2 baseUrl 校验）
      const q = new URL(req.url || '', 'http://x').searchParams;
      const baseUrl = String(q.get('baseUrl') || RVC_DEFAULTS.baseUrl).replace(/\/+$/, '');
      // FR-6/7/8 B2：baseUrl 三级校验（判据照 provider.mjs allowLan 模式）——loopback 放行；
      // 私网 IPv4 需 allowLanFiles===true（新增配置，默认 false）；公网一律拒。
      {
        let u = null;
        try { u = new URL(baseUrl); } catch (_) {}
        const host = u ? u.hostname : '';
        const isLoop = host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]';
        const isPrivateV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host) &&
          (host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
        if (!u || !['http:', 'https:'].includes(u.protocol) || (!isLoop && !(isPrivateV4 && breezeCfg.allowLanFiles === true))) {
          writeErr(res, 502, `baseUrl 不允许（SSRF 防护）：仅本机地址默认放行；私网需在配置开启 allowLanFiles；公网地址一律拒绝。（收到：${baseUrl}）`);
          return;
        }
      }
      try {
        const kind = q.get('kind') === 'index' ? 'index' : 'pth';
        const r = await fetch(baseUrl + '/files?kind=' + kind, {
          signal: AbortSignal.timeout(15000)
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
          writeErr(res, 502, `RVC /files 接口异常（HTTP ${r.status}）：${(data && data.message) || r.statusText}`, { code: "host.filesHttpFail", params: { status: r.status } });
          return;
        }
        writeJson(res, 200, data || { ok: false, files: [] });
      } catch (e) {
        const startup = rvcStartupHint();
        const rawError = String((e && e.message) || e);
        writeErr(res, 502,
          `无法连接本地 RVC 服务（${baseUrl}）——浏览本地文件需要它先运行。\n` +
          startup +
          `\n并确认设置里的「服务地址」与端口一致。原始错误：${rawError}`,
          { code: "host.filesNeedsServer", params: { baseUrl, startup, error: rawError } }
        );
      }
    }
  });

  const nextDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-next',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      try {
        const q = new URL(req.url || '', 'http://x').searchParams;
        const jobId = q.get('job') || '';
        const cancel = q.get('cancel') === '1';
        cleanupJobs();
        if (cancel) {
          // client abandon: release the job now (see cancelJob)
          const was = cancelJob(jobId);
          writeJson(res, 200, { done: true, cancelled: was });
          return;
        }
        const r = await nextJobChunk(jobId);
        writeJson(res, 200, r);
      } catch (e) {
        writeErr(res, 500, `后续段落合成失败：${String((e && e.message) || e)}`, { code: "host.chunkFail" });
      }
    }
  });

  const compactDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-compact-index',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      // B-2（方案 §四）：baseUrl 提到 try 外声明——catch 的错误 params 里引用它，
      // 原来声明在 try 内，走到 catch 时 baseUrl 不在作用域 ⇒ 错误响应自身再抛 ReferenceError
      let baseUrl = RVC_DEFAULTS.baseUrl;
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1048576) { writeJson(res, 413, { error: 'body too large (1MB max)' }); return; } } // C-2（方案 §五）：body 上限
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* fall through */ }
        baseUrl = String(parsed.baseUrl || RVC_DEFAULTS.baseUrl).replace(/\/+$/, '');
        const data = await rvcJson(baseUrl, '/compact-index', {
          index: String(parsed.index || ''),
          target_vectors: Number(parsed.target_vectors || 10000),
          out_dir: String(parsed.out_dir || '')
        }, 300000);
        writeJson(res, 200, data);
      } catch (e) {
        const msg = String((e && e.message) || e);
        const needsServer = /无法连接本地 RVC 推理服务/.test(msg);
        const startup = rvcStartupHint();
        writeErr(res, 502,
          needsServer
            ? `无法连接本地 RVC 服务——生成紧凑索引需要它先运行。\n` +
              startup +
              `\n原始错误：${msg}`
            : `紧凑索引生成失败：${msg}`,
          {
            code: needsServer ? "host.compactNeedsServer" : "host.compactFail",
            params: needsServer ? { baseUrl, startup, error: msg } : { error: msg }
          }
        );
      }
    }
  });

  const packsDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-packs',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      try {
        const q = new URL(req.url || '', 'http://x').searchParams;
        const registry = q.get('registry') || '';
        const proxy = q.get('proxy') || '';
        const { data } = await fetchManifest(registry, proxy);
        writeJson(res, 200, data);
      } catch (e) {
        writeErr(res, 502, `获取音色包列表失败：${String((e && e.message) || e)}`, { code: "host.packsListFail" });
      }
    }
  });

  const packsInstalledDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-packs-installed',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      try {
        writeJson(res, 200, { installed: installedPacks(), packsDir: packsDir() });
      } catch (e) {
        writeRouteError(res, e);
      }
    }
  });

  const packInstallDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-pack-install',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return;
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1048576) { writeJson(res, 413, { error: 'body too large (1MB max)' }); return; } } // C-2（方案 §五）：body 上限
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* fall through */ }
        const registry = String(parsed.registry || '');
        const packId = String(parsed.packId || '').trim();
        const indexId = parsed.indexId ? String(parsed.indexId) : '';
        const progressKey = parsed.progressKey ? String(parsed.progressKey).slice(0, 80) : '';
        const proxy = parsed.proxy ? String(parsed.proxy).slice(0, 300) : '';
        if (!registry || !packId) {
          writeErr(res, 400, 'registry 与 packId 必填', { code: 'host.registryPackRequired' });
          return;
        }
        // create the progress entry BEFORE the manifest fetch so the client's
        // poll never sees an empty gap and mistakes it for "finished"
        setPackProgress(progressKey, { phase: '准备', phaseKey: 'prepare', done: 0, total: 0 });
        try {
          const result = await installPack(registry, packId, indexId, progressKey, proxy);
          writeJson(res, 200, result);
        } catch (e) {
          finishPackProgress(progressKey);
          writeErr(res, 502, `音色包安装失败：${String((e && e.message) || e)}`, { code: "host.packInstallFail" });
        }
      } catch (e) {
        writeRouteError(res, e);
      }
    }
  });

  const packUninstallDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-pack-uninstall',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return;
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1048576) { writeJson(res, 413, { error: 'body too large (1MB max)' }); return; } } // C-2（方案 §五）：body 上限
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* fall through */ }
        const packId = String(parsed.packId || '').trim();
        if (!packId) {
          writeErr(res, 400, 'packId 必填', { code: 'host.packIdRequired' });
          return;
        }
        const stem = packId.replace(/[^\w.-]/g, '_');
        const dir = path.join(packsDir(), stem);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (e) { /* best-effort */ }
        const installed = installedPacks();
        delete installed[packId];
        saveInstalledPacks(installed);
        writeJson(res, 200, { ok: true });
      } catch (e) {
        writeErr(res, 502, `卸载失败：${String((e && e.message) || e)}`, { code: "host.packUninstallFail" });
      }
    }
  });

  const diagnoseDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/diagnose',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return; // 会真跑合成
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1048576) { writeJson(res, 413, { error: 'body too large (1MB max)' }); return; } } // C-2（方案 §五）：body 上限
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* fall through */ }
        const baseUrl = String(parsed.rvcBaseUrl || RVC_DEFAULTS.baseUrl).replace(/\/+$/, '');
        const checks = [];

        // 1) Edge TTS online synthesis
        const edgeCheck = { id: 'edge', name: 'Edge TTS 在线合成', ok: false, cls: '', detail: '' };
        try {
          const t0 = Date.now();
          await synthesize('测试一下。', 'zh-CN-XiaoxuanNeural', {});
          edgeCheck.ok = true;
          edgeCheck.cls = 'ok';
          edgeCheck.detail = '正常（' + (Date.now() - t0) + 'ms）';
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (msg.includes('1007')) {
            edgeCheck.cls = 'voice';
            edgeCheck.detail = '音色被端点移除（1007）：请换用列表内的音色';
          } else if (/403|Sec-MS-GEC|1006|timeout|websocket|closed early/i.test(msg)) {
            edgeCheck.cls = 'protocol';
            edgeCheck.detail = 'Edge 端点协议/网络异常：' + msg.slice(0, 140);
          } else {
            edgeCheck.cls = 'connect';
            edgeCheck.detail = '网络/连接异常：' + msg.slice(0, 140);
          }
        }
        checks.push(edgeCheck);

        // 2) RVC server reachability + loaded model status
        const rvcCheck = { id: 'rvc-server', name: '本地 RVC 服务', ok: false, cls: '', detail: '' };
        const modelCheck = { id: 'rvc-model', name: 'RVC 模型', ok: false, cls: '', detail: '' };
        try {
          const r = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(6000) });
          const d = await r.json().catch(() => null);
          if (!r.ok || !d || d.ok !== true) {
            rvcCheck.cls = 'protocol';
            rvcCheck.detail = '服务响应异常（HTTP ' + r.status + '）';
          } else {
            rvcCheck.ok = true;
            rvcCheck.cls = 'ok';
            rvcCheck.detail = '在线' + (d.gpu_name ? ' · ' + d.gpu_name + ' · ' + (d.vram_gb || '?') + 'GB' : '');
            if (d.model_loaded) {
              modelCheck.ok = true;
              modelCheck.cls = 'ok';
              modelCheck.detail = '已加载：' + (d.model || '');
            } else {
              modelCheck.cls = 'warn';
              modelCheck.detail = '服务在线但未加载模型——填好模型路径后，首次朗读会自动加载';
            }
          }
        } catch (e) {
          rvcCheck.cls = 'connect';
          rvcCheck.detail = '无法连接（' + baseUrl + '）——请先启动 rvc-server.py（见使用手册 §4.2），并确认「服务地址」';
        }
        checks.push(rvcCheck, modelCheck);
        writeJson(res, 200, { ok: checks.every((c) => c.ok), checks });
      } catch (e) {
        writeRouteError(res, e);
      }
    }
  });

  const packProgressDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/rvc-pack-progress',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      try {
        const q = new URL(req.url || '', 'http://x').searchParams;
        const key = q.get('key') || '';
        const p = key ? packProgress.get(key) : undefined;
        if (p) {
          const elapsed = Math.max(1, (Date.now() - p.startedAt) / 1000);
          writeJson(res, 200, {
            phase: p.phase,
            phaseKey: p.phaseKey || (p.phase === '模型' ? 'model' : p.phase === '索引' ? 'index' : 'prepare'),
            done: p.done,
            total: p.total,
            speed: Math.round(p.done / elapsed),
            finished: !!p.finished
          });
          if (Date.now() - p.startedAt > 600000) packProgress.delete(key);
          return;
        }
        writeJson(res, 200, { waiting: true }); // entry not created yet — keep polling
      } catch (e) {
        writeRouteError(res, e);
      }
    }
  });

  // Approval-alert queue: the client polls for new items since its cursor and
  // reads them aloud (approval requests interrupt, results announce when idle).
  const notifyDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/notify',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'sensitive' })) return; // 纯读但读审批事件＝信息泄露面（退单 001 四节）
      try {
        const q = new URL(req.url || '', 'http://x').searchParams;
        const since = Number(q.get('s') || 0) || 0;
        const items = notifyState.queue
          .filter((i) => i.seq > since)
          .map((i) => ({
            seq: i.seq,
            kind: i.kind,
            toolName: i.toolName,
            reason: i.reason,
            outcome: i.outcome
          }));
        writeJson(res, 200, { items, latest: notifyState.seq });
      } catch (e) {
        writeRouteError(res, e);
      }
    }
  });

  ctx.effect(() => speakDisposer, 'dsh-plugin-tts: speak route');
  ctx.effect(() => audioDisposer, 'dsh-plugin-tts: audio route');
  ctx.effect(() => filesDisposer, 'dsh-plugin-tts: rvc files route');
  ctx.effect(() => nextDisposer, 'dsh-plugin-tts: rvc next route');
  ctx.effect(() => compactDisposer, 'dsh-plugin-tts: rvc compact-index route');
  ctx.effect(() => packsDisposer, 'dsh-plugin-tts: rvc packs route');
  ctx.effect(() => packsInstalledDisposer, 'dsh-plugin-tts: rvc packs-installed route');
  ctx.effect(() => packInstallDisposer, 'dsh-plugin-tts: rvc pack-install route');
  ctx.effect(() => packUninstallDisposer, 'dsh-plugin-tts: rvc pack-uninstall route');
  ctx.effect(() => packProgressDisposer, 'dsh-plugin-tts: rvc pack-progress route');
  ctx.effect(() => notifyDisposer, 'dsh-plugin-tts: notify route');
  ctx.effect(() => diagnoseDisposer, 'dsh-plugin-tts: diagnose route');
}

// Test hook: expose pure helpers for unit tests without a real server.
// (e.g. tests/smoke.mjs asserts splitText never cuts URLs/decimals mid-token,
// and drives ingestSessionEvent + the notify queue directly.)
export const __test = {
  splitText,
  ingestSessionEvent,
  notify: () => ({
    seq: notifyState.seq,
    queued: notifyState.queue.length
  })
};

// ======================================================================
// ===== FR-5: AI 可设置通道（dsh-breeze-tts 全新段，与既有段零交叉） =====
// 方案 §六（第三轮定稿）。config.json 唯一权威源；鉴权矩阵照 §6.3；
// requireLocalToken=true 时 GET /config 一律剔除 token（R1×R3 互杀修法）。
// ======================================================================

// --- 配置存储（照既有 calibration 的 ~/.dsh 家目录模式，同步 fs 与本文件风格一致） ---
const BREEZE_CFG_DIR = path.join(os.homedir(), '.dsh', 'dsh-breeze-tts');
const BREEZE_CFG_FILE = path.join(BREEZE_CFG_DIR, 'config.json');
const BREEZE_DEFAULT_ENDPOINT = 'http://127.0.0.1:8080';

function breezeDefaultConfig() {
  return {
    version: 1,
    endpoint: BREEZE_DEFAULT_ENDPOINT,
    voice: '',
    engine: 'generic',
    speech: {},
    remoteAccess: false,
    trustedLocalCidrs: ['127.0.0.1', '::1'],
    token: randomBytes(32).toString('hex'),
    requireLocalToken: false,
    clientMigrated: false,
    // FR-6/7/8（方案 §4.1-7）：工坊调用通道（direct=浏览器直连 Breeze / proxy=走壳同源代理）与
    // rvc-files 私网放行开关（B2，默认关）
    accessMode: 'direct',
    allowLanFiles: false,
    // FR-8 配对码（文件通道）：6 位数字，人或 AI 直接写 config.json；兑换成功即焚（host 自动删字段）。
    // ★ GET /config 永远剔除本字段（configViewFor），不许从 API 读出来。
    pairCode: '',
    updatedAt: new Date().toISOString()
  };
}

let breezeCfgCorruptFile = ''; // 1.1.0 顺手项 7：config.json 损坏留底文件路径（非空＝正在按默认值运行）

function readBreezeConfig() {
  try {
    if (!existsSync(BREEZE_CFG_FILE)) return null;   // 真的没有 = 首启，可以直接建
    return JSON.parse(readFileSync(BREEZE_CFG_FILE, 'utf8'));
  } catch (e) {
    // ★★★ 2026-10-29 修（外部复核 P1-4，我复核时真跑复现过）：
    //   原来这里只打一行日志就 return null，而 ensureBreezeConfig() 把 null 一律当"首启"
    //   ⇒ **一处 JSON 语法错（多一个逗号 / PowerShell 写坏）= 整个 config 被出厂默认覆盖**，
    //   token、endpoint、trustedLocalCidrs、整个 speech 全丢，且原文件不留底、界面不提示。
    //   实测（沙箱）：76 B 坏文件 → 加载后变 443 B 出厂默认，token 被替换，目录里只剩 config.json。
    //   ⇒ 现在把坏文件改名留底（config.json.corrupt-<时间戳>），再让上层重建。
    //     留底比"不重建"重要：不重建插件就起不来；留底用户还能自己把值捡回来。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = BREEZE_CFG_FILE + '.corrupt-' + stamp;
    try {
      renameSync(BREEZE_CFG_FILE, bad);
      breezeCfgCorruptFile = bad; // 1.1.0 顺手项 7：损坏可见（configViewFor 带 configCorrupt → 面板黄条）
      console.error('[breeze-tts] config.json 已损坏，原文件已备份为 ' + bad + '，将按出厂默认重建。原因:', e && e.message);
    } catch (e2) {
      console.error('[breeze-tts] config.json 已损坏且备份失败（' + (e2 && e2.message) + '），按出厂默认处理:', e && e.message);
    }
    return null;
  }
}

function writeBreezeConfig(cfg) {
  mkdirSync(BREEZE_CFG_DIR, { recursive: true });
  cfg.updatedAt = new Date().toISOString();
  const tmp = BREEZE_CFG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  try { renameSync(tmp, BREEZE_CFG_FILE); }
  catch (e) { try { writeFileSync(BREEZE_CFG_FILE, readFileSync(tmp)); rmSync(tmp); } catch (_) { throw e; } }
  return cfg;
}

function ensureBreezeConfig() {
  let cfg = readBreezeConfig();
  if (!cfg) {
    cfg = writeBreezeConfig(breezeDefaultConfig());
    console.log('[breeze-tts] 首启已建配置（含随机管理 token）:', BREEZE_CFG_FILE, '（token 本身不打印）');
  }
  if (!cfg.token) { cfg.token = randomBytes(32).toString('hex'); writeBreezeConfig(cfg); }
  return cfg;
}
let breezeCfg = ensureBreezeConfig();
if (breezeCfg.pairCode) {
  // 1.1.0 顺手项 6（半件）：文件通道 pairCode 无硬时效（文件是用户自己的），但启动时告知
  console.warn('[breeze-tts] config.json 存在未使用的 pairCode——它是一次性凭据，兑换成功会自动删除；未使用请手动删除该字段。');
}

// --- 鉴权矩阵（§6.3）：本机（trustedLocalCidrs）读写免 token（除非 requireLocalToken）；
// 非本机 remoteAccess=false→403；true→读免、写必须 Bearer。穿透判据：requireLocalToken=true 时
// GET /config 对本机也剔除 token（R1×R3 互杀修法）。
function normalizeIp(addr) {
  const a = String(addr || '');
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}
// FR-6/7/8→1.1.0 §二.3：真 CIDR 匹配（阿枢复核修正版照抄——/0 拒绝、IPv6 网段明确报错，绝不静默）
function ipToLong(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function matchCidr(ip, rule) {
  rule = String(rule).trim();
  if (!rule.includes('/')) return ip === rule;              // 单 IP 等值（兼容现有写法）
  const [net, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  const a = ipToLong(ip), b = ipToLong(net);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  // ★★★ /0 等于信任所有 IP——在信任名单语境下是危险配置，一律不匹配（阿枢复核 053 复现：4/4 公网 IP 全被当本机）
  if (bits === 0) return false;
  return ((a ^ b) >>> (32 - bits)) === 0;
}

// 写入层校验：PUT /config 收到 trustedLocalCidrs 时逐条过一遍，返回 null=合法，否则是错误文案
function validateTrustedRule(rule) {
  const s = String(rule).trim();
  if (!s) return '不能为空';
  if (!s.includes('/')) {
    if (ipToLong(s) !== null) return null;                                  // 合法 IPv4 单 IP
    if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':')) return null;         // 合法 IPv6 单 IP
    return '不是合法的 IP：' + s;
  }
  const [net, bitsRaw] = s.split('/');
  // IPv6 网段本版不实现（128 位匹配易错，家里场景是 IPv4 局域网），但必须明确拒绝、不许静默
  if (net.includes(':')) return 'IPv6 不支持网段写法，请逐条列 IP（如 ::1）';
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return '掩码必须是 0–32 的整数：' + s;
  if (bits === 0) return '/0 等于信任所有 IP，不允许（请写具体网段）';
  if (ipToLong(net) === null) return '网段地址不合法：' + net;
  return null;
}

function isTrustedLocal(req) {
  const list = Array.isArray(breezeCfg.trustedLocalCidrs) ? breezeCfg.trustedLocalCidrs : ['127.0.0.1', '::1'];
  const ip = normalizeIp(req.socket && req.socket.remoteAddress);
  return (ip === '::1' && list.includes('::1')) || list.some(r => matchCidr(ip, r));
}
function bearerToken(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

// C-16（方案 §五）：token 比较走 timingSafeEqual，防时序侧信道逐字节猜 token。
// 长度不等直接 false（timingSafeEqual 要求等长 Buffer）；零长度也 false（空 token 不算凭据）。
function safeTokenEqual(a, b) {
  const sa = Buffer.from(String(a || ''), 'utf8');
  const sb = Buffer.from(String(b || ''), 'utf8');
  if (sa.length === 0 || sa.length !== sb.length) return false;
  try { return timingSafeEqual(sa, sb); } catch (_) { return false; }
}
// 返回 null=放行；否则已写响应（403/401），调用方直接 return。
// FR-6/7/8 改 A（方案 §三.3，第三轮+退单 002 定稿）：参数升级 {level:'read'|'sensitive'|'write'}；
// 穿透模式（requireLocalToken=true）不分级别不分本机非本机，一律查 token（B4 根治）。
function breezeGate(req, res, { level = 'read' } = {}) {
  const local = isTrustedLocal(req);
  if (local) {
    if (breezeCfg.requireLocalToken && !safeTokenEqual(bearerToken(req), breezeCfg.token)) {
      writeJson(res, 401, { error: 'requireLocalToken=true: all requests need a valid Bearer token' });
      return 'deny';
    }
    return null;
  }
  // B-5（方案 §四）：严格真值判断——`!remoteAccess` 会把 remoteAccess:"false"（字符串）当开，
  // JSON 语义上只有 true 是"允许远程"；配置面手滑写成字符串也按关处理（fail-closed）
  if (breezeCfg.remoteAccess !== true) {
    writeJson(res, 403, { error: 'remote access disabled (remoteAccess=false). Configure on the host machine or enable remoteAccess.' });
    return 'deny';
  }
  if (breezeCfg.requireLocalToken && !safeTokenEqual(bearerToken(req), breezeCfg.token)) {
    // 穿透模式叠加跨机：非本机也不分级（退单 002-P1）
    writeJson(res, 401, { error: 'requireLocalToken=true: all requests need a valid Bearer token' });
    return 'deny';
  }
  if (level === 'write' && !safeTokenEqual(bearerToken(req), breezeCfg.token)) {
    writeJson(res, 401, { error: 'missing or wrong Bearer token' });
    return 'deny';
  }
  return null;
}
// GET /config 的凭据出示规则（FR-6/7/8）：token 仅 本机 && !requireLocalToken 时保留；
// pairCode 无论何时、对谁都剔除（文件通道专用，从 API 读出来＝第三轮堵死的洞换个名字放回来）。
function configViewFor(req) {
  const showToken = isTrustedLocal(req) && !breezeCfg.requireLocalToken;
  const view = { ...breezeCfg };
  if (!showToken) delete view.token;
  delete view.pairCode;
  if (breezeCfgCorruptFile) view.configCorrupt = breezeCfgCorruptFile; // 1.1.0 顺手项 7：面板黄条数据源
  return view;
}

// --- host 版 fixWav（TR-7：client 版逐行平移，Uint8Array/Blob → Buffer；一个字节别改逻辑） ---
function fixWavHost(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const u8 = new Uint8Array(ab);
  const dv = new DataView(ab);
  let off = 12, found = -1;
  while (off + 8 <= u8.length) {
    const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    if (id === "data") { found = off; break; }
    let sz = dv.getUint32(off + 4, true);
    if (sz === 0xFFFFFFFF || sz > u8.length) break;
    off += 8 + sz + (sz % 2);
  }
  dv.setUint32(4, u8.length - 8, true);
  if (found >= 0) dv.setUint32(found + 4, u8.length - (found + 8), true);
  return Buffer.from(ab);
}

async function breezeFetchJson(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + (t ? ' · ' + t.slice(0, 200) : '')), { status: r.status, body: j });
  return j;
}

async function readRawBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) { total += c.length; if (total > limit) throw new Error('body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function breezeSynthWav(cfg, body) {
  // ★ 2026-10-29 加超时（外部复核 P1-3）：同文件其他 fetch 都有 AbortSignal.timeout
  //   （8000 / 15000 / 6000 / 1200000），只有这条主干没有 ⇒ Breeze 卡死或半开连接时，
  //   /speak-preview、/voices/design 会一直挂着，前端 busy 永久 true，只能刷新页面。
  //   合成是重活，给宽一点：5 分钟（比 rvc 的 20 分钟短，比 health 的 8 秒长很多）。
  const r = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw Object.assign(new Error('HTTP ' + r.status + (t ? ' · ' + t.slice(0, 200) : '')), { status: r.status });
  }
  const ab = await r.arrayBuffer();
  return fixWavHost(Buffer.from(ab));
}

function registerBreezeRoutes(ctx, webServer) { // B-1：接收 ctx，路由反注册走 ctx.effect（照 legacy 段模式）
  // 1+2) /config —— GET 读 / PUT 写，★合并在【一次】register 里按 method 分发。
  //   ★ FA-5（2026-10-29 12:4x 装机实测发现）：DSH 的 webServer.register 按 (kind,path) 判重，
  //   **不看 method**（dsh-host-webserver/lib/index.js:177-184 `table.set(route.path, route)`，
  //   path 已在表里就 throw）。原代码把 GET 与 PUT 分成两次 register 同一 path ⇒ 第二次抛
  //   `webserver: duplicate exact route "/dsh-breeze-tts-api/config"` ⇒ 整个 apply 抛错 ⇒
  //   **插件零路由加载、dsh 只报 "1 entry did not activate"**，表面上页面还在、功能全死。
  //   ⇒ 同 path 的多个 method 必须自己在一个 handler 内分发。这是 DSH 架构的硬约束。
  const dConfig = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/config',
    async handler(req, res) {
      const method = String(req.method || 'GET').toUpperCase();

      if (method === 'GET' || method === 'HEAD') {
        // 读：token 出示规则见 configViewFor
        if (breezeGate(req, res, { level: 'read' })) return;
        // ★ 2026-10-29 修（反馈第 4 条的根因，比"updatedAt 旧"严重得多）：
        //   breezeCfg 是【模块加载那一刻】读一次盘定下的快照，之后再也不重载。
        //   于是：① GET 的 updatedAt 永远停在启动时刻；
        //        ② 更糟——**用户按文档直接改 config.json（pairCode 是文件通道、就指望这个）
        //           或者盘上 token 被换掉，插件全看不见**，直到重启。
        //   ⇒ GET 前先拿磁盘重载一次。配置是小 JSON，一次读盘成本可以忽略。
        //   ★ 只重载、不写盘：GET 是只读语义，绝不能因为读一下就改了盘上的东西。
        try {
          const fresh = readBreezeConfig();
          if (fresh && typeof fresh === 'object') {
            // token 特殊：盘上没有就保留内存里的，别把已配对的人踢下线
            if (!fresh.token && breezeCfg.token) fresh.token = breezeCfg.token;
            breezeCfg = fresh;
          }
        } catch (_) { /* 读失败就用内存里的旧快照，不能让 GET 直接挂 */ }
        writeJson(res, 200, configViewFor(req));
        return;
      }

      // B-4（方案 §四）：不再接受 POST 写 /config——1.1.1 的 keepalive flush 用的是 PUT（已核），
      // 放行 POST 会让"该收 PUT 的门"被 POST 绕过鉴权语义（对配置写而言是行为不兼容修正）
      if (method === 'PUT') {
        // 写：局部 merge（矩阵管控，写接口必须 token）
        if (breezeGate(req, res, { level: 'write' })) return;
        try {
          const raw = await readRawBody(req, 1024 * 1024);
          // ★ 去 BOM：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 UTF-8 BOM，
          //   JSON.parse 直接抛 `Unexpected token '\uFEFF'` ⇒ 400。用户是照文档写文件才中的，
          //   不是他写错了。（2026-10-29 AI 实测反馈第 3 条）
          const text = raw.toString('utf8').replace(/^\uFEFF/, '').trim();
          const patch = JSON.parse(text || '{}');
          const allow = ['endpoint', 'voice', 'engine', 'speech', 'remoteAccess', 'trustedLocalCidrs', 'requireLocalToken', 'clientMigrated', 'accessMode', 'allowLanFiles'];
          // FR-8 配对码（FA-3 定为乙：不支持经 HTTP 写 pairCode——带外通道就该走文件）。
          // 必须先判、判完即返：若先 merge 再返，内存已被改动却没落盘 ⇒ 内存与磁盘不一致（比静默丢弃更难查）。
          if ('pairCode' in patch) {
            writeJson(res, 400, { error: 'pairCode is file-channel only: edit ~/.dsh/dsh-breeze-tts/config.json (or use POST /pair/new on the host). It is NOT writable via PUT /config.' });
            return;
          }
          // 1.1.0 §二.3：trustedLocalCidrs 写入层校验——逐条过 validateTrustedRule，
          // /0 拒绝、IPv6 网段明确报错（不静默）；错就 400 报第几条。
          if (Array.isArray(patch.trustedLocalCidrs)) {
            // B-6（方案 §四）：空数组拒绝——trust 全空＝本机也不信＝插件自锁，谁也进不来
            if (patch.trustedLocalCidrs.length === 0) {
              writeJson(res, 400, { error: 'trustedLocalCidrs 不能为空（至少保留 127.0.0.1），否则插件自锁' });
              return;
            }
            for (let i = 0; i < patch.trustedLocalCidrs.length; i++) {
              const err = validateTrustedRule(patch.trustedLocalCidrs[i]);
              if (err) {
                writeJson(res, 400, { error: `trustedLocalCidrs 第 ${i + 1} 条格式不对：${err}` });
                return;
              }
            }
          }
          // ★★★ 2026-10-29 修（AI 实测反馈第 1 条，真数据丢失）：
          //   原来这里是 `breezeCfg[k] = patch[k]` —— 浅赋值。`speech` 是个对象，
          //   传 `{"speech":{"localRuntime":{...}}}` 就会把整个 speech **整块换掉**，
          //   autoRead / voice / provider / rvc / notify 全没了。返回还是 200，无任何警告。
          //   实测：speech 7 个子键 → 2 个，912 B → 661 B。
          //   ⇒ 现在对 speech 做【一层深合并】。为什么只做一层：speech 下面都是
          //     `localRuntime` / `rvc` / `notify` 这类整体配置块，调用方要么整块给、要么不给，
          //     再往深合反而会造出「传 {} 想清空却清不掉」的意外。一层是够用且可预测的边界。
          //   （顶层字段本来就没问题：下面那段以磁盘为基底回写，provider / coexistenceMode /
          //     人手写的备注都保得住 —— 已实测确认，缺陷范围只在 speech 内部。）
          for (const k of allow) {
            if (!(k in patch)) continue;
            if (k === 'speech') {
              const cur = (breezeCfg.speech && typeof breezeCfg.speech === 'object') ? breezeCfg.speech : {};
              const inc = (patch.speech && typeof patch.speech === 'object') ? patch.speech : {};
              const merged = { ...cur };
              for (const sk of Object.keys(inc)) {
                // 显式给 null 才允许删这个子键；给别的就当覆盖
                if (inc[sk] === null) delete merged[sk];
                else merged[sk] = inc[sk];
              }
              breezeCfg.speech = merged;
            } else {
              breezeCfg[k] = patch[k];
            }
          }
          // ★ FA-2 第二重后果修法：不再拿内存整份盖盘。
          //   以磁盘为基底，只把白名单内的运行时值写回 ⇒ 磁盘上他人手改的字段（如 pairCode、备注字段）不被抹掉。
          const onDisk = readBreezeConfig() || {};
          for (const k of allow) { if (k in breezeCfg) onDisk[k] = breezeCfg[k]; }
          if (!onDisk.token) onDisk.token = breezeCfg.token;
          writeBreezeConfig(onDisk);
          // ★ 2026-10-29 修（反馈第 4 条）：writeBreezeConfig 会给传进去的那个对象刷 updatedAt，
          //   但刷的是 `onDisk` 这份副本，内存 `breezeCfg` 还挂着老时间戳 ⇒ GET 一直回旧值。
          //   把刷好的值接回内存，GET / PUT 的返回就与磁盘一致了。
          breezeCfg.updatedAt = onDisk.updatedAt;
          writeJson(res, 200, configViewFor(req));
        } catch (e) {
          writeErr(res, 400, 'bad config patch: ' + (e && e.message));
        }
        return;
      }

      writeJson(res, 405, { error: 'method not allowed: ' + method + ' (use GET or PUT)' });
    }
  });

  // 3) GET /health —— 代理 Breeze /health，返回 {ok, reason?}
  const dHealth = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/health',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      try {
        const r = await fetch(breezeCfg.endpoint.replace(/\/+$/, '') + '/health', { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!r.ok) { writeJson(res, 200, { ok: false, reason: 'Breeze HTTP ' + r.status }); return; }
        writeJson(res, 200, { ok: true, sample_rate: j && j.sample_rate, ws_port: j && j.ws_port });
      } catch (e) {
        writeJson(res, 200, { ok: false, reason: 'cannot reach Breeze at ' + breezeCfg.endpoint + '（' + (e && e.message) + '）' });
      }
    }
  });

  // 4) GET /voices —— 代理 Breeze /v1/voices
  const dVoices = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/voices',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'read' })) return;
      try {
        const j = await breezeFetchJson(breezeCfg.endpoint.replace(/\/+$/, '') + '/v1/voices', { cache: 'no-store' });
        writeJson(res, 200, j);
      } catch (e) {
        writeJson(res, e && e.status ? e.status : 502, { error: (e && e.message) || String(e) });
      }
    }
  });

  // 5) POST /speak-preview —— {input, voice?, instructions?, seed?, cfg_scale?} → wav 音频流
  const dSpeakPreview = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/speak-preview',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return;
      try {
        const raw = await readRawBody(req);
        const p = JSON.parse(raw.toString('utf8') || '{}');
        const input = String(p.input || '').trim();
        if (!input) { writeErr(res, 400, 'empty input'); return; }
        const body = { input, response_format: 'wav' };
        if (p.voice) body.voice = p.voice;
        if (p.instructions) body.instructions = p.instructions;
        if (Number.isInteger(p.seed)) body.seed = p.seed;
        if (Number.isFinite(p.cfg_scale)) body.cfg_scale = p.cfg_scale;
        const wav = await breezeSynthWav(breezeCfg, body);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        res.end(wav);
      } catch (e) {
        writeJson(res, e && e.status ? e.status : 502, { error: (e && e.message) || String(e) });
      }
    }
  });

  // 6) POST /voices/design —— {name, text, instructions, seed?, cfg_scale?} → 合成 → fixWav → multipart 注册
  const dDesign = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/voices/design',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return;
      try {
        const raw = await readRawBody(req, 16 * 1024 * 1024); // 1.1.0 顺手项 8：音频上传显式 16MB
        const p = JSON.parse(raw.toString('utf8') || '{}');
        const name = String(p.name || '').trim();
        const text = String(p.text || '').trim();
        if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) { writeErr(res, 400, 'bad voice name（字母/数字/短横/下划线，≤64）'); return; }
        if (!text) { writeErr(res, 400, 'empty text'); return; }
        const body = { input: text, response_format: 'wav' };
        if (p.instructions) body.instructions = p.instructions;
        if (Number.isInteger(p.seed)) body.seed = p.seed;
        if (Number.isFinite(p.cfg_scale)) body.cfg_scale = p.cfg_scale;
        const wav = await breezeSynthWav(breezeCfg, body);
        const fd = new FormData();
        fd.append('ref_audio', new Blob([wav], { type: 'audio/wav' }), name + '.wav');
        fd.append('ref_text', text); // 转录＝试听文本（与工坊 UI 行为一致）
        fd.append('name', name);
        const j = await breezeFetchJson(breezeCfg.endpoint.replace(/\/+$/, '') + '/v1/voices', { method: 'POST', body: fd });
        writeJson(res, 200, j);
      } catch (e) {
        writeJson(res, e && e.status ? e.status : 502, { error: (e && e.message) || String(e) });
      }
    }
  });

  // 7) POST /voices/clone —— multipart（ref_audio/ref_text/name）转发 Breeze /v1/voices
  const dClone = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/voices/clone',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return;
      try {
        const raw = await readRawBody(req, 16 * 1024 * 1024); // 1.1.0 顺手项 8：音频上传显式 16MB
        const ct = String(req.headers['content-type'] || '');
        if (!/multipart\/form-data/i.test(ct)) { writeErr(res, 400, 'expected multipart/form-data (ref_audio, ref_text, name)'); return; }
        const r = await fetch(breezeCfg.endpoint.replace(/\/+$/, '') + '/v1/voices', {
          method: 'POST',
          headers: { 'Content-Type': ct },
          body: raw,
        });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch (_) {}
        if (!r.ok) { writeJson(res, r.status, { error: 'HTTP ' + r.status + (t ? ' · ' + t.slice(0, 200) : '') }); return; }
        writeJson(res, 200, j);
      } catch (e) {
        writeJson(res, 502, { error: (e && e.message) || String(e) });
      }
    }
  });

  // 8) DELETE /voices/<id> —— prefix 捕获，转发 Breeze 删除
  // ★★★ 2026-10-29 修（外部复核时挖出（原报告把「注册判重」与「路由匹配」混为一谈））：
  //   原来 path 写的是 '/dsh-breeze-tts-api/voices/'（**带尾斜杠**）。
  //   DSH 匹配器（dsh-host-webserver/lib/index.js match()）判的是：
  //       pathname === prefix || pathname.startsWith(`${prefix}/`)
  //   它拼的是 prefix + '/'。prefix 自己已带尾斜杠 ⇒ 拼出 '…/voices//'
  //   ⇒ **任何正常路径都不会以它开头 ⇒ 这条路由从来没生效过**。
  //   症状只是 DELETE 音色一律 404，看不出是路由写错的。
  //   同包另一条 prefix '/dsh-breeze-tts-audio'（无尾斜杠）一直正常 ⇒ 这是笔误不是通病。
  //   ⇒ 教益：kind:'prefix' 的 path 不能带尾斜杠，带了不报错、就是静默匹配不到。
  const dVoiceById = webServer.register({
    kind: 'prefix',
    path: '/dsh-breeze-tts-api/voices',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return;
      // ★ 2026-10-29 加：前缀路由不判 method 的话，PUT/GET /voices/<id> 会被当 DELETE 转发。
      //   （外部复核 P1-2 建议，采纳；但他说的"POST design 落进删除分支"不成立 ——
      //     exact 表优先，design/clone 有自己的 exact 路由，实测见 049_prove_route_priority.mjs）
      if (req.method !== 'DELETE') {
        writeErr(res, 405, 'method not allowed: this path only supports DELETE /voices/<id>');
        return;
      }
      try {
        const url = (req.url || '').split('?')[0];
        const id = decodeURIComponent(url.split('/').filter(Boolean).pop() || '');
        if (!id) { writeErr(res, 400, 'missing voice id'); return; }
        const j = await breezeFetchJson(breezeCfg.endpoint.replace(/\/+$/, '') + '/v1/voices/' + encodeURIComponent(id), { method: 'DELETE' });
        writeJson(res, 200, j);
      } catch (e) {
        writeJson(res, e && e.status ? e.status : 502, { error: (e && e.message) || String(e) });
      }
    }
  });

  // ── FR-8 配对码（方案 §三.1，退单 001-P1/002-P1 定稿）──
  // 两条取码通道：① 文件通道 config.json 的 pairCode（AI/人写文件，带外）② 现场通道 POST /pair/new（本机便利）。
  // 兑换 POST /pair：★不挂 gate（凭据入口本身，挂上即死锁）；防爆破＝同码错 5 次作废＋全局连错 3 次锁 10 分钟。
  const pairMem = { code: '', expiresAt: 0, attempts: 0, globalFails: 0, lockedUntil: 0 };
  const PAIR_TTL_MS = 5 * 60 * 1000, PAIR_MAX_ATTEMPTS = 5, PAIR_LOCK_MS = 10 * 60 * 1000, PAIR_GLOBAL_FAILS = 3;
  const genPairCode = () => String((randomBytes(4).readUInt32BE(0) % 900000) + 100000); // 1.1.0 顺手项 5：Math.random → crypto

  // 9) POST /pair/new —— 生成 6 位码，只存内存不落盘，5 分钟有效，全局同时一个
  const dPairNew = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/pair/new',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return; // 穿透模式下本机也要 token（不构成豁免，退单 002 三节）
      if (pairMem.lockedUntil > Date.now()) { writeJson(res, 423, { error: 'pairing locked (too many failures), retry later' }); return; }
      pairMem.code = genPairCode();
      pairMem.expiresAt = Date.now() + PAIR_TTL_MS;
      pairMem.attempts = 0;
      writeJson(res, 200, { code: pairMem.code, expiresInSec: PAIR_TTL_MS / 1000 });
    }
  });

  // 10) POST /pair —— 兑换配对码换 token。★不挂 gate（退单 002-P1：挂上即死锁）
  const dPair = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/pair',
    async handler(req, res) {
      try {
        const raw = await readRawBody(req, 4096);
        const p = JSON.parse(raw.toString('utf8') || '{}');
        const code = String(p.code || '').trim();
        if (!/^\d{6}$/.test(code)) { writeJson(res, 400, { error: 'bad code format (6 digits)' }); return; }
        if (pairMem.lockedUntil > Date.now()) {
          writeJson(res, 423, { error: 'pairing locked (too many failures), retry after ' + new Date(pairMem.lockedUntil).toISOString() });
          return;
        }
        let matched = false;
        // 通道②：内存现场码
        if (pairMem.code && pairMem.expiresAt > Date.now() && pairMem.attempts < PAIR_MAX_ATTEMPTS && code === pairMem.code) {
          matched = true;
          pairMem.code = ''; // 一次性：兑换即焚
        }
        // 通道①：文件 pairCode（config.json，AI/人写；兑换成功 host 自动删字段）
        // ★ FA-2 修法甲（验收 b436ef58 第七之二节）：从磁盘现读。
        //   根因：breezeCfg 只在模块加载时读一次（见 1737），之后无 watch/轮询 ⇒ 内存里的 pairCode
        //   恒为启动值，外部写文件进程看不见；且任何一次 PUT /config 会用内存整份盖盘把码抹掉。
        //   ⇒ 文件通道必须以磁盘为准，"AI 全设完人只用用"才成立。不引入 fs.watch（Windows rename 不稳）。
        if (!matched) {
          let diskPair = '';
          try { diskPair = String((readBreezeConfig() || {}).pairCode || ''); } catch (_) { diskPair = ''; }
          if (/^\d{6}$/.test(diskPair) && code === diskPair) {
            matched = true;
            delete breezeCfg.pairCode;            // 内存侧一并清（启动值，通常为空）
            // 兑换即焚：只从磁盘删该字段，其余字段保持磁盘原样，不拿内存盖盘（避免抹掉他人手改）
            try {
              const onDisk = readBreezeConfig();
              if (onDisk) { delete onDisk.pairCode; writeBreezeConfig(onDisk); }
            } catch (_) { /* 焚字段失败不影响本次兑换，但下次仍可用同一码——记日志 */ console.error('[breeze-tts] pairCode 焚毁写盘失败，请人工检查 config.json'); }
          }
        }
        if (!matched) {
          pairMem.attempts += 1;
          pairMem.globalFails += 1;
          if (pairMem.code && pairMem.attempts >= PAIR_MAX_ATTEMPTS) pairMem.code = ''; // 该码作废
          if (pairMem.globalFails >= PAIR_GLOBAL_FAILS) { pairMem.lockedUntil = Date.now() + PAIR_LOCK_MS; pairMem.globalFails = 0; }
          writeJson(res, 401, { error: 'wrong pairing code' });
          return;
        }
        pairMem.globalFails = 0;
        writeJson(res, 200, { token: breezeCfg.token });
      } catch (e) {
        writeJson(res, 400, { error: (e && e.message) || String(e) });
      }
    }
  });
  // 11) POST /base-audio —— A-3 甲方案（方案 §三-A3）：基准音频上传落盘。
  //     客户端（VoiceSettingsPanel onUploadAudio）把降采样后的 wav POST 上来，
  //     按内容 sha256 前 12 位命名存 base-audio/，返回 {file}；内容寻址天然去重
  //     （同音频重复上传不重复落盘）。引用计数/孤儿清理留下一版。
  //     ★ 文件名形态 base-<12位hex>.wav 必须与 resolveBaseAudioPath 白名单正则一致，混了全拒。
  const dBaseAudio = webServer.register({
    kind: 'exact',
    path: '/dsh-breeze-tts-api/base-audio',
    async handler(req, res) {
      if (breezeGate(req, res, { level: 'write' })) return; // 写盘；跨机需 token
      try {
        const body = await readRawBody(req, 16 * 1024 * 1024); // 与 client C-23 前置校验同上限
        if (!body || body.length < 44) { writeJson(res, 400, { error: 'not a wav (too small)' }); return; }
        const file = 'base-' + sha256Hex(body).slice(0, 12) + '.wav';
        const dir = path.join(BREEZE_CFG_DIR, 'base-audio');
        mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, file);
        if (!existsSync(fp)) writeFileSync(fp, body); // 内容寻址去重
        writeJson(res, 200, { file });
      } catch (e) {
        if (e && e.message === 'body too large') { writeJson(res, 413, { error: 'base audio too large (16MB max)' }); return; }
        writeErr(res, 500, 'base-audio save failed: ' + String((e && e.message) || e));
      }
    },
  });

  // B-1（方案 §四）：breeze 段路由生命周期接线（照 legacy 段 :1673-1684 模式）——
  // 插件卸载/重载时反注册。dsh 的 register 按 (kind,path) 判重，不反注册热重载会撞 duplicate。
  ctx.effect(() => () => dConfig?.(), 'breeze-tts: route config');
  ctx.effect(() => () => dHealth?.(), 'breeze-tts: route health');
  ctx.effect(() => () => dVoices?.(), 'breeze-tts: route voices');
  ctx.effect(() => () => dSpeakPreview?.(), 'breeze-tts: route speak-preview');
  ctx.effect(() => () => dDesign?.(), 'breeze-tts: route voices/design');
  ctx.effect(() => () => dClone?.(), 'breeze-tts: route voices/clone');
  ctx.effect(() => () => dVoiceById?.(), 'breeze-tts: route voices/:id');
  ctx.effect(() => () => dPairNew?.(), 'breeze-tts: route pair/new');
  ctx.effect(() => () => dPair?.(), 'breeze-tts: route pair');
  ctx.effect(() => () => dBaseAudio?.(), 'breeze-tts: route base-audio');
}

// FR-5 路由挂载：挂在主 apply 的 webServer 上（既有 webServer 变量作用域内追加注册）。
// 说明：本段与既有段零交叉——只在 apply 末尾追加一次 registerBreezeRoutes(webServer) 调用。
console.log('[breeze-tts] config:', BREEZE_CFG_FILE, '（token 不打印）');
