// dsh-breeze-tts — Client half (browser bundle).
// Hand-written in the harness module-loader format; `require` answers the
// platform externals (react), everything else is inlined.
//
// FA-6: `id` MUST equal the npm package name. The client-modules host resolves
// each boot-graph row by its package id and then asserts `factories.has(id)`;
// a mismatched id registers under a name nobody imports, and DSH reports
// `could not load "<pkg>": ... loaded without registering "<pkg>"`.
//
// ═══ factory 层 vs apply 层边界（小深提醒4 / 方案 §八-5，1.2.0 起写死）═══
// 本文件只有两层词法作用域，合并上游代码前先想清楚新东西放哪层：
//   【factory 层】= factory: require => { ... } 体内、apply 外（模块加载即执行）：
//     · module/exports/var module、BreezeWorkshop IIFE（:5230 起）、
//       IIFE 顶层名（react/h/_apiFetch/setApiFetch/fetchJson/fetchBlob/refreshAccessMode/
//       buildTokenCurl/WORKSHOP_ACCESS/DSH_API 等）、exports.inject / exports.apply 赋值。
//     · 规则：**够不到 apply 内的任何名字**（闭包由定义处决定）；要反向拿 apply 内的
//       运行时能力，走参数注入（A-1 模式：apply 内调 BreezeWorkshop.setApiFetch(...)）。
//   【apply 层】= :67 const apply = ctx => { ... } 体内（首次被 DSH 调用时才执行）：
//     · breezeApiFetch / breezePairOn401 / t / I18N / shared / sharedDefaults /
//       createLocalController / 全部运行时状态与设置页组件、downloadText 等。
//   【合并上游纪律】上游代码搬过来时**函数跟着搬、依赖必须跟着搬**——1.1.x 的全部
//     跨作用域事故（工坊调不到 breezeApiFetch、coerceVisibleEngine 三面、fmtMb 假 TDZ）
//     根源都是这条边界没被显式管理。拿不准放哪层 ⇒ 停手问，别猜。
// ═══════════════════════════════════════════════════════════════════════
window.__ModuleLoader__.load({
  id: "dsh-breeze-tts",
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

// 1.1.0 §二.2 上传前降采样：浏览器 decodeAudioData 全格式解码 → OfflineAudioContext 重采样
// 到 24kHz/mono → 手写 44 字节 WAV 头导出 16bit PCM（零依赖；host 侧无解码器，复杂度待在有
// 解码器的一端）。顺带满足 Breeze 实测结论：24kHz/16bit/mono 注册克隆质量最好（48kHz/24bit
// 会"女声变男声"）——既解超限又埋质量坑。
async function downsampleForUpload(file) {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return file; // 极老环境：原样上传（host 4MB 上限兜底）
  const decodeCtx = new AC();
  let decoded;
  try { decoded = await decodeCtx.decodeAudioData(ab); }
  finally { try { decodeCtx.close && decodeCtx.close(); } catch (_) {} }
  const frames = Math.max(1, Math.ceil(decoded.duration * 24000));
  const offline = new OfflineAudioContext(1, frames, 24000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const ch = rendered.getChannelData(0);
  const dataLen = ch.length * 2;
  const out = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(out);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < ch.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new File([out], (file.name || 'audio').replace(/\.[^.]+$/, '') + '-24k.wav', { type: 'audio/wav' });
}

    const apply = ctx => {
      const slots = ctx.get("slots");
      const hostLocale = ctx.get("locale");

      // ===== A-2（方案 §三-A2）：coerceVisibleEngine 及依赖提至 apply 顶层（自 createLocalController 内整体搬入）=====
      // ★★★ 2026-10-29（产品决定：这三个引擎先不对外，但代码留着）：
      //   本地那三个引擎（IndexTTS / GPT-SoVITS / 本地模型文件夹）都要 spawn 包内
      //   `adapters/*.py` 的 Python worker，而**发布包里一个 worker 都没带**
      //   （独立查证：全项目零个 worker，5 个 .py 全是我们自己的工具脚本）。
      //   ⇒ 用户选中 = 点一下 → 等 → 报「加载失败」，看不出是脚本没随包发。
      //
      //   处置：**代码一行不删，只把界面入口藏起来**。哪天 worker 到位了，把下面这个
      //     开关改成 true 就全回来 —— 不用重写任何逻辑。
      //   ★ 保留 `generic`（通用本地 TTS）：它走 HTTP / custom-http，**不需要 worker**，
      //     是真能用的，所以不藏。
      const LOCAL_ENGINES_AVAILABLE = false;   // ← worker 补齐后改 true
      const HIDDEN_ENGINES = LOCAL_ENGINES_AVAILABLE ? [] : ['indextts', 'gpt-sovits', 'folder'];
      const engineVisible = (id) => !HIDDEN_ENGINES.includes(id);
      // ★ 老用户/默认值可能停在被隐藏的引擎上（defaults.engine 原本就是 'indextts'）
      //   ⇒ 加载持久化设置后要给一个可见的落点，否则下拉显示空、区块也不渲染，看着像坏了。
      // ★★★ 2026-10-30 02:5x 阿枢修 TDZ（真 1.0.0 / 1.1.1 共同的启动崩溃根因）：
      //   原来写的是 `const coerceVisibleEngine = (c) => {...}`，但它在上面
      //   `shared.localProcess = {...}` 之后**立刻就被调用了**（相隔十几行），
      //   而 `const` 有暂时性死区 ⇒ 抛 ReferenceError: Cannot access
      //   'coerceVisibleEngine' before initialization ⇒ 整个 apply() 抛错
      //   ⇒ DSH 报 `dsh-breeze-tts: failed` / `web boot: 1 entry did not activate`。
      //   blind 版没有这个函数所以能跑；1.0.0 引入它时把定义放晚了。
      //   ⇒ 改用函数声明（会提升），一行改动、行为完全一致。
      function coerceVisibleEngine(c) {
        if (!c || engineVisible(c.engine)) return c;
        c.engine = 'generic';
        if (c.launchPreset !== 'custom') c.launchPreset = 'custom';
        return c;
      }

      // BEGIN HOST CLIENT
// Public message selectors differ across Harness 0.1 and 0.2. Keep that
// distinction at this boundary; playback and sentence logic share one path.
const EMPTY_HOST_MESSAGES = Object.freeze([]);
const hostMessageCapability = { supported: true };
// FR-6/7/8（方案 §4.3-4）：所有 /dsh-breeze-tts-api/* 统一走此封装——localStorage 存有
// breezeTtsToken（配对/弹框获得）就带 Bearer；同机/免 token 场景零影响。
async function breezeApiFetch(url, opts = {}) {
  let token = '';
  try { token = localStorage.getItem('breezeTtsToken') || ''; } catch (_) {}
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  // FR-8：穿透/跨机 401 → 配对弹框一次 → 重试一次（breezePairOn401 自带防循环闸）
  if (r.status === 401 && !opts.__breezeNoPairRetry) {
    const paired = await breezePairOn401();
    if (paired) return breezeApiFetch(url, Object.assign({}, opts, { __breezeNoPairRetry: true }));
  }
  return r;
}
// FR-8（方案 §4.3-5）：/dsh-breeze-tts-audio/* 取 blob（穿透模式无 token 会被 gate 拦）——
// 保持 <audio> 元素控制链（pause/rate 不变），仅把 src 换成授权取回的 blob URL；?t= 方案已否决。
async function authorizeAudioUrl(url) {
  let token = '';
  try { token = localStorage.getItem('breezeTtsToken') || ''; } catch (_) {}
  try {
    const r = await fetch(url, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
    if (!r.ok) return url; // 401 等回退原 URL，由既有 el.onerror 提示（非 blob，不进台账）
    return trackedUrl(URL.createObjectURL(await r.blob()));
  } catch (_) { return url; }
}

// 1.1.0 §二.4 blob 泄漏台账：authorizeAudioUrl 产出的 blob URL 统一登记，
// 三个安全 revoke 点（播完 onended／换 src 前／stopSpeaking 全收）走 releaseUrl；
// releaseUrl 幂等——非登记 URL（401 回退的原始 URL）天然跳过。
const blobRegistry = new Set();
function trackedUrl(u) { blobRegistry.add(u); return u; }
function releaseUrl(u) { if (u && blobRegistry.delete(u)) { try { URL.revokeObjectURL(u); } catch (_) {} } }

// FR-8：穿透模式 401 兜底交互（方案 §三.3 UI）——弹框一次，接受配对码（6 位）或 token（长 hex）；
// 兑换成功存 localStorage 后由调用方重试。每次 fetch 只提示一轮，失败即放行原响应（防循环）。
let breezePairPromptBusy = false;
async function breezePairOn401() {
  if (breezePairPromptBusy) return false;
  breezePairPromptBusy = true;
  try {
    // 本函数在 apply() 体内，t() 虽声明在下文（约 943 行）但属函数声明、会提升，
    // 这里直接调用是合法的（勿再误判为"域外"而退回中文硬编码——10-29 栽过）。
    const input = window.prompt(t('pair.prompt'));
    if (!input) return false;
    const v = input.trim();
    if (/^\d{6}$/.test(v)) {
      const r = await fetch('/dsh-breeze-tts-api/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: v }),
      });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j || !j.token) return false;
      try { localStorage.setItem('breezeTtsToken', j.token); } catch (_) {}
      return true;
    }
    if (v.length >= 32) {
      try { localStorage.setItem('breezeTtsToken', v); } catch (_) {}
      return true;
    }
    return false;
  } catch (_) { return false; }
  finally { breezePairPromptBusy = false; }
}
function selectHostMessageSnapshot(snapshot) {
  if (snapshot == null) return EMPTY_HOST_MESSAGES;
  const nodes = snapshot.legacy?.nodes ?? snapshot.nodes;
  hostMessageCapability.supported = Array.isArray(nodes);
  return hostMessageCapability.supported ? nodes : EMPTY_HOST_MESSAGES;
}
function useHostMessages(props) {
  if (typeof props.useChat === 'function') return props.useChat(selectHostMessageSnapshot) || EMPTY_HOST_MESSAGES;
  if (typeof props.useSession === 'function') return props.useSession(selectHostMessageSnapshot) || EMPTY_HOST_MESSAGES;
  return selectHostMessageSnapshot(props.session);
}

// END HOST CLIENT

      // BEGIN UPDATE CLIENT
// The market owns package replacement, validation and rollback. This client
// only checks this repository's releases and requests an explicit update.
// 本地自用版：不走上游 GitHub 发版。版本号与 package.json 保持一致，
// 改 package.json 的 version 时这里要一起改（否则设置页显示的版本会对不上列表页）。
const LOCAL_PLUGIN_VERSION = "1.2.0";   // ★ 2026-10-30 阿枢：跟 package.json 同步（原为 1.0.0）
const LOCAL_PLUGIN_PACKAGE = 'dsh-breeze-tts';
// 留空 = 不做远端检查。check() 见空即 `return Promise.resolve(null)`（不发明白请求），
// state.latest 保持 null ⇒ 界面走 update.help 分支，不会谎报"已是最新"。
const LOCAL_PLUGIN_REPO = '';
const LOCAL_PLUGIN_UPDATE_KEY = 'dsh-local-ai-tts-update-v1';
function releaseVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value || '');
  if (!match) return null;
  const core = match.slice(1, 4).map(Number), pre = match[4]?.split('.') || [];
  if (!core.every(Number.isSafeInteger) || pre.some(id => /^\d+$/.test(id) && id.length > 1 && id[0] === '0')) return null;
  return [...core, pre];
}
function compareReleaseVersions(a, b) {
  const left = releaseVersion(a), right = releaseVersion(b);
  if (!left || !right) throw new Error('Invalid plugin release version.');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  const lp = left[3], rp = right[3];
  if (!lp.length || !rp.length) return lp.length === rp.length ? 0 : lp.length ? -1 : 1;
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    if (lp[i] === rp[i]) continue;
    if (lp[i] === undefined || rp[i] === undefined) return lp[i] === undefined ? -1 : 1;
    const ln = /^\d+$/.test(lp[i]), rn = /^\d+$/.test(rp[i]);
    if (ln && rn) return BigInt(lp[i]) < BigInt(rp[i]) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return lp[i] < rp[i] ? -1 : 1;
  }
  return 0;
}
function selectPluginRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release response.');
  let latest = null;
  for (const release of releases) {
    if (!release || release.draft || !releaseVersion(release.tag_name)) continue;
    const version = release.tag_name.replace(/^v/, '');
    const filename = `dsh-external-dsh-plugin-local-ai-tts-${version}.tgz`;
    const archive = `https://github.com/${LOCAL_PLUGIN_REPO}/releases/download/${release.tag_name}/${filename}`;
    if (!Array.isArray(release.assets) || !release.assets.some(asset => asset.name === filename && asset.browser_download_url === archive)) continue;
    if (!latest || compareReleaseVersions(version, latest.version) > 0)
      latest = { version, candidate: !!release.prerelease, url: `https://github.com/${LOCAL_PLUGIN_REPO}/releases/tag/${release.tag_name}` };
  }
  if (!latest) throw new Error('No complete plugin release is available.');
  return latest;
}
function createPluginUpdater({ request = fetch, storage = localStorage, current = LOCAL_PLUGIN_VERSION, changed = notify, now = Date.now } = {}) {
  const state = { current, latest: null, checking: false, installing: false, installed: false, error: null, auto: false };
  let checkedAt = 0, checking;
  try {
    const saved = JSON.parse(storage.getItem(LOCAL_PLUGIN_UPDATE_KEY) || 'null');
    if (saved) {
      state.auto = saved.auto !== false;
      if (saved.latest && releaseVersion(saved.latest.version) && Number.isFinite(saved.at) && saved.at <= now()) {
        state.latest = { version: saved.latest.version, candidate: !!saved.latest.candidate };
        checkedAt = saved.at;
      }
    }
  } catch { /* browser storage can be unavailable */ }
  function save() {
    try { storage.setItem(LOCAL_PLUGIN_UPDATE_KEY, JSON.stringify({ auto: state.auto, at: checkedAt, latest: state.latest })); } catch { /* browser storage can be unavailable */ }
  }
  async function json(url, options = {}) {
    const response = await request(url, { ...options, credentials: url.startsWith('https:') ? 'omit' : 'same-origin', signal: AbortSignal.timeout(options.method === 'POST' ? 600000 : 15000) });
    if (response.status === 404 && url.startsWith('/dsh-market/')) throw new Error(t("update.marketMissing"));
    const data = await response.json();
    if (!response.ok || data?.error) throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
    return data;
  }
  function check(force = false) {
    if (checking) return checking;
    if (!LOCAL_PLUGIN_REPO) return Promise.resolve(null); // FR-6/7/8 B6：repo 置空则短路，不发白打请求
    if (!force && checkedAt && now() - checkedAt < 86400000) return Promise.resolve(state.latest);
    state.checking = true; state.error = null; changed();
    checking = (async () => {
      try {
        state.latest = selectPluginRelease(await json(`https://api.github.com/repos/${LOCAL_PLUGIN_REPO}/releases?per_page=30`));
        checkedAt = now(); save(); return state.latest;
      } catch (error) { state.error = error.message; return null; }
      finally { state.checking = false; checking = null; changed(); }
    })();
    return checking;
  }
  async function install(confirm) {
    if (state.installing || state.installed) return false;
    state.installing = true; state.error = null; changed();
    try {
      const release = await check(true);
      if (!release) return false;
      if (compareReleaseVersions(release.version, current) <= 0) return false;
      if (!confirm(release)) return false;
      // Refresh the installed source before choosing the market operation.
      const updates = await json('/dsh-market/updates?force=1');
      const source = updates.updates?.[LOCAL_PLUGIN_PACKAGE];
      if (!source || !['github', 'linked'].includes(source.kind)) throw new Error(t("update.sourceHelp"));
      if (source.kind === 'github' && releaseVersion(source.version) && compareReleaseVersions(source.version, release.version) >= 0 && source.updateAvailable === false) {
        state.installed = true; return true;
      }
      const result = await json('/dsh-market/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: LOCAL_PLUGIN_PACKAGE, force: true, ...(source.kind === 'linked' ? { restore: true } : {}) }),
      });
      if (result.ok !== true || result.cancelled || result.stale || result.timedOut || result.compatibility?.ok === false)
        throw new Error(result.error || t("update.failed"));
      // The old module stays loaded until Harness restarts.
      state.installed = true; return true;
    } catch (error) { state.error = error.message; return false; }
    finally { state.installing = false; changed(); }
  }
  return { state, check, install, available: () => state.latest && compareReleaseVersions(state.latest.version, current) > 0,
    setAuto(value) { state.auto = !!value; save(); changed(); } };
}
const pluginUpdater = createPluginUpdater();
function PluginUpdatePanel() {
  useSharedForce(); useI18n();
  const state = pluginUpdater.state;
  react.useEffect(() => { if (state.auto) void pluginUpdater.check(); }, [state.auto]);
  const busy = state.checking || state.installing;
  // 本地自用版（LOCAL_PLUGIN_REPO 为空）：没有远端可查，就不摆"检查更新/立即安装"
  // 那两个按了也没反应的按钮，也不链到上游作者的仓库——只如实报版本号。
  const localMode = !LOCAL_PLUGIN_REPO;
  return react.createElement('section', { className: 'dsh-local-ai-tts-module', style: { display: 'block' } },
    react.createElement('div', { className: 'dsh-local-ai-tts-module-title' }, t("update.title") + ' · v' + state.current),
    react.createElement('p', { className: 'dsh-local-ai-tts-module-desc', role: 'status' },
      localMode ? t("update.localOnly") :
      state.installed ? t("update.restart") : busy ? t("update.busy") : state.latest ?
        (pluginUpdater.available() ? t("update.available") : t("update.current")) + ' v' + state.latest.version + (state.latest.candidate ? ' · ' + t("update.candidate") : '') : t("update.help")),
    localMode ? null : react.createElement('label', { className: 'dsh-local-ai-tts-check' },
      react.createElement('input', { type: 'checkbox', checked: state.auto, onChange: e => pluginUpdater.setAuto(e.target.checked) }), t("update.auto")),
    localMode ? null : react.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
      react.createElement('button', { type: 'button', className: 'dsh-local-ai-tts-btn', disabled: busy, onClick: () => void pluginUpdater.check(true) }, t("update.check")),
      react.createElement('button', { type: 'button', className: 'dsh-local-ai-tts-btn', disabled: busy || state.installed || !pluginUpdater.available(),
        onClick: () => void pluginUpdater.install(release => window.confirm(t("update.confirm") + ' v' + release.version + (release.candidate ? ' · ' + t("update.candidate") : ''))) }, t("update.install"))),
    state.error && react.createElement('p', { role: 'alert' }, state.error));
}

// END UPDATE CLIENT

      // BEGIN COEXISTENCE CLIENT
// Embedded by build-client.mjs. All names and state belong to this fork.
const coexistence = { upstream: false, companion: false, upstreamAutoRead: null };
const UPSTREAM_TTS_PACKAGE = '@dsh-external/dsh-plugin-tts';
function detectUpstreamTts() {
  try {
    const loader = ctx.get('loader');
    if (typeof loader?.entries === 'function') {
      return Array.from(loader.entries()).some(e => e.options?.name === UPSTREAM_TTS_PACKAGE &&
        e.disabled !== true && e.options?.disabled !== true);
    }
  } catch {}
  const graph = window.__DSH_BOOT__;
  if (Array.isArray(graph?.entries)) return graph.entries.some(e => e.id === UPSTREAM_TTS_PACKAGE);
  // Older Harness versions may expose neither inventory nor boot metadata.
  // Upstream itself exports this settings getter. Read it; never replace it.
  return typeof window.__dshTtsSettings?.get === 'function';
}
function upstreamAutoRead() {
  try {
    const value = window.__dshTtsSettings?.get?.().autoRead;
    return typeof value === 'boolean' ? value : null;
  } catch { return null; }
}
function localAutoAllowed() {
  return !coexistence.companion || (coexistence.upstream && upstreamAutoRead() === false);
}
function refreshCoexistence() {
  const upstream = detectUpstreamTts();
  const companion = upstream || shared.coexistenceMode === 'companion';
  const auto = upstream ? upstreamAutoRead() : null;
  const changed = companion !== coexistence.companion || upstream !== coexistence.upstream || auto !== coexistence.upstreamAutoRead;
  Object.assign(coexistence, { upstream, companion, upstreamAutoRead: auto });
  if (companion && shared.provider !== 'local-runtime' && shared.provider !== 'indextts-process' && shared.provider !== 'gpt-sovits-process') {
    stopSpeaking(); shared.provider = shared.localProcess?.command ? 'indextts-process' : 'local-runtime';
  }
  if (companion && auto !== false && shared.speakSource === 'auto') stopSpeaking();
  if (companion) shared.hideSelectionRead?.();
  if (changed) { localRuntime.sync(); notify(); }
}
function CoexistenceNotice() {
  useSharedForce(); useI18n();
  const h = react.createElement;
  // 已经没装原版插件时（最常见状态），整块共存配置都是空的：下拉框换什么都不会
  // 有差别。所以收成一行 + 可展开，而不是删掉——真与原版并存时它仍然是要用的开关。
  if (!coexistence.companion) {
    return h('section', { className: 'dsh-local-ai-tts-module dsh-local-ai-tts-module-stack', 'aria-label': t("coexist.title") },
      h('details', null,
        h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t("coexist.title")),
        h('p', { role: 'status', className: 'dsh-local-ai-tts-module-desc', style: { marginTop: 6 } }, t("coexist.standalone")),
        h('label', null, t("coexist.mode"), h('select', {
          className: 'dsh-local-ai-tts-select', value: shared.coexistenceMode,
          onChange: e => { shared.coexistenceMode = e.target.value; refreshCoexistence(); saveSettings(); notify(); },
        }, h('option', { value: 'auto' }, t("coexist.auto")), h('option', { value: 'companion' }, t("coexist.force"))))));
  }
  return h('section', { className: 'dsh-local-ai-tts-module dsh-local-ai-tts-module-stack', 'aria-label': t("coexist.title") },
    h('strong', null, t("coexist.title")),
    h('p', { role: 'status', className: 'dsh-local-ai-tts-module-desc' }, t("coexist.companion")),
    !localAutoAllowed() ? h('p', { role: 'status' }, t("coexist.autoBlocked")) : null,
    h('label', null, t("coexist.mode"), h('select', {
      className: 'dsh-local-ai-tts-select', value: shared.coexistenceMode,
      onChange: e => { shared.coexistenceMode = e.target.value; refreshCoexistence(); saveSettings(); notify(); },
    }, h('option', { value: 'auto' }, t("coexist.auto")), h('option', { value: 'companion' }, t("coexist.force")))));
}

// END COEXISTENCE CLIENT

      // ------------------------------------------------------------------
      // i18n — full zh/en coverage for the whole plugin UI. The plugin is a
      // legacy hand-written bundle, so i18n is a minimal t() over two inline
      // dictionaries (zh / en) with a language setting: "auto" follows the
      // browser/host locale, "zh" and "en" force a language. `t(key, params)`
      // resolves key -> string, substitutes {name} placeholders, and falls
      // back to en then to the key itself so the UI never blanks.
      // ------------------------------------------------------------------
      const UI_LOCALES = { zh: "zh", en: "en" }; // canonical values
      function resolveLocale(pref) {
        if (pref === "zh" || pref === "en") return pref;
        const candidates = [];
        try {
          const snapshot = hostLocale?.getSnapshot?.() || hostLocale?.getLocale?.();
          if (snapshot?.active) candidates.push(snapshot.active);
        } catch (e) {}
        try {
          if (document?.documentElement?.lang) candidates.push(document.documentElement.lang);
        } catch (e) {}
        try {
          if (navigator) candidates.push(...(navigator.languages || []), navigator.language || "");
        } catch (e) {}
        for (const code of candidates) {
          if (/^zh(?:-|$)/i.test(code)) return "zh";
          if (/^en(?:-|$)/i.test(code)) return "en";
        }
        return "en";
      }
      // Language preference is persisted in localStorage (same pattern as the
      // voice-pack settings below) so the chosen UI language survives reloads.
      const LANG_KEY = "dsh-local-ai-tts-lang";
      function loadPersistedLang() {
        try {
          const v = localStorage.getItem(LANG_KEY);
          if (v === "zh" || v === "en" || v === "auto") return v;
        } catch (e) { /* non-fatal */ }
        return "auto";
      }
      const I18N = {
        lang: loadPersistedLang(), // "auto" | "zh" | "en" (persisted via localStorage)
        dict: {
          zh: {
            "coexist.title": "与原版插件共存",
            "coexist.standalone": "未检测到原版：本插件提供 Edge TTS、RVC 和 Local Runtime。设置独立保存。",
            "coexist.companion": "本地补充模式：Edge/RVC、选中文本朗读和审批播报交给原版；这里仅提供 Local Runtime。",
            "coexist.autoBlocked": "请先关闭原版 Auto Read。原版已开启或状态未知时，本地自动朗读暂停，手动本地朗读仍可用。",
            "coexist.mode": "共存检测",
            "coexist.auto": "自动检测",
            "coexist.force": "始终仅提供本地功能",
            "coexist.localAuto": "本地 Auto Read",
            "coexist.localRead": "本地朗读此消息",
            "coexist.tab": "本地语音",
            "pair.prompt": "需要凭据（穿透模式已开启）。\n输入 6 位配对码，或直接粘贴管理 token：",
            "autoRead.on": "自动朗读已开启",
            "autoRead.off": "自动朗读已关闭",
            "autoRead.label": "自动朗读",
            "autoRead.on.title": "自动朗读：开启（点击关闭）",
            "autoRead.off.title": "自动朗读：关闭（点击开启）",
            "stopRead.part.lead": "停止朗读（第 ",
            "stopRead.part.tail": " 段播放中）",
            "stopRead": "停止朗读",
            "readThisMessage": "朗读本条消息",
            "mini.pause": "暂停",
            "mini.resume": "继续播放",
            "mini.speed": "播放速度",
            "mini.speedTip": "切换朗读速度（1x / 1.25x / 1.5x）",
            "download.audio": "下载音频",
            "download.notSupported": "长文本分段朗读暂不支持导出为单个音频文件",
            "download.fail": "下载失败：",
            "sel.read": "朗读选中文本",
            "voice.xiaoxuan": "晓萱（zh-CN-XiaoxuanNeural）",
            "voice.xiaoyi": "晓伊（zh-CN-XiaoyiNeural）",
            "voice.yunxi": "云希（zh-CN-YunxiNeural）",
            "voice.yunyang": "云扬（zh-CN-YunyangNeural）",
            "voice.xiaoxiao": "晓晓（zh-CN-XiaoxiaoNeural）",
            "voice.yunjian": "云健（zh-CN-YunjianNeural）",
            "voice.yunxia": "云夏（zh-CN-YunxiaNeural）",
            "voice.xiaobei": "晓北·辽宁（zh-CN-liaoning-XiaobeiNeural）",
            "voice.xiaoni": "晓妮·陕西（zh-CN-shaanxi-XiaoniNeural）",
            "voice.hsiaochen": "曉臻（zh-TW-HsiaoChenNeural）",
            "voice.hsiaoyu": "曉雨（zh-TW-HsiaoYuNeural）",
            "voice.yunjhe": "雲哲（zh-TW-YunJheNeural）",
            "voice.hiugaai": "曉佳（zh-HK-HiuGaaiNeural）",
            "voice.hiumaan": "曉曼（zh-HK-HiuMaanNeural）",
            "voice.wanlung": "雲龍（zh-HK-WanLungNeural）",
            "voice.nanami": "七海（ja-JP-NanamiNeural）",
            "voice.svetlana": "斯韦特兰娜（ru-RU-SvetlanaNeural）",
            "voice.dmitry": "德米特里（ru-RU-DmitryNeural）",
            "preview.defaultText": "你好，这是一个语音测试。",
            "preview.emptyError": "请输入要试听的内容",
            "synthFail": "语音合成失败：",
            "fileListFail": "读取文件列表失败：",
            "tab.index": "索引",
            "tab.model": "模型",
            "busy.preparing": "准备中…",
            "packs.needUrl": "请先填写音色包仓库地址",
            "packs.listFail": "获取列表失败：",
            "packs.waitingStart": "等待开始",
            "packs.done": "完成",
            "packs.installedEnabled": "已安装并启用「",
            "packs.alreadyLatest": "（已是最新版本）",
            "packs.installFail": "安装失败：",
            "packs.unknownError": "未知错误",
            "packs.confirmUninstall.lead": "确定卸载音色包「",
            "packs.confirmUninstall.tail": "」？将删除已下载的模型与索引文件。",
            "packs.uninstalled": "已卸载「",
            "packs.uninstallFail": "卸载失败：",
            "diag.httpUnavailable": "诊断接口不可用（HTTP ",
            "diag.httpUnavailable.tail": "）：插件 Host 已更新但 dsh web 未重启，请重启 dsh web 后重试",
            "diag.httpFail": "诊断失败（HTTP ",
            "diag.httpFail.tail": "），请稍后重试",
            "diag.title": "诊断",
            "diag.desc": "一键检查：Edge TTS 在线合成是否正常、本地 RVC 服务是否已启动、模型是否已加载",
            "diag.running": "检查中…（约 1-2 秒）",
            "diag.run": "运行诊断",
            "diag.fail": "诊断失败：",
            "packs.title": "音色包",
            "packs.desc": "从网上（或朋友的分享）一键下载现成音色，下载好自动启用，不用自己找文件",
            "packs.installTo": "下载后安装到：",
            "packs.installTo.tail": "（模型与索引会自动填入上方 RVC 配置）",
            "packs.registryUrl": "仓库地址",
            "packs.loading": "加载中…",
            "packs.fetchList": "获取列表",
            "packs.registryHelp": "音色作者会给你一个网址（仓库地址），填进去点「获取列表」就能看到有哪些音色。下载和文件校验由插件自动完成",
            "packs.proxy": "代理地址（可选）",
            "packs.proxyPlaceholder": "http://127.0.0.1:7897（Clash 等本地代理）",
            "packs.proxyHelp": "直连 GitHub raw 很慢时（实测 ~100KB/s），填本地代理（如 Clash 的 http://127.0.0.1:7897）可提速到十几 MB/s；留空 = 直连",
            "packs.fetching": "正在获取清单…",
            "packs.installedV": "已安装 v",
            "packs.uninstall": "卸载",
            "packs.downloading": "下载中…",
            "packs.downloadEnable": "下载并启用",
            "packs.indexVersion": "索引版本：",
            "packs.modelSep": " ｜ 模型 ",
            "packs.plusIdx": " + 可选索引 ",
            "packs.count": " 个（",
            "packs.plusIndex": " + 索引 ",
            "packs.noIndex": "（免索引）",
            "packs.licenseSep": " ｜ 许可 ",
            "packs.unknown": "未知",
            "packs.authorSep": " ｜ 作者 ",
            "packs.copyright": "只能安装版权允许分发的音色（注意看每个包的「许可」）。演示音色 azusa-test 受版权限制，不会出现在公开仓库里。",
            "compact.size2k": "2k（约 6 MB）",
            "compact.size5k": "5k（约 15 MB）",
            "compact.size10k": "10k（约 30 MB）",
            "compact.size20k": "20k（约 60 MB）",
            "compact.needIndex": "请先填写或选择要压缩的索引路径",
            "compact.fail": "生成失败：",
            "compact.noIndex": "（未填写索引路径）",
            "compact.desc": "生成紧凑索引 —— 把大索引变小：从原索引中抽样重建，音色还原度基本不变。索引越小，加载越快、越容易分享",
            "compact.source": "来源：",
            "compact.building": "构建中…",
            "compact.generate": "生成",
            "compact.close": "关闭",
            "compact.reading": "正在读取大索引并抽样重建…（约几秒到几十秒，内存峰值 ~1GB）",
            "compact.alreadySmall.lead": "原索引已足够小（",
            "compact.alreadySmall.tail": "），无需压缩。",
            "compact.generated": "已生成：",
            "compact.orig": "，原 ",
            "compact.autoFill": "%），已自动填入索引路径。",
            "picker.readingFiles": "正在读取文件列表…",
            "picker.found": "发现 ",
            "picker.foundTail": " 个文件（点击选择）",
            "picker.none": "未发现文件（可手动输入路径）",
            "f0.default": "默认",
            "f0.semitones": " 半音",
            "baseVoice.yunyang": "云扬（男声）",
            "baseVoice.yunxi": "云希（男声）",
            "baseVoice.yunxia": "云夏（男声）",
            "baseVoice.xiaoxiao": "晓晓（女声）",
            "baseVoice.xiaoyi": "晓伊（女声）",
            "baseVoice.guy": "Guy（en 男声）",
            "baseVoice.jenny": "Jenny（en 女声）",
            "f0.rmvpe": "rmvpe（效果最好）",
            "f0.pm": "pm（最快）",
            "f0.harvest": "harvest（低音好但慢）",
            "f0.crepe": "crepe（吃 GPU）",
            "section.voiceTuning": "声音调节",
            "voiceTuning.desc": "调整朗读的语气和速度（转换前生效，最终音色会保留这些语调）",
            "voiceTuning.edgeDesc": "直接作用于 Edge TTS 朗读（0 = 默认）",
            "field.rate": "语速",
            "field.rate.tip": "朗读快慢：向左慢、向右快，0 为默认",
            "field.pitch": "音调",
            "field.pitch.tip": "声音高低：负值更低沉，正值更明亮",
            "field.volume": "音量",
            "field.volume.tip": "朗读响度：负值更轻，正值更响",
            "section.rvc": "RVC 配置",
            "rvc.desc": "用你自己训练好的音色模型来朗读。首次使用先启动本地 RVC 服务（macOS/Windows/Linux 命令见使用手册 §4.2 / RVC 指南）；服务没启动时点「浏览」会看到具体启动步骤。启动后再在这里填模型路径",
            "onboard.title": "首次使用 RVC？三步上手",
            "onboard.desc": "用自定义音色朗读需要：① 模型文件 (.pth)；② 本机正在运行的转换服务。",
            "onboard.steps": "① 先启动本地 RVC 服务（保持终端/窗口运行）；\n② 在下方「模型路径」选择或粘贴 .pth 文件；\n③ 索引可选；点「一键诊断」确认服务在线、模型已加载。",
            "onboard.cmd": "# Windows（PowerShell/CMD，<你的RVC目录> 换成实际路径）\n<你的RVC目录>/runtime/python.exe rvc-server.py --port 4892\n\n# macOS / Linux\n<你的RVC目录>/runtime/bin/python rvc-server.py --port 4892\n# 便携运行时：解压后运行 ./start-rvc-server.sh",
            "field.baseUrl": "服务地址",
            "field.baseUrl.tip": "一般保持默认即可：这是你电脑上那个转换服务的地址（默认 4892 端口）",
            "field.baseSource": "原声来源",
            "baseSource.edge": "让 Edge TTS 先读一遍",
            "baseSource.upload": "上传自己的音频",
            "baseSource.tip": "转换前的原声从哪里来：让 Edge TTS 自动读一遍（推荐，最方便），或上传你自己的一段录音/音频",
            "baseSource.uploadBtn": "上传音频",
            "baseSource.chooseFile": "选择文件",
            "baseSource.noFile": "未选择文件",
            "baseSource.uploadTip": "上传后直接用这段音频做转换，不再经过 Edge TTS；上面的语速/音调/音量设置不适用",
            "field.baseVoice": "原声音色",
            "field.baseVoice.tip": "转换前由 Edge TTS 用哪个声音读（决定语气和停顿）；转换后说话人声音会变成你模型的音色",
            "field.modelPath": "模型路径 (.pth)",
            "field.browse": "浏览",
            "field.modelPath.tip": "你的音色模型文件（.pth），通常叫 xxx.pth。用「浏览」从电脑上选，或直接粘贴路径",
            "field.indexPath": "索引路径 (.index)",
            "indexPath.empty": "留空 = 免索引",
            "indexPath.compactTip": "生成紧凑索引：把几百 MB 的索引缩到几 MB（音色还原度基本不变）",
            "indexPath.compact": "压缩索引",
            "indexPath.tip": "可选。留空 = 免索引（效果略降但能用）；「浏览」选 .index 文件；「压缩索引」把大索引缩到几 MB",
            "section.advanced": "高级参数（一般不用改）",
            "field.spkId": "说话人 ID",
            "field.spkId.tip": "多说话人模型选择说话人；单说话人模型保持 0",
            "field.f0Method": "f0 方法",
            "field.f0Method.tip": "音高检测算法：rmvpe 效果最好，pm 最快，harvest 低音好但慢",
            "field.f0UpKey": "变调",
            "field.f0UpKey.tip": "整体升降调：负值更低沉、正值更尖锐（可当声线调节）",
            "field.indexRate": "索引权重",
            "field.indexRate.tip": "越高越像模型原来的声音，越低越像你输入的原始声音（0 = 完全不用索引）",
            "field.resampleSr": "输出采样率",
            "field.resampleSr.tip": "输出音频采样率：越高细节越好、文件越大",
            "field.rmsMixRate": "响度混合",
            "field.rmsMixRate.tip": "输出音量包络混合比例：越高越接近模型训练者的响度习惯",
            "field.protect": "辅音保护",
            "field.protect.tip": "保护清辅音与呼吸声；过高会保留更多原声细节",
            "field.filterRadius": "滤波半径",
            "field.filterRadius.tip": "音高平滑滤波（仅 harvest 有效）：越大曲线越平滑",
            "field.f0File": "F0 曲线文件",
            "f0File.empty": "留空 = 自动提取音高",
            "f0File.tip": "手动指定音高曲线文件；留空自动提取",
            "provider.label": "TTS提供者",
            "provider.help": "Edge TTS：在线语音；RVC：音色转换；本地 AI TTS：内置引擎启动或通用 HTTP / worker 接口",
            "provider.generic": "通用本地 TTS（HTTP / worker）",
            "provider.folder": "本地模型文件夹（自动识别）",
            "local.title": "本地 AI 语音",
            "local.footnote": "本地语音 · 文件夹加载 / 通用接口 / 官方启动器",
            "provider.rvc": "自定义音色（RVC）",
            "field.voice": "朗读音色",
            "field.voice.tip": "选择朗读用的声音（仅 Edge TTS 模式可选）",
            "preview.title": "试听测试",
            "preview.text": "试听文本",
            "preview.stop": "停止试听",
            "preview.play": "试听",
            "preview.playing": "停止试听（播放中）",
            "chunk.playing.lead": "正在播放 第 ",
            "chunk.playing.tail": " 段 · 后续段落边播边合成…",
            "footnote": "由 Microsoft Edge TTS 驱动（node-edge-tts）。",
                        "err.chunkFail": "后续段落合成失败：",
            "err.audioDecode": "音频解码失败：",
            "err.chunkSkip": "某段音频加载失败，已跳过",
            "err.synthFailShort": "语音合成失败",
            "err.audioLoadRetry": "音频加载失败，请重试",
            "lang.label": "界面语言",
            "lang.auto": "自动（跟随 DSH）",
            "lang.zh": "中文",
            "lang.en": "English",
            "lang.modeAuto": "界面语言自动跟随 DSH 设置",
            "lang.modeManual": "界面语言已手动指定",
            "host.rvcUnreachable": "无法连接本地 RVC 推理服务",
            "host.rvcHttpFail": "RVC 接口失败",
            "host.rvcConvertNoAudio": "RVC /convert 返回异常",
            "host.noModelConfigured": "未配置 RVC 模型路径（设置 → 插件 → 语音 → RVC 配置）",
            "host.registryNotUrl": "仓库地址必须是 http(s) URL",
            "host.manifestInvalid": "清单格式无效",
            "host.manifestNoPacks": "清单格式无效（缺少 packs 数组）",
            "host.downloadFailed": "下载失败",
            "host.downloadStreamUnavailable": "下载流不可用",
            "host.sizeMismatch": "文件大小不符",
            "host.sha256Mismatch": "sha256 校验失败",
            "host.packNotFound": "仓库中没有该音色包",
            "host.packNoModel": "音色包缺少模型文件",
            "host.filesHttpFail": "文件列表接口异常",
            "host.filesNeedsServer": "读取文件列表失败：无法连接本地 RVC 服务（{baseUrl}）。\n\n请先启动 RVC 服务：\n{startup}\n\n启动成功后保持终端/窗口不关，再回来点「浏览」。如果服务已启动，请确认「服务地址」与端口一致。\n原始错误：{error}",
            "host.chunkFail": "后续段落合成失败",
            "host.compactNeedsServer": "生成紧凑索引失败：无法连接本地 RVC 服务（{baseUrl}）。\n\n请先启动 RVC 服务：\n{startup}\n\n启动成功后保持终端/窗口不关，再重试。如果服务已启动，请确认「服务地址」与端口一致。\n原始错误：{error}",
            "host.compactFail": "紧凑索引生成失败",
            "host.packsListFail": "获取音色包列表失败",
            "host.registryPackRequired": "registry 与 packId 必填",
            "host.packInstallFail": "音色包安装失败",
            "host.packIdRequired": "packId 必填",
            "host.packUninstallFail": "卸载失败",
            "host.phase.prepare": "准备",
            "host.phase.model": "模型",
            "host.phase.index": "索引",
"tab.voice": "Breeze 设置",
            "voice.removed": "所选音色已被端点移除，已自动切换回默认音色",
            "settings.reset": "恢复默认设置",
            "settings.resetDone": "已恢复默认设置",
            "update.title": "插件版本",
            "update.localOnly": "已发布至 GitHub（OldQin-Aurora001/dsh-breeze-tts）—— 更新请走插件市场。",
            "update.restart": "新版已安装。请重启 Harness 并刷新页面。",
            "update.busy": "正在检查或安装，请稍候。",
            "update.available": "发现新版",
            "update.current": "未发现更高版本，最新发布",
            "update.candidate": "发布候选版",
            "update.help": "检查本插件的 GitHub 发布，由插件市场执行更新。",
            "update.auto": "打开设置时自动检查更新（每天最多一次）",
            "update.check": "检查更新",
            "update.install": "更新安装",
            "update.confirm": "通过插件市场安装 GitHub 当前源码，完成后需要重启。继续？检测到发布版：",
            "update.releases": "发布记录",
            "update.manual": "手动更新命令",
            "update.sourceHelp": "固定安装包或无插件市场时，请用下方命令切换到 GitHub 来源；自定义配置请替换 web。",
            "update.marketMissing": "未检测到可用的 DSH 插件市场，请使用手动更新命令。",
            "update.failed": "更新未完成，请查看插件市场记录或使用手动更新命令。",
            "compat.messages": "宿主消息接口暂不受支持，消息朗读按钮已停用。请检查插件更新；仍可在设置中试听。",
            "toast.dismiss": "关闭",
            "toast.useEdge": "改用 Edge TTS 朗读",
            "toast.rvcFallback": "RVC 不可用，已临时改用 Edge TTS 朗读",
            "rvc.fallbackOn": "RVC 失败时自动改用 Edge TTS",
            "rvc.fallbackTip": "开启后：RVC 服务不可用或转换失败时，本条消息自动改用 Edge TTS 朗读。默认关闭——RVC 为纯本地处理，自动降级会把文本发送给微软在线端点",
            "notify.title": "事件语音提醒",
            "notify.desc": "会话内出现审批请求时用语音播报提醒：审批请求会打断当前朗读（高优先级），审批结果仅在空闲时播报。播报固定走 Edge TTS（不依赖 RVC 服务）。默认关闭",
            "notify.enabled": "启用审批语音提醒",
            "notify.approval": "审批请求（打断当前朗读）",
            "notify.approvalResult": "审批结果（空闲时播报）",
            "notify.voice": "提醒音色",
            "notify.approval.lead": "需要审批，",
            "notify.decided.lead": "审批结果：",
            "notify.decided.granted": "已批准",
            "notify.decided.rejected": "已拒绝",
            "notify.decided.settled": "已结束",
          },
          en: {
            "coexist.title": "Upstream plugin coexistence",
            "coexist.standalone": "Upstream not detected: Edge TTS, RVC and Local Runtime are available. Settings are stored separately.",
            "coexist.companion": "Local companion mode: upstream owns Edge/RVC, selection reading and approval alerts; this panel provides Local Runtime only.",
            "coexist.autoBlocked": "Turn off upstream Auto Read first. Local Auto Read is suspended while upstream is enabled or its state is unknown; manual local reading remains available.",
            "coexist.mode": "Coexistence detection",
            "coexist.auto": "Detect automatically",
            "coexist.force": "Always provide local features only",
            "coexist.localAuto": "Local Auto Read",
            "coexist.localRead": "Read this message locally",
            "coexist.tab": "Local voice",
            "pair.prompt": "Credentials required (tunnel mode is on).\nEnter the 6-digit pairing code, or paste the admin token directly:",
            "autoRead.on": "Auto-read on",
            "autoRead.off": "Auto-read off",
            "autoRead.label": "Auto-read",
            "autoRead.on.title": "Auto-read: ON (click to turn off)",
            "autoRead.off.title": "Auto-read: OFF (click to turn on)",
            "stopRead.part.lead": "Stop (section ",
            "stopRead.part.tail": " of {total} playing)",
            "stopRead": "Stop reading",
            "readThisMessage": "Read this message",
            "mini.pause": "Pause",
            "mini.resume": "Resume",
            "mini.speed": "Playback speed",
            "mini.speedTip": "Cycle reading speed (1x / 1.25x / 1.5x)",
            "download.audio": "Download audio",
            "download.notSupported": "Long chunked reads can't be exported as a single file yet",
            "download.fail": "Download failed: ",
            "sel.read": "Read selected text",
            "voice.xiaoxuan": "Xiaoxuan (zh-CN-XiaoxuanNeural)",
            "voice.xiaoyi": "Xiaoyi (zh-CN-XiaoyiNeural)",
            "voice.yunxi": "Yunxi (zh-CN-YunxiNeural)",
            "voice.yunyang": "Yunyang (zh-CN-YunyangNeural)",
            "voice.xiaoxiao": "Xiaoxiao (zh-CN-XiaoxiaoNeural)",
            "voice.yunjian": "Yunjian (zh-CN-YunjianNeural)",
            "voice.yunxia": "Yunxia (zh-CN-YunxiaNeural)",
            "voice.xiaobei": "Xiaobei-Liaoning (zh-CN-liaoning-XiaobeiNeural)",
            "voice.xiaoni": "Xiaoni-Shaanxi (zh-CN-shaanxi-XiaoniNeural)",
            "voice.hsiaochen": "HsiaoChen (zh-TW-HsiaoChenNeural)",
            "voice.hsiaoyu": "HsiaoYu (zh-TW-HsiaoYuNeural)",
            "voice.yunjhe": "YunJhe (zh-TW-YunJheNeural)",
            "voice.hiugaai": "HiuGaai (zh-HK-HiuGaaiNeural)",
            "voice.hiumaan": "HiuMaan (zh-HK-HiuMaanNeural)",
            "voice.wanlung": "WanLung (zh-HK-WanLungNeural)",
            "voice.nanami": "Nanami (ja-JP-NanamiNeural)",
            "voice.svetlana": "Svetlana (ru-RU-SvetlanaNeural)",
            "voice.dmitry": "Dmitry (ru-RU-DmitryNeural)",
            "preview.defaultText": "Hi, this is a voice test.",
            "preview.emptyError": "Enter some text to preview first",
            "synthFail": "Speech synthesis failed: ",
            "fileListFail": "Failed to load file list: ",
            "tab.index": "Index",
            "tab.model": "Model",
            "busy.preparing": "Preparing…",
            "packs.needUrl": "Enter a voice-pack registry URL first",
            "packs.listFail": "Failed to fetch list: ",
            "packs.waitingStart": "Waiting to start",
            "packs.done": "Done",
            "packs.installedEnabled": "Installed & enabled “",
            "packs.alreadyLatest": " (already latest)",
            "packs.installFail": "Install failed: ",
            "packs.unknownError": "Unknown error",
            "packs.confirmUninstall.lead": "Uninstall voice pack “",
            "packs.confirmUninstall.tail": "”? The downloaded model & index files will be deleted.",
            "packs.uninstalled": "Uninstalled “",
            "packs.uninstallFail": "Uninstall failed: ",
            "diag.httpUnavailable": "Diagnostics endpoint unavailable (HTTP ",
            "diag.httpUnavailable.tail": "): the plugin Host was updated but dsh web wasn't restarted — restart dsh web and retry",
            "diag.httpFail": "Diagnostics failed (HTTP ",
            "diag.httpFail.tail": "), please retry later",
            "diag.title": "Diagnostics",
            "diag.desc": "One-click check: Edge TTS synthesis, whether the local RVC service is up, and whether the model is loaded",
            "diag.running": "Checking… (about 1-2s)",
            "diag.run": "Run diagnostics",
            "diag.fail": "Diagnostics failed: ",
            "packs.title": "Voice packs",
            "packs.desc": "One-click download of ready-made voices from the web (or a friend's share); auto-enabled after download — no need to find files yourself",
            "packs.installTo": "Installs to:",
            "packs.installTo.tail": " (model & index are auto-filled into the RVC config above)",
            "packs.registryUrl": "Registry URL",
            "packs.loading": "Loading…",
            "packs.fetchList": "Fetch list",
            "packs.registryHelp": "The pack author gives you a URL (registry). Paste it and click “Fetch list” to see available voices. Download & file verification are handled automatically",
            "packs.proxy": "Proxy URL (optional)",
            "packs.proxyPlaceholder": "http://127.0.0.1:7897 (local proxy such as Clash)",
            "packs.proxyHelp": "When direct GitHub raw is slow (~100KB/s measured), a local proxy (e.g. Clash http://127.0.0.1:7897) can speed it to tens of MB/s; leave blank for direct",
            "packs.fetching": "Fetching manifest…",
            "packs.installedV": "Installed v",
            "packs.uninstall": "Uninstall",
            "packs.downloading": "Downloading…",
            "packs.downloadEnable": "Download & enable",
            "packs.indexVersion": "Index version: ",
            "packs.modelSep": "  model ",
            "packs.plusIdx": " + optional index ",
            "packs.count": " (",
            "packs.plusIndex": " + index ",
            "packs.noIndex": " (index-free)",
            "packs.licenseSep": "  license ",
            "packs.unknown": "Unknown",
            "packs.authorSep": "  author ",
            "packs.copyright": "Only install packs whose license permits redistribution (check each pack's “license”). The demo voice azusa-test is copyright-restricted and won't appear in public registries.",
            "compact.size2k": "2k (~6 MB)",
            "compact.size5k": "5k (~15 MB)",
            "compact.size10k": "10k (~30 MB)",
            "compact.size20k": "20k (~60 MB)",
            "compact.needIndex": "Enter or pick the index path to compact first",
            "compact.fail": "Generation failed: ",
            "compact.noIndex": " (no index path)",
            "compact.desc": "Build a compact index — shrink big indexes by sampling & rebuilding; timbre fidelity is basically unchanged. Smaller = faster load & easier to share",
            "compact.source": "Source: ",
            "compact.building": "Building…",
            "compact.generate": "Generate",
            "compact.close": "Close",
            "compact.reading": "Reading the big index and sampling… (a few sec to tens of sec, ~1GB peak memory)",
            "compact.alreadySmall.lead": "Source index is already small (",
            "compact.alreadySmall.tail": "), no compaction needed.",
            "compact.generated": "Generated: ",
            "compact.orig": ", source ",
            "compact.autoFill": "%), auto-filled into the index path.",
            "picker.readingFiles": "Reading file list…",
            "picker.found": "Found ",
            "picker.foundTail": " files (click to select)",
            "picker.none": "No files found (you can type the path manually)",
            "f0.default": "Default",
            "f0.semitones": " semitones",
            "baseVoice.yunyang": "Yunyang (male)",
            "baseVoice.yunxi": "Yunxi (male)",
            "baseVoice.yunxia": "Yunxia (male)",
            "baseVoice.xiaoxiao": "Xiaoxiao (female)",
            "baseVoice.xiaoyi": "Xiaoyi (female)",
            "baseVoice.guy": "Guy (EN male)",
            "baseVoice.jenny": "Jenny (EN female)",
            "f0.rmvpe": "rmvpe (best quality)",
            "f0.pm": "pm (fastest)",
            "f0.harvest": "harvest (good bass but slow)",
            "f0.crepe": "crepe (GPU heavy)",
            "section.voiceTuning": "Voice tuning",
            "voiceTuning.desc": "Adjust tone & speed of the read (applied before conversion; final voice keeps these intonations)",
            "voiceTuning.edgeDesc": "Applies directly to Edge TTS (0 = default)",
            "field.rate": "Rate",
            "field.rate.tip": "Reading speed: left slower, right faster, 0 = default",
            "field.pitch": "Pitch",
            "field.pitch.tip": "Pitch: negative lower, positive brighter",
            "field.volume": "Volume",
            "field.volume.tip": "Loudness: negative softer, positive louder",
            "section.rvc": "RVC Config",
            "rvc.desc": "Read with your own trained voice model. Start the local RVC service first (macOS/Windows/Linux commands: User Guide §4.2 / RVC Guide); if it is not running, clicking Browse shows the startup steps. Then fill in the model path here",
            "onboard.title": "New to RVC? Three steps",
            "onboard.desc": "Reading with a custom voice needs: ① a model file (.pth); ② a running local conversion service.",
            "onboard.steps": "① Start the local RVC service first (keep the terminal/window running);\n② Pick or paste the .pth in \"Model path\" below;\n③ Index is optional; click \"Run diagnostics\" to confirm the service is online and the model is loaded.",
            "onboard.cmd": "# Windows (PowerShell/CMD, replace <yourRvcDir>)\n<yourRvcDir>/runtime/python.exe rvc-server.py --port 4892\n\n# macOS / Linux\n<yourRvcDir>/runtime/bin/python rvc-server.py --port 4892\n# portable runtime: run ./start-rvc-server.sh after extracting",
            "field.baseUrl": "Service URL",
            "field.baseUrl.tip": "Usually keep default: the address of the conversion service on this PC (default port 4892)",
            "field.baseSource": "Base audio source",
            "baseSource.edge": "Let Edge TTS read it first",
            "baseSource.upload": "Upload your own audio",
            "baseSource.tip": "Where the pre-conversion base audio comes from: let Edge TTS read it (recommended, easiest), or upload your own recording/audio",
            "baseSource.uploadBtn": "Upload audio",
            "baseSource.chooseFile": "Choose file",
            "baseSource.noFile": "No file selected",
            "baseSource.uploadTip": "After upload this audio is used directly, bypassing Edge TTS; the rate/pitch/volume settings above don't apply",
            "field.baseVoice": "Base voice",
            "field.baseVoice.tip": "Which Edge TTS voice reads before conversion (sets tone & pauses); after conversion the speaker becomes your model's voice",
            "field.modelPath": "Model path (.pth)",
            "field.browse": "Browse",
            "field.modelPath.tip": "Your voice model file (.pth), usually xxx.pth. Use “Browse” to pick, or paste the path",
            "field.indexPath": "Index path (.index)",
            "indexPath.empty": "Leave blank = index-free",
            "indexPath.compactTip": "Build a compact index: shrink a few-hundred-MB index to a few MB (fidelity basically unchanged)",
            "indexPath.compact": "Compact index",
            "indexPath.tip": "Optional. Leave blank = index-free (slightly lower fidelity but works); “Browse” for a .index file; “Compact index” shrinks a big index to a few MB",
            "section.advanced": "Advanced (usually no need to change)",
            "field.spkId": "Speaker ID",
            "field.spkId.tip": "Choose speaker for multi-speaker models; keep 0 for single-speaker",
            "field.f0Method": "F0 method",
            "field.f0Method.tip": "Pitch-detection algorithm: rmvpe best, pm fastest, harvest good bass but slow",
            "field.f0UpKey": "Pitch shift",
            "field.f0UpKey.tip": "Shift pitch: negative deeper, positive brighter (can be used as voice tuning)",
            "field.indexRate": "Index rate",
            "field.indexRate.tip": "Higher = closer to the model's original voice, lower = closer to your input (0 = no index)",
            "field.resampleSr": "Output sample rate",
            "field.resampleSr.tip": "Output sample rate: higher = more detail, bigger file",
            "field.rmsMixRate": "RMS mix",
            "field.rmsMixRate.tip": "Output loudness-envelope mix; higher = closer to the model owner's loudness",
            "field.protect": "Consonant protect",
            "field.protect.tip": "Protects consonants & breaths; too high keeps more original detail",
            "field.filterRadius": "Filter radius",
            "field.filterRadius.tip": "Pitch smoothing (harvest only): larger = smoother curve",
            "field.f0File": "F0 curve file",
            "f0File.empty": "Leave blank = auto-extract pitch",
            "f0File.tip": "Specify a pitch-curve file manually; leave blank for auto",
            "provider.label": "TTS provider",
            "provider.help": "Edge TTS: online speech; RVC: voice conversion; Local AI TTS: built-in engine launchers or universal HTTP / worker connections",
            "provider.generic": "Universal local TTS (HTTP / worker)",
            "provider.folder": "Local model folder (auto detect)",
            "local.title": "Local AI TTS",
            "local.footnote": "Local speech · model folder / universal API / official launcher",
            "provider.rvc": "Custom voice (RVC)",
            "field.voice": "Reading voice",
            "field.voice.tip": "Choose the speaking voice (Edge TTS mode only)",
            "preview.title": "Preview test",
            "preview.text": "Preview text",
            "preview.stop": "Stop preview",
            "preview.play": "Preview",
            "preview.playing": "Stop preview (playing)",
            "chunk.playing.lead": "Playing section ",
            "chunk.playing.tail": " · later sections synthesizing while playing…",
            "footnote": "Powered by Microsoft Edge TTS (node-edge-tts).",
                        "err.chunkFail": "Later-section synthesis failed: ",
            "err.audioDecode": "Audio decoding failed: ",
            "err.chunkSkip": "A section failed to load, skipped",
            "err.synthFailShort": "Speech synthesis failed",
            "err.audioLoadRetry": "Audio failed to load, please retry",
            "lang.label": "Language",
            "lang.auto": "Auto (follow DSH)",
            "lang.zh": "中文",
            "lang.en": "English",
            "lang.modeAuto": "UI language follows the DSH setting automatically",
            "lang.modeManual": "UI language is set manually",
            "host.rvcUnreachable": "Cannot connect to the local RVC service",
            "host.rvcHttpFail": "RVC endpoint failed",
            "host.rvcConvertNoAudio": "RVC /convert returned an unexpected response",
            "host.noModelConfigured": "No RVC model path configured (Settings → Plugins → Voice → RVC Config)",
            "host.registryNotUrl": "Registry address must be an http(s) URL",
            "host.manifestInvalid": "Invalid manifest format",
            "host.manifestNoPacks": "Invalid manifest (missing packs array)",
            "host.downloadFailed": "Download failed",
            "host.downloadStreamUnavailable": "Download stream unavailable",
            "host.sizeMismatch": "File size mismatch",
            "host.sha256Mismatch": "sha256 verification failed",
            "host.packNotFound": "Voice pack not found in registry",
            "host.packNoModel": "Voice pack is missing the model file",
            "host.filesHttpFail": "File-list endpoint error",
            "host.filesNeedsServer": "Failed to read file list: cannot reach the local RVC service ({baseUrl}).\n\nStart the RVC service first:\n{startup}\n\nKeep the terminal/window open, then click Browse again. If it is already running, check the Service URL matches the port.\nRaw error: {error}",
            "host.chunkFail": "Later-section synthesis failed",
            "host.compactNeedsServer": "Failed to compact the index: cannot reach the local RVC service ({baseUrl}).\n\nStart the RVC service first:\n{startup}\n\nKeep the terminal/window open, then retry. If it is already running, check the Service URL matches the port.\nRaw error: {error}",
            "host.compactFail": "Compact index generation failed",
            "host.packsListFail": "Failed to fetch the voice-pack list",
            "host.registryPackRequired": "registry and packId are required",
            "host.packInstallFail": "Voice pack install failed",
            "host.packIdRequired": "packId is required",
            "host.packUninstallFail": "Uninstall failed",
            "host.phase.prepare": "Preparing",
            "host.phase.model": "Model",
            "host.phase.index": "Index",
"tab.voice": "Breeze Settings",
            "voice.removed": "The selected voice was removed by the endpoint; auto-fell back to default",
            "settings.reset": "Reset to defaults",
            "settings.resetDone": "Settings reset to defaults",
            "update.title": "Plugin version",
            "update.localOnly": "Published on GitHub (OldQin-Aurora001/dsh-breeze-tts) — update via the plugin market.",
            "update.restart": "The new version is installed. Restart Harness and refresh this page.",
            "update.busy": "Checking or installing, please wait.",
            "update.available": "New release available",
            "update.current": "No newer release. Latest published",
            "update.candidate": "Release candidate",
            "update.help": "Check this plugin's GitHub releases and let the plugin market perform updates.",
            "update.auto": "Check when settings opens (at most once per day)",
            "update.check": "Check updates",
            "update.install": "Install update",
            "update.confirm": "Install the current GitHub source through the plugin market, then restart. Continue? Published release:",
            "update.releases": "Release history",
            "update.manual": "Manual update command",
            "update.sourceHelp": "For a pinned archive or without the market, use this command to switch to GitHub. Replace web for a custom profile.",
            "update.marketMissing": "The DSH plugin market is unavailable. Use the manual update command.",
            "update.failed": "Update did not complete. Check the market logs or use the manual update command.",
            "compat.messages": "The host message interface is unsupported; message read buttons are disabled. Check for a plugin update. Settings previews remain available.",
            "toast.dismiss": "Dismiss",
            "toast.useEdge": "Read with Edge TTS instead",
            "toast.rvcFallback": "RVC unavailable — temporarily reading with Edge TTS",
            "rvc.fallbackOn": "Auto-switch to Edge TTS when RVC fails",
            "rvc.fallbackTip": "When on: if the RVC service is down or conversion fails, this message auto-reads with Edge TTS instead. Off by default — RVC is fully local; auto-fallback sends your text to Microsoft's online endpoint",
            "notify.title": "Event voice alerts",
            "notify.desc": "Voice-announce approval events from the session: approval requests interrupt the current read (high priority); results announce only when idle. Announcements always use Edge TTS (independent of the RVC service). Off by default",
            "notify.enabled": "Enable approval voice alerts",
            "notify.approval": "Approval requested (interrupts current read)",
            "notify.approvalResult": "Approval decided (announce when idle)",
            "notify.voice": "Alert voice",
            "notify.approval.lead": "Approval needed, ",
            "notify.decided.lead": "Approval result: ",
            "notify.decided.granted": "granted",
            "notify.decided.rejected": "rejected",
            "notify.decided.settled": "settled",
          },        },
        listeners: new Set(),
        subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
        notify() { for (const fn of this.listeners) { try { fn(); } catch (e) {} } },
        setLang(v) {
          const next = v === "zh" || v === "en" ? v : "auto";
          if (this.lang === next) return;
          this.lang = next;
          try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* non-fatal */ }
          this.notify();
        },
        current() { return resolveLocale(this.lang); },
      };
      if (hostLocale && typeof hostLocale.subscribe === "function") {
        ctx.effect(() => hostLocale.subscribe(() => {
          if (I18N.lang === "auto") I18N.notify();
        }), "local-ai-tts: follow DSH locale");
      }
      // test/debug hook: allows e.g. tests to drive setLang and assert persistence
      try { if (typeof window !== "undefined") window.__dshLocalAiTtsI18n = I18N; } catch (e) {}
      // test/debug hook for the toast (client-load.mjs renders TtsToastHost and
      // asserts the toast appears with the message, then dismisses)
      try {
        if (typeof window !== "undefined")
          window.__dshLocalAiTtsToast = {
            show: (text, kind, action) => showToast(text, kind, action),
            dismiss: () => dismissToast(),
            current: () => shared.toast,
          };
      } catch (e) {}
      let UI_LANG = I18N.current(); // current resolved locale (zh|en)
      function t(key, params) {
        UI_LANG = I18N.current();
        const loc = I18N.dict[UI_LANG] || I18N.dict.en;
        let s = loc[key] !== undefined ? loc[key]
          : I18N.dict.en[key] !== undefined ? I18N.dict.en[key]
          : key;
        // dev aid: a key missing from BOTH dictionaries is a real gap; warn so
        // untranslated keys are caught during development (ignored in prod).
        if (I18N.dict.zh[key] === undefined && typeof console !== "undefined") {
          try { console.warn("[tts i18n] missing key: " + key); } catch (e) {}
        }
        if (params) {
          for (const k of Object.keys(params)) {
            s = String(s).split("{" + k + "}").join(String(params[k]));
          }
        }
        return s;
      }
      // force a re-render on locale change: components that call useI18n()
      // subscribe and bump their own state.
      function useI18n() {
        const [, setN] = react.useState(0);
        react.useEffect(() => I18N.subscribe(() => {
          UI_LANG = I18N.current();
          setN(n => n + 1);
        }), []);
      }
      // Localize a host-side error/response: prefer the host-provided
      // `i18n: { code, params }` tag (translated via t()), else fall back to
      // the plain `error`/`message` (zh fallback) so nothing ever blanks.
      function hostErrText(obj) {
        const i18n = obj && obj.i18n;
        if (i18n && i18n.code && I18N.dict.zh[i18n.code] !== undefined) {
          const translated = t(i18n.code, i18n.params);
          if (translated !== i18n.code) {
            // If the host omitted some params (e.g. version skew), don't show a
            // literal `{placeholder}` — fall back to the full host message too.
            if (translated.includes('{') && obj && (obj.error || obj.message)) {
              return translated + '\n' + String(obj.error || obj.message);
            }
            return translated;
          }
        }
        if (obj && obj.error) return String(obj.error);
        if (obj && obj.message) return String(obj.message);
        return String(obj);
      }
      // ------------------------------------------------------------ /i18n

      // ---------- shared state & audio control ----------
      const shared = {
        coexistenceMode: "auto",
        autoRead: false,
        voice: "zh-CN-XiaoxuanNeural",
        provider: "edge-tts",
        rvcAutoFallback: false, // RVC read failed -> silently retry with Edge TTS (opt-in; off by default for privacy)
        rvc: {
          baseUrl: "http://127.0.0.1:4892",
          model: "",
          index: "",
          baseSource: "edge",
          baseAudioName: "",
          baseAudioFile: "",
          baseVoice: "zh-CN-YunyangNeural",
          baseRate: 0,
          basePitch: 0,
          baseVolume: 0,
          spkId: 0,
          f0File: "",
          f0Method: "rmvpe",
          indexRate: 0.75,
          f0UpKey: 0,
          resampleSr: 40000,
          rmsMixRate: 0.25,
          protect: 0.33,
          filterRadius: 3,
        },
        speaking: false,
        currentText: null,
        currentKey: null,    // ★ 2026-10-29：区分"同一次播放"（同消息同文字才算同一段）
        speakSource: null,
        speakToken: 0,
        paused: false,       // mini-player: playback paused
        rate: 1,             // mini-player: playback speed (1 / 1.25 / 1.5)
        chunkProgress: null, // { index: 1-based chunk now playing, total } during chunked playback
        currentJobId: null,  // active RVC chunked job, cancelled eagerly on stop
        toast: null,         // { text, kind: "error"|"warn", action: {label,onClick} } transient toast, or null
        notify: {
          // Approval voice alerts (Agent-event voice broadcast). off by default.
          enabled: false,
          approval: true,        // approval/asked -> interrupts current read
          approvalResult: false, // approval/decided -> announce only when idle
          voice: "zh-CN-XiaoxuanNeural",
        },
        notifyCursor: 0,        // last /dsh-breeze-tts-api/notify sequence consumed
        notifyBaselined: false, // first poll syncs the cursor without announcing (no replay after refresh)
        removedVoices: new Set(), // Edge voices the endpoint rejected (1007) this session
        audioEl: null,
        spareAudioEl: null, // second <audio> used for ping-pong chunk playback (fallback)
        audioCtx: null,     // shared Web Audio context (chunked playback)
        waCleanup: null,    // stop() the active Web Audio chain
        lastSeqBySession: new Map(),
      };

      // BEGIN LOCAL RUNTIME CLIENT
// Embedded into the upstream Harness module-loader bundle by tools/build-client.mjs.
function createLocalController() {
  const clientId = globalThis.crypto?.randomUUID?.() || 'client_' + Math.random().toString(36).slice(2) + Date.now();
  let sessionId = '', configured = '', remoteConfig = null, epoch = 0, busy = false, operations = Promise.resolve();
  let nodes = new Set(), received = new Set(), acknowledgements = [], nextTime = 0, currentJob = null;
  const defaults = { mode: 'process', launchPreset: 'webui', engine: 'indextts', pythonPath: '', projectPath: '', modelDir: '', presetsRoot: '', device: '', apiScript: '', ttsConfig: '', referenceAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh', durationFactor: 1, speedFactor: 1, port: 9880, command: '', args: [], cwd: '', voice: 'default', startupTimeoutMs: 300000, timeoutMs: 180000, autoStart: true, debug: false,
    webuiMode: 'auto', webuiEndpoint: '', webuiVariant: 'standard', gptVersion: '', gptModel: '', sovitsModel: '', engineProfiles: {},
    modelType: '', sdkPath: '', vocoderDir: '', language: 'Chinese', modelChoices: [], modelVoices: [], referenceVoices: [], voicePresets: [],
    endpoint: '', httpPreset: 'openai', protocol: 'auto', model: '', speechPath: '/v1/audio/speech', healthPath: '', healthMode: 'json', voicesPath: '/v1/audio/voices', requestEncoding: 'json',
    requestBody: '{"text":"{{text}}"}', extraBody: '{}', audioFiles: '{}', responseAudio: 'auto', sampleRate: 24000, channels: 1, audioBase64Path: '', apiKeyEnv: '', allowLan: false };
  const genericDefaults = { mode: 'http', launchPreset: 'custom', engine: 'generic', protocol: 'openai-speech' };
  // Presets are configuration data. They all use the same HTTP provider.
  const httpPresets = {
    openai: { endpoint: '', model: '', voice: 'default' },
    kokoro: { endpoint: 'http://127.0.0.1:8880', model: 'kokoro', voice: 'af_heart' },
    piper: { endpoint: 'http://127.0.0.1:5000', protocol: 'custom-http', speechPath: '/synthesize', healthPath: '/info', healthMode: 'http', voicesPath: '/voices', requestBody: '{"text":"{{text}}","voice":"{{voice}}"}' },
    'piper-legacy': { endpoint: 'http://127.0.0.1:5000', protocol: 'custom-http', speechPath: '/', voicesPath: '' },
    fish: { endpoint: 'http://127.0.0.1:8080', protocol: 'custom-http', speechPath: '/v1/tts', healthPath: '/v1/health', voicesPath: '',
      requestBody: '{"text":"{{text}}","reference_id":"{{voice}}","format":"wav","streaming":false}' },
    gpt: { endpoint: 'http://127.0.0.1:9880', protocol: 'custom-http', speechPath: '/tts', voicesPath: '',
      requestBody: '{"text":"{{text}}","text_lang":"zh","ref_audio_path":"","prompt_text":"","prompt_lang":"zh","media_type":"wav","streaming_mode":false}' },
    custom: { endpoint: '', protocol: 'custom-http', speechPath: '/synthesize', voicesPath: '' },
  };
  shared.localProcess = { ...defaults, engineProfiles: {} };
  // `local-runtime` is retained as an internal compatibility alias for older
  // persisted settings and older bundled test harnesses.
  shared.localRuntime = shared.localProcess;
  // ★★★ 2026-10-30 02:5x 阿枢修复（真 1.0.0 / 1.1.1 共同的启动崩溃根因）：
  //   这里原来是 `coerceVisibleEngine(shared.localProcess);`，但它依赖的
  //   LOCAL_ENGINES_AVAILABLE / HIDDEN_ENGINES / engineVisible 三个 `const`
  //   全在下面十几行才定义 ⇒ 撞暂时性死区（TDZ）⇒
  //   ReferenceError: Cannot access 'X' before initialization ⇒ 整个 apply() 抛错
  //   ⇒ DSH 报 `dsh-breeze-tts: failed` / `web boot: 1 entry did not activate`。
  //   blind 版没有这套逻辑所以能跑；1.0.0 引入时把调用点放在了定义之前。
  //   ⇒ 修法：把这次调用**下移到三个 const 定义之后**（见下方 "TDZ 修复：调用点"）。
  const isProcessProvider = provider => provider === 'indextts-process' || provider === 'gpt-sovits-process' || provider === 'local-runtime';
  // ★ A-2（方案 §三-A2）：定义块（藏引擎三 const + coerceVisibleEngine）已整体提至 apply
  //   顶层——apply 层的 hydrateFromHost/resetSettings 调用点原本够不到（第二面 ReferenceError），
  //   提顶后本调用点（第一面）与那两处（第二面）共用同一份词法可见的定义。
  coerceVisibleEngine(shared.localProcess);
  let discoveryTicket = 0, discoveryResult = null, pendingDiscovery = null;
  const launchReady = () => {
    const c = shared.localProcess;
    if (c.engine === 'folder') return !!c.modelType && !!c.modelDir.trim() && !!c.pythonPath.trim() &&
      (!['f5', 'voxcpm', 'cosyvoice'].includes(c.modelType) || !!c.referenceAudio.trim() && !!c.promptText.trim()) &&
      (c.modelType !== 'f5' || !!c.vocoderDir.trim()) && (c.modelType !== 'cosyvoice' || !!c.sdkPath.trim()) && !!c.voice.trim();
    if (c.engine === 'generic') {
      if (c.mode === 'process') return !!c.command.trim();
      if (!c.endpoint?.trim() || (c.protocol === 'openai-speech' && !c.model.trim())) return false;
      try { for (const key of ['requestBody', 'extraBody', 'audioFiles']) JSON.parse(c[key]); } catch { return false; }
      return c.protocol !== 'custom-http' || c.requestBody.includes('{{text}}');
    }
    if (shared.provider === 'local-runtime' && c.endpoint) return true;
    if (c.launchPreset === 'webui') return !!(c.engine === 'gpt-sovits' ? c.referenceAudio.trim() : c.voice.trim() && c.voice !== 'default') &&
      (c.webuiMode === 'attach' ? !!c.webuiEndpoint.trim() : !!c.projectPath.trim() && (c.engine === 'gpt-sovits' || !!c.modelDir.trim()));
    if (c.launchPreset !== 'builtin') return !!c.command.trim();
    return !!c.projectPath.trim() && (c.engine === 'gpt-sovits'
      ? !!c.apiScript.trim() && !!c.referenceAudio.trim()
      : !!c.modelDir.trim() && !!c.voice.trim() && c.voice !== 'default');
  };
  function resetLaunch() {
    const c = shared.localProcess;
    for (const key of ['pythonPath', 'modelDir', 'presetsRoot', 'device', 'apiScript', 'ttsConfig', 'referenceAudio', 'promptText', 'command', 'args', 'cwd', 'voice', 'launchPreset', 'webuiEndpoint', 'gptVersion', 'gptModel', 'sovitsModel']) c[key] = defaults[key];
    delete c.endpoint;
    discoveryResult = null;
  }
  function updateSetting(key, value) {
    const c = shared.localProcess;
    if (c[key] === value) return;
    if (['modelChoices', 'modelVoices', 'referenceVoices', 'voicePresets'].includes(key)) { c[key] = value; saveSettings(); notify(); return; }
    stopSpeaking(); discoveryTicket++;
    if (key === 'projectPath') resetLaunch();
    if (key === 'modelDir' && c.engine === 'folder') {
      Object.assign(c, { modelType: '', pythonPath: '', sdkPath: '', vocoderDir: '', modelChoices: [], modelVoices: [], referenceVoices: [], voice: 'default' });
    }
    if (key === 'launchPreset') { c.command = ''; c.args = []; c.cwd = ''; c.autoStart = true; delete c.endpoint; }
    c[key] = value;
    if (key === 'voice' && c.engine === 'gpt-sovits') c.referenceAudio = value === 'default' ? '' : value;
    if (key === 'referenceAudio' && c.engine !== 'folder') c.voice = value || 'default';
    invalidateConfiguration(); saveSettings(); notify();
  }
  function selectEngine(engine) {
    if (!['indextts', 'gpt-sovits', 'generic', 'folder'].includes(engine)) return;
    stopSpeaking(); discoveryTicket++;
    const c = shared.localProcess;
    if (c.engine !== engine) {
      const profiles = c.engineProfiles && typeof c.engineProfiles === 'object' && !Array.isArray(c.engineProfiles)
        ? { ...c.engineProfiles } : {};
      const current = {};
      for (const key of Object.keys(defaults)) if (key !== 'engineProfiles' && Object.hasOwn(c, key)) current[key] = c[key];
      if (typeof c.endpoint === 'string') current.endpoint = c.endpoint;
      profiles[c.engine] = current;
      const saved = profiles[engine];
      const restored = saved && typeof saved === 'object' && !Array.isArray(saved) && saved.engine === engine
        ? { ...defaults, ...saved, engineProfiles: profiles }
        : { ...defaults, ...(engine === 'generic' ? genericDefaults : {}), ...(engine === 'folder' ? { launchPreset: 'folder' } : {}), engine, engineProfiles: profiles };
      for (const key of Object.keys(c)) delete c[key];
      Object.assign(c, restored);
      discoveryResult = null;
      pendingDiscovery = null;
    }
    c.engine = engine;
    shared.provider = ['generic', 'folder'].includes(engine) ? 'local-runtime' : (engine === 'gpt-sovits' ? 'gpt-sovits-process' : 'indextts-process');
    invalidateConfiguration(); saveSettings(); notify();
  }
  function applyHttpPreset(name) {
    if (!Object.hasOwn(httpPresets, name) || shared.localProcess.engine !== 'generic') return;
    stopSpeaking(); discoveryTicket++;
    const c = shared.localProcess;
    for (const key of ['protocol', 'model', 'voice', 'speechPath', 'healthPath', 'healthMode', 'voicesPath', 'requestEncoding', 'requestBody', 'extraBody', 'audioFiles', 'responseAudio', 'sampleRate', 'channels', 'audioBase64Path', 'apiKeyEnv', 'allowLan']) c[key] = defaults[key];
    Object.assign(c, genericDefaults, httpPresets[name], { httpPreset: name });
    invalidateConfiguration(); saveSettings(); notify();
  }
  const characterKeys = ['referenceAudio', 'gptModel', 'sovitsModel', 'gptVersion', 'promptText', 'promptLang'];
  function selectCharacter(id) {
    const c = shared.localProcess;
    if (c.engine !== 'gpt-sovits' || c.launchPreset !== 'webui' || discoveryResult?.engine !== c.engine || discoveryResult?.projectPath !== c.projectPath) return false;
    const selected = discoveryResult.candidates?.characters?.find(v => v.id === id);
    if (!selected || !characterKeys.every(key => typeof selected.config?.[key] === 'string' && selected.config[key])) return false;
    // Commit the model pair and its reference together; never send a partially
    // switched character to an already configured Auto Read session.
    stopSpeaking(); discoveryTicket++;
    for (const key of characterKeys) c[key] = selected.config[key];
    c.voice = c.referenceAudio;
    invalidateConfiguration(); saveSettings(); notify();
    return true;
  }
  function discover() {
    const c = shared.localProcess, key = JSON.stringify(c), provider = shared.provider;
    // A blur followed by a button click must not scan the same folder twice.
    if (pendingDiscovery?.config === c && pendingDiscovery.key === key && pendingDiscovery.provider === provider && pendingDiscovery.ticket === discoveryTicket) return pendingDiscovery.promise;
    const ticket = ++discoveryTicket;
    const current = () => ticket === discoveryTicket && shared.localProcess === c && JSON.stringify(c) === key && shared.provider === provider;
    const promise = (async () => {
      try {
        const result = await rpc('discover', { engine: c.engine, projectPath: c.projectPath });
        if (!current()) return null;
        stopSpeaking();
        // Fill gaps only: rescanning an unchanged project preserves overrides.
        for (const [name, value] of Object.entries(result.config || {})) {
          if (name === 'projectPath' || (Object.hasOwn(defaults, name) && (!c[name] || (name === 'voice' && c[name] === 'default')))) c[name] = value;
        }
        if (c.engine === 'gpt-sovits' && c.referenceAudio) c.voice = c.referenceAudio;
        discoveryResult = { ...result, engine: c.engine, projectPath: c.projectPath };
        invalidateConfiguration(); saveSettings(); notify();
        return discoveryResult;
      } catch (e) { if (current()) throw e; return null; }
      finally { if (pendingDiscovery?.ticket === ticket) pendingDiscovery = null; }
    })();
    pendingDiscovery = { config: c, key, provider, ticket, promise };
    return promise;
  }
  const enqueue = fn => (operations = operations.catch(() => {}).then(fn));
  function invalidateConfiguration() {
    configured = '';
    // Also disable the Host's previous Auto Read snapshot while a new folder
    // is incomplete. A pending configure is drained before this operation.
    enqueue(async () => {
      configured = '';
      const previous = remoteConfig; remoteConfig = null;
      if (previous) {
        if (previous.config.engine === 'folder') await rpc('unload');
        else await rpc('configure', { ...previous, autoRead: false });
      }
    }).catch(() => {});
  }
  async function rpc(action, payload = {}) {
    const response = await breezeApiFetch('/dsh-breeze-tts-api/local-runtime', {
      __breezeNoPairRetry: true, // A-6（方案 §三-A6）：rpc 被 status 后台轮询复用，401 静默跳过不弹框
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, clientId, ...payload }),
      signal: AbortSignal.timeout(['status', 'load'].includes(action) ? Math.max(payload.config?.startupTimeoutMs || 0, (payload.config?.timeoutMs || 120000) * 2) + 15000 : 15000),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || `TTS HTTP ${response.status}`);
    return data;
  }
  function snapshot() {
    const config = { ...shared.localProcess, engine: shared.provider === 'gpt-sovits-process' ? 'gpt-sovits' : (shared.provider === 'local-runtime' ? (shared.localProcess.engine || 'indextts') : 'indextts') };
    for (const key of ['engineProfiles', 'modelChoices', 'modelVoices', 'referenceVoices', 'voicePresets']) delete config[key];
    if (shared.provider === 'local-runtime' && !['generic', 'folder'].includes(config.engine) && config.endpoint) { delete config.mode; }
    return { config, sessionId, autoRead: isProcessProvider(shared.provider) && shared.autoRead && localAutoAllowed() };
  }
  async function configure() {
    const value = snapshot(), key = JSON.stringify(value);
    if (key !== configured) { await rpc('configure', value); remoteConfig = value; configured = key; }
  }
  function resetAudio() {
    for (const node of nodes) { node.onended = null; try { node.stop(); node.disconnect(); } catch {} }
    nodes.clear(); received.clear(); acknowledgements = []; nextTime = 0; currentJob = null;
  }
  function stop() {
    epoch++; resetAudio();
    if (configured) enqueue(() => rpc('stop')).catch(() => {});
  }
  function sync() {
    if (!isProcessProvider(shared.provider) || !launchReady()) {
      if (configured || remoteConfig) { stop(); invalidateConfiguration(); }
      return;
    }
    enqueue(() => { if (isProcessProvider(shared.provider) && launchReady()) return configure(); }).catch(e => showToast(e.message, 'error'));
  }
  function session(value) {
    if (sessionId !== value) { if (shared.speakSource === 'auto') stopSpeaking(); sessionId = value || ''; sync(); }
  }
  async function read(text, onError) {
    const version = epoch;
    try {
      return await enqueue(async () => {
        await configure();
        if (version !== epoch) return { ok: false };
        await rpc('read', { text });
        return { ok: true };
      });
    } catch (e) {
      if (version === epoch) { clearSpeaking(shared.speakToken); (onError || (m => showToast(m, 'error')))(e.message); }
      return { ok: false, error: e.message };
    }
  }
  async function play(item, job, version) {
    if (job.source === 'auto' && !localAutoAllowed()) return;
    const key = job.jobId + ':' + item.index;
    if (received.has(key)) return;
    received.add(key);
    let audioContext = shared.audioCtx;
    if (!audioContext) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Web Audio is unavailable in this browser.');
      audioContext = shared.audioCtx = new Context();
    }
    if (!shared.paused) await audioContext.resume();
    const bytes = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
    const buffer = await audioContext.decodeAudioData(bytes.buffer);
    if (version !== epoch || (job.source === 'auto' && !localAutoAllowed())) return;
    if (!shared.speaking) { shared.speakToken++; shared.speaking = true; shared.speakSource = job.source; }
    const token = shared.speakToken;
    shared.waCleanup = resetAudio;
    shared.chunkProgress = { index: item.index, total: job.done ? item.index : '?' };
    const source = audioContext.createBufferSource(); source.buffer = buffer;
    source.connect(audioContext.destination); nodes.add(source);
    source.onended = () => {
      nodes.delete(source); source.disconnect();
      if (version === epoch) acknowledgements.push({ jobId: job.jobId, index: item.index });
      if (version === epoch && currentJob?.done && !nodes.size && token === shared.speakToken) {
        acknowledgements.push({ jobId: job.jobId, index: item.index, finished: true });
        shared.waCleanup = null; clearSpeaking(token);
      }
    };
    const start = Math.max(audioContext.currentTime + 0.025, nextTime);
    source.start(start); nextTime = start + buffer.duration; notify();
  }
  async function poll() {
    refreshCoexistence();
    if (busy || !isProcessProvider(shared.provider) || !configured) return;
    busy = true; const version = epoch;
    const acks = acknowledgements.splice(0);
    try {
      await operations;
      if (version !== epoch) return;
      const data = await rpc('poll', { acknowledgements: acks });
      if (version !== epoch) return;
      // The Host retains at most three unacknowledged segments per browser.
      for (const job of data.jobs || []) {
        currentJob = job;
        if (job.error) {
          const key = job.jobId + ':error';
          if (!received.has(key)) { received.add(key); showToast(job.error.message, 'error'); }
        }
        for (const item of job.audio) await play(item, job, version);
        if (job.done && !nodes.size) {
          acknowledgements.push({ jobId: job.jobId, index: Number.MAX_SAFE_INTEGER, finished: true });
          if (isProcessProvider(shared.provider)) { shared.waCleanup = null; clearSpeaking(shared.speakToken); }
          received.clear(); nextTime = 0;
        }
      }
    } catch (e) {
      if (version === epoch) {
        stopSpeaking(); configured = ''; showToast(e.message || 'Local process playback failed.', 'error');
      }
    } finally { busy = false; }
  }
  function Settings() {
    useSharedForce();
    const [, render] = react.useState(0);
    const [status, setStatus] = react.useState('');
    const [testing, setTesting] = react.useState(false);
    const [detecting, setDetecting] = react.useState(false);
    const [voices, setVoices] = react.useState([]);
    const [trialText, setTrialText] = react.useState('你好，这是本地语音测试。');
    const [browser, setBrowser] = react.useState(null);
    const browserTicket = react.useRef(0);
    const [presetName, setPresetName] = react.useState('');
    const revision = react.useRef(0), scanRevision = react.useRef(0);
    const c = shared.localProcess;
    const webui = c.launchPreset === 'webui';
    const audioValue = c.engine === 'gpt-sovits' ? c.referenceAudio : (c.voice === 'default' ? '' : c.voice);
    react.useEffect(() => {
      revision.current++; scanRevision.current++;
      setStatus(''); setVoices([]); setDetecting(false);
    }, [c, c.engine, shared.provider]);
    // 音色列表自动拉一次。原先只在点「检查服务」时才填 ⇒ 每次刷新页面「服务音色列表」
    // 那个下拉框都消失，得手点一次才回来。
    // 次序必须走 configure → status（实测：直接 status 报 ENDPOINT 400，第 036 号探针证实）。
    // 故走 enqueue 串行队列，跟 read()/loadModel() 同一范式，避免与别的 RPC 抢。
    // **只取音色、不写 status**：若复用 checkConnection，刷新后就显示"服务可访问"，
    // 用户没测过却被告知可访问＝假话。失败一律静默（服务没起是正常态）。
    react.useEffect(() => {
      let alive = true;
      const version = revision.current;
      enqueue(async () => {
        if (!alive || version !== revision.current) return;
        try {
          await configure();
          if (!alive || version !== revision.current) return;
          const data = await rpc('status', snapshot());
          if (!alive || version !== revision.current) return;
          if (Array.isArray(data?.voices) && data.voices.length) setVoices(data.voices);
        } catch (_) { /* 服务没起/未授权 = 正常态，静默 */ }
      }).catch(() => {});
      return () => { alive = false; };
    }, [c.engine, c.endpoint, shared.provider]);
    const zh = window.__dshLocalAiTtsI18n?.current() !== 'en';
    const label = (en, cn) => zh ? cn : en;
    const h = react.createElement;
    const detected = discoveryResult?.engine === c.engine && discoveryResult?.projectPath === c.projectPath ? discoveryResult : null;
    const gptCharacters = webui && c.engine === 'gpt-sovits' ? detected?.candidates?.characters || [] : [];
    const selectedCharacter = gptCharacters.find(v => characterKeys.every(key => v.config?.[key] === c[key]));
    const change = (key, value) => {
      revision.current++; scanRevision.current++; setDetecting(false);
      updateSetting(key, value); setStatus('');
      if (key === 'projectPath' || key === 'modelDir') setVoices([]);
      render(n => n + 1);
    };
    const scan = async () => {
      if (!c.projectPath.trim()) return;
      const version = ++scanRevision.current;
      setDetecting(true); setStatus(label('Finding files…', '正在查找文件…'));
      try {
        const result = await discover();
        if (version !== scanRevision.current) return;
        setStatus(result ? label('Paths detected; runtime and model dependencies are not tested yet.', '路径已识别；尚未验证运行环境及模型依赖。') : '');
        render(n => n + 1);
      } catch (e) { if (version === scanRevision.current) setStatus(e.message); }
      finally { if (version === scanRevision.current) setDetecting(false); }
    };
    const field = (title, element) => h('label', { style: { display: 'grid', gap: 6 } }, h('span', null, title), element);
    const input = (key, props = {}) => h('input', {
      className: 'dsh-local-ai-tts-preview-input', style: { width: '100%', boxSizing: 'border-box' },
      value: c[key], spellCheck: false, onChange: e => change(key, e.target.value), ...props,
    });
    const note = text => h('p', { className: 'dsh-local-ai-tts-module-desc', style: { margin: 0, overflowWrap: 'anywhere' } }, text);
    const playbackControls = () => shared.speaking ? h('div', { role: 'group', 'aria-label': label('Playback controls', '播放控制'), style: { display: 'flex', gap: 8 } },
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', onClick: togglePause }, shared.paused ? t('mini.resume') : t('mini.pause')),
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', onClick: stopSpeaking }, t('stopRead'))) : null;
    const engineSelector = field(label('Engine', '引擎'), h('select', { className: 'dsh-local-ai-tts-select', value: c.engine, onChange: e => {
      revision.current++; scanRevision.current++; selectEngine(e.target.value);
      setStatus(''); setVoices([]); setDetecting(false); render(n => n + 1);
    } },
    // ★ 2026-10-29：本地三引擎在 worker 到位前不进下拉（见 LOCAL_ENGINES_AVAILABLE 处说明）
    engineVisible('indextts') ? h('option', { value: 'indextts' }, 'IndexTTS 2.5') : null,
    engineVisible('gpt-sovits') ? h('option', { value: 'gpt-sovits' }, 'GPT-SoVITS') : null,
    engineVisible('folder') ? h('option', { value: 'folder' }, label('Local model folder', '本地模型文件夹（自动识别）')) : null,
    h('option', { value: 'generic' }, label('Universal local TTS', '通用本地 TTS（高级协议接入）'))));
    if (c.engine === 'folder') {
      const needsReference = ['f5', 'voxcpm', 'cosyvoice'].includes(c.modelType);
      const chooseModel = (model, choices = c.modelChoices) => {
        stopSpeaking(); discoveryTicket++; revision.current++; setVoices([]);
        const config = { ...model.config };
        if (c.modelType === config.modelType && c.modelDir === config.modelDir) {
          for (const key of ['pythonPath', 'sdkPath', 'vocoderDir']) if (c[key]) config[key] = c[key];
          if (model.voices.some(v => v.id === c.voice)) config.voice = c.voice;
        }
        Object.assign(c, config, { modelChoices: choices, modelVoices: model.voices, referenceVoices: model.referenceVoices });
        invalidateConfiguration(); saveSettings(); notify(); setStatus(label('Folder recognized. Load the model to verify the environment.', '已识别文件夹，请加载模型验证运行环境。')); render(n => n + 1);
      };
      const recognize = async () => {
        const version = ++scanRevision.current, key = c.modelDir;
        setDetecting(true); setStatus(label('Recognizing model files…', '正在识别模型文件…'));
        try {
          const result = await rpc('discover-model', { modelDir: key });
          if (version !== scanRevision.current || shared.localProcess !== c || c.modelDir !== key || c.engine !== 'folder') return;
          if (result.models.length === 1) chooseModel(result.models[0], result.models);
          else { change('modelChoices', result.models); setStatus(label('Several models found. Choose one below.', '找到多个模型，请在下方选择。')); }
        } catch (e) { if (version === scanRevision.current) setStatus(e.message); }
        finally { if (version === scanRevision.current) setDetecting(false); }
      };
      const browse = async folder => {
        const ticket = ++browserTicket.current;
        setBrowser({ loading: true, folder: '', parent: '', folders: [] });
        try { const result = await rpc('browse-folders', { folder }); if (ticket === browserTicket.current && c.engine === 'folder') setBrowser(result); }
        catch (e) { if (ticket === browserTicket.current) { setBrowser(null); setStatus(e.message); } }
      };
      const loadModel = async () => {
        const version = revision.current, key = JSON.stringify(c);
        setTesting(true); setStatus(label('Loading model… The first load can take several minutes.', '正在加载模型…首次加载可能需要几分钟。'));
        try {
          await enqueue(async () => {
            if (version !== revision.current || key !== JSON.stringify(c) || shared.localProcess !== c || c.engine !== 'folder') return;
            await configure();
            if (version !== revision.current || key !== JSON.stringify(c) || shared.localProcess !== c || c.engine !== 'folder') return;
            const result = await rpc('load', snapshot());
            if (version !== revision.current || key !== JSON.stringify(c) || shared.localProcess !== c || c.engine !== 'folder') return;
            setVoices(result.voices || []);
            setStatus(label('Model ready. You can try reading now.', '模型已就绪，可以试听。'));
          });
        } catch (e) { if (version === revision.current) setStatus(e.message); }
        finally { setTesting(false); }
      };
      const availableVoices = voices.length ? voices : c.modelVoices;
      const references = [...c.referenceVoices, ...c.voicePresets];
      return h('section', { 'aria-label': label('Local model folder', '本地模型文件夹'), className: 'dsh-local-ai-tts-module dsh-local-ai-tts-module-stack', style: { display: 'grid', gap: 16, width: '100%' }, 'aria-busy': detecting || testing },
        h('strong', null, label('Local model folder', '本地模型文件夹')), engineSelector,
        note(label('Choose downloaded model files. Existing Python dependencies are reused; no API server is required. IndexTTS and GPT-SoVITS retain their own engine entries.', '选择已下载的模型文件夹，复用已有 Python 环境，无需先启动 API 服务。IndexTTS 和 GPT-SoVITS 继续使用各自的引擎入口。')),
        field(label('Model folder', '模型文件夹'), input('modelDir', { disabled: testing, placeholder: label('Absolute path on the Host computer', '运行 DSH 的电脑上的文件夹完整路径') })),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: detecting || testing, onClick: () => browse(c.modelDir || '') }, label('Choose folder', '选择文件夹')),
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: detecting || testing || !c.modelDir.trim(), onClick: recognize }, detecting ? label('Recognizing…', '识别中…') : label('Recognize folder', '识别文件夹'))),
        browser ? h('div', { role: 'region', 'aria-label': label('Folder browser', '文件夹浏览器'), style: { display: 'grid', gap: 8, padding: 12, border: '1px solid currentColor', borderRadius: 8 } },
          note(browser.loading ? label('Loading folders…', '正在读取文件夹…') : browser.folder || label('Choose a drive', '请选择磁盘')),
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: browser.loading, onClick: () => browse(browser.parent) }, label('Parent folder', '上一级')),
          h('div', { style: { maxHeight: 240, overflowY: 'auto', display: 'grid', gap: 4 } }, ...browser.folders.map(f => h('button', { key: f.path, type: 'button', className: 'dsh-local-ai-tts-browse', style: { textAlign: 'left', overflowWrap: 'anywhere' }, onClick: () => browse(f.path) }, f.name))),
          browser.truncated ? note(label('First 200 folders shown. Paste a path to open other folders.', '仅显示前 200 个文件夹，其他文件夹可直接粘贴路径。')) : null,
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: browser.loading || !browser.folder, onClick: () => { browserTicket.current++; change('modelDir', browser.folder); setBrowser(null); } }, label('Use this folder', '使用此文件夹')),
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', onClick: () => { browserTicket.current++; setBrowser(null); } }, label('Close', '关闭'))) : null,
        c.modelChoices.length > 1 ? field(label('Recognized models', '识别到的模型'), h('select', { className: 'dsh-local-ai-tts-select', disabled: testing, value: c.modelType ? c.modelDir : '', onChange: e => { const model = c.modelChoices.find(m => m.config.modelDir === e.target.value); if (model) chooseModel(model); } }, h('option', { value: '' }, label('Choose a model', '请选择模型')), ...c.modelChoices.map(m => h('option', { key: m.config.modelDir, value: m.config.modelDir }, m.name + ' · ' + m.config.modelDir)))) : null,
        c.modelType ? note(label('Recognized model: ', '已识别模型：') + c.modelType + (c.pythonPath ? label(' · Python environment found', ' · 已找到 Python 环境') : label(' · Set Python in Environment settings', ' · 请在环境设置中指定 Python'))) : null,
        needsReference ? h('div', { style: { display: 'grid', gap: 12 } },
          note(label('This model needs reference audio and its matching transcript. Save them once as a voice preset.', '该模型需要参考音频和对应原文，填写后可保存为音色预设，供其他克隆模型复用。')),
          references.length ? field(label('Saved voices', '已保存音色'), h('select', { className: 'dsh-local-ai-tts-select', disabled: testing, value: '', onChange: e => { const v = references[Number(e.target.value)]; if (!v) return; change('referenceAudio', v.referenceAudio); change('promptText', v.promptText); } }, h('option', { value: '' }, label('Choose a voice', '请选择音色')), ...references.map((v, i) => h('option', { key: i, value: String(i) }, v.name)))) : null,
          field(label('Reference audio path', '参考音频路径'), input('referenceAudio', { disabled: testing })), field(label('Reference transcript', '参考音频原文'), input('promptText', { disabled: testing })),
          field(label('Voice preset name', '音色预设名称'), h('input', { className: 'dsh-local-ai-tts-preview-input', value: presetName, onChange: e => setPresetName(e.target.value) })),
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: !presetName.trim() || !c.referenceAudio.trim() || !c.promptText.trim() || testing, onClick: () => {
            const preset = { id: presetName.trim(), name: presetName.trim(), referenceAudio: c.referenceAudio, promptText: c.promptText };
            change('voicePresets', [...c.voicePresets.filter(v => v.id !== preset.id), preset]); setStatus(label('Voice preset saved in this browser.', '音色预设已保存在当前浏览器。'));
          } }, label('Save voice preset', '保存音色预设'))) : availableVoices.length ? field(label('Preset voice', '预设音色'), h('select', { className: 'dsh-local-ai-tts-select', disabled: testing, value: c.voice, onChange: e => change('voice', e.target.value) }, ...availableVoices.map(v => h('option', { key: v.id, value: v.id }, v.name)))) : null,
        h('details', null, h('summary', { style: { cursor: 'pointer', padding: '10px 0' } }, label('Environment settings', '环境设置（识别不完整时展开）')),
          h('div', { style: { display: 'grid', gap: 12 } },
            field(label('Python executable with model dependencies', '已安装模型依赖的 Python 程序'), input('pythonPath', { disabled: testing })),
            c.modelType === 'f5' ? field(label('Vocos vocoder folder', 'Vocos 声码器文件夹'), input('vocoderDir', { disabled: testing })) : null,
            c.modelType === 'cosyvoice' ? field(label('CosyVoice source folder', 'CosyVoice 源码文件夹'), input('sdkPath', { disabled: testing })) : null,
            field(label('Device', '运算设备'), h('select', { className: 'dsh-local-ai-tts-select', value: c.device || 'auto', disabled: testing, onChange: e => change('device', e.target.value) }, ...[['auto', label('Automatic', '自动')], ['cuda', 'CUDA'], ['cpu', 'CPU']].map(([id, name]) => h('option', { key: id, value: id }, name)))),
            c.modelType === 'qwen3' ? field(label('Language', '合成语言'), h('select', { className: 'dsh-local-ai-tts-select', value: c.language, disabled: testing, onChange: e => change('language', e.target.value) }, ...[['Chinese', '中文'], ['English', '英语'], ['Japanese', '日语'], ['Korean', '韩语'], ['Auto', '自动']].map(([id, name]) => h('option', { key: id, value: id }, label(id, name))))) : null,
            ['kokoro', 'f5', 'cosyvoice'].includes(c.modelType) ? field(label('Speech speed', '语速'), input('speedFactor', { type: 'number', min: 0.6, max: 1.65, step: 0.05, disabled: testing, onChange: e => change('speedFactor', Number(e.target.value)) })) : null,
            field(label('Startup timeout (ms)', '启动超时（毫秒）'), input('startupTimeoutMs', { type: 'number', min: 1000, max: 600000, disabled: testing, onChange: e => change('startupTimeoutMs', Number(e.target.value)) })),
            field(label('Synthesis timeout (ms)', '合成超时（毫秒）'), input('timeoutMs', { type: 'number', min: 100, max: 600000, disabled: testing, onChange: e => change('timeoutMs', Number(e.target.value)) })))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: testing || detecting || !launchReady(), onClick: loadModel }, testing ? label('Loading…', '加载中…') : label('Load model', '加载模型')),
          h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: testing, onClick: async () => {
            stopSpeaking(); shared.autoRead = false;
            try { await enqueue(async () => { if (remoteConfig) await rpc('unload'); configured = ''; remoteConfig = null; }); saveSettings(); setStatus(label('Model unloaded. Auto Read is off.', '模型已卸载，自动朗读已关闭。')); }
            catch (e) { setStatus(e.message); }
          } }, label('Unload model', '卸载模型'))),
        field(label('Trial text', '试听文本'), h('input', { className: 'dsh-local-ai-tts-preview-input', value: trialText, onChange: e => setTrialText(e.target.value) })),
        h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: testing || detecting || !trialText.trim() || !launchReady() || shared.speaking, onClick: async () => {
          if (!shared.audioCtx) { const Context = window.AudioContext || window.webkitAudioContext; if (!Context) { setStatus(label('Web Audio is unavailable.', '浏览器不支持 Web Audio。')); return; } shared.audioCtx = new Context(); }
          await shared.audioCtx.resume(); const result = await read(trialText, message => setStatus(message)); if (result.ok) setStatus(label('Trial queued.', '试听已入队，正在合成并播放。'));
        } }, label('Trial read', '试听')),
        playbackControls(),
        h('div', { role: 'status', 'aria-live': 'polite', style: { overflowWrap: 'anywhere' } }, status || (c.modelType ? label('Model settings saved. Load or try reading to verify the current model.', '模型设置已保存，可加载或试听验证当前模型。') : label('Choose a folder to begin.', '请选择模型文件夹开始。'))));
    }
    if (c.engine === 'generic') {
      const select = (key, options) => h('select', { className: 'dsh-local-ai-tts-select', value: c[key], onChange: e => change(key, e.target.value) },
        ...options.map(([id, title]) => h('option', { key: id, value: id }, title)));
      const jsonInput = key => h('textarea', { className: 'dsh-local-ai-tts-preview-input', rows: 5, value: c[key], spellCheck: false,
        style: { width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }, onChange: e => change(key, e.target.value) });
      const checkConnection = async () => {
        const version = revision.current, key = JSON.stringify(c), provider = shared.provider;
        const valid = () => version === revision.current && c === shared.localProcess && JSON.stringify(c) === key && provider === shared.provider;
        setTesting(true); setStatus(label('Checking service…', '正在检查服务…'));
        try {
          const data = await rpc('status', { config: snapshot().config });
          if (!valid()) return;
          setVoices(data.voices || []);
          if (c.voice === 'default' && data.voices?.length === 1) change('voice', data.voices[0].id);
          setStatus((data.status === 'unchecked' ? label('No health check configured; use Trial read to verify synthesis.', '未设置健康检查，请点击试听验证合成。')
            : data.status === 'reachable' ? label('Service reachable; use Trial read to verify the model.', '服务可访问，请点击试听验证模型。')
            : data.ready ? label('Service reports ready; synthesis still needs a trial read.', '服务报告已就绪，实际合成仍需试听。') : label('Service not ready: ', '服务尚未就绪：') + data.status) + (data.warning ? ' — ' + data.warning : ''));
        } catch (e) { if (valid()) setStatus(e.message); }
        finally { setTesting(false); }
      };
      return h('section', { 'aria-label': label('Universal local TTS', '通用本地 TTS'), className: 'dsh-local-ai-tts-module dsh-local-ai-tts-module-stack', style: { display: 'grid', gap: 16, width: '100%' } },
        h('strong', null, label('Universal local TTS', '通用本地 TTS')), engineSelector,
        note(label('Connect your installed TTS service by protocol. The Host sends text and receives audio; models stay in your own runtime.', '按协议连接已安装的 TTS 服务。插件发送文本并接收音频，模型由现有服务管理。')),
        field(label('Connection', '连接方式'), select('mode', [['http', 'HTTP API'], ['process', label('JSONL worker', 'JSONL worker 进程')]])),
        c.mode !== 'process' ? h('div', { style: { display: 'grid', gap: 16 } },
          field(label('Preset (fills connection defaults)', '配置预设（填入接口默认值）'), h('select', { className: 'dsh-local-ai-tts-select', value: c.httpPreset, onChange: e => {
            revision.current++; applyHttpPreset(e.target.value); setStatus(''); setVoices([]); render(n => n + 1);
          } }, ...[['openai', label('OpenAI-compatible / LocalAI', 'OpenAI 兼容 / LocalAI')], ['kokoro', 'Kokoro-FastAPI'], ['piper', 'Piper'], ['piper-legacy', label('Piper (older / route)', 'Piper（旧版 / 路由）')], ['fish', 'Fish Speech API'], ['gpt', 'GPT-SoVITS API'], ['custom', label('Custom HTTP', '自定义 HTTP')]].map(([id, title]) => h('option', { key: id, value: id }, title)))),
          field(label('Service base URL', '服务基础地址'), input('endpoint', { placeholder: 'http://127.0.0.1:5000' })),
          field(label('Protocol', '协议'), select('protocol', [['openai-speech', 'OpenAI speech'], ['custom-http', label('Custom HTTP (JSON / form)', '自定义 HTTP（JSON / 表单）')]])),
          field(label('Model ID', '模型 ID'), input('model', { placeholder: label('Required for OpenAI speech', 'OpenAI speech 必填') })),
          field(label('Voice ID', '音色 ID'), input('voice')),
          voices.length ? field(label('Discovered voices', '服务音色列表'), h('select', { className: 'dsh-local-ai-tts-select', value: voices.some(v => v.id === c.voice) ? c.voice : '', onChange: e => { if (e.target.value) change('voice', e.target.value); } },
            h('option', { value: '' }, label('Select…', '请选择…')), ...voices.map(v => h('option', { key: v.id, value: v.id }, v.name)))) : null,
          c.protocol === 'custom-http' ? h('div', { style: { display: 'grid', gap: 12 } },
            field(label('Synthesis route', '合成路由'), input('speechPath')),
            field(label('Request encoding', '请求编码'), select('requestEncoding', [['json', 'JSON'], ['form', 'application/x-www-form-urlencoded'], ['multipart', 'multipart/form-data']])),
            field(label('Request body template (JSON object)', '请求体模板（JSON 对象）'), jsonInput('requestBody')),
            note(label('Use complete values {{text}}, {{voice}}, {{model}}. Text is encoded safely. A reference path inside JSON belongs to the TTS server.', '使用完整字段值 {{text}}、{{voice}}、{{model}}，文本会正确编码。JSON 内的参考音频路径属于 TTS 服务端。')),
            c.requestEncoding === 'multipart' ? field(label('Audio uploads: field → absolute Host audio path (JSON)', '音频上传：字段名 → Host 上音频的完整路径（JSON）'), jsonInput('audioFiles')) : null) : null,
          h('details', null, h('summary', { style: { cursor: 'pointer', padding: '10px 0' } }, label('Advanced HTTP settings', '高级 HTTP 设置')),
            h('div', { style: { display: 'grid', gap: 12 } },
              c.protocol === 'openai-speech' ? field(label('Synthesis route', '合成路由'), input('speechPath')) : null,
              c.protocol === 'openai-speech' ? field(label('Extra synthesis fields (JSON)', '额外合成参数（JSON）'), jsonInput('extraBody')) : null,
              field(label('Health route (optional)', '健康检查路由（可留空）'), input('healthPath')),
              field(label('Health response', '健康检查响应'), select('healthMode', [['json', label('JSON readiness status', 'JSON 就绪状态')], ['http', label('HTTP reachability only', '仅检查 HTTP 可访问')]])),
              field(label('Voices route (optional)', '音色列表路由（可留空）'), input('voicesPath')),
              field(label('Audio response', '音频响应'), select('responseAudio', [['auto', label('WAV / MP3 / Ogg / FLAC', 'WAV / MP3 / Ogg / FLAC')], ['pcm-s16le', label('Raw PCM (s16le)', '裸 PCM（s16le）')]])),
              c.responseAudio === 'pcm-s16le' ? field(label('PCM sample rate (Hz)', 'PCM 采样率（Hz）'), input('sampleRate', { type: 'number', min: 8000, max: 192000, onChange: e => change('sampleRate', Number(e.target.value)) })) : null,
              c.responseAudio === 'pcm-s16le' ? field(label('PCM channels', 'PCM 声道数'), input('channels', { type: 'number', min: 1, max: 2, onChange: e => change('channels', Number(e.target.value)) })) : null,
              field(label('JSON base64 audio field (optional)', 'JSON base64 音频字段（可留空）'), input('audioBase64Path', { placeholder: 'data.audio' })),
              field(label('Bearer key environment variable on Host (optional)', 'Host 上存放 Bearer 密钥的环境变量名（可留空）'), input('apiKeyEnv', { placeholder: 'LOCAL_TTS_API_KEY' })),
              h('label', null, h('input', { type: 'checkbox', checked: c.allowLan, onChange: e => change('allowLan', e.target.checked) }), label('Allow private LAN IPv4 (text and uploaded references leave this computer)', '允许私有局域网 IPv4（文本和上传的参考音频将离开本机）')))))
        : h('div', { style: { display: 'grid', gap: 12 } },
          field(label('Worker executable', 'Worker 可执行程序'), input('command')),
          field(label('Arguments (one per line, without shell quotes)', '启动参数（每行一个，无需 shell 引号）'), h('textarea', { className: 'dsh-local-ai-tts-preview-input', rows: 3, value: c.args.join('\n'),
            style: { width: '100%', boxSizing: 'border-box' }, onChange: e => change('args', e.target.value ? e.target.value.split(/\r?\n/) : []) })),
          field(label('Working directory (optional)', '工作目录（可留空）'), input('cwd')), field(label('Voice ID', '音色 ID'), input('voice')),
          note(label('The command must implement the documented JSONL worker protocol. A normal WebUI/CLI command does not implement it automatically.', '命令必须实现文档中的 JSONL worker 协议，普通 WebUI 或 CLI 命令不会自动具备这个协议。'))),
        field(label('Request timeout (ms)', '请求超时（毫秒）'), input('timeoutMs', { type: 'number', min: 100, max: c.mode === 'process' ? 600000 : 300000, onChange: e => change('timeoutMs', Number(e.target.value)) })),
        c.mode === 'process' ? field(label('Startup timeout (ms)', '启动超时（毫秒）'), input('startupTimeoutMs', { type: 'number', min: 1000, max: 600000, onChange: e => change('startupTimeoutMs', Number(e.target.value)) })) : null,
        h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: testing, onClick: checkConnection }, testing ? label('Checking…', '检查中…') : label('Test Connection', '测试连接')),
        field(label('Trial text', '试听文本'), h('input', { className: 'dsh-local-ai-tts-preview-input', value: trialText, onChange: e => setTrialText(e.target.value) })),
        h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: !trialText.trim() || !launchReady() || shared.speaking, onClick: async () => {
          if (!shared.audioCtx) {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) { setStatus(label('Web Audio is unavailable.', '浏览器不支持 Web Audio。')); return; }
            shared.audioCtx = new Context();
          }
          await shared.audioCtx.resume();
          const result = await read(trialText, message => setStatus(message));
          if (result.ok) setStatus(label('Trial queued; listen to the audio before enabling Auto Read.', '试听已入队，请确认音频播放后再开启自动朗读。'));
        } }, label('Trial read', '试听')),
        playbackControls(),
        h('div', { role: 'status', 'aria-live': 'polite', style: { overflowWrap: 'anywhere' } }, status || label('Not tested', '尚未测试')));
    }
    const choice = (key, title, placeholder) => {
      const options = detected?.candidates?.[key] || [];
      return h('div', { style: { display: 'grid', gap: 6 } },
        field(title, input(key, { placeholder })),
        options.length > 1 ? field(label('Detected candidates — choose one', '检测到多个候选，请选择'),
          h('select', { className: 'dsh-local-ai-tts-select', value: options.includes(c[key]) ? c[key] : '', onChange: e => { if (e.target.value) change(key, e.target.value); } },
            h('option', { value: '' }, label('Select…', '请选择…')), ...options.map(v => h('option', { key: v, value: v }, v)))) : null);
    };
    const warnings = {
      SAVED_MODELS_UNREADABLE: label('Saved GPT model selection could not be read; confirm the pair in Advanced.', '无法读取已保存的 GPT 模型选择，请在高级设置确认模型组合。'),
      SAVED_MODELS_INCOMPLETE: !webui || c.webuiMode === 'attach' || (c.gptVersion && c.gptModel && c.sovitsModel) ? '' : label('weight.json has no complete model pair. Choose a saved character or confirm both weights in Advanced.', 'weight.json 未保存完整模型组合。请选择已保存角色，或在高级设置确认两份权重。'),
      CHARACTER_PRESET_INVALID: label('Some local character configurations are unsupported or refer to missing/out-of-folder files; they were skipped.', '部分本地角色配置格式不支持，或文件缺失／超出目录范围，已跳过。'),
      CHOOSE_CHARACTER: selectedCharacter ? '' : label(webui ? 'Choose a saved character to fill its model pair, reference and transcript together.' : 'Reference audio was found in runtime_voices; select it below and confirm the API model configuration.', webui ? '请选择已保存角色，一次填入模型组合、参考音频和原文。' : '已在 runtime_voices 找到参考音频，请在下方选择，并确认 API 模型配置。'),
      INACCESSIBLE_FILES: label('Some files are inaccessible.', '部分文件无法访问。'),
      MULTIPLE_PYTHONS: c.pythonPath ? '' : label('Several Python environments found; choose in Advanced.', '找到多个 Python 环境，请在高级设置中选择。'),
      PYTHON_NOT_FOUND: c.pythonPath ? '' : label('Python was not found. Set the installed environment in Advanced; otherwise PATH python is used.', '未找到 Python。请在高级设置中指定已安装的环境；留空会使用 PATH 中的 python。'),
      MULTIPLE_MODELS: c.modelDir ? '' : label('Several model directories found; choose in Advanced.', '找到多个模型目录，请在高级设置中选择。'),
      MODEL_NOT_FOUND: c.modelDir ? '' : label('No model config found; specify the model directory in Advanced.', '未找到模型配置，请在高级设置中指定模型目录。'),
      OTHER_INDEX_VERSION: label('Non-2.5 model configs were skipped.', '已跳过非 2.5 版本的模型配置。'),
      MODEL_VERSION_UNCONFIRMED: label('A config has no version marker; confirm it is for IndexTTS 2.5.', '有配置未声明版本，请确认它属于 IndexTTS 2.5。'),
      TTS_CONFIG_NOT_FOUND: c.ttsConfig ? '' : label('Default tts_infer.yaml missing; specify an existing inference YAML in Advanced.', '默认 tts_infer.yaml 缺失，请在高级设置中指定已有推理配置。'),
      REFERENCE_NOT_FOUND: c.voice !== 'default' && c.voice ? '' : label('No reference audio found; enter an existing audio path.', '未找到参考音频，请填写已有音频路径。'),
      CHOOSE_REFERENCE: c.voice !== 'default' && c.voice ? '' : label('Several reference audios found; select the intended voice.', '找到多个参考音频，请选择想使用的音色。'),
      AUDIO_LIST_TRUNCATED: label('Audio search limit reached; enter an unlisted audio path manually.', '音频候选已达扫描上限；未列出的音频可手动填写路径。'),
    };
    // IndexTTS presets are character voices, even though the official WebUI
    // exposes them as a prompt.wav path. Keep the real path as the option
    // value (the Host needs it) but present a character name to the user. A
    // matching voice_cache lets the official backend reuse the preset without
    // decoding the prompt file again.
    const characterName = value => {
      const text = String(value?.name || value?.id || '').replace(/\\/g, '/');
      const match = text.match(/(?:^|\/)outputs\/presets\/([^/]+)\/prompt\.wav$/i);
      return match ? match[1] : '';
    };
    const audioLabel = value => {
      const character = characterName(value);
      if (character) return label(`${character} (saved character voice)`, `${character}（已保存角色音色）`);
      const name = String(value?.name || value?.id || '');
      return /^examples[\\/]/i.test(name)
        ? label(`Official example: ${name}`, `官方示例：${name}`)
        : name;
    };
    const audioOptions = [...new Map([...(detected?.candidates?.voices || []), ...voices]
      .filter(v => v.id && v.id !== 'default').map(v => [v.id, v])).values()]
      .sort((a, b) => {
        const ar = !!characterName(a), br = !!characterName(b);
        if (ar !== br) return ar ? -1 : 1;
        return audioLabel(a).localeCompare(audioLabel(b), undefined, { numeric: true });
      });
    const characterOptions = audioOptions.filter(v => characterName(v));
    const otherAudioOptions = audioOptions.filter(v => !characterName(v) && !gptCharacters.some(role => role.config.referenceAudio === v.id));
    const referenceTitle = c.engine === 'indextts' && characterOptions.length
      ? label('Character preset path (auto-filled)', '角色预设路径（自动填充）')
      : label('Reference audio path (required)', '参考音频路径（必填）');
    const languageOptions = c.engine === 'indextts'
      ? [['ZH', label('Chinese', '中文')], ['EN', label('English', '英语')], ['JA', label('Japanese', '日语')], ['AR', label('Arabic', '阿拉伯语')], ['ES', label('Spanish', '西班牙语')]]
      : [['zh', label('Chinese', '中文')], ['en', label('English', '英语')], ['ja', label('Japanese', '日语')], ['ko', label('Korean', '韩语')], ['yue', label('Cantonese', '粤语')], ['auto', label('Multilingual', '多语种')]];
    const languageValue = c.engine === 'indextts'
      ? String(c.textLang || 'ZH').toUpperCase()
      : String(c.textLang || 'zh');
    const speedKey = c.engine === 'indextts' ? 'durationFactor' : 'speedFactor';
    const speedValue = Number.isFinite(Number(c[speedKey])) ? Number(c[speedKey]) : 1;
    const speedMin = c.engine === 'indextts' ? 0.5 : 0.6;
    const speedMax = c.engine === 'indextts' ? 2 : 1.65;
    const speedStep = c.engine === 'indextts' ? 0.01 : 0.05;
    return h('section', { 'aria-label': 'Local AI TTS', className: 'dsh-local-ai-tts-module dsh-local-ai-tts-module-stack', style: { display: 'grid', gap: 16, width: '100%', boxSizing: 'border-box' } },
      h('strong', null, label('Breeze settings', 'Breeze 设置')),
      note(label('Use your existing installation. Folder discovery does not start Python, download models or open a WebUI. Paths refer to the Harness Host, not the browser device.', '使用已有安装。目录识别不会启动 Python、下载模型或打开 WebUI。路径属于运行 Harness 的电脑，不是浏览器所在设备。')),
      engineSelector,
      webui ? note(label(c.webuiMode === 'auto' ? 'Official backend: reuse if available, otherwise start in the background. No browser window is needed. The first connection loads the model and may take a while; keep this page open and do not click repeatedly.' : 'Connection only: reuse the running inference service; never start or stop its model process.', c.webuiMode === 'auto' ? '官方后端：优先复用，否则后台启动，无需打开网页。首次连接会加载模型，可能需要一段时间；请保持页面打开，不要重复点击。' : '仅连接：复用已运行的推理服务，不启动或停止它的模型进程。')) : null,
      field(label(webui && c.webuiMode === 'attach' ? 'Project folder (optional, for finding Python/audio)' : 'Project folder (required)', webui && c.webuiMode === 'attach' ? '项目文件夹（可选，用于查找 Python 和音频）' : '项目文件夹（必填）'), input('projectPath', {
        placeholder: label('Paste the absolute path of your installed engine', '粘贴已安装引擎的文件夹完整路径'), onBlur: scan,
      })),
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: detecting || testing || !c.projectPath.trim(), onClick: scan },
        detecting ? label('Finding files…', '正在查找文件…') : label('Find files automatically', '自动查找文件')),
      h('div', { style: { display: 'grid', gap: 6 } },
        gptCharacters.length ? field(label('Character (saved local configuration)', '角色（已保存的本地配置）'), h('select', {
          className: 'dsh-local-ai-tts-select', value: selectedCharacter?.id || '',
          onChange: e => {
            if (!selectCharacter(e.target.value)) return;
            revision.current++; scanRevision.current++; setDetecting(false);
            setStatus(label('Character model pair, reference and transcript filled. Connection is not tested yet.', '已填入角色模型组合、参考音频和原文；尚未测试连接。'));
            render(n => n + 1);
          },
        }, h('option', { value: '' }, label('Choose a character', '请选择角色')),
        ...gptCharacters.map(v => h('option', { key: v.id, value: v.id }, `${v.name} (${v.config.gptVersion})`)))) : null,
        gptCharacters.length ? note(label('Reads local runtime_voices/voice.json metadata, not its tensor cache. Model weights apply on backend startup; connection-only mode cannot switch an existing WebUI model.', '读取本地 runtime_voices/voice.json 配置，不加载其中的张量缓存。模型权重在后台启动时生效；仅连接模式不会切换已有 WebUI 的模型。')) : null,
        characterOptions.length ? field(label('Character voice (saved preset)', '角色音色（已保存预设）'), h('select', {
          className: 'dsh-local-ai-tts-select', value: characterOptions.some(v => v.id === audioValue) ? audioValue : '',
          onChange: e => { if (e.target.value) change('voice', e.target.value); },
        }, h('option', { value: '' }, label('Choose a character', '选择角色音色')),
        ...characterOptions.map(v => h('option', { key: v.id, value: v.id }, audioLabel(v))))) : null,
        characterOptions.length ? note(label('Character entries use the saved voice cache when available; the prompt.wav path is kept only as the official WebUI input.', '角色音色会优先使用已保存的 voice_cache；prompt.wav 路径仅作为官方 WebUI 的输入。')) : null,
        otherAudioOptions.length ? field(label(characterOptions.length || gptCharacters.length ? 'Other detected reference audio' : 'Detected reference audio', characterOptions.length || gptCharacters.length ? '其他检测到的参考音频' : '找到的参考音频'), h('select', {
          className: 'dsh-local-ai-tts-select', value: otherAudioOptions.some(v => v.id === audioValue) ? audioValue : '',
          onChange: e => { if (e.target.value) change('voice', e.target.value); },
        }, h('option', { value: '' }, label('Choose audio / enter a path below', '选择音频／在下方填写路径')),
        ...otherAudioOptions.map(v => h('option', { key: v.id, value: v.id }, audioLabel(v))))) : null,
        field(referenceTitle, input(c.engine === 'gpt-sovits' ? 'referenceAudio' : 'voice', {
          value: audioValue, placeholder: label('Auto-filled when only one audio is found; external paths also work', '只找到一个音频时自动填入；也可填写其他位置的音频'),
        }))),
      field(label('Output language', '合成语言'), h('select', {
        className: 'dsh-local-ai-tts-select', value: languageOptions.some(v => v[0] === languageValue) ? languageValue : languageOptions[0][0],
        onChange: e => change('textLang', e.target.value),
      }, ...languageOptions.map(v => h('option', { key: v[0], value: v[0] }, v[1])))),
      field(label(c.engine === 'indextts' ? 'Duration factor (model setting)' : 'Speech speed (model setting)', c.engine === 'indextts' ? '时长系数（模型原版设置）' : '语速（模型原版设置）'), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' } },
        h('input', { type: 'range', min: speedMin, max: speedMax, step: speedStep, value: speedValue, onChange: e => change(speedKey, Number(e.target.value)) }),
        h('output', { style: { minWidth: 42, textAlign: 'right' } }, speedValue.toFixed(2)))),
      note(label(c.engine === 'indextts' ? '0.50 is faster and 2.00 is slower; this is the official IndexTTS duration_factor.' : '1.00 is the official default; the range matches the GPT-SoVITS WebUI speed_factor control.', c.engine === 'indextts' ? '0.50 更快，2.00 更慢；这里使用 IndexTTS 原版 duration_factor。' : '1.00 是官方默认值；范围与 GPT-SoVITS WebUI 的 speed_factor 一致。')),
      c.engine === 'gpt-sovits' ? note(label('Advanced contains the reference transcript and languages. Depending on the model, its matching transcript may be required; it cannot be inferred from the filename.', '参考音频原文和语言位于高级设置。部分模型需要填写对应原文，无法靠文件名可靠推断。')) : null,
      detected ? h('div', { role: 'status', 'aria-live': 'polite' },
        ...detected.warnings.map(code => warnings[code]).filter(Boolean).map(message => h('p', { key: message, className: 'dsh-local-ai-tts-module-desc' }, message))) : null,
      h('details', null,
        h('summary', { style: { cursor: 'pointer', padding: '10px 0' } }, label('Advanced settings — only if detection needs help', '高级设置 · 自动识别不完整时再填写')),
        h('div', { style: { display: 'grid', gap: 16, paddingTop: 12 } },
          field(label('Connection method', '连接方式'), h('select', { className: 'dsh-local-ai-tts-select', value: c.launchPreset, onChange: e => change('launchPreset', e.target.value) },
            h('option', { value: 'webui' }, label('Official WebUI backend (no browser required)', '官方 WebUI 后端（无需打开网页）')),
            h('option', { value: 'builtin' }, label('Independent worker / official API', '独立 worker／官方 API')),
            c.launchPreset === 'custom' ? h('option', { value: 'custom' }, label('Saved custom worker', '已保存的自定义 worker')) : null)),
          webui ? field(label('Backend startup', '后端启动'), h('select', { className: 'dsh-local-ai-tts-select', value: c.webuiMode, onChange: e => change('webuiMode', e.target.value) },
            h('option', { value: 'auto' }, label('Reuse or start official backend', '复用或后台启动官方后端')),
            h('option', { value: 'attach' }, label('Connect only; never start a model', '仅连接，不启动模型')))) : null,
          webui ? field(label('Inference WebUI address (auto-detected when blank)', '推理 WebUI 地址（留空时读取官方端口配置）'), input('webuiEndpoint', { placeholder: 'http://127.0.0.1:…' })) : null,
          webui ? note(label('Uses the confirmed reference and initial WebUI defaults, not unsaved settings in another browser. The selected endpoint must be the intended engine/model.', '使用已确认的参考音频和网页初始参数，不同步其他浏览器中未保存的设置。请确认该地址运行的是目标引擎和模型。')) : null,
          choice('pythonPath', label('Python executable', 'Python 可执行文件'), label('Blank: python on PATH', '留空：使用 PATH 中的 python')),
          c.engine === 'indextts' ? choice('modelDir', label('IndexTTS 2.5 model directory', 'IndexTTS 2.5 模型目录'), label('Directory containing config.yaml', '包含 config.yaml 的目录')) : null,
          !webui && c.engine === 'indextts' ? field(label('Additional voice directory (optional)', '附加音色目录（可选）'), input('presetsRoot')) : null,
          !webui && c.engine === 'indextts' ? field(label('Device (optional)', '设备（可选）'), input('device', { placeholder: 'cuda:0 / cpu' })) : null,
          !webui && c.engine === 'gpt-sovits' ? field(label('API script', 'API 启动脚本'), input('apiScript', { placeholder: 'api_v2.py' })) : null,
          !webui && c.engine === 'gpt-sovits' ? field(label('Inference YAML', '推理配置 YAML'), input('ttsConfig', { placeholder: 'GPT_SoVITS/configs/tts_infer.yaml' })) : null,
          webui && c.engine === 'gpt-sovits' ? field(label('Official inference variant (startup only)', '官方推理分支（仅启动时使用）'), h('select', { className: 'dsh-local-ai-tts-select', value: c.webuiVariant, onChange: e => change('webuiVariant', e.target.value) }, h('option', { value: 'standard' }, 'standard'), h('option', { value: 'fast' }, 'fast'))) : null,
          webui && c.engine === 'gpt-sovits' ? choice('gptVersion', label('Saved GPT model version (startup only)', '已保存的 GPT 模型版本（仅启动时使用）'), 'v1 / v2 / v3 / v4 / v2Pro / v2ProPlus') : null,
          webui && c.engine === 'gpt-sovits' ? field(label('GPT weights override (optional)', 'GPT 权重覆盖（可选）'), input('gptModel')) : null,
          webui && c.engine === 'gpt-sovits' ? field(label('SoVITS weights override (optional)', 'SoVITS 权重覆盖（可选）'), input('sovitsModel')) : null,
          c.engine === 'gpt-sovits' ? field(label('Reference transcript (model-dependent)', '参考音频原文（是否必填取决于模型）'), input('promptText')) : null,
          c.engine === 'gpt-sovits' ? field(label('Reference language', '参考音频语言'), input('promptLang', { placeholder: 'zh / en / ja' })) : null,
          !webui && c.engine === 'gpt-sovits' ? field(label('API port', 'API 端口'), input('port', { type: 'number', min: 1024, max: 65535, onChange: e => change('port', Number(e.target.value)) })) : null,
          c.launchPreset === 'custom' || c.endpoint ? note(label('Saved custom/legacy configuration. Changing the project folder selects the official backend.', '当前保留了旧版或自定义配置。更换项目文件夹后将选择官方后端。')) : null,
          field(label('Startup timeout (ms)', '启动超时（毫秒）'), input('startupTimeoutMs', { type: 'number', min: 1000, max: 600000, onChange: e => change('startupTimeoutMs', Number(e.target.value)) })),
          field(label('Request timeout (ms)', '请求超时（毫秒）'), input('timeoutMs', { type: 'number', min: 100, max: 600000, onChange: e => change('timeoutMs', Number(e.target.value)) })),
          !webui ? h('label', null, h('input', { type: 'checkbox', checked: c.autoStart !== false, onChange: e => change('autoStart', e.target.checked) }), label('Start worker automatically when reading', '朗读时自动启动 worker')) : null,
          h('label', null, h('input', { type: 'checkbox', checked: c.debug, onChange: e => change('debug', e.target.checked) }), label('Debug: logs full sentence text (private data)', 'Debug：将完整句子写入日志（含隐私数据）')))),
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', disabled: testing || detecting, onClick: async () => {
        const current = revision.current, key = JSON.stringify(c), provider = shared.provider;
        const valid = () => current === revision.current && shared.localProcess === c && JSON.stringify(c) === key && shared.provider === provider;
        setTesting(true); setStatus(label(webui && c.webuiMode === 'attach' ? 'Connecting to inference service…' : 'Connecting / loading engine in the background…', webui && c.webuiMode === 'attach' ? '正在连接推理服务…' : '正在后台连接／加载引擎…'));
        try {
          const d = await rpc('status', { config: { ...snapshot().config } });
          if (!valid()) return;
          setVoices(d.voices || []);
          setStatus((d.ready ? label('● Worker responded', '● Worker 已响应') : label('Worker not ready: ', 'Worker 尚未就绪：') + d.status) +
            (d.warning ? ' — ' + d.warning : '') + label(' — synthesis still needs a trial read.', ' — 实际合成仍需试听验证。'));
        } catch (e) { if (valid()) setStatus(e.message); }
        finally { setTesting(false); }
      } }, testing ? label('Connecting…', '连接中…') : label('Test Connection', '测试连接')),
      h('div', { role: 'status', 'aria-live': 'polite', style: { overflowWrap: 'anywhere' } }, status || label('Not tested', '尚未测试')),
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', onClick: () => { saveSettings(); setStatus(label('Settings saved', '设置已保存')); } }, label('Save settings', '保存设置')));
  }
  function Player() {
    useSharedForce();
    if (!isProcessProvider(shared.provider) || !shared.speaking) return null;
    const h = react.createElement;
    const zh = window.__dshLocalAiTtsI18n?.current() !== 'en';
    return h('div', { className: 'dsh-local-ai-tts-module', role: 'region', 'aria-label': zh ? '本地语音播放器' : 'Local Runtime player',
      style: { position: 'fixed', bottom: 24, right: 24, zIndex: 1000, display: 'flex', gap: 12, alignItems: 'center', padding: 12,
        background: 'var(--dsw-alias-bg-layer-2, #20242c)', color: 'var(--dsw-alias-label-primary, #fff)', borderRadius: 12 } },
      h('span', { role: 'status' }, (zh ? '本地语音 · ' : 'Local TTS · ') + (shared.chunkProgress?.index || '…')),
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', onClick: togglePause }, shared.paused ? t('mini.resume') : t('mini.pause')),
      h('button', { type: 'button', className: 'dsh-local-ai-tts-browse', onClick: stopSpeaking }, t('stopRead')));
  }
  slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', key: 'local-runtime-player', id: 'local-runtime-player', order: 1003 }, Player));
  ctx.effect(() => { const timer = setInterval(poll, 200); sync(); return () => { clearInterval(timer); stop(); }; }, 'local-runtime: browser player');
  return { defaults, sync, stop, session, read, Settings, discover, updateSetting, selectEngine, selectCharacter, applyHttpPreset };
}

// END LOCAL RUNTIME CLIENT
      const localRuntime = createLocalController();

      // ---------- settings persistence (voice / auto-read / provider / rvc) ----------
      // README Known-limits: voice & auto-read used to be in-memory only and reset
      // on refresh. Persist the user's settings to localStorage and restore them on
      // load, so refresh / reopen doesn't lose the choice.
      const SETTINGS_KEY = "dsh-local-ai-tts-settings";
      const RVC_DEFAULTS = {
        baseUrl: "http://127.0.0.1:4892",
        model: "",
        index: "",
        baseSource: "edge",
        baseAudioName: "",
        baseAudioFile: "",
        baseVoice: "zh-CN-YunyangNeural",
        baseRate: 0,
        basePitch: 0,
        baseVolume: 0,
        spkId: 0,
        f0File: "",
        f0Method: "rmvpe",
        indexRate: 0.75,
        f0UpKey: 0,
        resampleSr: 40000,
        rmsMixRate: 0.25,
        protect: 0.33,
        filterRadius: 3,
      };
      const sharedDefaults = {
        autoRead: false,
        voice: "zh-CN-XiaoxuanNeural",
        provider: "edge-tts",
        rvcAutoFallback: false,
        notify: {
          enabled: false,
          approval: true,
          approvalResult: false,
          voice: "zh-CN-XiaoxuanNeural",
        },
      };
      function loadSettings() {
        try {
          const store = globalThis.localStorage;
          if (!store) return;
          let raw = store.getItem(SETTINGS_KEY);
          // One-time copy only. Never write/delete the original plugin's settings.
          if (!raw && !store.getItem(SETTINGS_KEY + '-migrated')) {
            store.setItem(SETTINGS_KEY + '-migrated', '1');
            const legacy = store.getItem('dsh-tts-settings');
            if (legacy) {
              const old = JSON.parse(legacy);
              raw = JSON.stringify({ ...old, autoRead: false, notify: { ...old.notify, enabled: false } });
              store.setItem(SETTINGS_KEY, raw);
            }
          }
          if (!raw) return;
          const data = JSON.parse(raw);
          if (data.coexistenceMode === "auto" || data.coexistenceMode === "companion") shared.coexistenceMode = data.coexistenceMode;
          if (typeof data.autoRead === "boolean") shared.autoRead = data.autoRead;
          if (typeof data.voice === "string") shared.voice = data.voice;
          if (data.provider === "edge-tts" || data.provider === "rvc" || data.provider === "local-runtime" || data.provider === "indextts-process" || data.provider === "gpt-sovits-process")
            shared.provider = data.provider;
          const savedProcess = data.localProcess || data.localRuntime;
          if (savedProcess && typeof savedProcess === "object") {
            // Do not migrate existing launch commands to WebUI implicitly.
            if (savedProcess.launchPreset === undefined) shared.localProcess.launchPreset = savedProcess.command ? 'custom' : 'builtin';
            for (const key in localRuntime.defaults) {
              if (typeof savedProcess[key] === typeof localRuntime.defaults[key]) shared.localProcess[key] = savedProcess[key];
            }
            // Preserve the old HTTP connector only for the legacy provider
            // alias; new process providers use command/args instead.
            if (typeof savedProcess.endpoint === "string") shared.localProcess.endpoint = savedProcess.endpoint;
            // Keep older builtin/custom profile JSON stable. WebUI-only fields
            // are written after the user explicitly selects that mode.
            if (savedProcess.launchPreset !== 'webui' && savedProcess.webuiMode === undefined && savedProcess.webuiEndpoint === undefined) {
              for (const key of ['webuiMode', 'webuiEndpoint', 'webuiVariant', 'gptVersion', 'gptModel', 'sovitsModel']) delete shared.localProcess[key];
            }
          }
          if (typeof data.rvcAutoFallback === "boolean")
            shared.rvcAutoFallback = data.rvcAutoFallback;
          if (data.rvc && typeof data.rvc === "object") {
            for (const k in RVC_DEFAULTS) {
              if (k in data.rvc) shared.rvc[k] = data.rvc[k];
            }
          }
          if (data.notify && typeof data.notify === "object") {
            for (const k in sharedDefaults.notify) {
              if (k in data.notify) shared.notify[k] = data.notify[k];
            }
          }
        } catch (e) {
          /* bad/corrupt stored settings — keep defaults */
        }
      }
      function saveSettings() {
        localRuntime.sync();
        try {
          const store = globalThis.localStorage;
          if (!store) return;
          const data = {
            coexistenceMode: shared.coexistenceMode,
            autoRead: shared.autoRead,
            voice: shared.voice,
            provider: shared.provider,
            localProcess: { ...shared.localProcess },
            localRuntime: { ...shared.localProcess },
            rvcAutoFallback: shared.rvcAutoFallback,
            rvc: Object.assign({}, shared.rvc),
            notify: Object.assign({}, shared.notify),
          };
          store.setItem(SETTINGS_KEY, JSON.stringify(data));
          // FR-5（方案 §6.4-①）：配置外置——localStorage 保留为迁移源+兜底，host config.json 为唯一权威。
          // 去抖 fire-and-forget 推送全量 settings（host 侧局部 merge；last-write-wins，方案 Q1 拍板）。
          scheduleHostPush(JSON.stringify(data));
        } catch (e) {
          /* non-fatal */
        }
      }
      // FR-5（方案 §6.4-①）：host 推送（去抖）——函数签名不变，localStorage 与 host 双写
      // FR-6/7/8 B1：待发 body 存模块级变量＋pagehide keepalive flush（关页不丢最后一次设置）
      let hostPushTimer = null;
      let hostPushPending = null;
      function scheduleHostPush(jsonBody) {
        hostPushPending = JSON.stringify({
          speech: JSON.parse(jsonBody),
          endpoint: (shared.localProcess && typeof shared.localProcess.endpoint === "string") ? shared.localProcess.endpoint : undefined,
        });
        if (hostPushTimer) clearTimeout(hostPushTimer);
        hostPushTimer = setTimeout(() => {
          hostPushTimer = null;
          const body = hostPushPending;
          hostPushPending = null;
          if (!body) return;
          try {
            breezeApiFetch("/dsh-breeze-tts-api/config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body,
            }).catch(() => {});
          } catch (_) { /* host 不可达不致命（localStorage 兜底） */ }
        }, 800);
      }
      try {
        window.addEventListener("pagehide", () => {
          if (hostPushTimer) { clearTimeout(hostPushTimer); hostPushTimer = null; }
          if (hostPushPending) {
            const body = hostPushPending;
            hostPushPending = null;
            try { breezeApiFetch("/dsh-breeze-tts-api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {}); } catch (_) {}
          }
        });
      } catch (_) {}
      // FR-5（方案 §6.1-Q2）：挂载水合——host 为唯一权威；首次（host 出厂态＋本地有既有设置）自动迁移一次
      async function hydrateFromHost() {
        try {
          const r = await breezeApiFetch("/dsh-breeze-tts-api/config", { cache: "no-store" });
          if (!r.ok) return;
          const cfg = await r.json();
          const store = globalThis.localStorage;
          const localRaw = store ? store.getItem(SETTINGS_KEY) : null;
          if (!cfg.clientMigrated && localRaw) {
            try {
              await breezeApiFetch("/dsh-breeze-tts-api/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientMigrated: true,
                  speech: JSON.parse(localRaw),
                  endpoint: (shared.localProcess && typeof shared.localProcess.endpoint === "string") ? shared.localProcess.endpoint : undefined,
                }),
              });
            } catch (_) {}
            return; // 迁移轮不覆盖——host 已拿到本地设置，下次挂载按 host 渲染
          }
          const data = cfg.speech || {};
          if (typeof data.autoRead === "boolean") shared.autoRead = data.autoRead;
          if (typeof data.voice === "string") shared.voice = data.voice;
          if (data.provider === "edge-tts" || data.provider === "rvc" || data.provider === "local-runtime" || data.provider === "indextts-process" || data.provider === "gpt-sovits-process")
            shared.provider = data.provider;
          const savedProcess = data.localProcess || data.localRuntime;
          if (savedProcess && typeof savedProcess === "object") {
            for (const key in localRuntime.defaults) {
              if (typeof savedProcess[key] === typeof localRuntime.defaults[key]) shared.localProcess[key] = savedProcess[key];
            }
          }
          if (typeof data.rvcAutoFallback === "boolean") shared.rvcAutoFallback = data.rvcAutoFallback;
          if (data.rvc && typeof data.rvc === "object") {
            for (const k in RVC_DEFAULTS) {
              if (k in data.rvc) shared.rvc[k] = data.rvc[k];
            }
          }
          if (data.notify && typeof data.notify === "object") {
            for (const k in sharedDefaults.notify) {
              if (k in data.notify) shared.notify[k] = data.notify[k];
            }
          }
          // 两 tab 统一（方案拍板 5）：顶层 endpoint 为唯一 Breeze 地址源，覆盖本地
          if (typeof cfg.endpoint === "string" && cfg.endpoint && shared.localProcess) {
            shared.localProcess.endpoint = cfg.endpoint;
          }
          // ★ 2026-10-29：host 里可能存着被隐藏的引擎（老配置）⇒ 拉回来时给个可见落点，
          //   否则下拉空白、区块不渲染，用户以为插件坏了。
          coerceVisibleEngine(shared.localProcess);
          localRuntime.sync();
          notify();
        } catch (_) { /* host 不可达：localStorage 兜底已在用 */ }
      }
      function resetSettings() {
        stopSpeaking();
        shared.localProcess = { ...localRuntime.defaults };
        coerceVisibleEngine(shared.localProcess);
        shared.coexistenceMode = "auto";
        shared.autoRead = sharedDefaults.autoRead;
        shared.voice = sharedDefaults.voice;
        shared.provider = sharedDefaults.provider;
        shared.rvcAutoFallback = sharedDefaults.rvcAutoFallback;
        for (const k in sharedDefaults.notify) shared.notify[k] = sharedDefaults.notify[k];
        for (const k in RVC_DEFAULTS) shared.rvc[k] = RVC_DEFAULTS[k];
        try {
          const store = globalThis.localStorage;
          if (store) store.removeItem(SETTINGS_KEY);
        } catch (e) {}
        refreshCoexistence();
        notify();
      }
      loadSettings();
      // A-2（方案 §三-A2 第三面双保险）：loadSettings 会把 savedProcess 的隐藏引擎逐字段
      // 拷回 shared.localProcess，覆盖前面各落点——这里再落点一次，refresh 后隐藏引擎不回魂。
      coerceVisibleEngine(shared.localProcess);
      hydrateFromHost(); // FR-5：host 权威配置水合（首次自动迁移 localStorage）
      try {
        if (typeof window !== "undefined")
          window.__dshLocalAiTtsSettings = {
            get: () => ({
              coexistenceMode: shared.coexistenceMode,
            autoRead: shared.autoRead,
              voice: shared.voice,
              provider: shared.provider,
            localProcess: { ...shared.localProcess },
              localRuntime: { ...shared.localProcess },
              rvcAutoFallback: shared.rvcAutoFallback,
              rvc: Object.assign({}, shared.rvc),
              notify: Object.assign({}, shared.notify),
            }),
            save: saveSettings,
            reset: resetSettings,
          };
      } catch (e) {}
      const listeners = new Set();
      function notify() {
        for (const fn of listeners) {
          try {
            fn();
          } catch (e) {}
        }
      }
      function useSharedForce() {
        const [, setN] = react.useState(0);
        react.useEffect(() => {
          const fn = () => setN(n => n + 1);
          listeners.add(fn);
          return () => listeners.delete(fn);
        }, []);
      }

      // ---------- toast (transient, themed error/warn notification) ----------
      // Errors that happen *outside* the settings preview (message read-aloud,
      // auto-read, chunk playback) had nowhere to land — they only reset the
      // icon and logged to console. A small fixed toast in shell.overlay makes
      // them visible: auto-dismisses, has a close button, and can carry one
      // action button (e.g. "read with Edge instead" after an RVC failure).
      let toastTimer = null;
      function showToast(text, kind, action) {
        shared.toast = { text: String(text), kind: kind || "error", action: action || null };
        notify();
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          shared.toast = null;
          notify();
        }, 6000);
      }
      function dismissToast() {
        if (toastTimer) {
          clearTimeout(toastTimer);
          toastTimer = null;
        }
        shared.toast = null;
        notify();
      }
      // Edge voice used when an RVC read falls back to plain Edge TTS: reuse the
      // RVC base voice (the timbre the user picked for conversion) when it comes
      // from Edge, otherwise the configured reading voice.
      function fallbackEdgeVoice() {
        return (shared.rvc.baseSource === "edge" && shared.rvc.baseVoice) ||
          shared.voice;
      }

      // ---------- approval voice alerts (Agent-event broadcast) ----------
      // The Host ingests approval session events (approval/asked, approval/
      // decided) from the session/event firehose and serves them through
      // /dsh-breeze-tts-api/notify?s=N. The poller picks them up and reads a short
      // alert aloud: requests INTERRUPT the current read (high priority, the
      // agent is waiting on the decision); results announce only when idle.
      // Alerts always use Edge TTS with the configured alert voice and never
      // surface error toasts (they must not spam while the agent loops).
      function announceNotify(item) {
        if (coexistence.companion) return;
        if (shared.provider === "local-runtime" || shared.provider === "indextts-process" || shared.provider === "gpt-sovits-process") return;
        if (!shared.notify.enabled) return;
        let text = "";
        if (item.kind === "approval") {
          if (!shared.notify.approval) return;
          text = t("notify.approval.lead");
          if (item.toolName) text += item.toolName;
          if (item.reason) text += "，" + item.reason;
        } else if (item.kind === "approval-decided") {
          if (!shared.notify.approvalResult) return;
          text =
            t("notify.decided.lead") +
            (item.outcome === "granted"
              ? t("notify.decided.granted")
              : item.outcome === "rejected"
                ? t("notify.decided.rejected")
                : t("notify.decided.settled"));
        }
        if (!text) return;
        if (item.kind !== "approval" && shared.speaking) return; // idle-only
        speakText(text, "notify", () => {}, {
          provider: "edge-tts",
          voice: shared.notify.voice || "zh-CN-XiaoxuanNeural",
        });
      }

      function plainText(text) {
        return String(text || "")
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/`([^`]*)`/g, "$1")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/__([^_]+)__/g, "$1")
          .replace(/~~([^~]+)~~/g, "$1")
          .replace(/^\s*(?:[-*_~—―─━⸺⸻]\s*){3,}\s*$/gmu, " ")
          .replace(/[—―─━⸺⸻]+/gu, " ")
          .replace(/^\s*[-*+]\s+/gm, "")
          .replace(/^\s*\d+\.\s+/gm, "")
          .replace(/[ \t]+/g, " ")
          .replace(/\s*\n\s*/g, " ")
          .trim();
      }

      function extractText(blocks) {
        let text = "";
        if (blocks) {
          for (const b of blocks) {
            if (b && b.kind === "text" && typeof b.text === "string")
              text += (text ? "\n" : "") + b.text;
          }
        }
        return text;
      }

      function clearSpeaking(token) {
        if (token === shared.speakToken) {
          shared.speaking = false;
          shared.currentText = null;
          shared.currentKey = null;
          shared.speakSource = null;
          shared.chunkProgress = null;
          shared.currentJobId = null;
          shared.paused = false;
          shared.rate = 1;
          notify();
        }
      }

      function stopSpeaking() {
        localRuntime.stop();
        shared.speakToken += 1;
        shared.speaking = false;
        shared.currentText = null;
        shared.currentKey = null;
        shared.speakSource = null;
        shared.chunkProgress = null;
        shared.paused = false;
        shared.rate = 1;
        const el = shared.audioEl;
        if (el) {
          try {
            el.pause();
          } catch (e) {}
          releaseUrl(el.dataset.blobUrl); // 1.1.0 revoke 点③：停播全收
          try {
            el.removeAttribute("src");
          } catch (e) {}
        }
        const el2 = shared.spareAudioEl;
        if (el2) {
          try {
            el2.pause();
          } catch (e) {}
          releaseUrl(el2.dataset.blobUrl); // 1.1.0 revoke 点③
          try {
            el2.removeAttribute("src");
          } catch (e) {}
        }
        // 1.1.0 revoke 点③（续）：未播 chunk 的 blob 全收（queue 由 playChunksAudio 挂在 shared 上）
        for (const u of (shared.activeChunkQueue || [])) releaseUrl(u);
        shared.activeChunkQueue = null;
        if (shared.waCleanup) {
          try {
            shared.waCleanup();
          } catch (e) {}
          shared.waCleanup = null;
        }
        // Eagerly cancel the RVC chunked job so the local conversion service
        // stops scheduling new chunks and the Host releases the job promptly
        // (no waiting for the lazy GC). Best-effort, fire-and-forget.
        const job = shared.currentJobId;
        shared.currentJobId = null;
        if (job) {
          try {
            breezeApiFetch(
              "/dsh-breeze-tts-api/rvc-next?job=" + encodeURIComponent(job) + "&cancel=1",
            ).catch(() => {});
          } catch (e) {}
        }
        notify();
      }

      function stopIfSource(source) {
        if (shared.speakSource === source) stopSpeaking();
      }

      // Edge TTS 端点移除音色（1007）时自愈：prune 掉该音色并回退默认，
      // 让用户下次不再选到已失效音色（比反复报错更有用）。只有 Edge 模式适用。
      function pruneRemovedVoice(errorText) {
        const voice = shared.voice;
        const text = String(errorText || "");
        if (!voice || shared.provider !== "edge-tts") return false;
        if (!/1007|unsupported\s+voice|not\s+support/i.test(text)) return false;
        shared.removedVoices.add(voice);
        shared.voice = "zh-CN-XiaoxuanNeural";
        notify();
        return true;
      }

      // ---------- mini player: pause/resume + speed ----------
      const SPEEDS = [1, 1.25, 1.5];
      function formatRate(r) {
        return r === 1 ? "1x" : r + "x";
      }
      function applySpeedToEl() {
        const el = shared.audioEl;
        if (el) {
          try {
            el.playbackRate = shared.rate;
            const el2 = shared.spareAudioEl;
            if (el2) el2.playbackRate = shared.rate;
          } catch (e) {}
        }
      }
      function togglePause() {
        shared.paused = !shared.paused;
        if (shared.waCleanup || shared.provider === 'local-runtime' || shared.provider === 'indextts-process' || shared.provider === 'gpt-sovits-process') {
          // Web Audio chunked path: suspend/resume the shared context (gapless-safe)
          const ctx = shared.audioCtx;
          if (ctx) {
            if (shared.paused) {
              try { ctx.suspend(); } catch (e) {}
            } else {
              try { ctx.resume(); } catch (e) {}
            }
          }
        } else {
          // single-URL <audio> path
          const el = shared.audioEl;
          if (el) {
            if (shared.paused) {
              try { el.pause(); } catch (e) {}
            } else {
              try { el.play().catch(() => {}); } catch (e) {}
            }
          }
        }
        notify();
      }
      function cycleSpeed() {
        if (shared.provider === "local-runtime" || shared.provider === "indextts-process" || shared.provider === "gpt-sovits-process") return;
        const i = SPEEDS.indexOf(shared.rate);
        shared.rate = SPEEDS[(i < 0 ? 0 : i + 1) % SPEEDS.length];
        applySpeedToEl();
        notify();
      }

      async function rpcSpeak(text, voice, provider) {
        // `provider` defaults to the active provider; an explicit override is
        // used by the RVC->Edge fallback (auto or one-click) so a failed RVC
        // read can be re-synthesized with plain Edge TTS without flipping the
        // persisted provider.
        const useProvider = provider || shared.provider;
        const payload = { text, voice, provider: useProvider };
        const pct = v =>
          v === 0 ? "default" : (v > 0 ? "+" : "") + v + "%";
        if (useProvider === "rvc") {
          const r = shared.rvc;
          const custom = Object.assign({}, r, {
            baseRate: pct(r.baseRate),
            basePitch: pct(r.basePitch),
            baseVolume: pct(r.baseVolume),
          });
          if (r.baseSource !== "upload") {
            custom.baseAudioFile = "";
            custom.baseAudioName = "";
          }
          payload.custom = custom;
        } else {
          payload.prosody = {
            rate: pct(shared.rvc.baseRate),
            pitch: pct(shared.rvc.basePitch),
            volume: pct(shared.rvc.baseVolume),
          };
        }
        const response = await breezeApiFetch("/dsh-breeze-tts-api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        // 1.1.0 §二.2：413 说人话（方案 §二.2-③）——极端超限时不再甩"body too large"
        if (response.status === 413) {
          return { error: "音频太长：已自动压缩到 24kHz，请改用 30 秒以内的片段" };
        }
        return await response.json();
      }

      async function fetchNextChunk(jobId, token) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 200000);
        try {
          const r = await breezeApiFetch(
            "/dsh-breeze-tts-api/rvc-next?job=" + encodeURIComponent(jobId),
            { signal: ctrl.signal },
          );
          return await r.json().catch(() => ({ done: true }));
        } catch (e) {
          return { done: true, error: String((e && e.message) || e) };
        } finally {
          clearTimeout(timer);
        }
      }

      // Web Audio chunk player: decodes each chunk into an AudioBuffer and
      // schedules the sources back-to-back on the sample clock
      // (start(prevEnd) — sample-accurate, gapless by construction). The server
      // already trims per-chunk edge silence; decoding stays 2 buffers ahead so
      // the chain never falls behind.
      async function playChunks(jobId, initialUrls, total, token, onError) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return playChunksAudio(jobId, initialUrls, total, token, onError);
        let ctx = shared.audioCtx;
        if (!ctx) {
          try {
            ctx = shared.audioCtx = new AC();
          } catch (e) {
            return playChunksAudio(jobId, initialUrls, total, token, onError);
          }
        }
        if (ctx.state === "suspended") {
          try {
            await ctx.resume();
          } catch (e) { /* keep going; start() clamps to currentTime */ }
        }
        const queue = initialUrls.slice();
        let cursor = 0;       // next queue index to decode
        let completed = false; // host reported no more chunks
        let inFlight = null;
        let nextStart = ctx.currentTime + 0.05; // schedule cursor (sample clock)
        let decoded = 0;      // sources scheduled
        let played = 0;       // sources that ended
        let finished = false;
        const sources = new Set();
        let master = null;
        try {
          master = ctx.createGain();
          master.connect(ctx.destination);
        } catch (e) {
          return playChunksAudio(jobId, initialUrls, total, token, onError);
        }
        const setProgress = index => {
          shared.chunkProgress = { index: Math.min(index, total), total };
          notify();
        };
        const requestNext = () => {
          if (completed || inFlight) return;
          inFlight = fetchNextChunk(jobId, token)
            .then(r => {
              inFlight = null;
              if (token !== shared.speakToken) return;
              if (r && r.url) queue.push(r.url);
              else if (r && r.error) {
                completed = true;
                if (typeof onError === "function") onError(t("err.chunkFail") + r.error);
              } else {
                completed = true;
              }
            })
            .catch(() => {
              inFlight = null;
              completed = true;
            });
        };
        const decode = async url => {
          const r = await breezeApiFetch(url); // 1.1.0：decode 走插件路由，穿透模式需 token（开工指令 §一.2）
          if (!r.ok) throw new Error("HTTP " + r.status);
          return await ctx.decodeAudioData(await r.arrayBuffer());
        };
        const schedule = buf => {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = shared.rate || 1; // mini-player speed
          src.connect(master);
          src.start(nextStart);
          nextStart += buf.duration / (shared.rate || 1); // wall-clock-consistent
          sources.add(src);
          const k = decoded;
          src.onended = () => {
            sources.delete(src);
            if (token !== shared.speakToken) return;
            played++;
            setProgress(k + 2);
            if (played >= total) finish();
          };
          decoded++;
        };
        const cleanup = () => {
          for (const s of sources) {
            try {
              s.stop();
            } catch (e) {}
          }
          sources.clear();
          try {
            master.disconnect();
          } catch (e) {}
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          if (shared.waCleanup === cleanup) shared.waCleanup = null;
          cleanup();
          if (token === shared.speakToken) clearSpeaking(token);
        };
        shared.waCleanup = () => {
          if (finished) return;
          finished = true;
          if (shared.waCleanup === cleanup) shared.waCleanup = null;
          cleanup();
        };
        try {
          setProgress(1);
          while (token === shared.speakToken && !finished) {
            if (queue.length - cursor >= 2) requestNext(); // top up URL queue
            if (cursor < queue.length && decoded - played < 2) {
              const url = queue[cursor++];
              try {
                const buf = await decode(url);
                if (token !== shared.speakToken) break;
                schedule(buf);
              } catch (e) {
                if (typeof onError === "function")
                  onError(t("err.audioDecode") + String((e && e.message) || e));
                break;
              }
              continue;
            }
            requestNext();
            await new Promise(r => setTimeout(r, 200));
          }
        } finally {
          finish();
        }
      }

      // Fallback chunk player (no Web Audio): two <audio> elements ping-pong;
      // the next chunk's data preloads during the current chunk's playback.
      async function playChunksAudio(jobId, initialUrls, total, token, onError) {
        const elA = shared.audioEl;
        const elB = document.createElement("audio");
        elB.preload = "auto";
        elB.style.display = "none";
        document.body.appendChild(elB);
        shared.spareAudioEl = elB;
        // FR-8（方案 §4.3-5）：chunk URL 在入队前统一授权取 blob（穿透模式 /audio 无 token 401）
        const queue = [];
        for (const u of initialUrls) queue.push(await authorizeAudioUrl(u));
        shared.activeChunkQueue = queue; // 1.1.0 revoke 点③：stopSpeaking 全收未播 blob
        let cursor = 0;
        let completed = false; // host reported no more chunks
        let inFlight = null;
        let cur = elA;
        let spare = elB;
        const setProgress = index => {
          shared.chunkProgress = { index, total };
          notify();
        };
        const requestNext = () => {
          if (completed || inFlight) return;
          inFlight = fetchNextChunk(jobId, token)
            .then(async r => {
              inFlight = null;
              if (token !== shared.speakToken) return;
              if (r && r.url) queue.push(await authorizeAudioUrl(r.url));
              else if (r && r.error) {
                completed = true;
                if (typeof onError === "function") onError(t("err.chunkFail") + r.error);
              } else {
                completed = true;
              }
            })
            .catch(() => {
              inFlight = null;
              completed = true;
            });
        };
        const playOne = (url, index) =>
          new Promise(resolve => {
            if (token !== shared.speakToken) return resolve();
            setProgress(index);
            let done = false;
            const fin = () => {
              if (done) return;
              done = true;
              cur.onended = null;
              cur.onerror = null;
              resolve();
            };
            cur.onended = fin;
            cur.onerror = () => {
              fin();
              if (typeof onError === "function") onError(t("err.chunkSkip"));
            };
            if (cur.getAttribute("src") !== url) {
              releaseUrl(cur.dataset.blobUrl); // 1.1.0 revoke 点②：换 src 前收旧
              cur.src = url;
              cur.dataset.blobUrl = blobRegistry.has(url) ? url : "";
              cur.load();
            }
            try { cur.playbackRate = shared.rate || 1; } catch (e) {}
            cur.play().catch(fin);
          });
        try {
          while (token === shared.speakToken) {
            if (queue.length - cursor >= 2) requestNext(); // top up while comfortably buffered
            if (cursor < queue.length) {
              const url = queue[cursor];
              const after = queue[cursor + 1];
              // preload the NEXT chunk's audio into the spare element while the
              // current chunk plays (full chunk-duration of lead time)
              if (after && spare.getAttribute("src") !== after) {
                releaseUrl(spare.dataset.blobUrl); // 1.1.0 revoke 点②：预载换 src 前收旧
                spare.src = after;
                spare.dataset.blobUrl = blobRegistry.has(after) ? after : "";
                spare.load();
                try { spare.playbackRate = shared.rate || 1; } catch (e) {}
              }
              await playOne(url, cursor + 1);
              // swap: the buffered spare becomes the player; the just-finished
              // element becomes the next preload target
              const t = cur;
              cur = spare;
              spare = t;
              cursor++;
              continue;
            }
            requestNext();
            if (!inFlight) break; // nothing buffered, nothing coming
            await new Promise(r => setTimeout(r, 200));
          }
        } finally {
          if (token === shared.speakToken) clearSpeaking(token);
          try { elB.pause(); } catch (e) {}
          try { elB.removeAttribute("src"); } catch (e) {}
          try { document.body.removeChild(elB); } catch (e) {}
          shared.spareAudioEl = null;
        }
      }

      async function speakText(rawText, source, onError, opts) {
        refreshCoexistence();
        if (coexistence.companion && ((opts && opts.provider && opts.provider !== "local-runtime" && opts.provider !== "indextts-process" && opts.provider !== "gpt-sovits-process") || (source === "auto" && !localAutoAllowed()))) return { ok: false, error: "coexistence guard" };
        const trimmed = plainText(rawText);
        if (!trimmed) return { ok: false, error: "empty text" };
        // ★ 2026-10-29：区分"同一次播放"。以前只看文字，相同文字的不同按钮会互相顶掉。
        //   opts.sourceKey 由调用方给（消息按钮传 "msg:<messageId>"）；
        //   不给就退回老行为（只比文字），保证不改变自动朗读等既有语义。
        const myKey = (opts && typeof opts.sourceKey === "string") ? opts.sourceKey : null;
        const sameTarget = myKey && shared.currentKey
          ? (myKey === shared.currentKey)
          : true;   // 老行为：没给 key 就只按文字判
        if (shared.speaking && shared.currentText === trimmed && sameTarget) {
          stopSpeaking();
          return { ok: true, stopped: true };
        }
        stopSpeaking();
        const token = ++shared.speakToken;
        shared.speaking = true;
        shared.currentText = trimmed;
        shared.currentKey = myKey;
        shared.speakSource = source || "manual";
        notify();
        // Explicit provider override (one-click RVC->Edge fallback) else active.
        const provider = (opts && opts.provider) || shared.provider;
        // An explicit voice override (approval alerts pick their own alert
        // voice); falling back from RVC to Edge reuses the RVC base voice when
        // it came from Edge (closest to the configured timbre), else the
        // configured reading voice.
        const voice =
          (opts && opts.voice) ||
          (provider === "edge-tts" && shared.provider === "rvc"
            ? fallbackEdgeVoice()
            : shared.voice);
        if (provider === "local-runtime" || provider === "indextts-process" || provider === "gpt-sovits-process") return localRuntime.read(trimmed, onError);
        try {
          let result = await rpcSpeak(trimmed, voice, provider);
          if (token !== shared.speakToken)
            return { ok: false, error: "interrupted" };
          // Opt-in auto-fallback: an RVC read failed -> silently retry with
          // Edge TTS. Only for the ACTIVE RVC provider and not already a
          // fallback attempt. Long RVC reads fail at /speak time (prewarm), so
          // this single error path covers both short and chunked reads.
          if (
            result &&
            result.error &&
            shared.provider === "rvc" &&
            !(opts && opts.provider) &&
            shared.rvcAutoFallback
          ) {
            const r2 = await rpcSpeak(trimmed, fallbackEdgeVoice(), "edge-tts");
            if (token !== shared.speakToken)
              return { ok: false, error: "interrupted" };
            if (r2 && !r2.error) {
              result = r2;
              showToast(t("toast.rvcFallback"), "warn");
            }
          }
          if (!result || result.error) {
            const errText = String(
              (result && result.error) || t("err.synthFailShort"),
            );
            const pruned = pruneRemovedVoice(errText);
            clearSpeaking(token);
            console.error("[tts] synthesize failed:", errText);
            if (pruned && typeof onError === "function")
              onError(t("voice.removed"));
            else if (typeof onError === "function") onError(errText);
            return { ok: false, error: errText };
          }
          const el = shared.audioEl;
          if (!el) {
            clearSpeaking(token);
            return { ok: false, error: "audio unavailable" };
          }
          // Long RVC read -> chunked progressive playback queue.
          if (Array.isArray(result.chunks) && result.chunks.length) {
            const total = result.total || result.chunks.length;
            shared.currentJobId = result.jobId || null;
            shared.chunkProgress = { index: 1, total };
            notify();
            playChunks(result.jobId, result.chunks, total, token, onError);
            return { ok: true, chunked: true, total };
          }
          shared.currentJobId = null;
          el.onended = () => { releaseUrl(el.dataset.blobUrl); clearSpeaking(token); }; // 1.1.0 revoke 点①：播完即收
          el.onerror = () => {
            clearSpeaking(token);
            if (typeof onError === "function") onError(t("err.audioLoadRetry"));
          };
          el.src = await authorizeAudioUrl(result.url); // FR-8：/audio 授权取 blob（保持 <audio> 控制链）
          el.dataset.blobUrl = blobRegistry.has(el.src) ? el.src : "";
          // C-22（方案 §五）：停止竞态二次校验——authorizeAudioUrl 是 await 点，期间用户
          // 可能已按停止（speakToken 已变），不校验的话刚停的声音又自己响起来（失控）。
          if (token !== shared.speakToken) { releaseUrl(el.src); el.src = ""; return { ok: false, error: "interrupted" }; }
          try { el.playbackRate = shared.rate; } catch (e) {}
          try {
            await el.play();
          } catch (e) {
            clearSpeaking(token);
            console.error("[tts] play failed:", String(e));
            if (typeof onError === "function") onError(errTextOf(e));
            return { ok: false, error: String((e && e.message) || e) };
          }
          return { ok: true };
        } catch (e) {
          const errText2 = String((e && e.message) || e);
          console.error("[tts] rpc failed:", errText2);
          const pruned = pruneRemovedVoice(errText2);
          clearSpeaking(token);
          if (pruned && typeof onError === "function")
            onError(t("voice.removed"));
          else if (typeof onError === "function") onError(errText2);
          return { ok: false, error: errText2 };
        }
      }

      function errTextOf(e) {
        const s = String((e && e.message) || e || "");
        return s || t("err.audioLoadRetry");
      }

      // Export the synthesized audio of a message as a downloadable file. Uses
      // the same in-session cache so a just-read message downloads instantly.
      // Long RVC chunked reads have no single audio file yet -> unsupported.
      async function downloadText(rawText, onError) {
        if (shared.provider === "local-runtime" || shared.provider === "indextts-process" || shared.provider === "gpt-sovits-process") { if (onError) onError(t("download.notSupported")); return; }
        const plain = plainText(rawText);
        if (!plain) return;
        // Long RVC reads are chunked with no single output file yet; skip rather
        // than starting a wasteful probe+prewarm conversion job on the Host.
        if (
          shared.provider === "rvc" &&
          shared.rvc.baseSource === "edge" &&
          plain.length > 60
        ) {
          if (typeof onError === "function") onError(t("download.notSupported"));
          return;
        }
        try {
          const result = await rpcSpeak(plain, shared.voice);
          if (result && result.error) {
            if (typeof onError === "function") onError(t("download.fail") + result.error);
            return;
          }
          if (result && result.url) {
            // A-4（方案 §三-A4）：下载改 fetch→blob→a.click()——原来的 <a href> 普通导航
            // 不带 Bearer，穿透/跨机模式必 401；走 breezeApiFetch（带 token + 401 配对），
            // blob URL 用完即弃（10s 后 revoke，等浏览器起下载），不进播放 blob 台账。
            try {
              const r2 = await breezeApiFetch(result.url + "?download=1");
              if (!r2.ok) throw new Error("HTTP " + r2.status);
              const u = URL.createObjectURL(await r2.blob());
              const a = document.createElement("a");
              a.href = u;
              a.download = "dsh-local-ai-tts.mp3";
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_) {} }, 10000);
            } catch (e2) {
              if (typeof onError === "function") onError(t("download.fail") + String((e2 && e2.message) || e2));
            }
            return;
          }
          if (result && Array.isArray(result.chunks)) {
            if (typeof onError === "function") onError(t("download.notSupported"));
            return;
          }
          if (typeof onError === "function") onError(t("download.fail") + (result && result.error || "?"));
        } catch (e) {
          if (typeof onError === "function")
            onError(t("download.fail") + String((e && e.message) || e));
        }
      }

      // ---------- icons ----------
      function SpeakerIcon() {
        return react.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            width: 16,
            height: 16,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.2,
            "aria-hidden": true,
          },
          react.createElement("path", {
            d: "M2.5 6v4h2.5L8 12.5v-9L5 6H2.5z",
            fill: "currentColor",
            stroke: "none",
          }),
          react.createElement("path", { d: "M10 6.2a3 3 0 0 1 0 3.6" }),
          react.createElement("path", { d: "M11.4 4.6a5 5 0 0 1 0 6.8" }),
        );
      }
      function HeadphonesIcon() {
        return react.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            width: 15,
            height: 15,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.4,
            "aria-hidden": true,
          },
          react.createElement("path", { d: "M3 9a5 5 0 0 1 10 0" }),
          react.createElement("path", {
            d: "M2.5 8.5v3a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-2a.5.5 0 0 0-.5.5z",
            fill: "currentColor",
            stroke: "none",
          }),
          react.createElement("path", {
            d: "M13.5 8.5v3a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5z",
            fill: "currentColor",
            stroke: "none",
          }),
        );
      }
      function EqualizerIcon() {
        return react.createElement(
          "span",
          { className: "dsh-local-ai-tts-eq", "aria-hidden": true },
          react.createElement("span", { className: "dsh-local-ai-tts-eq-bar" }),
          react.createElement("span", { className: "dsh-local-ai-tts-eq-bar" }),
          react.createElement("span", { className: "dsh-local-ai-tts-eq-bar" }),
        );
      }
      function PauseIcon() {
        return react.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            width: 15,
            height: 15,
            fill: "currentColor",
            "aria-hidden": true,
          },
          react.createElement("rect", { x: 4.2, y: 3, width: 2.6, height: 10, rx: 1 }),
          react.createElement("rect", { x: 9.2, y: 3, width: 2.6, height: 10, rx: 1 }),
        );
      }
      function PlayIcon() {
        return react.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            width: 15,
            height: 15,
            fill: "currentColor",
            "aria-hidden": true,
          },
          react.createElement("path", {
            d: "M5 3.4v9.2c0 .7.8 1.1 1.4.7l6.6-4.6c.5-.4.5-1.1 0-1.5L6.4 2.7c-.6-.4-1.4 0-1.4.7z",
          }),
        );
      }
      function DownloadIcon() {
        return react.createElement(
          "svg",
          {
            viewBox: "0 0 16 16",
            width: 15,
            height: 15,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.4,
            "aria-hidden": true,
          },
          react.createElement("path", { d: "M8 2.5v7" }),
          react.createElement("path", { d: "M5 6.5l3 3 3-3" }),
          react.createElement("path", { d: "M3 11v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V11" }),
        );
      }
      function SpinnerIcon() {
        return react.createElement("span", {
          className: "dsh-local-ai-tts-spinner",
          "aria-hidden": true,
        });
      }

      // ---------- styles ----------
      const CSS =
        ".dsh-local-ai-tts-toggle{width:28px;height:28px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:999px;place-items:center;display:grid}" +
        ".dsh-local-ai-tts-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
        ".dsh-local-ai-tts-toggle[data-active]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-auto-pill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none;order:1}" +
        ".dsh-local-ai-tts-auto-pill:hover{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-label-dimmed)}" +
        ".dsh-local-ai-tts-auto-pill[data-active]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}" +
        ".dsh-local-ai-tts-auto-label{font-size:12px;line-height:1}" +
        ".dsh-local-ai-tts-auto-dot{width:7px;height:7px;border-radius:50%;border:1.5px solid currentColor;flex:none}" +
        ".dsh-local-ai-tts-auto-pill[data-active] .dsh-local-ai-tts-auto-dot{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}" +
        'div[class*="_tools"]>.dsh-local-ai-tts-auto-pill{order:1}' +
        'div[class*="_tools"]>div[class*="_modes"]{order:2}' +
        'div[class*="_tools"]>.dsh-local-ai-tts-toggle{order:1}' +
        ".dsh-local-ai-tts-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}" +
        ".dsh-local-ai-tts-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
        ".dsh-local-ai-tts-action:disabled{cursor:default;opacity:.4}" +
        ".dsh-local-ai-tts-action[data-active]{color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-mini{display:inline-flex;align-items:center;gap:2px}" +
        ".dsh-local-ai-tts-mini .dsh-local-ai-tts-action{width:26px;height:26px;padding:5px}" +
        ".dsh-local-ai-tts-dl-err{font-size:11px;line-height:16px;color:var(--dsw-alias-label-error);max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        ".dsh-local-ai-tts-dl-err[role=alert]{font-size:11px;color:var(--dsw-alias-label-error)}" +
        ".dsh-local-ai-tts-sel-wrap{position:fixed;z-index:1200;transform:translateX(-50%)}" +
        ".dsh-local-ai-tts-sel-btn{height:26px;padding:0 11px;border:none;border-radius:999px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-inverse);font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:nowrap}" +
        ".dsh-local-ai-tts-sel-btn:hover{opacity:.9}" +
        ".dsh-local-ai-tts-speed-label{font-size:11px;font-weight:600;line-height:1;min-width:22px;text-align:center}" +
        ".dsh-local-ai-tts-chunk-pill{font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);padding:0 2px;white-space:nowrap;font-variant-numeric:tabular-nums}" +
        "[data-local-ai-tts-tip]{position:relative}" +
        "[data-local-ai-tts-tip]:hover::after{content:attr(data-local-ai-tts-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;line-height:14px;z-index:300;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none}" +
        "[data-local-ai-tts-tip]:hover::before{content:\"\";position:absolute;bottom:calc(100% + 2px);left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--dsw-alias-border-l2);z-index:300;pointer-events:none}" +
        ".dsh-local-ai-tts-eq{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;gap:2px}" +
        ".dsh-local-ai-tts-eq-bar{width:2.5px;border-radius:1px;background:currentColor;height:6px;animation:dsh-local-ai-tts-eq-bounce .9s ease-in-out infinite}" +
        ".dsh-local-ai-tts-eq-bar:nth-child(1){animation-delay:0s}" +
        ".dsh-local-ai-tts-eq-bar:nth-child(2){animation-delay:.15s}" +
        ".dsh-local-ai-tts-eq-bar:nth-child(3){animation-delay:.3s}" +
        "@keyframes dsh-local-ai-tts-eq-bounce{0%,100%{height:5px}50%{height:13px}}" +
        ".dsh-local-ai-tts-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:3000;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 32px));padding:9px 10px 9px 14px;border-radius:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 18px rgba(0,0,0,.32);animation:dsh-local-ai-tts-toast-in .18s ease-out}" +
        ".dsh-local-ai-tts-toast-error{border-color:var(--dsw-alias-label-error)}" +
        ".dsh-local-ai-tts-toast-warn{border-color:var(--dsw-alias-label-warning,var(--dsw-alias-label-secondary))}" +
        ".dsh-local-ai-tts-toast-text{flex:1;min-width:0;white-space:pre-line;color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-toast-action{flex:none;height:26px;padding:0 11px;border:none;border-radius:999px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-inverse);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}" +
        ".dsh-local-ai-tts-toast-action:hover{opacity:.88}" +
        ".dsh-local-ai-tts-toast-close{flex:none;width:24px;height:24px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1}" +
        ".dsh-local-ai-tts-toast-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}" +
        "@keyframes dsh-local-ai-tts-toast-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}" +
        ".dsh-local-ai-tts-fallback-row{display:flex;flex-direction:column;gap:4px;margin:2px 0 8px}" +
        ".dsh-local-ai-tts-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}" +
        ".dsh-local-ai-tts-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;cursor:pointer}" +
        ".dsh-local-ai-tts-settings{display:flex;flex-direction:column}" +
        ".dsh-local-ai-tts-module{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 4px;border-bottom:1px solid var(--dsw-alias-border-secondary)}" +
        ".dsh-local-ai-tts-module:last-child{border-bottom:none}" +
        ".dsh-local-ai-tts-module-stack{flex-direction:column;align-items:stretch;gap:10px}" +
        ".dsh-local-ai-tts-module-info{min-width:0}" +
        ".dsh-local-ai-tts-module-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-module-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}" +
        ".dsh-local-ai-tts-select{max-width:300px;height:34px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 12px;font-size:13px;font-family:inherit;color-scheme:light dark}" +
        ".dsh-local-ai-tts-select option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-select:hover{border-color:var(--dsw-alias-label-dimmed)}" +
        ".dsh-local-ai-tts-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
        ".dsh-local-ai-tts-preview-row{display:flex;align-items:center;gap:8px;width:100%}" +
        ".dsh-local-ai-tts-preview-input{flex:1;min-width:0;height:34px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 12px;font-size:13px;font-family:inherit}" +
        ".dsh-local-ai-tts-preview-input:hover{border-color:var(--dsw-alias-label-dimmed)}" +
        ".dsh-local-ai-tts-preview-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
        ".dsh-local-ai-tts-preview-btn{width:38px;height:34px;flex:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:none;border-radius:9px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-inverse);transition:background-color .15s ease,transform .1s ease,opacity .15s ease}" +
        ".dsh-local-ai-tts-preview-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-primary);opacity:.88;transform:scale(1.05)}" +
        ".dsh-local-ai-tts-preview-btn:active:not(:disabled){transform:scale(.95)}" +
        ".dsh-local-ai-tts-preview-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}" +
        ".dsh-local-ai-tts-preview-btn:disabled{cursor:default;opacity:.55}" +
        ".dsh-local-ai-tts-spinner{width:15px;height:15px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:dsh-local-ai-tts-spin .8s linear infinite}" +
        "@keyframes dsh-local-ai-tts-spin{to{transform:rotate(360deg)}}" +
        ".dsh-local-ai-tts-error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-error);padding:2px 4px 0;white-space:pre-line}" +
        ".dsh-local-ai-tts-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 4px 0}" +
        ".dsh-local-ai-tts-rvc{background:var(--dsw-alias-bg-layer-2,transparent);border-radius:10px;padding:2px 10px 10px}" +
        ".dsh-local-ai-tts-onboard{background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;margin-bottom:4px}" +
        ".dsh-local-ai-tts-onboard-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-onboard-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}" +
        ".dsh-local-ai-tts-onboard-steps{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);margin-top:6px;white-space:pre-line}" +
        ".dsh-local-ai-tts-onboard-cmd{margin:8px 0 0;padding:8px 10px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow:auto;max-height:160px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
        ".dsh-local-ai-tts-field{margin:8px 0}" +
        ".dsh-local-ai-tts-rvc-row{display:flex;align-items:center;gap:10px;min-width:0}" +
        ".dsh-local-ai-tts-rvc-label{flex:none;width:110px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:right}" +
        ".dsh-local-ai-tts-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:3px 0 0 120px;font-style:italic}" +
        ".dsh-local-ai-tts-rvc-input{flex:1;min-width:0;height:30px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font-size:12px;font-family:inherit}" +
        ".dsh-local-ai-tts-rvc-input:hover{border-color:var(--dsw-alias-label-dimmed)}" +
        ".dsh-local-ai-tts-rvc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
        ".dsh-local-ai-tts-rvc-input-num{flex:none;max-width:96px}" +
        ".dsh-local-ai-tts-path{flex:1;min-width:0;display:flex;align-items:center;gap:6px}" +
        ".dsh-local-ai-tts-path .dsh-local-ai-tts-rvc-input{flex:0 0 80%;max-width:none}" +
        ".dsh-local-ai-tts-browse{flex:none;height:30px;padding:0 12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit}" +
        ".dsh-local-ai-tts-browse:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
        ".dsh-local-ai-tts-upload{flex:1;min-width:0;display:flex;align-items:center;gap:8px}" +
        ".dsh-local-ai-tts-file-btn{flex:none;height:30px;padding:0 12px;cursor:pointer;display:inline-flex;align-items:center;border:none;border-radius:8px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-inverse);font-size:12px;font-family:inherit}" +
        ".dsh-local-ai-tts-file-btn:hover{opacity:.9}" +
        ".dsh-local-ai-tts-upload-name{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        ".dsh-local-ai-tts-picker{font-style:normal;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;max-height:180px;overflow:auto}" +
        ".dsh-local-ai-tts-compact{margin-top:6px;padding:8px;background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}" +
        ".dsh-local-ai-tts-compact-row{display:flex;align-items:center;gap:8px;margin-top:6px}" +
        ".dsh-local-ai-tts-compact-src{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".dsh-local-ai-tts-compact-btn{flex:none;height:26px;padding:0 10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit}" +
        ".dsh-local-ai-tts-compact-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
        ".dsh-local-ai-tts-compact-btn:disabled{cursor:default;opacity:.55}" +
        ".dsh-local-ai-tts-compact-info{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:6px}" +
        ".dsh-local-ai-tts-compact-ok{color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-compact-select{flex:none;height:26px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:0 8px;font-size:12px;font-family:inherit}" +
        ".dsh-local-ai-tts-pack-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-top:6px;background:var(--dsw-alias-bg-layer-2,transparent)}" +
        ".dsh-local-ai-tts-pack-head{display:flex;align-items:center;gap:8px;justify-content:space-between}" +
        ".dsh-local-ai-tts-pack-name{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".dsh-local-ai-tts-pack-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;line-height:16px}" +
        ".dsh-local-ai-tts-pack-btn{flex:none;height:26px;padding:0 10px;cursor:pointer;border:none;border-radius:7px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-inverse);font-size:12px;font-family:inherit}" +
        ".dsh-local-ai-tts-pack-btn:hover:not(:disabled){opacity:.88}" +
        ".dsh-local-ai-tts-pack-btn:disabled{cursor:default;opacity:.55}" +
        ".dsh-local-ai-tts-pack-btn[data-done]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-pack-head-actions{flex:none;display:flex;align-items:center;gap:6px}" +
        ".dsh-local-ai-tts-pack-uninstall{background:transparent;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2)}" +
        ".dsh-local-ai-tts-pack-uninstall:hover{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}" +
        ".dsh-local-ai-tts-overlay{position:fixed;inset:0;z-index:40}" +
        ".dsh-local-ai-tts-picker{position:relative;z-index:41}" +
        ".dsh-local-ai-tts-diag{display:flex;flex-direction:column;gap:6px;margin-top:8px}" +
        ".dsh-local-ai-tts-diag-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px}" +
        ".dsh-local-ai-tts-diag-mark{flex:none;width:16px;text-align:center}" +
        ".dsh-local-ai-tts-diag-name{flex:none;width:110px;color:var(--dsw-alias-label-secondary);text-align:right}" +
        ".dsh-local-ai-tts-diag-detail{min-width:0;color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-diag-ok{color:var(--dsw-alias-label-success,var(--dsw-alias-label-primary))}" +
        ".dsh-local-ai-tts-diag-fail{color:var(--dsw-alias-label-error)}" +
        ".dsh-local-ai-tts-diag-warn{color:var(--dsw-alias-label-warning,var(--dsw-alias-label-secondary))}" +
        ".dsh-local-ai-tts-pack-progress{flex:none;width:130px;display:flex;flex-direction:column;gap:3px}" +
        ".dsh-local-ai-tts-pack-progress-bar{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover,transparent);overflow:hidden}" +
        ".dsh-local-ai-tts-pack-progress-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}" +
        ".dsh-local-ai-tts-pack-progress-text{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}" +
        ".dsh-local-ai-tts-picker-title{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}" +
        ".dsh-local-ai-tts-picker-item{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;cursor:pointer;background:transparent;border:none;border-radius:6px;padding:4px 6px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:left;font-family:inherit}" +
        ".dsh-local-ai-tts-picker-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-picker-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".dsh-local-ai-tts-picker-size{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
        ".dsh-local-ai-tts-slider{flex:1;min-width:0}" +
        ".dsh-local-ai-tts-slider input[type=range]{width:100%;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}" +
        ".dsh-local-ai-tts-slider-scale{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}" +
        ".dsh-local-ai-tts-slider-value{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums;min-width:36px;text-align:right;margin-left:8px}" +
        ".dsh-local-ai-tts-slider-end{white-space:nowrap}" +
        ".dsh-local-ai-tts-slider-spacer{flex:1}" +
        ".dsh-local-ai-tts-advanced{margin-top:2px}" +
        ".dsh-local-ai-tts-advanced summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 0;user-select:none}" +
        ".dsh-local-ai-tts-advanced summary:hover{color:var(--dsw-alias-label-primary)}" +
        ".dsh-local-ai-tts-advanced[open] summary{margin-bottom:6px}" +
        ".dsh-local-ai-tts-footnote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:10px 4px 4px}";

      function insertCss(css) {
        const tag = document.createElement("style");
        tag.dataset.pluginCss = "dsh-plugin-local-ai-tts";
        tag.textContent = css;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }
      ctx.effect(() => insertCss(CSS), "dsh-plugin-tts: styles");

      // ---------- autoplay unlock ----------
      // Browsers block programmatic audio playback until a user gesture. Capture
      // the very first user interaction to eagerly lift that restriction for both
      // the shared Web Audio context and the <audio> host, so a read (or an
      // auto-read) started right after isn't silently blocked by autoplay policy.
      // ~50ms silent WAV (8000Hz mono) used only to "unlock" the <audio> path.
      const SILENT_WAV =
        "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
      let authUnlockEl = null;
      function unlockAudio() {
        try {
          if (typeof window !== "undefined") {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!shared.audioCtx && AC) shared.audioCtx = new AC();
            const c = shared.audioCtx;
            if (c && c.state === "suspended") c.resume().catch(() => {});
          }
        } catch (e) {}
        try {
          if (!authUnlockEl && typeof document !== "undefined") {
            authUnlockEl = document.createElement("audio");
            authUnlockEl.muted = true;
            authUnlockEl.style.display = "none";
            authUnlockEl.setAttribute("src", SILENT_WAV);
            authUnlockEl.load();
            document.body.appendChild(authUnlockEl);
          }
        } catch (e) {}
        if (authUnlockEl) {
          try {
            authUnlockEl.play().catch(() => {});
          } catch (e) {}
        }
      }
      function setupAutoplayUnlock() {
        const events = ["pointerdown", "pointerup", "keydown", "touchstart", "mousedown"];
        const handler = () => {
          unlockAudio();
          for (const ev of events) {
            try {
              document.removeEventListener(ev, handler, true);
            } catch (e) {}
          }
        };
        for (const ev of events) {
          try {
            document.addEventListener(ev, handler, true);
          } catch (e) {}
        }
        return () => {
          for (const ev of events) {
            try {
              document.removeEventListener(ev, handler, true);
            } catch (e) {}
          }
        };
      }
      ctx.effect(setupAutoplayUnlock, "dsh-plugin-tts: autoplay unlock");

      // ---------- keyboard shortcuts (a11y) ----------
      // Esc or S stops the current read-aloud (and clears any active RVC chunked
      // job). Guarded so it never fires while the user is typing in an input /
      // textarea / contenteditable — avoids hijacking normal editing keys.
      function setupKeyboardShortcuts() {
        const handler = e => {
          if (coexistence.companion) return;
          try {
            const t = e.target;
            const tag = t && t.tagName ? String(t.tagName).toLowerCase() : "";
            const editable =
              tag === "input" ||
              tag === "textarea" ||
              tag === "select" ||
              (t && t.isContentEditable);
            if (editable) return;
            const k = String(e.key || "").toLowerCase();
            if ((k === "escape" || k === "s") && shared.speaking) {
              e.preventDefault();
              stopSpeaking();
            }
          } catch (err) {}
        };
        try {
          document.addEventListener("keydown", handler, true);
        } catch (e) {}
        return () => {
          try {
            document.removeEventListener("keydown", handler, true);
          } catch (e) {}
        };
      }
      ctx.effect(setupKeyboardShortcuts, "dsh-plugin-tts: keyboard shortcuts");

      // ---------- read selected text (F4) ----------
      // A small floating "朗读选中" chip appears near a text selection in the
      // conversation; clicking it reads the selected text. Guarded so it never
      // shows for selections inside inputs/textareas and self-cleans on click
      // elsewhere / scroll.
      function setupSelectionRead() {
        let wrap = null;
        function hide() { if (wrap) wrap.style.display = "none"; }
        shared.hideSelectionRead = hide;
        function ensure() {
          if (wrap) return wrap;
          try {
            wrap = document.createElement("div");
            wrap.className = "dsh-local-ai-tts-sel-wrap";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "dsh-local-ai-tts-sel-btn";
            btn.textContent = t("sel.read");
            btn.addEventListener("click", e => {
              e.stopPropagation();
              try {
                const sel = window.getSelection && window.getSelection();
                const s = sel && sel.toString ? sel.toString().trim() : "";
                if (s) speakText(s, "manual");
              } catch (err) {}
              hide();
            });
            wrap.appendChild(btn);
            document.body.appendChild(wrap);
            wrap.style.display = "none";
          } catch (e) {
            wrap = null;
          }
          return wrap;
        }
        function onMouseUp() {
          if (coexistence.companion) { hide(); return; }
          try {
            const sel = window.getSelection && window.getSelection();
            const s = sel && sel.toString ? sel.toString().trim() : "";
            if (!s) { hide(); return; }
            const node = sel.anchorNode;
            const el =
              node && node.nodeType === 1
                ? node
                : node && node.parentElement;
            const tag = el && el.tagName ? el.tagName.toLowerCase() : "";
            if (tag === "input" || tag === "textarea") { hide(); return; }
            const range = sel.rangeCount ? sel.getRangeAt(0) : null;
            const rect = range ? range.getBoundingClientRect() : null;
            if (!rect || (!rect.width && !rect.height)) { hide(); return; }
            const w = ensure();
            if (!w) return;
            w.style.left = rect.left + rect.width / 2 + "px";
            w.style.top = Math.max(0, rect.top - 36) + "px";
            w.style.display = "block";
          } catch (e) {
            hide();
          }
        }
        function onDown() { setTimeout(hide, 120); }
        function onScroll() { hide(); }
        try {
          document.addEventListener("mouseup", onMouseUp, true);
          document.addEventListener("mousedown", onDown, true);
          document.addEventListener("scroll", onScroll, true);
          window.addEventListener("scroll", onScroll, true);
        } catch (e) {}
        return () => {
          try {
            document.removeEventListener("mouseup", onMouseUp, true);
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("scroll", onScroll, true);
          } catch (e) {}
        };
      }
      ctx.effect(setupSelectionRead, "dsh-plugin-tts: selection read");

      // ---------- audio host (hidden <audio> in shell.overlay) ----------
      function TtsAudioHost() {
        react.useEffect(
          () => () => {
            shared.audioEl = null;
          },
          [],
        );
        return react.createElement("audio", {
          ref: el => {
            shared.audioEl = el;
          },
          style: { display: "none" },
          preload: "auto",
        });
      }
      slots.inject("shell.overlay", () =>
        slots.register(
          { name: "shell.overlay", key: "local-ai-tts-audio-host", id: "local-ai-tts-audio-host", order: 1000 },
          TtsAudioHost,
        ),
      );

      // ---------- toast host (transient notifications in shell.overlay) ----------
      function TtsToastHost() {
        useI18n();
        useSharedForce();
        const toast = shared.toast;
        if (!toast) return null;
        const node = react.createElement(
          "div",
          { className: "dsh-local-ai-tts-toast dsh-local-ai-tts-toast-" + toast.kind, role: "alert" },
          react.createElement("span", { className: "dsh-local-ai-tts-toast-text" }, toast.text),
          toast.action
            ? react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-toast-action",
                  onClick: () => {
                    const fn = toast.action.onClick;
                    dismissToast();
                    if (typeof fn === "function") fn();
                  },
                },
                toast.action.label,
              )
            : null,
          react.createElement(
            "button",
            {
              type: "button",
              className: "dsh-local-ai-tts-toast-close",
              "aria-label": t("toast.dismiss"),
              onClick: dismissToast,
            },
            "✕",
          ),
        );
        return node;
      }
      slots.inject("shell.overlay", () =>
        slots.register(
          { name: "shell.overlay", key: "local-ai-tts-toast-host", id: "local-ai-tts-toast-host", order: 1001 },
          TtsToastHost,
        ),
      );

      // ---------- approval alert poller (invisible, in shell.overlay) ----------
      // Polls /dsh-breeze-tts-api/notify?s=N every few seconds for new approval events
      // and announces them aloud. The first successful poll only syncs the
      // cursor (baseline) so a refresh doesn't replay stale alerts.
      function TtsNotifyPoller() {
        react.useEffect(() => {
          let alive = true;
          let timer = null;
          const poll = async () => {
            if (coexistence.companion) return;
            try {
              const r = await breezeApiFetch(
                "/dsh-breeze-tts-api/notify?s=" + shared.notifyCursor,
                { __breezeNoPairRetry: true }, // 1.1.0 阿枢复核 R3：后台轮询 401 静默跳过，永不弹配对框
              );
              const d = await r.json().catch(() => null);
              if (!alive || !d || !Array.isArray(d.items)) return;
              const latest = Number(d.latest) || shared.notifyCursor;
              if (!shared.notifyBaselined) {
                shared.notifyBaselined = true;
                shared.notifyCursor = Math.max(shared.notifyCursor, latest);
                return;
              }
              shared.notifyCursor = Math.max(shared.notifyCursor, latest);
              if (!d.items.length) return;
              for (const item of d.items) {
                try {
                  announceNotify(item);
                } catch (e) { /* one bad item must not stop the loop */ }
              }
            } catch (e) { /* poll again later */ }
          };
          timer = setInterval(poll, 4000);
          poll();
          return () => {
            alive = false;
            if (timer) clearInterval(timer);
          };
        }, []);
        return null;
      }
      slots.inject("shell.overlay", () =>
        slots.register(
          { name: "shell.overlay", key: "local-ai-tts-notify-poller", id: "local-ai-tts-notify-poller", order: 1002 },
          TtsNotifyPoller,
        ),
      );

      // ---------- 1) input.left: auto-read toggle + watcher ----------
      function AutoReadToggle(props) {
        useI18n();
        useSharedForce();
        const nodes = useHostMessages(props);
        const on = shared.autoRead && localAutoAllowed();
        react.useEffect(
          () => () => {
            stopIfSource("auto");
          },
          [],
        );
        react.useEffect(() => {
          localRuntime.session(props.sessionId);
          let maxSeq = -1;
          let newest = null;
          if (nodes) {
            for (const n of nodes) {
              if (
                n &&
                n.kind === "assistant" &&
                typeof n.messageId === "string" &&
                n.seq > maxSeq
              ) {
                maxSeq = n.seq;
                newest = n;
              }
            }
          }
          if (!newest) return;
          const key = props.sessionId;
          const prev = shared.lastSeqBySession.get(key);
          if (prev === undefined) {
            shared.lastSeqBySession.set(key, maxSeq);
            return;
          }
          if (maxSeq > prev) {
            shared.lastSeqBySession.set(key, maxSeq);
            if (shared.provider === "local-runtime" || shared.provider === "indextts-process" || shared.provider === "gpt-sovits-process") {
              if (shared.speaking && shared.speakSource === "auto") {
                shared.currentText = plainText(extractText(newest.blocks));
                notify();
              }
              return;
            }
            if (shared.autoRead) {
              const text = extractText(newest.blocks);
              if (text.trim())
                speakText(text, "auto", msg =>
                  showToast(t("synthFail") + msg, "error"),
                );
            }
          }
        }, [nodes, props.sessionId]);
        const onClick = () => {
          refreshCoexistence();
          if (!shared.autoRead && coexistence.companion && !localAutoAllowed()) { showToast(t("coexist.autoBlocked"), "warn"); return; }
          const next = !shared.autoRead;
          shared.autoRead = next;
          saveSettings();
          notify();
          if (!next) stopIfSource("auto");
        };
        return react.createElement(
          "button",
          {
            type: "button",
            className: "dsh-local-ai-tts-auto-pill",
            "data-active": on || undefined,
            "aria-label": (coexistence.companion ? t("coexist.localAuto") + ": " : "") + (on ? t("autoRead.on") : t("autoRead.off")),
            "aria-pressed": on,
            "data-local-ai-tts-tip": on
              ? t("autoRead.on.title")
              : t("autoRead.off.title"),
            onClick: onClick,
          },
          HeadphonesIcon(),
          react.createElement(
            "span",
            { className: "dsh-local-ai-tts-auto-label" },
            coexistence.companion ? t("coexist.localAuto") : t("autoRead.label"),
          ),
          react.createElement("span", { className: "dsh-local-ai-tts-auto-dot" }),
        );
      }
      slots.inject("conversation.input.left", () =>
        slots.register(
          { name: "conversation.input.left", key: "local-ai-tts-autoread", id: "local-ai-tts-autoread", order: 20 },
          AutoReadToggle,
        ),
      );

      // ---------- 2) assistant-actions: per-message read-aloud button ----------
      function ReadAloudButton(props) {
        useI18n();
        useSharedForce();
        const nodes = useHostMessages(props);
        let node = null;
        if (nodes) {
          for (const n of nodes) {
            if (
              n &&
              n.kind === "assistant" &&
              n.messageId === props.messageId
            ) {
              node = n;
              break;
            }
          }
        }
        const raw = node ? extractText(node.blocks) : "";
        const plain = plainText(raw);
        // ★★ 2026-10-29 修（外部复核 P3）：之前只按文字判"是不是在播这条"
        //   ⇒ 同一会话里两段**完全相同的文字**（比如连着两次同样的回复），
        //     点第二段的按钮会被当成"停止第一段"，用户看到的是"点了没反应"。
        //   ⇒ 现在带 messageId 一起判：**同一条消息 + 同一段文字**才算同一次播放。
        //     ★ 必须用 `speakText` 传入的 sourceKey 对齐：按钮走 "msg:<id>"，
        //       自动朗读传的是消息 id，这样两边不会互相顶掉。
        const speakKey = "msg:" + (props.messageId || "");
        const isPlaying =
          shared.speaking && !!plain && shared.currentText === plain && shared.currentKey === speakKey;
        const cp = shared.chunkProgress;
        const playingLabel = isPlaying
          ? cp && cp.total > 1
            ? t("stopRead.part.lead") + cp.index + "/" + cp.total + t("stopRead.part.tail", { total: cp.total })
            : t("stopRead")
          : coexistence.companion ? t("coexist.localRead") : t("readThisMessage");
        const onClick = () => {
          if (!plain) return;
          speakText(plain, "manual", msg => {
            // In RVC mode offer one-click "read with Edge instead" — always
            // available, independent of the opt-in auto-fallback toggle.
            const action =
              shared.provider === "rvc"
                ? {
                    label: t("toast.useEdge"),
                    onClick: () =>
                      speakText(plain, "manual", null, { provider: "edge-tts", sourceKey: speakKey }),
                  }
                : null;
            showToast(t("synthFail") + msg, "error", action);
          }, { sourceKey: speakKey });
        };
        const [dlErr, setDlErr] = react.useState(null);
        const dlTimer = react.useRef(null);
        const onDlError = msg => {
          setDlErr(msg);
          if (dlTimer.current) clearTimeout(dlTimer.current);
          dlTimer.current = setTimeout(() => setDlErr(null), 3500);
        };
        const onDownload = e => {
          e.stopPropagation();
          if (plain) downloadText(plain, onDlError);
        };
        const controls = isPlaying
          ? [
              ...(cp && cp.total > 1
                ? [
                    react.createElement(
                      "span",
                      {
                        className: "dsh-local-ai-tts-chunk-pill",
                        "data-local-ai-tts-tip": playingLabel,
                        "aria-hidden": true,
                      },
                      cp.index + "/" + cp.total,
                    ),
                  ]
                : []),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-action dsh-local-ai-tts-mini-pause",
                  "aria-label": shared.paused ? t("mini.resume") : t("mini.pause"),
                  "data-local-ai-tts-tip": shared.paused ? t("mini.resume") : t("mini.pause"),
                  onClick: e => {
                    e.stopPropagation();
                    togglePause();
                  },
                },
                shared.paused ? PlayIcon() : PauseIcon(),
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-action dsh-local-ai-tts-mini-speed",
                  "aria-label": t("mini.speed"),
                  "data-local-ai-tts-tip": t("mini.speedTip"),
                  onClick: e => {
                    e.stopPropagation();
                    cycleSpeed();
                  },
                },
                react.createElement(
                  "span",
                  { className: "dsh-local-ai-tts-speed-label" },
                  formatRate(shared.rate),
                ),
              ),
            ]
          : [];
        return react.createElement(
          "div",
          { className: "dsh-local-ai-tts-mini" },
          ...controls,
          shared.provider !== "local-runtime" && shared.provider !== "indextts-process" && shared.provider !== "gpt-sovits-process" && react.createElement(
            "button",
            {
              type: "button",
              className: "dsh-local-ai-tts-action dsh-local-ai-tts-action-dl",
              "aria-label": t("download.audio"),
              "data-local-ai-tts-tip": t("download.audio"),
              disabled: !plain || undefined,
              onClick: onDownload,
            },
            DownloadIcon(),
          ),
          react.createElement(
            "button",
            {
              type: "button",
              className: "dsh-local-ai-tts-action",
              "data-active": isPlaying || undefined,
              "aria-label": playingLabel,
              "data-local-ai-tts-tip": playingLabel,
              disabled: !plain || undefined,
              onClick: onClick,
            },
            isPlaying ? EqualizerIcon() : SpeakerIcon(),
            coexistence.companion && react.createElement("span", { "aria-hidden": true }, "Local"),
          ),
          dlErr
            ? react.createElement(
                "span",
                { className: "dsh-local-ai-tts-dl-err", role: "alert" },
                dlErr,
              )
            : null,
        );
      }
      slots.inject("conversation.chat.assistant-actions", () =>
        slots.register(
          {
            name: "conversation.chat.assistant-actions",
            key: "local-ai-tts-read",
            id: "local-ai-tts-read",
            order: 20,
          },
          ReadAloudButton,
        ),
      );

      // ---------- 3) settings.plugins.tab: voice settings panel ----------
      const VOICES = [
        ["zh-CN-XiaoxuanNeural", t("voice.xiaoxuan")],
        ["zh-CN-XiaoyiNeural", t("voice.xiaoyi")],
        ["zh-CN-YunxiNeural", t("voice.yunxi")],
        ["zh-CN-YunyangNeural", t("voice.yunyang")],
        ["zh-CN-XiaoxiaoNeural", t("voice.xiaoxiao")],
        ["zh-CN-YunjianNeural", t("voice.yunjian")],
        ["zh-CN-YunxiaNeural", t("voice.yunxia")],
        [
          "zh-CN-liaoning-XiaobeiNeural",
          t("voice.xiaobei"),
        ],
        [
          "zh-CN-shaanxi-XiaoniNeural",
          t("voice.xiaoni"),
        ],
        ["zh-TW-HsiaoChenNeural", t("voice.hsiaochen")],
        ["zh-TW-HsiaoYuNeural", t("voice.hsiaoyu")],
        ["zh-TW-YunJheNeural", t("voice.yunjhe")],
        ["zh-HK-HiuGaaiNeural", t("voice.hiugaai")],
        ["zh-HK-HiuMaanNeural", t("voice.hiumaan")],
        ["zh-HK-WanLungNeural", t("voice.wanlung")],
        ["en-US-AriaNeural", "Aria（en-US-AriaNeural）"],
        ["en-US-JennyNeural", "Jenny（en-US-JennyNeural）"],
        ["en-US-GuyNeural", "Guy（en-US-GuyNeural）"],
        ["en-GB-SoniaNeural", "Sonia（en-GB-SoniaNeural）"],
        ["ja-JP-NanamiNeural", t("voice.nanami")],
        ["ko-KR-SunHiNeural", "SunHi（ko-KR-SunHiNeural）"],
        ["fr-FR-DeniseNeural", "Denise（fr-FR-DeniseNeural）"],
        ["ru-RU-SvetlanaNeural", t("voice.svetlana")],
        ["ru-RU-DmitryNeural", t("voice.dmitry")],
      ];

      function VoiceSettingsPanel() {
        useI18n();
        useSharedForce();
        const [lang, setLangState] = react.useState(I18N.lang);
        const changeLang = e => {
          I18N.setLang(e.target.value);
          setLangState(e.target.value);
        };
        const [voice, setVoice] = react.useState(shared.voice);
        const [preview, setPreview] =
          react.useState(t("preview.defaultText"));
        const [playingText, setPlayingText] = react.useState(null);
        const [error, setError] = react.useState(null);
        const errorTimer = react.useRef(null);
        const resetTimer = react.useRef(null);
        const isPreviewPlaying =
          shared.speaking &&
          !!playingText &&
          shared.currentText === playingText;
        react.useEffect(() => {
          if (!shared.speaking) setPlayingText(null);
        }, [shared.speaking]);
        const changeVoice = e => {
          const v = e.target.value;
          shared.voice = v;
          saveSettings();
          setVoice(v);
        };
        const [resetMsg, setResetMsg] = react.useState(null);
        const onResetSettings = () => {
          resetSettings();
          setVoice(shared.voice);
          setProvider(shared.provider);
          showError(null);
          setResetMsg(t("settings.resetDone"));
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setResetMsg(null), 3000);
        };
        const showError = msg => {
          if (errorTimer.current) {
            clearTimeout(errorTimer.current);
            errorTimer.current = null;
          }
          setError(msg);
          if (msg) {
            errorTimer.current = setTimeout(() => {
              setError(null);
              errorTimer.current = null;
            }, 5000);
          }
        };
        const onPreview = () => {
          const target = plainText(preview);
          if (!target) {
            showError(t("preview.emptyError"));
            return;
          }
          if (isPreviewPlaying) {
            stopSpeaking();
            setPlayingText(null);
            return;
          }
          // ★ 2026-10-29 修（外部复核 P3）：Web Audio 路径的 play 会【立刻 resolve】，
          //   于是按钮马上复位成"试听"，用户连点两个音色 ⇒ 两段叠着播。
          //   ⇒ 换目标前显式停一次，保证同一时刻只有一段试听。
          stopSpeaking();
          showError(null);
          setPlayingText(target);
          // speakText already reports every real failure through onError with
          // the raw message (or voice.removed); the returned promise only
          // resets the preview state here (avoiding double-display).
          speakText(target, "manual", msg =>
            showError(t("synthFail") + msg),
          ).then(r => {
            if (r && !r.ok) setPlayingText(null);
          });
        };
        const voiceOptions = VOICES
          .filter(v => !shared.removedVoices.has(v[0]))
          .map(v =>
          react.createElement("option", { key: v[0], value: v[0] }, v[1]),
        );
        const [, setProvider] = react.useState(shared.provider);
        const provider = shared.provider;
        const [, setRvcTick] = react.useState(0);
        const changeProvider = e => {
          if (['indextts-process', 'gpt-sovits-process', 'local-runtime', 'folder-model'].includes(e.target.value)) {
            localRuntime.selectEngine(e.target.value === 'folder-model' ? 'folder' : e.target.value === 'local-runtime' ? 'generic' : (e.target.value === 'gpt-sovits-process' ? 'gpt-sovits' : 'indextts'));
          } else {
            stopSpeaking();
            shared.provider = e.target.value;
            saveSettings();
          }
          setProvider(e.target.value);
        };
        const setRvc = (key, value) => {
          shared.rvc[key] = value;
          saveSettings();
          setRvcTick(n => n + 1);
        };
        // ---- 文件选择器（RVC 服务文件发现）----
        const [picker, setPicker] = react.useState(null);
        // Esc closes the file picker; click on the transparent overlay also closes it
        react.useEffect(() => {
          const onKey = e => {
            if (e.key === "Escape") setPicker(null);
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, []);
        const openPicker = async kind => {
          setPicker({ kind, files: [], loading: true, error: null });
          try {
            const r = await breezeApiFetch(
              "/dsh-breeze-tts-api/rvc-files?baseUrl=" +
                encodeURIComponent(shared.rvc.baseUrl) +
                "&kind=" +
                kind,
            );
            const data = await r.json().catch(() => null);
            if (!r.ok || !data || data.error) {
              throw new Error(hostErrText(data) || ("HTTP " + r.status));
            }
            setPicker({ kind, files: data.files || [], loading: false, error: null });
          } catch (e) {
            setPicker({
              kind,
              files: [],
              loading: false,
              error: t("fileListFail") + String((e && e.message) || e),
            });
          }
        };
        const pickFile = (kind, f) => {
          setRvc(kind === "pth" ? "model" : "index", f.path);
          setPicker(null);
        };
        // ---- 音色包（注册表 + 下载安装）----
        const PKG_SETTINGS_KEY = "dsh-local-ai-tts-pack-settings"; // { registry, proxy }
        const PKG_ACTIVE_KEY = "dsh-local-ai-tts-pack-active";      // { key, packId }
        const [registryUrl, setRegistryUrl] = react.useState("");
        const [packProxy, setPackProxy] = react.useState("");
        const [packs, setPacks] = react.useState(null); // { loading, error, list }
        const [installed, setInstalled] = react.useState({});
        const [installing, setInstalling] = react.useState(null);
        const [packNote, setPackNote] = react.useState(null);
        const [packIdx, setPackIdx] = react.useState({}); // packId -> selected index variant id
        const [installProg, setInstallProg] = react.useState(null); // { packId, pct, phase, speed }
        const [packsDir, setPacksDir] = react.useState(null);
        const savePackSettings = () => {
          try {
            localStorage.setItem(
              PKG_SETTINGS_KEY,
              JSON.stringify({ registry: registryUrl.trim(), proxy: packProxy.trim() }),
            );
          } catch (e) { /* non-fatal */ }
        };
        const refreshInstalled = async () => {
          try {
            const r = await breezeApiFetch("/dsh-breeze-tts-api/rvc-packs-installed");
            const d = await r.json().catch(() => null);
            if (d && d.installed) setInstalled(d.installed);
            if (d && d.packsDir) setPacksDir(d.packsDir);
          } catch (e) { /* non-fatal */ }
        };
        // restore persisted settings + re-attach to an in-flight download
        react.useEffect(() => {
          refreshInstalled();
          try {
            const s = JSON.parse(localStorage.getItem(PKG_SETTINGS_KEY) || "null");
            if (s) {
              if (s.registry) setRegistryUrl(s.registry);
              if (s.proxy) setPackProxy(s.proxy);
            }
          } catch (e) { /* non-fatal */ }
          try {
            const a = JSON.parse(localStorage.getItem(PKG_ACTIVE_KEY) || "null");
            if (a && a.key && a.packId) restoreActiveInstall(a.key, a.packId);
            else localStorage.removeItem(PKG_ACTIVE_KEY);
          } catch (e) { /* non-fatal */ }
        }, []);
        // re-attach to a download started before the panel was closed
        const restoreActiveInstall = (key, packId) => {
          let waitingCount = 0;
          const poll = async () => {
            for (let i = 0; i < 120; i++) {
              await new Promise(res => setTimeout(res, 500));
              try {
                const pr = await breezeApiFetch("/dsh-breeze-tts-api/rvc-pack-progress?key=" + encodeURIComponent(key), { __breezeNoPairRetry: true }); // A-6：后台轮询 401 静默
                const d = await pr.json().catch(() => null);
                if (d && d.finished) {
                  setInstalling(null);
                  setInstallProg(null);
                  localStorage.removeItem(PKG_ACTIVE_KEY);
                  refreshInstalled();
                  return;
                }
                if (d && d.waiting !== true && d.total) {
                  waitingCount = 0;
                  setInstalling(packId);
                  setInstallProg({
                    packId,
                    pct: Math.min(100, Math.round((d.done / d.total) * 100)),
                    phase: (d.phaseKey && t("host.phase." + d.phaseKey) !== "host.phase." + d.phaseKey)
                      ? t("host.phase." + d.phaseKey)
                      : (d.phase === t("tab.index") ? t("tab.index") : t("tab.model")),
                    speed: d.speed || 0,
                  });
                  continue;
                }
                // no entry yet — either still preparing or already gone
                waitingCount++;
                if (waitingCount > 4) {
                  // give up: entry expired without a finish flag
                  localStorage.removeItem(PKG_ACTIVE_KEY);
                  setInstalling(null);
                  setInstallProg(null);
                  refreshInstalled();
                  return;
                }
                setInstalling(packId);
                setInstallProg({ packId, pct: 0, phase: t("busy.preparing"), speed: 0 });
              } catch (e) { /* transient */ }
            }
          };
          poll();
        };
        const fetchPacks = async () => {
          const reg = registryUrl.trim();
          if (!reg) {
            setPacks({ loading: false, error: t("packs.needUrl"), list: [] });
            return;
          }
          savePackSettings();
          setPacks({ loading: true, error: null, list: [] });
          try {
            const r = await breezeApiFetch(
              "/dsh-breeze-tts-api/rvc-packs?registry=" +
                encodeURIComponent(reg) +
                (packProxy.trim() ? "&proxy=" + encodeURIComponent(packProxy.trim()) : ""),
            );
            const d = await r.json().catch(() => null);
            if (!r.ok || !d || d.error) {
              throw new Error(hostErrText(d) || ("HTTP " + r.status));
            }
            setPacks({ loading: false, error: null, list: d.packs || [] });
            refreshInstalled(); // reconcile installed state (files may have been removed)
          } catch (e) {
            setPacks({
              loading: false,
              error: t("packs.listFail") + String((e && e.message) || e),
              list: [],
            });
          }
        };
        const installPack = async (pack, indexId) => {
          const progressKey = pack.id + "-" + Date.now();
          try {
            localStorage.setItem(PKG_ACTIVE_KEY, JSON.stringify({ key: progressKey, packId: pack.id }));
          } catch (e) { /* non-fatal */ }
          setInstalling(pack.id);
          setPackNote(null);
          setInstallProg({ packId: pack.id, pct: 0, phase: t("packs.waitingStart"), speed: 0 });
          const fmtSpeed = bps =>
            bps >= 1048576
              ? (bps / 1048576).toFixed(1) + " MB/s"
              : Math.round(bps / 1024) + " KB/s";
          let settled = false;
          const req = breezeApiFetch("/dsh-breeze-tts-api/rvc-pack-install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              registry: registryUrl.trim(),
              packId: pack.id,
              indexId: indexId || "",
              progressKey: progressKey,
              proxy: packProxy.trim(),
            }),
          })
            .then(r => r.json().catch(() => null))
            .catch(e => ({ error: String((e && e.message) || e) }));
          const poll = (async () => {
            let pollStart = Date.now();
            let lastSig = ''; // 1.1.0 顺手项 9：活动续命式——进度有变化重置计时，无变化 90s 判停，硬上限 15 分钟
            while (!settled) {
              await new Promise(res => setTimeout(res, 250));
              if (settled) break;
              if (Date.now() - pollStart > 900000) break; // hard cap 15 min（覆盖实测 12 分钟装包）
              try {
                const pr = await breezeApiFetch(
                  "/dsh-breeze-tts-api/rvc-pack-progress?key=" + encodeURIComponent(progressKey),
                  { __breezeNoPairRetry: true }, // A-6：后台轮询 401 静默
                );
                const d = await pr.json().catch(() => null);
                if (!d || d.waiting) {
                  // install not reporting yet (manifest fetch etc.) — keep polling
                  setInstallProg(p =>
                    p && p.packId === pack.id ? { ...p, pct: 0, phase: t("busy.preparing"), speed: 0 } : p,
                  );
                  continue;
                }
                const sig = JSON.stringify([d.done, d.total, d.phaseKey, d.finished, d.waiting]);
                if (sig !== lastSig) { lastSig = sig; pollStart = Date.now(); }
                else if (Date.now() - pollStart > 90000) break; // 90s 无进度变化＝真停了
                const finished = !!d.finished;
                const pct = d.total
                  ? Math.min(100, Math.round((d.done / d.total) * 100))
                  : 0;
                setInstallProg({
                  packId: pack.id,
                  pct: finished ? 100 : pct,
                  phase: finished ? t("packs.done")
                    : (d.phaseKey && t("host.phase." + d.phaseKey) !== "host.phase." + d.phaseKey)
                      ? t("host.phase." + d.phaseKey)
                      : (d.phase === t("tab.index") ? t("tab.index") : t("tab.model")),
                  speed: d.speed || 0,
                });
              } catch (e) { /* transient poll error — keep trying */ }
            }
          })();
          const d = await req;
          settled = true;
          if (d && !d.error && d.ok !== false) {
            setRvc("model", d.modelPath);
            if (d.indexPath) setRvc("index", d.indexPath);
            if (pack.baseVoice) setRvc("baseVoice", pack.baseVoice);
            if (typeof pack.indexRate === "number") setRvc("indexRate", pack.indexRate);
            if (pack.f0Method) setRvc("f0Method", pack.f0Method);
            setPackNote({
              ok: true,
              text: t("packs.installedEnabled") + (d.name || pack.id) + "」" + (d.skipped ? t("packs.alreadyLatest") : ""),
            });
            refreshInstalled();
          } else {
            // ★ 2026-10-29 修（外部复核 P3）：原来是
            //     t("packs.installFail") + hostErrText(d) || t("packs.unknownError")
            //   左侧永远是"安装失败："+某字符串（至少非空）⇒ `||` 右边【永远不生效】，
            //   而 hostErrText(d) 返回空时会显示一句光秃秃的"安装失败："，看着像 undefined。
            //   ⇒ 先取错误文本，真没有才用兜底。
            const why = hostErrText(d) || t("packs.unknownError");
            setPackNote({ ok: false, text: t("packs.installFail") + why });
          }
          setInstallProg(null);
          setInstalling(null);
          try {
            localStorage.removeItem(PKG_ACTIVE_KEY);
          } catch (e) { /* non-fatal */ }
        };
        const uninstallPack = async pack => {
          if (!window.confirm(t("packs.confirmUninstall.lead") + (pack.name || pack.id) + t("packs.confirmUninstall.tail"))) return;
          setPackNote(null);
          try {
            const r = await breezeApiFetch("/dsh-breeze-tts-api/rvc-pack-uninstall", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ packId: pack.id }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok || !d || d.error) throw new Error(hostErrText(d) || ("HTTP " + r.status));
            // clear the rvc paths if they pointed into the removed pack dir
            const inst = installed[pack.id];
            if (inst) {
              if (shared.rvc.model && inst.modelPath && shared.rvc.model === inst.modelPath) setRvc("model", "");
              if (shared.rvc.index && inst.indexPath && shared.rvc.index === inst.indexPath) setRvc("index", "");
            }
            setPackNote({ ok: true, text: t("packs.uninstalled") + (pack.name || pack.id) + "」" });
            refreshInstalled();
          } catch (e) {
            setPackNote({ ok: false, text: t("packs.uninstallFail") + String((e && e.message) || e) });
          }
        };
        // ---- 一键诊断（Edge 合成 / RVC 服务）----
        const [diag, setDiag] = react.useState(null); // { running, checks, error }
        const runDiagnose = async () => {
          setDiag({ running: true, checks: null, error: null });
          try {
            const r = await breezeApiFetch("/dsh-breeze-tts-api/diagnose", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rvcBaseUrl: shared.rvc.baseUrl }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok || !d || d.error) {
              if (d && d.error) throw new Error(hostErrText(d));
              if (r.status === 405 || r.status === 404)
                throw new Error(t("diag.httpUnavailable") + r.status + t("diag.httpUnavailable.tail"));
              throw new Error(t("diag.httpFail") + r.status + t("diag.httpFail.tail"));
            }
            setDiag({ running: false, checks: d.checks || [], error: null });
          } catch (e) {
            setDiag({ running: false, checks: null, error: String((e && e.message) || e) });
          }
        };
        const diagMark = c =>
          c.ok ? react.createElement("span", { className: "dsh-local-ai-tts-diag-ok" }, "✓")
            : c.cls === "warn"
              ? react.createElement("span", { className: "dsh-local-ai-tts-diag-warn" }, "!")
              : react.createElement("span", { className: "dsh-local-ai-tts-diag-fail" }, "✗");
        const diagRow = c =>
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-diag-row" },
            react.createElement("span", { className: "dsh-local-ai-tts-diag-mark" }, diagMark(c)),
            react.createElement("span", { className: "dsh-local-ai-tts-diag-name" }, c.name),
            react.createElement(
              "span",
              {
                className:
                  "dsh-local-ai-tts-diag-detail " +
                  (c.ok ? "dsh-local-ai-tts-diag-ok" : c.cls === "warn" ? "dsh-local-ai-tts-diag-warn" : "dsh-local-ai-tts-diag-fail"),
              },
              c.detail || "",
            ),
          );
        const diagModule = () =>
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module dsh-local-ai-tts-module-stack" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-info" },
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-title" },
                t("diag.title"),
              ),
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-desc" },
                t("diag.desc"),
              ),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-preview-row" },
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-browse",
                  onClick: runDiagnose,
                  disabled: !!diag && diag.running,
                },
                diag && diag.running ? t("diag.running") : t("diag.run"),
              ),
            ),
            diag && diag.checks
              ? react.createElement("div", { className: "dsh-local-ai-tts-diag" }, diag.checks.map(diagRow))
              : null,
            diag && diag.error
              ? react.createElement("div", { className: "dsh-local-ai-tts-error" }, t("diag.fail") + diag.error)
              : null,
          );
        const packSection = () =>
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module dsh-local-ai-tts-module-stack dsh-local-ai-tts-rvc" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-info" },
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-title" },
                t("packs.title"),
              ),
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-desc" },
                t("packs.desc"),
              ),
              packsDir
                ? react.createElement(
                    "div",
                    { className: "dsh-local-ai-tts-compact-info" },
                    t("packs.installTo") + packsDir + t("packs.installTo.tail"),
                  )
                : null,
            ),
            field(
              t("packs.registryUrl"),
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-path" },
                react.createElement("input", {
                  className: "dsh-local-ai-tts-rvc-input",
                  value: registryUrl,
                  placeholder: "https://example.com/tts-packs",
                  onChange: e => {
                    setRegistryUrl(e.target.value);
                    savePackSettings();
                  },
                }),
                react.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-local-ai-tts-browse",
                    onClick: fetchPacks,
                    disabled: !!packs && packs.loading,
                  },
                  packs && packs.loading ? t("packs.loading") : t("packs.fetchList"),
                ),
              ),
              t("packs.registryHelp"),
            ),
            field(
              t("packs.proxy"),
              react.createElement("input", {
                className: "dsh-local-ai-tts-rvc-input",
                value: packProxy,
                placeholder: t("packs.proxyPlaceholder"),
                onChange: e => {
                  setPackProxy(e.target.value);
                  savePackSettings();
                },
              }),
              t("packs.proxyHelp"),
            ),
            packs && packs.loading
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-compact-info" },
                  t("packs.fetching"),
                )
              : null,
            packs && packs.error
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-error" },
                  packs.error,
                )
              : null,
            packs && packs.list.length
              ? packs.list.map(p =>
                  react.createElement(
                    "div",
                    { key: p.id, className: "dsh-local-ai-tts-pack-card" },
                    react.createElement(
                      "div",
                      { className: "dsh-local-ai-tts-pack-head" },
                      react.createElement(
                        "span",
                        { className: "dsh-local-ai-tts-pack-name" },
                        p.name || p.id,
                      ),
                      installed[p.id]
                        ? react.createElement(
                            "div",
                            { className: "dsh-local-ai-tts-pack-head-actions" },
                            react.createElement(
                              "button",
                              {
                                type: "button",
                                className: "dsh-local-ai-tts-pack-btn",
                                "data-done": true,
                                disabled: true,
                              },
                              t("packs.installedV") + (installed[p.id].version || ""),
                            ),
                            react.createElement(
                              "button",
                              {
                                type: "button",
                                className: "dsh-local-ai-tts-pack-btn dsh-local-ai-tts-pack-uninstall",
                                onClick: () => uninstallPack(p),
                              },
                              t("packs.uninstall"),
                            ),
                          )
                        : installing === p.id && installProg && installProg.packId === p.id
                          ? react.createElement(
                              "div",
                              { className: "dsh-local-ai-tts-pack-progress" },
                              react.createElement(
                                "div",
                                { className: "dsh-local-ai-tts-pack-progress-bar" },
                                react.createElement("div", {
                                  className: "dsh-local-ai-tts-pack-progress-fill",
                                  style: { width: (installProg.pct || 0) + "%" },
                                }),
                              ),
                              react.createElement(
                                "span",
                                { className: "dsh-local-ai-tts-pack-progress-text" },
                                installProg.phase +
                                  " " +
                                  (installProg.pct || 0) +
                                  "%" +
                                  (installProg.speed
                                    ? " · " +
                                      (installProg.speed >= 1048576
                                        ? (installProg.speed / 1048576).toFixed(1) + " MB/s"
                                        : Math.round(installProg.speed / 1024) + " KB/s")
                                    : ""),
                              ),
                            )
                          : react.createElement(
                              "button",
                              {
                                type: "button",
                                className: "dsh-local-ai-tts-pack-btn",
                                disabled: installing === p.id,
                                onClick: () =>
                                  installPack(
                                    p,
                                    (Array.isArray(p.indexes) && p.indexes.length && packIdx[p.id]) ||
                                      (Array.isArray(p.indexes) && p.indexes.length ? p.indexes[0].id : ""),
                                  ),
                              },
                              installing === p.id ? t("packs.downloading") : t("packs.downloadEnable"),
                            ),
                    ),
                    Array.isArray(p.indexes) && p.indexes.length > 1
                      ? react.createElement(
                          "div",
                          { className: "dsh-local-ai-tts-compact-row", style: { marginTop: 6 } },
                          react.createElement(
                            "span",
                            { className: "dsh-local-ai-tts-compact-src" },
                            t("packs.indexVersion"),
                          ),
                          react.createElement(
                            "select",
                            {
                              className: "dsh-local-ai-tts-compact-select",
                              value: packIdx[p.id] || p.indexes[0].id,
                              disabled: installing === p.id,
                              onChange: e => setPackIdx(s => ({ ...s, [p.id]: e.target.value })),
                            },
                            p.indexes.map(i =>
                              react.createElement("option", { key: i.id, value: i.id }, i.name || i.id),
                            ),
                          ),
                        )
                      : null,
                    react.createElement(
                      "div",
                      { className: "dsh-local-ai-tts-pack-meta" },
                      (p.description || "") +
                        t("packs.modelSep") +
                        fmtMb(p.model && p.model.size) +
                        (Array.isArray(p.indexes) && p.indexes.length
                          ? t("packs.plusIdx") +
                            p.indexes.length +
                            t("packs.count") +
                            p.indexes.map(i => fmtMb(i.size)).join("/") +
                            "）"
                          : p.index && p.index.size
                            ? t("packs.plusIndex") + fmtMb(p.index.size)
                            : t("packs.noIndex")) +
                        t("packs.licenseSep") +
                        (p.license || t("packs.unknown")) +
                        (p.author ? t("packs.authorSep") + p.author : ""),
                    ),
                  ),
                )
              : null,
            packNote
              ? react.createElement(
                  "div",
                  {
                    className: packNote.ok ? "dsh-local-ai-tts-compact-info dsh-local-ai-tts-compact-ok" : "dsh-local-ai-tts-error",
                  },
                  packNote.text,
                )
              : null,
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-footnote" },
              t("packs.copyright"),
            ),
          );
        // ---- 紧凑索引生成器 ----
        const [compact, setCompact] = react.useState(null);
        const COMPACT_TARGETS = [
          [2000, t("compact.size2k")],
          [5000, t("compact.size5k")],
          [10000, t("compact.size10k")],
          [20000, t("compact.size20k")],
        ];
        const runCompact = async () => {
          if (!shared.rvc.index) {
            setCompact(c => ({ ...c, error: t("compact.needIndex") }));
            return;
          }
          setCompact(c => ({ ...c, busy: true, error: null, result: null }));
          try {
            const r = await breezeApiFetch("/dsh-breeze-tts-api/rvc-compact-index", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                baseUrl: shared.rvc.baseUrl,
                index: shared.rvc.index,
                target_vectors: compact.target,
              }),
            });
            const data = await r.json().catch(() => null);
            if (!r.ok || !data || data.error) {
              throw new Error(hostErrText(data) || ("HTTP " + r.status));
            }
            if (data.already_small) {
              setCompact(c => ({
                ...c,
                busy: false,
                error: null,
                result: { alreadySmall: true, size: data.size, vectors: data.vectors },
              }));
              return;
            }
            setRvc("index", data.path); // 生成成功自动填入索引路径
            setCompact(c => ({
              ...c,
              busy: false,
              error: null,
              result: data,
            }));
          } catch (e) {
            setCompact(c => ({
              ...c,
              busy: false,
              error: t("compact.fail") + String((e && e.message) || e),
            }));
          }
        };
        const compactPanel = () => {
          if (!compact || !compact.open) return null;
          const fmtMb = n => ((n || 0) / 1048576).toFixed(1) + " MB";
          const srcName = shared.rvc.index
            ? shared.rvc.index.split(/[\\/]/).pop()
            : t("compact.noIndex");
          return react.createElement(
            "div",
            { className: "dsh-local-ai-tts-compact" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-picker-title" },
              t("compact.desc"),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-compact-src" },
              t("compact.source") + srcName,
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-compact-row" },
              react.createElement(
                "select",
                {
                  className: "dsh-local-ai-tts-compact-select",
                  value: compact.target,
                  disabled: !!compact.busy,
                  onChange: e => setCompact(c => ({ ...c, target: Number(e.target.value) })),
                },
                COMPACT_TARGETS.map(t =>
                  react.createElement("option", { key: t[0], value: t[0] }, t[1]),
                ),
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-compact-btn",
                  disabled: !!compact.busy,
                  onClick: runCompact,
                },
                compact.busy ? t("compact.building") : t("compact.generate"),
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-compact-btn",
                  disabled: !!compact.busy,
                  onClick: () => setCompact(null),
                },
                t("compact.close"),
              ),
            ),
            compact.busy
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-compact-info" },
                  t("compact.reading"),
                )
              : null,
            compact.error
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-error" },
                  compact.error,
                )
              : null,
            compact.result
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-compact-info dsh-local-ai-tts-compact-ok" },
                  compact.result.alreadySmall
                    ? t("compact.alreadySmall.lead") + fmtMb(compact.result.size) + t("compact.alreadySmall.tail")
                    : t("compact.generated") +
                      compact.result.path.split(/[\\/]/).pop() +
                      "（" +
                      fmtMb(compact.result.size) +
                      t("compact.orig") +
                      fmtMb(compact.result.source_size) +
                      "，-" +
                      compact.result.reduction_pct +
                      t("compact.autoFill"),
                )
              : null,
          );
        };
        const pickerList = kind => {
          const p = picker;
          if (!p || p.kind !== kind) return null;
          if (p.loading)
            return react.createElement(
              "div",
              { className: "dsh-local-ai-tts-picker" },
              t("picker.readingFiles"),
            );
          if (p.error)
            return react.createElement(
              "div",
              { className: "dsh-local-ai-tts-picker dsh-local-ai-tts-error" },
              p.error,
            );
          return react.createElement(
            "div",
            { className: "dsh-local-ai-tts-picker" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-picker-title" },
              p.files.length
                ? t("picker.found") + p.files.length + t("picker.foundTail")
                : t("picker.none"),
            ),
            p.files.map(f =>
              react.createElement(
                "button",
                {
                  key: f.path,
                  type: "button",
                  className: "dsh-local-ai-tts-picker-item",
                  onClick: () => pickFile(kind, f),
                },
                react.createElement(
                  "span",
                  { className: "dsh-local-ai-tts-picker-name" },
                  f.name,
                ),
                react.createElement(
                  "span",
                  { className: "dsh-local-ai-tts-picker-size" },
                  (f.size / 1048576).toFixed(1) + " MB",
                ),
              ),
            ),
          );
        };
        const onUploadAudio = async e => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          let f = file;
          try { f = await downsampleForUpload(file); } catch (_) { /* 降采样失败回退原文件（16MB 上限兜底） */ }
          // C-23（方案 §五）：16MB 前置校验——不发请求，人话提示（413 原始报错没人看得懂）
          if (f.size > 16 * 1024 * 1024) {
            setError("文件超过 16MB（当前 " + (f.size / 1048576).toFixed(1) + " MB），请截取 30 秒以内的片段再上传");
            return;
          }
          // A-3 甲方案（方案 §三-A3）：基准音频走 POST /base-audio 落盘（内容 sha256 前 12 位命名），
          // config 只存文件名 baseAudioFile——base64 不再进 localStorage/PUT /config，1MB 上限连根消失。
          try {
            const r = await breezeApiFetch("/dsh-breeze-tts-api/base-audio", {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: f,
            });
            if (!r.ok) throw new Error("HTTP " + r.status);
            const j = await r.json();
            setRvc("baseAudioFile", String((j && j.file) || ""));
            setRvc("baseAudioName", f.name);
          } catch (err) {
            console.error("[tts] base audio upload failed:", String(err));
            setError("基准音频上传失败：" + ((err && err.message) || err));
          }
        };
        const field = (label, control, note) =>
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-field" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-rvc-row" },
              react.createElement(
                "span",
                { className: "dsh-local-ai-tts-rvc-label" },
                label,
              ),
              control,
            ),
            note
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-note" },
                  note,
                )
              : null,
          );
        const textIn = (key, placeholder) =>
          react.createElement("input", {
            className: "dsh-local-ai-tts-rvc-input",
            value: shared.rvc[key],
            placeholder: placeholder,
            onChange: e => setRvc(key, e.target.value),
          });
        const num = (key, step, min) =>
          react.createElement("input", {
            className: "dsh-local-ai-tts-rvc-input dsh-local-ai-tts-rvc-input-num",
            type: "number",
            step: step,
            min: min,
            value: shared.rvc[key],
            onChange: e => setRvc(key, Number(e.target.value)),
          });
        const sel = (key, options) =>
          react.createElement(
            "select",
            {
              className: "dsh-local-ai-tts-rvc-input dsh-local-ai-tts-select",
              value: shared.rvc[key],
              onChange: e => setRvc(key, e.target.value),
            },
            options.map(o =>
              react.createElement("option", { key: o[0], value: o[0] }, o[1]),
            ),
          );
        const selNum = (key, options) =>
          react.createElement(
            "select",
            {
              className: "dsh-local-ai-tts-rvc-input dsh-local-ai-tts-select",
              value: shared.rvc[key],
              onChange: e => setRvc(key, Number(e.target.value)),
            },
            options.map(o =>
              react.createElement("option", { key: o[0], value: o[0] }, o[1]),
            ),
          );
        const slider = (key, min, max, step, fmt) =>
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-slider" },
            react.createElement("input", {
              type: "range",
              min: min,
              max: max,
              step: step,
              value: shared.rvc[key],
              onChange: e => setRvc(key, Number(e.target.value)),
            }),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-slider-scale" },
              react.createElement(
                "span",
                { className: "dsh-local-ai-tts-slider-end" },
                fmt(min),
              ),
              react.createElement("span", { className: "dsh-local-ai-tts-slider-spacer" }),
              react.createElement(
                "span",
                { className: "dsh-local-ai-tts-slider-end" },
                fmt(max),
              ),
              react.createElement(
                "span",
                { className: "dsh-local-ai-tts-slider-value" },
                fmt(shared.rvc[key]),
              ),
            ),
          );
        const pctFmt = v => Math.round(v * 100) + "%";
        const pct100Fmt = v =>
          v === 0 ? t("f0.default") : (v > 0 ? "+" : "") + v + "%";
        const semiFmt = v => (v > 0 ? "+" : "") + v + t("f0.semitones");
        const fmtMb = n =>
          n ? (n / 1048576 >= 100 ? (n / 1048576 / 1024).toFixed(1) + " GB" : (n / 1048576).toFixed(1) + " MB") : "0 MB";
        const BASE_VOICES = [
          ["zh-CN-YunyangNeural", t("baseVoice.yunyang")],
          ["zh-CN-YunxiNeural", t("baseVoice.yunxi")],
          ["zh-CN-YunxiaNeural", t("baseVoice.yunxia")],
          ["zh-CN-XiaoxiaoNeural", t("baseVoice.xiaoxiao")],
          ["zh-CN-XiaoyiNeural", t("baseVoice.xiaoyi")],
          ["en-US-GuyNeural", t("baseVoice.guy")],
          ["en-US-JennyNeural", t("baseVoice.jenny")],
        ];
        const F0_OPTIONS = [
          ["rmvpe", t("f0.rmvpe")],
          ["pm", t("f0.pm")],
          ["harvest", t("f0.harvest")],
          ["crepe", t("f0.crepe")],
        ];
        const SR_OPTIONS = [
          [16000, "16 kHz"],
          [24000, "24 kHz"],
          [32000, "32 kHz"],
          [40000, "40 kHz"],
          [48000, "48 kHz"],
        ];

        // 声音调节 —— Edge TTS 属性，两种 provider 通用
        const soundSection = react.createElement(
          "div",
          { className: "dsh-local-ai-tts-module dsh-local-ai-tts-module-stack" },
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module-info" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-title" },
              t("section.voiceTuning"),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-desc" },
              provider === "rvc"
                ? t("voiceTuning.desc")
                : t("voiceTuning.edgeDesc"),
            ),
          ),
          field(
            t("field.rate"),
            slider("baseRate", -50, 50, 1, pct100Fmt),
            t("field.rate.tip"),
          ),
          field(
            t("field.pitch"),
            slider("basePitch", -50, 50, 1, pct100Fmt),
            t("field.pitch.tip"),
          ),
          field(
            t("field.volume"),
            slider("baseVolume", -50, 50, 1, pct100Fmt),
            t("field.volume.tip"),
          ),
        );

        const rvcSection = react.createElement(
          "div",
          { className: "dsh-local-ai-tts-module dsh-local-ai-tts-module-stack dsh-local-ai-tts-rvc" },
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module-info" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-title" },
              t("section.rvc"),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-desc" },
              t("rvc.desc"),
            ),
          ),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-fallback-row" },
            react.createElement(
              "label",
              { className: "dsh-local-ai-tts-check" },
              react.createElement("input", {
                type: "checkbox",
                checked: shared.rvcAutoFallback,
                onChange: e => {
                  shared.rvcAutoFallback = e.target.checked;
                  saveSettings();
                  notify();
                },
              }),
              react.createElement("span", null, t("rvc.fallbackOn")),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-desc" },
              t("rvc.fallbackTip"),
            ),
          ),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-onboard" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-onboard-title" },
              t("onboard.title"),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-onboard-desc" },
              t("onboard.desc"),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-onboard-steps" },
              t("onboard.steps"),
            ),
            react.createElement(
              "pre",
              { className: "dsh-local-ai-tts-onboard-cmd" },
              t("onboard.cmd"),
            ),
            react.createElement(
              "button",
              {
                type: "button",
                className: "dsh-local-ai-tts-browse",
                onClick: runDiagnose,
                disabled: (diag && diag.running) || undefined,
              },
              t("diag.run"),
            ),
          ),
          field(
            t("field.baseUrl"),
            textIn("baseUrl", "http://127.0.0.1:4892"),
            t("field.baseUrl.tip"),
          ),
          field(
            t("field.baseSource"),
            sel("baseSource", [
              ["edge", t("baseSource.edge")],
              ["upload", t("baseSource.upload")],
            ]),
            t("baseSource.tip"),
          ),
          shared.rvc.baseSource === "upload"
            ? field(
                t("baseSource.uploadBtn"),
                react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-upload" },
                  react.createElement(
                    "label",
                    { className: "dsh-local-ai-tts-file-btn" },
                    t("baseSource.chooseFile"),
                    react.createElement("input", {
                      type: "file",
                      accept: ".wav,.mp3,.m4a,.ogg,.flac,audio/*",
                      style: { display: "none" },
                      onChange: onUploadAudio,
                    }),
                  ),
                  react.createElement(
                    "span",
                    { className: "dsh-local-ai-tts-upload-name" },
                    shared.rvc.baseAudioName || t("baseSource.noFile"),
                  ),
                ),
                t("baseSource.uploadTip"),
              )
            : null,
          shared.rvc.baseSource === "edge"
            ? field(
                t("field.baseVoice"),
                sel("baseVoice", BASE_VOICES),
                t("field.baseVoice.tip"),
              )
            : null,
          field(
            t("field.modelPath"),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-path" },
              textIn("model", "E:\\...\\assets\\weights\\xxx.pth"),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-browse",
                  onClick: () => openPicker("pth"),
                },
                t("field.browse"),
              ),
            ),
            picker && picker.kind === "pth"
              ? pickerList("pth")
              : t("field.modelPath.tip"),
          ),
          field(
            t("field.indexPath"),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-path" },
              textIn("index", t("indexPath.empty")),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-browse",
                  onClick: () => openPicker("index"),
                },
                t("field.browse"),
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-browse",
                  title: t("indexPath.compactTip"),
                  onClick: () =>
                    setCompact({ open: true, busy: false, error: null, result: null, target: 10000 }),
                },
                t("indexPath.compact"),
              ),
            ),
            react.createElement(
              react.Fragment,
              null,
              picker && picker.kind === "index"
                ? pickerList("index")
                : t("indexPath.tip"),
              compactPanel(),
            ),
          ),
          react.createElement(
            "details",
            { className: "dsh-local-ai-tts-advanced" },
            react.createElement("summary", null, t("section.advanced")),
            field(
              t("field.spkId"),
              num("spkId", 1, 0),
              t("field.spkId.tip"),
            ),
            field(
              t("field.f0Method"),
              sel("f0Method", F0_OPTIONS),
              t("field.f0Method.tip"),
            ),
            field(
              t("field.f0UpKey"),
              slider("f0UpKey", -12, 12, 1, semiFmt),
              t("field.f0UpKey.tip"),
            ),
            field(
              t("field.indexRate"),
              slider("indexRate", 0, 1, 0.05, pctFmt),
              t("field.indexRate.tip"),
            ),
            field(
              t("field.resampleSr"),
              selNum("resampleSr", SR_OPTIONS),
              t("field.resampleSr.tip"),
            ),
            field(
              t("field.rmsMixRate"),
              slider("rmsMixRate", 0, 1, 0.05, pctFmt),
              t("field.rmsMixRate.tip"),
            ),
            field(
              t("field.protect"),
              slider("protect", 0, 1, 0.05, pctFmt),
              t("field.protect.tip"),
            ),
            field(
              t("field.filterRadius"),
              slider("filterRadius", 0, 7, 1, v => String(v)),
              t("field.filterRadius.tip"),
            ),
            field(
              t("field.f0File"),
              textIn("f0File", t("f0File.empty")),
              t("f0File.tip"),
            ),
          ),
        );

        const notifySection = react.createElement(
          "div",
          { className: "dsh-local-ai-tts-module dsh-local-ai-tts-module-stack" },
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module-info" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-title" },
              t("notify.title"),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-desc" },
              t("notify.desc"),
            ),
          ),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-fallback-row" },
            react.createElement(
              "label",
              { className: "dsh-local-ai-tts-check" },
              react.createElement("input", {
                type: "checkbox",
                checked: shared.notify.enabled,
                onChange: e => {
                  shared.notify.enabled = e.target.checked;
                  saveSettings();
                  notify();
                },
              }),
              react.createElement("span", null, t("notify.enabled")),
            ),
          ),
          shared.notify.enabled
            ? react.createElement(
                "div",
                { className: "dsh-local-ai-tts-fallback-row" },
                react.createElement(
                  "label",
                  { className: "dsh-local-ai-tts-check" },
                  react.createElement("input", {
                    type: "checkbox",
                    checked: shared.notify.approval,
                    onChange: e => {
                      shared.notify.approval = e.target.checked;
                      saveSettings();
                      notify();
                    },
                  }),
                  react.createElement("span", null, t("notify.approval")),
                ),
                react.createElement(
                  "label",
                  { className: "dsh-local-ai-tts-check" },
                  react.createElement("input", {
                    type: "checkbox",
                    checked: shared.notify.approvalResult,
                    onChange: e => {
                      shared.notify.approvalResult = e.target.checked;
                      saveSettings();
                      notify();
                    },
                  }),
                  react.createElement("span", null, t("notify.approvalResult")),
                ),
                react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-rvc-row" },
                  react.createElement(
                    "span",
                    { className: "dsh-local-ai-tts-rvc-label" },
                    t("notify.voice"),
                  ),
                  react.createElement(
                    "select",
                    {
                      className: "dsh-local-ai-tts-select",
                      value: shared.notify.voice,
                      onChange: e => {
                        shared.notify.voice = e.target.value;
                        saveSettings();
                        notify();
                      },
                    },
                    VOICES
                      .filter(v => !shared.removedVoices.has(v[0]))
                      .map(v =>
                        react.createElement("option", { key: v[0], value: v[0] }, v[1]),
                      ),
                  ),
                ),
              )
            : null,
        );
        return react.createElement(
          "div",
          { className: "dsh-local-ai-tts-settings" },
          react.createElement(CoexistenceNotice),
          react.createElement(PluginUpdatePanel),
          !hostMessageCapability.supported && react.createElement('p', { role: 'alert' }, t("compat.messages")),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-info" },
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-title" },
                t("lang.label"),
              ),
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-desc" },
                I18N.lang === "auto" ? t("lang.modeAuto") : t("lang.modeManual"),
              ),
            ),
            react.createElement(
              "select",
              {
                className: "dsh-local-ai-tts-select",
                value: lang,
                onChange: changeLang,
              },
              react.createElement("option", { value: "auto" }, t("lang.auto")),
              react.createElement("option", { value: "zh" }, t("lang.zh")),
              react.createElement("option", { value: "en" }, t("lang.en")),
            ),
          ),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-info" },
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-title" },
                t("provider.label"),
              ),
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-desc" },
                t("provider.help"),
              ),
            ),
            react.createElement(
              "select",
              {
                className: "dsh-local-ai-tts-select",
                value: provider === 'local-runtime' && shared.localProcess.engine === 'folder' ? 'folder-model' : provider,
                onChange: changeProvider,
              },
              !coexistence.companion && react.createElement(
                "option",
                { value: "edge-tts" },
                "Edge TTS",
              ),
              !coexistence.companion && react.createElement(
                "option",
                { value: "rvc" },
                t("provider.rvc"),
              ),
              react.createElement("option", { key: "folder-local", value: "folder-model" }, t("provider.folder")),
              react.createElement("option", { key: "index-local", value: "indextts-process" }, window.__dshLocalAiTtsI18n?.current() === 'en' ? 'IndexTTS 2.5 (local)' : 'IndexTTS 2.5（本地）'),
              react.createElement("option", { key: "gpt-local", value: "gpt-sovits-process" }, window.__dshLocalAiTtsI18n?.current() === 'en' ? 'GPT-SoVITS (local)' : 'GPT-SoVITS（本地）'),
              react.createElement("option", { key: "generic-local", value: "local-runtime" }, t("provider.generic")),
            ),
          ),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module dsh-local-ai-tts-reset" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-info" },
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-title" },
                t("settings.reset"),
              ),
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-desc" },
                resetMsg || " ",
              ),
            ),
            react.createElement(
              "button",
              {
                type: "button",
                className: "dsh-local-ai-tts-browse",
                onClick: onResetSettings,
              },
              t("settings.reset"),
            ),
          ),
          provider === "edge-tts"
            ? react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module" },
                react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-module-info" },
                  react.createElement(
                    "div",
                    { className: "dsh-local-ai-tts-module-title" },
                    t("field.voice"),
                  ),
                  react.createElement(
                    "div",
                    { className: "dsh-local-ai-tts-module-desc" },
                    t("field.voice.tip"),
                  ),
                ),
                react.createElement(
                  "select",
                  {
                    className: "dsh-local-ai-tts-select",
                    value: voice,
                    onChange: changeVoice,
                  },
                  voiceOptions,
                ),
              )
            : null,
          provider === "edge-tts" || (provider === "rvc" && shared.rvc.baseSource === "edge")
            ? soundSection
            : null,
          provider === "local-runtime" || provider === "indextts-process" || provider === "gpt-sovits-process" ? react.createElement(localRuntime.Settings) : null,
          provider === "rvc" ? rvcSection : null,
          provider === "rvc" ? packSection() : null,
          provider !== "local-runtime" && provider !== "indextts-process" && provider !== "gpt-sovits-process" ? notifySection : null,
          provider !== "local-runtime" && provider !== "indextts-process" && provider !== "gpt-sovits-process" ? diagModule() : null,
          !(provider === 'local-runtime') && react.createElement(
            "div",
            { className: "dsh-local-ai-tts-module dsh-local-ai-tts-module-stack" },
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-module-info" },
              react.createElement(
                "div",
                { className: "dsh-local-ai-tts-module-title" },
                t("preview.title"),
              ),
            ),
            react.createElement(
              "div",
              { className: "dsh-local-ai-tts-preview-row" },
              react.createElement("input", {
                className: "dsh-local-ai-tts-preview-input",
                value: preview,
                "aria-label": t("preview.text"),
                onChange: e => setPreview(e.target.value),
              }),
              react.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-local-ai-tts-preview-btn",
                  "aria-label": isPreviewPlaying ? t("preview.stop") : t("preview.play"),
                  title: isPreviewPlaying ? t("preview.playing") : t("preview.play"),
                  onClick: onPreview,
                },
                isPreviewPlaying ? SpinnerIcon() : PlayIcon(),
              ),
            ),
            error
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-error", role: "status" },
                  error,
                )
              : null,
            isPreviewPlaying && shared.chunkProgress && shared.chunkProgress.total > 1
              ? react.createElement(
                  "div",
                  { className: "dsh-local-ai-tts-status", role: "status" },
                  t("chunk.playing.lead") +
                    shared.chunkProgress.index +
                    "/" +
                    shared.chunkProgress.total +
                    t("chunk.playing.tail"),
                )
              : null,
          ),
          react.createElement(
            "div",
            { className: "dsh-local-ai-tts-footnote" },
            provider === "local-runtime" || provider === "indextts-process" || provider === "gpt-sovits-process" ? t("local.footnote") : t("footnote"),
          ),
          picker
            ? react.createElement("div", {
                className: "dsh-local-ai-tts-overlay",
                onClick: () => setPicker(null),
              })
            : null,
        );
      }
      slots.inject("settings.plugins.tab", () =>
        slots.register(
          {
            name: "settings.plugins.tab",
            key: "local-ai-tts",
            id: "local-ai-tts",
            order: 20,
            // 页签名：以前拼成「语音 · 本地 AI 语音」（tab.voice + " · " + local.title），
            // 两个词叠着说同一件事。现统一成自家名：普通态「Breeze 设置」，
            // 与原版共存态「本地语音」（此时本插件只提供 Local Runtime，名字要区别开）。
            label: () => coexistence.companion ? t("coexist.tab") : t("tab.voice"),
          },
          VoiceSettingsPanel,
        ),
      );
      // FR-1：方向二「Breeze 音色工坊」tab（order 30 在方向一之后）——方案 §5.3
      slots.inject("settings.plugins.tab", () =>
        slots.register(
          { name: "settings.plugins.tab", key: "breeze-voices", id: "breeze-voices",
            order: 30, label: () => "Breeze 音色工坊" },
          BreezeWorkshop.VoicePanel,
        ),
      );
      refreshCoexistence();
      ctx.effect(() => {
        const timer = setInterval(refreshCoexistence, 500);
        return () => clearInterval(timer);
      }, 'local-ai-tts: coexistence detection');
      // A-1（方案 §三-A1）：工坊参数注入。落码级修正：方案写 factory 顶层 :5924，但
      // breezeApiFetch 词法仅在 apply 体内（:64 全文件唯一定义），factory 层引用必 ReferenceError
      // （闭包由定义处决定，方案自己引用的小深结论）。落在 apply 闭合前：词法可见，且运行时
      // IIFE 早已执行完毕（与 :5203 引用 BreezeWorkshop.VoicePanel 同款先例）。
      BreezeWorkshop.setApiFetch(breezeApiFetch);
    };

    // ===== Breeze 音色工坊（原 dsh-breeze-voices，并入段） =====
    // 搬运自参考_dsh-breeze-voices/lib_client.js（28750 字节含试听修复版），剥 __ModuleLoader__ 外壳后
    // 包 IIFE 隔离顶层命名（方案 §5.2）；voices 原 apply 剥除，slot 注册见下方第二份注册（方案 §5.3）。
    const BreezeWorkshop = (() => {
    // A-1（方案 §三-A1）参数注入插座：IIFE 在 factory 层，词法够不到 apply 内的 breezeApiFetch
    // （闭包由定义处决定），由 apply 内 setApiFetch 把封装递进来；未注入前为 null。
    let _apiFetch = null;
    function setApiFetch(f) { _apiFetch = f; }
    let react = require("react");
    const h = react.createElement;

    /* ================= 常量 ================= */
    const DEFAULT_API = "http://127.0.0.1:8080"; // FR-6/7/8 B5：出厂默认本机（FR-6 验收 1 零配置可连）
    const LS_KEY = "breezeApi"; // 与原型一致；与旧插件的存储键零交集（不复用旧键，避免串味）
    const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const loadApi = () => {
      try { return localStorage.getItem(LS_KEY) || DEFAULT_API; } catch (_) { return DEFAULT_API; }
    };
    // FR-5（方案 §6.4-②）：endpoint 统一到 host config.json——本地 localStorage 保留为同步缓存/兜底，
    // 保存时双写（PUT /config 局部 merge 到顶层 endpoint 字段，两个 tab 共用唯一源）。
    const saveApi = v => {
      try { localStorage.setItem(LS_KEY, v); } catch (_) {}
      try {
        _apiFetch("/dsh-breeze-tts-api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: v }),
        }).catch(() => {});
      } catch (_) {}
    };

    /* ================= 样式（原型 CSS，全部选择器加 bwv- 前缀） ================= */
    const CSS = `
.bwv-root{
  --bg:#14161a; --panel:#1c1f26; --panel2:#232730; --line:#2e333d;
  --txt:#e6e8ec; --dim:#8b919d; --accent:#7c9cff; --ok:#4ec98a; --warn:#f0a44a; --err:#f26d6d;
  box-sizing:border-box; color:var(--txt);
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  padding:0 0 24px;
}
.bwv-root *{box-sizing:border-box}
.bwv-header{
  display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  padding:14px 0; margin-bottom:14px; border-bottom:1px solid var(--line);
}
.bwv-title{font-size:16px; font-weight:600; letter-spacing:.5px; margin:0}
.bwv-dot{width:8px;height:8px;border-radius:50%;background:var(--dim);display:inline-block;margin-right:6px}
.bwv-dot.ok{background:var(--ok); box-shadow:0 0 8px var(--ok)}
.bwv-dot.bad{background:var(--err)}
.bwv-health{font-size:12px; color:var(--dim)}
.bwv-spacer{flex:1}
.bwv-api{display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dim)}
.bwv-api input{
  background:var(--panel2); border:1px solid var(--line); color:var(--txt);
  border-radius:6px; padding:5px 8px; width:210px; font-size:12px; font-family:ui-monospace,monospace;
}
.bwv-nav{display:flex; gap:8px; padding-bottom:0}
.bwv-nav button{
  background:var(--panel); border:1px solid var(--line); color:var(--dim);
  padding:8px 16px; border-radius:8px 8px 0 0; cursor:pointer; font-size:13px;
  border-bottom:none; transition:.15s;
}
.bwv-nav button:hover{color:var(--txt)}
.bwv-nav button.bwv-active{background:var(--panel2); color:var(--txt); border-color:var(--accent)}
.bwv-section{background:var(--panel2); border:1px solid var(--line); border-radius:0 10px 10px 10px; padding:20px}
.bwv-grid{display:grid; grid-template-columns:1fr 1fr; gap:18px}
@media(max-width:820px){.bwv-grid{grid-template-columns:1fr}}
.bwv-label{display:block; margin-bottom:6px; font-size:12px; color:var(--dim)}
.bwv-root textarea,.bwv-root input[type=text],.bwv-root input[type=number]{
  width:100%; background:var(--panel); border:1px solid var(--line); color:var(--txt);
  border-radius:8px; padding:10px 12px; font-size:13px; font-family:inherit; resize:vertical;
}
.bwv-root textarea{min-height:76px; line-height:1.6}
.bwv-root textarea:focus,.bwv-root input:focus{outline:none; border-color:var(--accent)}
.bwv-field{margin-bottom:14px}
.bwv-row{display:flex; gap:10px; align-items:center; flex-wrap:wrap}
.bwv-act{
  background:var(--accent); color:#0d1017; border:none; border-radius:8px;
  padding:9px 18px; font-size:13px; font-weight:600; cursor:pointer; transition:.15s;
}
.bwv-act:hover{filter:brightness(1.1)}
.bwv-act:disabled{opacity:.45; cursor:not-allowed; filter:none}
.bwv-ghost{
  background:transparent; color:var(--dim); border:1px solid var(--line);
  border-radius:8px; padding:9px 16px; font-size:13px; cursor:pointer;
}
.bwv-ghost:hover{color:var(--txt); border-color:var(--accent)}
.bwv-ghost.bwv-danger{color:var(--err); border-color:rgba(242,109,109,.35)}
.bwv-root audio{width:100%; margin-top:10px; filter:invert(.92) hue-rotate(180deg)}
.bwv-hint{font-size:12px; color:var(--dim); margin-top:6px; line-height:1.5}
.bwv-msg{margin-top:12px; font-size:12.5px; padding:9px 12px; border-radius:8px}
.bwv-msg.bwv-ok{background:rgba(78,201,138,.12); color:var(--ok); border:1px solid rgba(78,201,138,.3)}
.bwv-msg.bwv-err{background:rgba(242,109,109,.12); color:var(--err); border:1px solid rgba(242,109,109,.3)}
.bwv-msg.bwv-info{background:rgba(124,156,255,.12); color:var(--accent); border:1px solid rgba(124,156,255,.3)}
.bwv-msg.bwv-warn{background:rgba(240,164,74,.12); color:var(--warn); border:1px solid rgba(240,164,74,.35)}
.bwv-vcard{
  display:flex; align-items:center; gap:14px; padding:12px 14px;
  background:var(--panel); border:1px solid var(--line); border-radius:10px; margin-bottom:10px;
}
.bwv-vcard .bwv-meta{flex:1; min-width:0}
.bwv-vcard .bwv-name{font-weight:600; font-size:14px}
.bwv-vcard .bwv-sub{font-size:12px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.bwv-vcard button{font-size:12px; padding:6px 12px}
.bwv-empty{color:var(--dim); font-size:13px; padding:20px 0; text-align:center}
.bwv-tag{font-size:11px; padding:2px 7px; border-radius:5px; background:var(--panel2); color:var(--dim); border:1px solid var(--line)}
.bwv-tag.bwv-saved{color:var(--ok); border-color:rgba(78,201,138,.35)}
.bwv-file{
  width:100%; background:var(--panel); border:1px solid var(--line); border-radius:8px;
  padding:9px; color:var(--dim); font-size:12px;
}
`;
    function injectStyle() {
      if (document.getElementById("bwv-style")) return;
      const tag = document.createElement("style");
      tag.id = "bwv-style";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ================= 音频播放（坑 4：浏览器自动播放限制） =================
       现象：点「试听」没声音，也不报错。
       根因：合成要等十几秒，await 之后用户手势（transient activation）已过期，
             new Audio(url).play() 被浏览器静默拦截，且返回的 Promise 没人接。
       解法：① 在点击那一刻「同步」解锁 AudioContext（手势内 resume）
             ② 合成完用 Web Audio 解码播放（不受手势限制）
             ③ 万一 Web Audio 不可用，退回 <audio> 并把错误抛给 UI */
    let sharedAudioCtx = null;
    function getAudioCtx() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!sharedAudioCtx) { try { sharedAudioCtx = new AC(); } catch (_) { return null; } }
      return sharedAudioCtx;
    }
    // ★ 必须在点击事件的同步代码里调用（await 之前），否则解锁无效
    function unlockAudio() {
      const ctx = getAudioCtx();
      if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
      return ctx;
    }
    function decodeAudio(ctx, ab) {
      return new Promise((resolve, reject) => {
        let p;
        try { p = ctx.decodeAudioData(ab, resolve, reject); } catch (e) { reject(e); return; }
        if (p && typeof p.then === "function") p.then(resolve, reject);
      });
    }
    async function playBlob(blob) {
      const ctx = getAudioCtx();
      if (ctx) {
        try {
          if (ctx.state === "suspended") { try { await ctx.resume(); } catch (_) {} }
          const ab = await blob.arrayBuffer();
          const buf = await decodeAudio(ctx, ab);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const gain = ctx.createGain();
          gain.gain.value = 1;
          src.connect(gain); gain.connect(ctx.destination);
          src.start();
          return "webaudio";
        } catch (e) {
          console.warn("[breeze] Web Audio 播放失败，回退 <audio>：", e);
        }
      }
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.volume = 1;
      a.onended = () => URL.revokeObjectURL(url);
      await a.play(); // 让 rejection 冒到 UI，不再静默
      return "audio";
    }

    /* ================= WAV 头修复（坑 1：Breeze 流式输出 length=0xFFFFFFFF） =================
       与原型/开工说明里的版本逐字一致，一个字节别改。 */
    async function fixWav(blob) {
      const ab = await blob.arrayBuffer();
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
      return new Blob([ab], { type: "audio/wav" });
    }

    /* ================= 错误分类（说人话） ================= */
    function humanError(e) {
      const s = e && e.status;
      if (s === 404) return "接口或音色不存在（404）——音色列表是 /v1/voices，别带 audio。";
      if (s === 409) return "Breeze 正忙（一次只能处理一个请求），稍等一下再试。";
      if (s === 400) return "参数不对（400）——检查音色名（只允许字母/数字/短横/下划线）和转录文本。";
      if (e && e.network) return "连不上 Breeze——服务起了吗？地址对吗？（启动BreezeTTS.bat，或检查顶栏地址）。若您在通过公网访问，够不到家里那台 TTS——请让 AI 把 accessMode 改成 proxy（走壳中转），或回家再设置。";
      return (e && e.message) ? e.message : String(e);
    }
    async function httpErr(r) {
      let t = ""; try { t = await r.text(); } catch (_) {}
      const e = new Error("HTTP " + r.status + (t ? " · " + t.slice(0, 200) : ""));
      e.status = r.status;
      return e;
    }

    /* ================= 409 自动重试一次（坑 2） ================= */
    async function withRetry(fn) {
      try { return await fn(); }
      catch (e) {
        if (e && e.status === 409) { await sleep(2000); return await fn(); }
        throw e;
      }
    }

    /* ================= API（将来升级方案 B 只改这里） ================= */
    // FR-8 双通道（方案 §三.2）：accessMode='proxy' 时走壳同源代理路由（外网浏览器够不到私网 Breeze），
    // 'direct'（默认）浏览器直连。切换由 host config.json 的 accessMode 字段决定（挂载时同步），不自动切。
    let WORKSHOP_ACCESS = { mode: "direct" };
    const DSH_API = "/dsh-breeze-tts-api";
    async function fetchJson(url, opts) {
      let r;
      try { r = await _apiFetch(url, opts); }
      catch (_) { const e = new Error("network"); e.network = true; throw e; }
      if (!r.ok) throw await httpErr(r);
      return r.json();
    }
    async function fetchBlob(url, opts) {
      let r;
      try { r = await _apiFetch(url, opts); }
      catch (_) { const e = new Error("network"); e.network = true; throw e; }
      if (!r.ok) throw await httpErr(r);
      return r.blob();
    }
    const apiHealth = API => WORKSHOP_ACCESS.mode === "proxy"
      ? fetchJson(DSH_API + "/health", { cache: "no-store" })
      : fetchJson(API + "/health", { cache: "no-store" });
    const apiListVoices = API => WORKSHOP_ACCESS.mode === "proxy"
      ? fetchJson(DSH_API + "/voices", { cache: "no-store" })
      : fetchJson(API + "/v1/voices", { cache: "no-store" });
    const apiDeleteVoice = (API, id) =>
      withRetry(() => WORKSHOP_ACCESS.mode === "proxy"
        ? fetchJson(DSH_API + "/voices/" + encodeURIComponent(id), { method: "DELETE" })
        : fetchJson(API + "/v1/voices/" + encodeURIComponent(id), { method: "DELETE" }));
    const apiSynth = (API, body) => withRetry(() =>
      WORKSHOP_ACCESS.mode === "proxy"
        ? fetchBlob(DSH_API + "/speak-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : fetchBlob(API + "/v1/audio/speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }));
    const apiSaveVoice = (API, fd) => withRetry(() =>
      WORKSHOP_ACCESS.mode === "proxy"
        ? fetchJson(DSH_API + "/voices/clone", { method: "POST", body: fd })
        : fetchJson(API + "/v1/voices", { method: "POST", body: fd }));

    /* ================= 合成（返回修好头的 blob） =================
       opts（工单001，可选）：{ seed: int, cfgScale: float }——填了才传，空/NaN 不传 */
    async function synth(API, text, instructions, voice, opts) {
      const body = { input: text, response_format: "wav" };
      if (instructions) body.instructions = instructions;
      if (voice) body.voice = voice;
      if (opts && Number.isInteger(opts.seed)) body.seed = opts.seed;
      if (opts && Number.isFinite(opts.cfgScale)) body.cfg_scale = opts.cfgScale;
      const blob = await apiSynth(API, body);
      return fixWav(blob); // 坑 1：上传/播放前必须修 WAV 头
    }

    /* ================= 注册音色（multipart） ================= */
    async function saveVoice(API, name, refText, blob) {
      const fd = new FormData();
      fd.append("ref_audio", blob, name + ".wav");
      fd.append("ref_text", refText);
      fd.append("name", name);
      return apiSaveVoice(API, fd);
    }

    /* ================= 小组件 ================= */
    function Msg(props) {
      if (!props || !props.msg) return null;
      return h("div", { className: "bwv-msg bwv-" + props.msg.type }, props.msg.text);
    }
    function AudioBox(props) {
      if (!props || !props.url) return null;
      return h("audio", { controls: true, src: props.url, style: { display: "block", marginTop: "10px", width: "100%" } });
    }

    /* ================= ① 声音设计 ================= */
    function DesignTab(props) {
      const API = props.api;
      const [text, setText] = react.useState(
        "哥哥，你回来啦。我等你好久了。今天外面冷不冷？来，把手给我，我给你暖暖。");
      const [instr, setInstr] = react.useState(
        "A soft, breathy young Chinese woman, unhurried and intimate, short quiet sentences with small pauses, whispered and close-mic.");
      const [name, setName] = react.useState("");
      const [refText, setRefText] = react.useState("");
      const [seed, setSeed] = react.useState("42");      // 工单001：默认 42（与 Breeze 默认一致）
      const [cfg, setCfg] = react.useState("1.0");      // 工单001：默认 1.0
      const [busy, setBusy] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [saveMsg, setSaveMsg] = react.useState(null);
      const [audioUrl, setAudioUrl] = react.useState("");
      const blobRef = react.useRef(null);

      const gen = async () => {
        const t = text.trim();
        if (!t) { setMsg({ type: "err", text: "试听文本不能为空" }); return; }
        setSaveMsg(null);
        setBusy(true);
        setMsg({ type: "info", text: "正在生成，首次可能要十几秒…" });
        try {
          // 工单001：解析两个调音参数（清空/非法值 → 不传，让 Breeze 用自己的默认值）
          const opts = {};
          const s = seed === "" ? NaN : parseInt(seed, 10);
          if (!Number.isNaN(s)) opts.seed = s;
          const cf = cfg === "" ? NaN : parseFloat(cfg);
          if (!Number.isNaN(cf)) opts.cfgScale = cf;
          blobRef.current = await synth(API, t, instr.trim(), null, opts);
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          const url = URL.createObjectURL(blobRef.current);
          setAudioUrl(url);
          setRefText(t); // 转录文本自动填 = 试听文本
          setMsg({ type: "ok", text: "生成好了，先听一下。满意就填名字保存。" });
        } catch (e) {
          setMsg({ type: "err", text: "生成失败：" + humanError(e) });
        } finally { setBusy(false); }
      };

      const save = async () => {
        const n = name.trim(), rt = refText.trim();
        if (!n) { setSaveMsg({ type: "err", text: "先给音色起个名字" }); return; }
        if (!NAME_RE.test(n)) { setSaveMsg({ type: "err", text: "名字只能用字母、数字、短横、下划线（≤64）" }); return; }
        if (!rt) { setSaveMsg({ type: "err", text: "转录文本不能为空" }); return; }
        if (!blobRef.current) { setSaveMsg({ type: "err", text: "先点「生成试听」" }); return; }
        setSaving(true);
        setSaveMsg({ type: "info", text: "保存中…" });
        try {
          const j = await saveVoice(API, n, rt, blobRef.current);
          setSaveMsg({ type: "ok", text: `已保存：${j.id}（${j.seconds}s）—— 在「Breeze 设置」页的「音色 ID」里填 ${j.id} 就能用` });
          props.onSaved && props.onSaved();
        } catch (e) {
          setSaveMsg({ type: "err", text: "保存失败：" + humanError(e) });
        } finally { setSaving(false); }
      };

      return h("div", { className: "bwv-grid" },
        h("div", null,
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "试听文本（模型会读这句）"),
            h("textarea", { value: text, onChange: e => setText(e.target.value) })),
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "声音描述（中文英文都认，越具体越准）"),
            h("textarea", { value: instr, onChange: e => setInstr(e.target.value) })),
          h("div", { className: "bwv-field" }, // 工单001：种子 + 引导强度一行两个框
            h("div", { style: { display: "flex", gap: "10px" } },
              h("div", { style: { flex: "1" } },
                h("label", { className: "bwv-label" }, "种子（seed）"),
                h("input", {
                  type: "number", placeholder: "42", min: 0, max: 4294967295, step: 1,
                  value: seed, onChange: e => setSeed(e.target.value),
                }),
                h("div", { className: "bwv-hint" }, "同种子+同文本=同声音，可复现")),
              h("div", { style: { flex: "1" } },
                h("label", { className: "bwv-label" }, "引导强度（CFG）"),
                h("input", {
                  type: "number", placeholder: "1.0", min: 0, max: 3, step: "0.1",
                  value: cfg, onChange: e => setCfg(e.target.value),
                }),
                h("div", { className: "bwv-hint" }, "越高越贴描述，1.0 为默认")))),
          h("div", { className: "bwv-row" },
            h("button", { className: "bwv-act", disabled: busy, onClick: gen }, "生成试听"),
            h("span", { className: "bwv-hint" }, "首次可能要等十几秒")),
          h(Msg, { msg }),
          h(AudioBox, { url: audioUrl })),
        h("div", null,
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "音色名（只能用字母/数字/短横/下划线，≤64）"),
            h("input", { type: "text", placeholder: "比如 xiaoman", value: name, onChange: e => setName(e.target.value) })),
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "转录文本（必须与试听文本逐字一致）"),
            h("textarea", { style: { minHeight: "60px" }, value: refText, onChange: e => setRefText(e.target.value) }),
            h("div", { className: "bwv-hint" }, "生成试听后会自动填好，一般不用改。")),
          h("div", { className: "bwv-row" },
            h("button", { className: "bwv-act", disabled: saving || !blobRef.current, onClick: save }, "保存为音色"),
            h("span", { className: "bwv-hint" }, "要先「生成试听」才能保存")),
          h(Msg, { msg: saveMsg })));
    }

    /* ================= ② 声音克隆 ================= */
    function CloneTab(props) {
      const API = props.api;
      const [file, setFile] = react.useState(null);
      const [refText, setRefText] = react.useState("");
      const [name, setName] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [audioUrl, setAudioUrl] = react.useState("");

      const onFile = e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        setFile(f);
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(f));
        setMsg(null);
      };

      const save = async () => {
        const n = name.trim(), rt = refText.trim();
        if (!file) { setMsg({ type: "err", text: "先选一个参考音频" }); return; }
        if (!n) { setMsg({ type: "err", text: "先给音色起个名字" }); return; }
        if (!NAME_RE.test(n)) { setMsg({ type: "err", text: "名字只能用字母、数字、短横、下划线（≤64）" }); return; }
        if (!rt) { setMsg({ type: "err", text: "转录文本不能为空" }); return; }
        setSaving(true);
        setMsg({ type: "info", text: "上传并编码中…" });
        try {
          const f = await downsampleForUpload(file); // 1.1.0 §二.2：参考音频统一 24kHz/mono（控体积＋克隆质量）
          const j = await saveVoice(API, n, rt, f);
          setMsg({ type: "ok", text: `已保存：${j.id}（${j.seconds}s）—— 在「Breeze 设置」页的「音色 ID」里填 ${j.id}` });
          props.onSaved && props.onSaved();
        } catch (e) {
          setMsg({ type: "err", text: "保存失败：" + humanError(e) });
        } finally { setSaving(false); }
      };

      return h("div", { className: "bwv-grid" },
        h("div", null,
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "参考音频（wav / mp3 / flac / ogg，建议 8–15 秒）"),
            h("input", {
              type: "file", className: "bwv-file",
              accept: ".wav,.mp3,.flac,.ogg,audio/*", onChange: onFile,
            }),
            h("div", { className: "bwv-hint" }, "干净人声、无背景音乐效果最好。太短会不稳。")),
          h(AudioBox, { url: audioUrl })),
        h("div", null,
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "转录文本（这段音频里说的每一个字）"),
            h("textarea", {
              placeholder: "逐字照抄音频内容，不能省略、不能改字",
              value: refText, onChange: e => setRefText(e.target.value),
            })),
          h("div", { className: "bwv-field" },
            h("label", { className: "bwv-label" }, "音色名"),
            h("input", { type: "text", placeholder: "比如 qingqing", value: name, onChange: e => setName(e.target.value) })),
          h("div", { className: "bwv-row" },
            h("button", { className: "bwv-act", disabled: saving, onClick: save }, "保存为音色")),
          h(Msg, { msg })));
    }

    /* ================= ③ 已有音色 ================= */
    function ListTab(props) {
      const API = props.api;
      const [voices, setVoices] = react.useState(null); // null=未加载
      const [msg, setMsg] = react.useState(null);
      const [playing, setPlaying] = react.useState(null); // 正在试听的音色 id
      const [deleting, setDeleting] = react.useState(null);

      const load = react.useCallback(async () => {
        await refreshAccessMode(); // A-5 入口③：刷新列表前静默刷 accessMode
        setMsg(null);
        setVoices(null);
        try {
          const arr = await apiListVoices(API);
          setVoices(Array.isArray(arr) ? arr : []);
        } catch (e) {
          setVoices([]);
          setMsg({ type: "err", text: "加载失败：" + humanError(e) });
        }
      }, [API]);

      react.useEffect(() => { load(); }, [load]);

      const play = async v => {
        unlockAudio(); // ★ 必须在 await 之前同步解锁，否则自动播放限制会拦掉
        setPlaying(v.id);
        setMsg(null);
        try {
          const blob = await synth(API, "这是音色测试，听听看像不像。", null, v.id);
          const how = await playBlob(blob);
          console.log("[breeze] 试听已播放 via " + how + " · size=" + blob.size + " type=" + blob.type);
        } catch (e) {
          setMsg({ type: "err", text: "试听失败：" + humanError(e) });
        } finally { setPlaying(null); }
      };

      const del = async v => {
        if (!window.confirm(
          `移除音色 ${v.id}？\n（只从内存移除，磁盘上的 .breeze 文件还在，重启会回来）`)) return;
        setDeleting(v.id);
        try {
          await apiDeleteVoice(API, v.id);
          setMsg({ type: "info", text: `已从内存移除 ${v.id}` });
          load();
        } catch (e) {
          setMsg({ type: "err", text: "移除失败：" + humanError(e) });
        } finally { setDeleting(null); }
      };

      let body;
      if (voices === null) {
        body = h("div", { className: "bwv-empty" }, "加载中…");
      } else if (!voices.length) {
        body = h("div", { className: "bwv-empty" }, "还没有音色。去「① 声音设计」造一个吧。");
      } else {
        body = voices.map(v => h("div", { key: v.id, className: "bwv-vcard" },
          h("div", { className: "bwv-meta" },
            h("div", { className: "bwv-name" },
              v.id, " ",
              h("span", { className: "bwv-tag" + (v.saved ? " bwv-saved" : "") },
                v.saved ? "已存盘" : "仅内存")),
            h("div", { className: "bwv-sub" },
              `${(v.seconds ?? 0).toFixed(2)}s · ${v.frames || "?"} 帧 · ${((v.ref_text || "").slice(0, 40)) || "（无转录）"}`)),
          h("button", {
            className: "bwv-ghost", disabled: playing === v.id,
            onClick: () => play(v),
          }, playing === v.id ? "生成中…" : "试听"),
          h("button", {
            className: "bwv-ghost bwv-danger", disabled: deleting === v.id,
            onClick: () => del(v),
          }, "移除")));
      }

      return h("div", null,
        h("div", { className: "bwv-row", style: { marginBottom: "16px" } },
          h("button", { className: "bwv-act", onClick: load }, "刷新列表"),
          h("span", { className: "bwv-hint" }, "保存的音色会写进 Breeze 的 voices 文件夹，重启不丢。")),
        body,
        h(Msg, { msg }));
    }

    // A-5（方案 §三-A5）：refreshAccessMode 提至 IIFE 顶层（原在 VoicePanel 体内）——
    // 「刷新列表」入口在 ListTab（IIFE 顶层组件）里，不提上去够不到；依赖仅 _apiFetch 与
    // WORKSHOP_ACCESS，均在 IIFE 顶层，搬运零风险。
    // ★ 2026-10-29 修（外部复核 P3，WORKSHOP_ACCESS 只在挂载时同步）：
    //   面板挂载 useEffect 依赖数组是 []，只在挂载时读一次 accessMode。
    //   AI 在后台改了 accessMode（direct↔proxy）之后，**已打开的面板不会跟随**，
    //   继续用旧通道 ⇒ 外网环境下表现为"突然全连不上"，很难查。
    //   ⇒ 不动那个 effect 的依赖（会引发重新拉取风暴），改成：
    //     **每次真正调工坊接口前静默刷一次 accessMode**，成本一次 GET。
    async function refreshAccessMode() { // A-5：function 声明形态（定义行含 name(，与 065 判据三计数口径一致）
      try {
        const r = await _apiFetch("/dsh-breeze-tts-api/config", { cache: "no-store" });
        if (!r.ok) return;
        const cfg = await r.json();
        if (cfg.accessMode === "proxy" || cfg.accessMode === "direct") WORKSHOP_ACCESS.mode = cfg.accessMode;
      } catch (_) { /* host 不可达：沿用上一次已知值 */ }
    }

    // FR-5（§6.4-④）：带 token 的完整 curl 示例（面板一键复制用；token 由服务端 configViewFor 决定是否下发）
    function buildTokenCurl(token) {
      const base = (typeof location !== "undefined" && location.origin && location.origin !== "null")
        ? location.origin : "http://127.0.0.1:3104";
      return 'curl -X PUT ' + base + '/dsh-breeze-tts-api/config -H "Authorization: Bearer ' + token +
        '" -H "Content-Type: application/json" -d "{\\"voice\\":\\"shaonv2\\"}"';
    }

    /* ================= 主面板（顶栏 + 三 tab） ================= */
    function VoicePanel(props) {
      const [tab, setTab] = react.useState("design");
      const [api, setApi] = react.useState(loadApi());
      const [apiDraft, setApiDraft] = react.useState(api);
      const [health, setHealth] = react.useState({ state: "checking", text: "检测中…" });
      const [adminToken, setAdminToken] = react.useState(null);
      const [legacyWarning, setLegacyWarning] = react.useState("");
      const [penetrated, setPenetrated] = react.useState(false); // FR-8：穿透模式警示条
      const [pairInfo, setPairInfo] = react.useState(null); // FR-8：现场配对码（本机生成）
      const [corruptNote, setCorruptNote] = react.useState(""); // 1.1.0 顺手项 7：配置损坏黄条

      react.useEffect(() => { injectStyle(); }, []);

      // FR-5/6/7/8：挂载时 GET /config —— host 为唯一权威源（人刷新页面即见 AI 改的值）；
      // 响应含 token 字段＝本机且未开逃生门（服务端 configViewFor 规则），据此显示管理 token 复制区；
      // accessMode 同步给工坊双通道；requireLocalToken=true 时面板顶部常驻穿透警示条。
      react.useEffect(() => {
        let alive = true;
          (async () => {
            try {
              await refreshAccessMode(); // A-5 入口①：切 tab 到工坊/挂载时刷 accessMode——WORKSHOP_ACCESS.mode 更新点收敛于此（方案"唯一更新点"）
              const r = await _apiFetch("/dsh-breeze-tts-api/config", { cache: "no-store" });
              if (!r.ok || !alive) {
              if (alive && r.status === 401) setPenetrated(true);
              return;
            }
            const cfg = await r.json();
            if (!alive) return;
            if (typeof cfg.endpoint === "string" && cfg.endpoint) { setApi(cfg.endpoint); setApiDraft(cfg.endpoint); }
            if (cfg.token) setAdminToken({ token: cfg.token });
            if (cfg.requireLocalToken === true) setPenetrated(true);
            if (cfg.configCorrupt) setCorruptNote("配置文件损坏，已按默认值运行，原文件已备份为 " + cfg.configCorrupt + "（可自行把值捡回来）");
          } catch (_) { /* host 不可达：localStorage 兜底已在用 */ }
        })();
        return () => { alive = false; };
      }, []);

      // FR-8：现场通道——生成 6 位配对码（pair/new；穿透模式下本机也要 token，401 走弹框兜底）
      const genPairCode = async () => {
        await refreshAccessMode(); // A-5 入口⑤：生成配对码（pair/new 也是工坊接口）前刷 accessMode
        setPairInfo({ state: "busy" });
        try {
          const r = await _apiFetch("/dsh-breeze-tts-api/pair/new", { method: "POST" });
          if (!r.ok) { setPairInfo({ state: "err", text: "生成失败（HTTP " + r.status + "）——穿透模式下请走文件通道：让 AI 往 config.json 写 pairCode。" }); return; }
          const j = await r.json();
          setPairInfo({ state: "ok", code: j.code, until: Date.now() + (j.expiresInSec || 300) * 1000 });
        } catch (e) {
          setPairInfo({ state: "err", text: "生成失败：" + (e && e.message) });
        }
      };
      react.useEffect(() => {
        if (!pairInfo || pairInfo.state !== "ok") return;
        const timer = setInterval(() => {
          setPairInfo((p) => (p && p.state === "ok" && p.until <= Date.now() ? { state: "err", text: "配对码已过期，重新生成一个即可。" } : p));
        }, 1000);
        return () => clearInterval(timer);
      }, [pairInfo]);

      // 方案 §四.8-4（已拍板：做）：检测原版插件仍安装 → 顶部警告（复用 detectUpstreamTts 的 loader 探测姿势）
      react.useEffect(() => {
        try {
          const loader = window.__ModuleLoader__;
          const names = [];
          const collect = (m) => { try { const id = m && (m.id || m.options?.name); if (id) names.push(id); } catch (_) {} };
          if (loader && typeof loader.entries === "function") Array.from(loader.entries()).forEach((e) => collect(e.options || e));
          if (window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.entries)) window.__DSH_BOOT__.entries.forEach((e) => collect(e));
          const legacy = names.filter((n) => n === "@dsh-external/dsh-plugin-local-ai-tts" || n === "dsh-breeze-voices");
          if (legacy.length) setLegacyWarning("检测到原版插件仍在安装（" + legacy.join("、") + "）——请先卸载，避免路由冲突（见 README 安装第 0 步）。");
        } catch (_) { /* 探测失败不打扰 */ }
      }, []);

      const checkHealth = react.useCallback(async (API) => {
        await refreshAccessMode(); // A-5 入口②：点测连接前静默刷 accessMode（提 IIFE 顶层后此处可达）
        setHealth({ state: "checking", text: "检测中…" });
        try {
          const j = await apiHealth(API);
          // ★ 2026-10-29 修（外部复核 P3）：health 不一定回 sample_rate（旧版/PyTorch 版就没有）
          //   ⇒ 原来直接除 1000，缺字段时显示 "NaN kHz"，看着像坏了。缺就不显示这一段。
          const khz = Number(j && j.sample_rate) > 0 ? " · " + (j.sample_rate / 1000) + " kHz" : "";
          setHealth({ state: "ok", text: "在线" + khz });
        } catch (_) {
          setHealth({ state: "bad", text: "连不上" });
        }
      }, []);

      react.useEffect(() => { checkHealth(api); }, [api, checkHealth]);

      const saveApiUrl = () => {
        const v = apiDraft.trim().replace(/\/+$/, "");
        setApiDraft(v);
        setApi(v);
        saveApi(v);
        refreshAccessMode(); // A-5 入口④：保存配置后静默刷 accessMode（fire-and-forget，不阻塞 UI）
      };

      const dotCls = "bwv-dot" + (health.state === "ok" ? " ok" : health.state === "bad" ? " bad" : "");
      const tabBtn = (id, label) => h("button", {
        className: tab === id ? "bwv-active" : "",
        onClick: () => setTab(id),
      }, label);

      return h("div", { className: "bwv-root" },
        corruptNote ? h("div", { className: "bwv-msg bwv-warn", style: { marginBottom: "12px" } }, corruptNote) : null,
        legacyWarning ? h("div", { className: "bwv-msg bwv-err", style: { marginBottom: "12px" } }, legacyWarning) : null,
        penetrated ? h("div", { className: "bwv-msg bwv-warn", style: { marginBottom: "12px" } },
          "穿透模式已开启（requireLocalToken=true）：所有操作需要凭据。本机首次使用请在「高级」区输入一次管理 token；新设备配对走文件通道（让 AI 往 config.json 写 pairCode）。") : null,
        h("div", { className: "bwv-header" },
          h("h1", { className: "bwv-title" }, "🎚 Breeze 音色工坊"),
          h("span", { className: "bwv-health" },
            h("span", { className: dotCls }), health.text),
          h("span", { className: "bwv-spacer" }),
          h("div", { className: "bwv-api" },
            h("span", null, "服务"),
            h("input", {
              type: "text", spellCheck: false, value: apiDraft,
              onChange: e => setApiDraft(e.target.value),
            }),
            h("button", { className: "bwv-ghost", style: { padding: "5px 10px" }, onClick: saveApiUrl }, "保存"))),
        h("div", { className: "bwv-nav" },
          tabBtn("design", "① 声音设计"),
          tabBtn("clone", "② 声音克隆"),
          tabBtn("list", "③ 已有音色")),
        h("div", { className: "bwv-section" },
          tab === "design" ? h(DesignTab, { key: api, api, onSaved: () => setTab("list") }) : null,
          tab === "clone" ? h(CloneTab, { key: api, api, onSaved: () => setTab("list") }) : null,
          tab === "list" ? h(ListTab, { key: api, api }) : null),
        // FR-5/8：「高级」折叠区——管理 token 复制（本机可见）＋现场配对码生成（FR-7 跨机接入用）
        adminToken || WORKSHOP_ACCESS.mode === "direct" ? h("details", { style: { marginTop: "14px" } },
          h("summary", { className: "bwv-hint", style: { cursor: "pointer" } }, "高级（管理 token · 配对码 · 仅本机可见）"),
          h("div", { className: "bwv-hint" },
            adminToken ? h("div", null,
              h("div", { style: { wordBreak: "break-all", fontFamily: "ui-monospace,monospace", marginTop: "6px" } }, adminToken.token),
              h("div", { className: "bwv-row", style: { marginTop: "8px" } },
                h("button", {
                  className: "bwv-ghost",
                  onClick: () => { try { navigator.clipboard.writeText(adminToken.token); } catch (_) {} },
                }, "复制 token"),
                h("span", { className: "bwv-hint" }, "远程 AI/设备用得上；本机 AI 走 config.json 不需要它")),
              h("div", { style: { wordBreak: "break-all", fontFamily: "ui-monospace,monospace", marginTop: "8px" } },
                buildTokenCurl(adminToken.token)),
              h("div", { className: "bwv-row", style: { marginTop: "6px" } },
                h("button", {
                  className: "bwv-ghost",
                  onClick: () => { try { navigator.clipboard.writeText(buildTokenCurl(adminToken.token)); } catch (_) {} },
                }, "复制完整 curl"))) : null,
            h("div", { className: "bwv-field", style: { marginTop: "12px" } },
              h("button", { className: "bwv-act", onClick: genPairCode }, "生成配对码（5 分钟有效）"),
              h("div", { className: "bwv-hint" }, "另一台设备弹框里输这个码即可接入（一次性；穿透模式下此按钮需 token，走文件通道更稳）"),
              pairInfo && pairInfo.state === "busy" ? h("div", { className: "bwv-msg bwv-info" }, "生成中…") : null,
              pairInfo && pairInfo.state === "ok" ? h("div", { className: "bwv-msg bwv-ok" },
                h("div", { style: { fontSize: "28px", fontWeight: "700", letterSpacing: "6px", fontFamily: "ui-monospace,monospace" } }, pairInfo.code),
                h("div", null, "有效期至 " + new Date(pairInfo.until).toLocaleTimeString() + "（一次性，用完即焚）")) : null,
              pairInfo && pairInfo.state === "err" ? h("div", { className: "bwv-msg bwv-err" }, pairInfo.text) : null))) : null);
    }

    return { VoicePanel, setApiFetch };
    })();

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
