// verify-modes.mjs — FR-6/7/8 三档回归（方案 §六 14+5+10 条判据，除"声音对不对"外全自动化）
// 用法：node verify-modes.mjs <DSH基址> [跨机基址]
//   例（225 本机）  ：node verify-modes.mjs http://127.0.0.1:3104
//   例（FR-7 跨机） ：node verify-modes.mjs http://127.0.0.1:3104 http://<对端主机IP>:3104
// 前置：酒馆已装 dsh-breeze-tts 并重启；本机执行（FR-6/FR-8 的"本机"判据依赖 remoteAddress）。
// 纪律：每跑完一档，把开关恢复出厂（remoteAccess=false / requireLocalToken=false，改 config.json 后重启）再跑 FR-6 回归。
// ★ FA-1（验收 b436ef58 第九节）：本文件是 .mjs（ESM），没有 require —— 原先 87/102/120 三处用 require('fs')
//   会导致：87/120 被 try 吃掉静默跳过、102 无 try 直接崩 ⇒ F8-11/12 跑不到 且【恢复出厂不执行】
//   ⇒ requireLocalToken 残留 true ⇒ 装完机所有请求 401。改用 import。
// ★ FA-4（2026-10-29 12:3x 在 225 勘查发现）：配置路径不能靠 os.homedir() 猜。
//   Windows 上若 DSH 由计划任务以 **SYSTEM** 账户运行 ⇒ 服务进程里 homedir = C:\Windows\System32\config\systemprofile，
//   而人登录进来（普通账户）homedir = C:\Users\<用户名> ⇒ 读不到同一个 config.json ⇒ F8-5~11 静默跳过 = 假绿。
//   ⇒ 优先读环境变量 DSH_BREEZE_TTS_CFG；未设时才回落 homedir（并打印实际用的路径，别让它是隐形的）。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import os from 'node:os';

const BASE = process.argv[2] || 'http://127.0.0.1:3104';
const REMOTE = process.argv[3] || '';
const CFG_FILE = process.env.DSH_BREEZE_TTS_CFG || (os.homedir() + '/.dsh/dsh-breeze-tts/config.json');
const readTokenFromDisk = () => { try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')).token || ''; } catch (_) { return ''; } };
console.log('[cfg] ' + CFG_FILE + (process.env.DSH_BREEZE_TTS_CFG ? ' (from env DSH_BREEZE_TTS_CFG)' : ' (homedir guess)'));
if (!existsSync(CFG_FILE)) console.log('[cfg] NOT FOUND - if service runs as SYSTEM, set DSH_BREEZE_TTS_CFG');
let pass = 0, fail = 0;
const check = (id, name, cond, detail) => {
  if (cond) { pass++; console.log(`  [PASS] ${id} ${name}${detail ? ' ｜ ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${id} ${name}${detail ? ' ｜ ' + detail : ''}`); }
};
const j = async (url, opts) => { const r = await fetch(url, opts); let b = null; try { b = await r.json(); } catch (_) {} return { status: r.status, body: b }; };

async function main() {
  // ───── FR-6 回归（同机，两开关全默认）─────
  console.log('═══ FR-6 同机默认 ═══');
  {
    const cfg = await j(`${BASE}/dsh-breeze-tts-api/config`);
    check('F6-1', 'GET /config 200 且含 token', cfg.status === 200 && cfg.body && typeof cfg.body.token === 'string', cfg.status);
    const put = await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: 'shaonv2' }) });
    check('F6-2', 'PUT /config 本机无 token → 200', put.status === 200, put.status);
    const speak = await j(`${BASE}/dsh-breeze-tts-api/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '回归测试', provider: 'edge-tts' }) });
    check('F6-3', 'POST /speak 本机无 token → 非 401/403', speak.status !== 401 && speak.status !== 403, speak.status);
    const pair = await j(`${BASE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000' }) });
    check('F6-4', 'POST /pair 本机 → 业务错误（400/401），非 403', pair.status === 400 || pair.status === 401, pair.status);
    if (REMOTE) {
      const rcfg = await j(`${REMOTE}/dsh-breeze-tts-api/config`);
      check('F6-5', '跨机全部 → 403（remoteAccess=false）', rcfg.status === 403, rcfg.status);
    } else console.log('  （未给跨机基址，F6-5 跳过——FR-7 档会补）');
  }

  // ───── FR-7 回归（remoteAccess=true；跨机判据需 REMOTE）─────
  console.log('═══ FR-7 跨机（remoteAccess=true）═══');
  let fr7Token = '';
  {
    const open = await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remoteAccess: true }) });
    check('F7-0', '开启 remoteAccess（本机 PUT）', open.status === 200, open.status);
    if (!REMOTE) { console.log('  （未给跨机基址，FR-7 远程判据需在 224 上跑：node verify-modes.mjs http://225:3104 http://225:3104）'); }
    else {
      const rcfg = await j(`${REMOTE}/dsh-breeze-tts-api/config`);
      check('F7-1', 'GET /config 远程无 token → 200 且不含 token/pairCode', rcfg.status === 200 && rcfg.body && !('token' in rcfg.body) && !('pairCode' in rcfg.body));
      const rput = await j(`${REMOTE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      check('F7-2', 'PUT /config 远程无 token → 401', rput.status === 401, rput.status);
    }
    const pn = await j(`${BASE}/dsh-breeze-tts-api/pair/new`, { method: 'POST' });
    check('F7-3', 'POST /pair/new 壳本机 → 200 拿 6 位码', pn.status === 200 && pn.body && /^\d{6}$/.test(pn.body.code || ''), pn.status);
    if (REMOTE && pn.body && pn.body.code) {
      const code = pn.body.code;
      for (let i = 0; i < 5; i++) await j(`${REMOTE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '999999' }) });
      const reUse = await j(`${REMOTE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      check('F7-4', '错码 ×5 后原码作废（再用对码也 401）', reUse.status === 401, reUse.status);
      const pn2 = await j(`${BASE}/dsh-breeze-tts-api/pair/new`, { method: 'POST' });
      const good = await j(`${REMOTE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pn2.body && pn2.body.code }) });
      check('F7-5', 'POST /pair 远程对码 → 200 拿 token', good.status === 200 && good.body && good.body.token, good.status);
      fr7Token = (good.body && good.body.token) || '';
    }
    if (REMOTE && fr7Token) {
      const rput2 = await j(`${REMOTE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fr7Token }, body: JSON.stringify({ voice: 'shaonv2' }) });
      check('F7-6', 'PUT /config 远程带 token → 200', rput2.status === 200, rput2.status);
      const rv = await j(`${REMOTE}/dsh-breeze-tts-api/voices`, { headers: { Authorization: 'Bearer ' + fr7Token } });
      check('F7-7', 'GET /voices 远程带 token → 200', rv.status === 200, rv.status);
      const cw = await j(`${REMOTE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      check('F7-8', 'C 机无 token 任何写 → 401', cw.status === 401, cw.status);
    }
    console.log('  （F7-9 人测：配对→选音色→试听出声，唯一人工项；F7-10 文件通道：AI 写 config.json pairCode → POST /pair 兑换）');
  }
  // 恢复出厂：关 remoteAccess
  await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remoteAccess: false }) });

  // ───── FR-8 回归（requireLocalToken=true，穿透模式）─────
  console.log('═══ FR-8 穿透（requireLocalToken=true）═══');
  {
    const on = await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireLocalToken: true }) });
    check('F8-0', '开启逃生门（最后一次免 token 写）', on.status === 200, on.status);
    const c1 = await j(`${BASE}/dsh-breeze-tts-api/config`);
    check('F8-1', 'GET /config 本机无 token → 401', c1.status === 401, c1.status);
    const c2 = await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('F8-2', 'PUT /config 本机无 token → 401', c2.status === 401, c2.status);
    const sp = await j(`${BASE}/dsh-breeze-tts-api/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x', provider: 'edge-tts' }) });
    check('F8-3', 'POST /speak 本机无 token → 401', sp.status === 401, sp.status);
    const nt = await j(`${BASE}/dsh-breeze-tts-api/notify?s=0`);
    check('F8-4', 'GET /notify 本机无 token → 401', nt.status === 401, nt.status);
    // 从 config.json 读 token（穿透模式 API 不给，脚本走文件——部署机直接读）
    let token = readTokenFromDisk();
    if (!token) { console.log('  （拿不到 token，F8-5~9 跳过——在部署机上跑本脚本可自动读 config.json）'); }
    else {
      const auth = { Authorization: 'Bearer ' + token };
      const evil = await j(`${BASE}/dsh-breeze-tts-api/rvc-files?baseUrl=http://evil.com`, { headers: auth });
      check('F8-5', 'rvc-files 公网 baseUrl（带 token）→ 502（B2 堵）', evil.status === 502 || evil.status === 403, evil.status);
      const big = await j(`${BASE}/dsh-breeze-tts-api/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024), provider: 'edge-tts' }) });
      check('F8-6', 'POST /speak body=2MB → 413（B3 堵）', big.status === 413, big.status);
      const au = await j(`${BASE}/dsh-breeze-tts-audio/nonexistent`);
      check('F8-7a', '/audio 无 Authorization → 401（先于 404）', au.status === 401, au.status);
      const cfgT = await j(`${BASE}/dsh-breeze-tts-api/config`, { headers: auth });
      check('F8-8', 'GET /config 带 token → 200 但不含 token/pairCode', cfgT.status === 200 && cfgT.body && !('token' in cfgT.body) && !('pairCode' in cfgT.body));
      const pv = await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ voice: 'shaonv2' }) });
      check('F8-9', '带 token 全套 → 正常', pv.status === 200, pv.status);
      // F8-11 配对码文件通道 + 即焚
      // ★ 纪律（验收第九节"结果三"）：改部署机配置前先留原文，finally 必须还原——验收脚本不该裸改生产配置。
      let cfgBackup = '';
      try { cfgBackup = readFileSync(CFG_FILE, 'utf8'); } catch (_) {}
      try {
        const rawCfg = JSON.parse(cfgBackup || '{}');
        rawCfg.pairCode = '654321';
        writeFileSync(CFG_FILE, JSON.stringify(rawCfg, null, 2));
        const px = await j(`${BASE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '654321' }) });
        // ★ FA-2 后：/pair 从磁盘现读 ⇒ 写完不必重启即可兑换
        check('F8-11', '文件通道 pairCode 兑换 → 200 拿 token 且 config.json 字段已焚', px.status === 200 && px.body && px.body.token && !JSON.parse(readFileSync(CFG_FILE, 'utf8')).pairCode, px.status);
      } finally {
        if (cfgBackup) { try { writeFileSync(CFG_FILE, cfgBackup); } catch (_) {} }
      }
      // F8-12 爆破防护
      for (let i = 0; i < 5; i++) await j(`${BASE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '111111' }) });
      const locked = await j(`${BASE}/dsh-breeze-tts-api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '222222' }) });
      check('F8-12', '连错 3 次后配对接口锁（423）', locked.status === 423, locked.status);
    }
    // F8-13 /pair 豁免已由 F8-11 覆盖（无 token 兑换成功＝豁免成立）
    console.log('  （F8-10 界面警示条＝真机人测；F8-7b 带 Bearer /audio → 200 需先合成出真实 audio id，真机补）');
  }
  // 恢复出厂：关逃生门（改 config.json 文件——穿透下 API 也要 token，脚本直接读 token 再 PUT；失败提示人工）
  {
    const token = readTokenFromDisk();
    if (token) {
      const off = await j(`${BASE}/dsh-breeze-tts-api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ requireLocalToken: false }) });
      console.log(`  恢复出厂 requireLocalToken=false → ${off.status}（纪律：每档跑完必须恢复再跑 FR-6）`);
      // ★ FA-1：恢复失败必须显式喊出来，别静默 —— 残留 true 会让所有请求 401
      if (off.status !== 200) console.log('  ！！！ 恢复失败：请立刻人工改 config.json 把 requireLocalToken 改为 false，否则面板全 401');
    } else console.log('  ！未能自动恢复 requireLocalToken——请人工改 config.json 后重启');
  }

  console.log(`\n═══ verify-modes 结果：PASS ${pass} / FAIL ${fail} ═══`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
