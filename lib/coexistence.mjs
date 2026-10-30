// 上游两代名（abbccdd/dsh-localtts 改过名：旧名 v0.1.0–0.2.0，现名 v0.1.12-rc.5）
export const UPSTREAM_PACKAGES = ['@dsh-external/dsh-plugin-local-ai-tts', '@dsh-external/dsh-plugin-tts'];
// 自家前身（v1.0.0 合并前的 voices 私有包，仅自家机器装过；与上游分开，概念不混）
export const SELF_LEGACY_PACKAGES = ['dsh-breeze-voices'];

// Only inspect the public loader inventory. Never inspect or modify other
// plugins' config, route tables, contexts, credentials or implementation.
export function upstreamEnabled(ctx) {
  try {
    const loader = ctx.get('loader');
    if (typeof loader?.entries !== 'function') return false;
    return Array.from(loader.entries()).some(entry => UPSTREAM_PACKAGES.includes(entry.options?.name) &&
      entry.disabled !== true && entry.options?.disabled !== true);
  } catch { return false; }
}

export function installLegacyWhenStandalone(ctx, webServer, install) {
  ctx.effect(() => {
    let disposeLegacy = null, disposed = false;
    function reconcile() {
      if (disposed) return;
      if (upstreamEnabled(ctx)) { disposeLegacy?.(); disposeLegacy = null; return; }
      if (disposeLegacy) return;
      const cleanups = [];
      const once = fn => { let done = false; return () => { if (!done) { done = true; fn?.(); } }; };
      const cleanup = () => { for (const fn of cleanups.reverse()) { try { fn(); } catch {} } };
      const scopedServer = { register(route) {
        const off = once(webServer.register(route)); cleanups.push(off); return off;
      } };
      const scoped = {
        get: name => name === 'webServer' ? scopedServer : ctx.get(name),
        ...(typeof ctx.on === 'function' ? { on: (...args) => ctx.on(...args) } : {}),
        effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(once(off)); },
      };
      try { install(scoped); disposeLegacy = cleanup; }
      catch (e) { cleanup(); throw e; }
    }
    reconcile();
    // Inventory is populated before activation, so both initial load orders work.
    // Polling also handles enable/disable when internal/status is not exported.
    const timer = setInterval(() => {
      try { reconcile(); }
      catch { console.warn('[dsh-breeze-tts]', JSON.stringify({ status: 'error', error: 'LEGACY_ROUTE_REGISTRATION' })); }
    }, 1000); timer.unref?.();
    return () => { disposed = true; clearInterval(timer); disposeLegacy?.(); };
  }, 'local-ai-tts: standalone legacy providers');
}
