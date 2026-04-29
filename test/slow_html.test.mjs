// Vanilla Node test runner for SLOW.html. No NPM dependencies — just `node`.
// Reads SLOW.html, extracts the inline IIFE body, evaluates it in a sandboxed
// Function with stubbed browser globals, and exercises the deterministic helpers
// (keccak256, namehash, ABI codec, parse/formatUnits, decodeId, fmtTime, etc.)
// against canonical vectors.
//
// Run:  node test/slow_html.test.mjs
//
// SLOW.html is not modified by this runner. The IIFE wrapper is rewritten only
// in memory: `(()=>{...})()` becomes `(()=>{...; return {...}; })()`.

import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '..', 'SLOW.html');
const html = await fs.readFile(htmlPath, 'utf8');

// ─── Extract the IIFE body ────────────────────────────────────────────────
const re = /<script>\s*\(\(\)\s*=>\s*\{([\s\S]*?)\}\)\(\);?\s*<\/script>/;
const m = html.match(re);
if (!m) {
  console.error('FATAL: could not locate IIFE in SLOW.html');
  process.exit(2);
}
const body = m[1];

// ─── Browser-global stubs (recording proxy; preserves writes) ──────────────
// `makeEl()` returns a Proxy that:
//   - stores property writes (so `el.sendBox.onclick = fn` then reads back as fn)
//   - implements a real classList that backs assertions
//   - implements addEventListener/removeEventListener with per-type handler arrays
//   - exposes __listeners as a test affordance
//   - returns a fresh child Proxy for any unknown property access
function makeEl() {
  const store = {};
  const set = new Set();
  const classList = {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: (c, force) => {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) { set.add(c); return true; }
      set.delete(c); return false;
    },
  };
  const dataset = {};
  const style = {};
  const listeners = {};
  const children = [];
  return new Proxy(function () {}, {
    get(_t, p) {
      if (p === 'classList') return classList;
      if (p === 'dataset') return dataset;
      if (p === 'style') return style;
      if (p === 'addEventListener')
        return (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
      if (p === 'removeEventListener')
        return (type, fn) => {
          const a = listeners[type]; if (!a) return;
          const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
        };
      if (p === '__listeners') return listeners;
      if (p === '__children') return children;
      if (p === 'querySelector') return () => makeEl();
      if (p === 'querySelectorAll') return () => [];
      if (p === 'appendChild') return c => { children.push(c); return c; };
      if (p === 'firstChild') return store.firstChild ?? {nodeValue: ''};
      if (p === 'value' || p === 'textContent' || p === 'innerHTML')
        return store[p] ?? '';
      if (p in store) return store[p];
      // unknown property: hand out a fresh child proxy so chained access doesn't throw
      return store[p] = makeEl();
    },
    set(_t, p, v) { store[p] = v; return true; },
    apply() { return makeEl(); },
  });
}
const proxyEl = makeEl();

// window.ethereum proxies to a public mainnet RPC so the dapp's resolution
// helpers (ensResolve / ensReverse / wnsResolve / wnsReverse) hit real
// registries when we exercise them at the bottom of this file. Deterministic
// helpers above never call window.ethereum, so they remain offline.
const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';
function mainnetRpc(method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(MAINNET_RPC);
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method, params: params || []});
    const req = https.request({
      host: url.hostname, port: 443, path: url.pathname,
      method: 'POST',
      headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)},
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(`${method}: ${j.error.message}`));
          else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
globalThis.window = {
  ethereum: {request: ({method, params}) => mainnetRpc(method, params), on() {}},
  open() {},
  addEventListener() {},
};
// getElementById returns a per-id element so each named handle (sendBox,
// confirmBtn, etc.) has its own backing store.
const elementsById = {};
const htmlIds = [...new Set([...html.matchAll(/\bid="([A-Za-z]\w*)"/g)].map(m => m[1]))];
const getEl = (id) => {
  const e = elementsById[id] = elementsById[id] || makeEl();
  e.id = id;
  return e;
};
globalThis.document = {
  body: {classList: {toggle: () => false, contains: () => false}},
  getElementById: getEl,
  querySelector: () => null,
  querySelectorAll: (sel) => sel === '[id]' ? htmlIds.map(getEl) : [],
  createElement: () => makeEl(),
  addEventListener: () => {},
};

// ─── Compile + capture exports ─────────────────────────────────────────────
const captured = {};
globalThis.__capture = captured;
const exposed = body + `
;Object.assign(globalThis.__capture, {
  SEL, SLOW, ZERO, ENS_REG, WNS, S, el,
  keccak256, namehash, encode, decode, cd,
  parseUnits, formatUnits, fmtNum, fmtTime, fmtCustomTime, decodeId,
  isAddr, shortAddr,
  ensResolve, ensReverse, wnsResolve, wnsReverse, resolveName, reverseAny,
  resolveRecipient,
  disconnect, setView, resetForm, ensureMainnet,
  handleConfirm,
});`;
new Function(exposed)();
const {SEL, SLOW, ZERO, ENS_REG, WNS, S, el,
  keccak256, namehash, encode, decode, cd,
  parseUnits, formatUnits, fmtNum, fmtTime, fmtCustomTime, decodeId,
  isAddr, shortAddr,
  ensResolve, ensReverse, wnsResolve, wnsReverse, resolveName, reverseAny,
  resolveRecipient,
  disconnect, setView, resetForm, ensureMainnet,
  handleConfirm} = captured;

// ─── Tiny test runner ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, msg) {
  const ok = (typeof actual === 'bigint' && typeof expected === 'bigint')
    ? actual === expected
    : actual === expected;
  if (ok) { pass++; }
  else {
    fail++;
    failures.push(`  ${msg}\n    got:    ${actual}\n    expect: ${expected}`);
  }
}
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; failures.push(`  ${msg}\n    got: ${cond}`); }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

// ─── SEL parity: every selector in SLOW.html must match keccak256(signature)[:10]
// This closes the gap between "the keccak256 function works" and "the SEL constants
// were typed correctly." If anyone hand-edits SEL.depositTo to a wrong selector,
// every dapp deposit silently fails — this test catches that at build time.
const sigs = {
  depositTo: 'depositTo(address,address,uint256,uint96,bytes)',
  reverse: 'reverse(uint256)',
  claim: 'claim(uint256)',
  clawback: 'clawback(uint256)',
  withdrawFrom: 'withdrawFrom(address,address,uint256,uint256)',
  multicall: 'multicall(bytes[])',
  pendingTransfers: 'pendingTransfers(uint256)',
  getOut: 'getOutboundTransfers(address)',
  getIn: 'getInboundTransfers(address)',
  guardians: 'guardians(address)',
  isWithdrawalApprovalNeeded: 'isWithdrawalApprovalNeeded(address,address,uint256,uint256)',
  unlock: 'unlock(uint256)',
  approve: 'approve(address,uint256)',
  allowance: 'allowance(address,address)',
  decimals: 'decimals()',
  symbol: 'symbol()',
  resolver: 'resolver(bytes32)',
  addr: 'addr(bytes32)',
  ensName: 'name(bytes32)',
  wnsReverse: 'reverseResolve(address)',
  depositToWithTip: 'depositToWithTip(address,address,uint256,uint96,uint256,bytes)',
  tips: 'tips(uint256)',
  refundTip: 'refundTip(uint256)',
  gateAddr: 'gate()',
};
for (const [key, sig] of Object.entries(sigs)) {
  eq(SEL[key], keccak256(sig).slice(0, 10), `SEL.${key} == selector("${sig}")`);
}
ok(Object.keys(SEL).length === Object.keys(sigs).length,
  `every SEL key has a canonical signature (got ${Object.keys(SEL).length}, want ${Object.keys(sigs).length})`);

// Hardcoded constant sanity
eq(SLOW.toLowerCase(), '0x000000000000888741b254d37e1b27128afeaabc', 'SLOW deployment address');
eq(ZERO, '0x0000000000000000000000000000000000000000', 'ZERO sentinel');
eq(ENS_REG, '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', 'ENS registry mainnet address');
eq(WNS, '0x0000000000696760E15f265e828DB644A0c242EB', 'WNS (wei.domains) mainnet address');

// keccak256 — vectors crosschecked with `cast keccak`
eq(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256("")');
eq(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', 'keccak256("abc")');
eq(keccak256('transfer(address,uint256)').slice(0, 10), '0xa9059cbb', 'transfer(address,uint256) selector');
eq(keccak256('depositTo(address,address,uint256,uint96,bytes)').slice(0, 10), '0x94eeaec9', 'depositTo selector');
eq(keccak256('unlock(uint256)').slice(0, 10), '0x6198e339', 'unlock selector');
eq(keccak256('reverse(uint256)').slice(0, 10), '0x97d15425', 'reverse selector');
eq(keccak256('claim(uint256)').slice(0, 10), '0x379607f5', 'claim selector');

// namehash — vectors from ENSIP-1
eq(namehash(''), '0x0000000000000000000000000000000000000000000000000000000000000000', 'namehash empty');
eq(namehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae', 'namehash("eth")');
eq(namehash('foo.eth'), '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f', 'namehash("foo.eth")');

// ABI encode (canonical)
eq('0x' + encode(['uint256'], [0x42n]),
  '0x0000000000000000000000000000000000000000000000000000000000000042',
  'encode uint256(0x42)');
eq('0x' + encode(['address'], ['0x1234567890123456789012345678901234567890']),
  '0x0000000000000000000000001234567890123456789012345678901234567890',
  'encode address');
// Note: encode lowercases addresses via BigInt round-trip; EVM treats calldata as case-insensitive.
eq('0x' + encode(['uint256','address'], [1n, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']),
  '0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  'encode (uint256, address)');

// ABI decode round-trips
eq(decode(['uint256'], '0x000000000000000000000000000000000000000000000000000000000000007b')[0], 123n, 'decode uint256');
eq(decode(['address'], '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')[0].toLowerCase(),
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'decode address');

// cd: function selector + encoded args (matches `abi.encodeWithSelector`)
eq(cd('0x6198e339', ['uint256'], [42n]),
  '0x6198e339000000000000000000000000000000000000000000000000000000000000002a',
  'cd unlock(42)');
eq(cd('0xd4fdc309', ['address','address','uint256','uint256'], [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    1n, 100n,
  ]),
  '0xd4fdc309000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000064',
  'cd withdrawFrom');

// parseUnits / formatUnits
eq(parseUnits('1', 18), 10n ** 18n, 'parseUnits("1", 18)');
eq(parseUnits('1.5', 18), 1500000000000000000n, 'parseUnits("1.5", 18)');
eq(parseUnits('0.000001', 6), 1n, 'parseUnits("0.000001", 6)');
eq(parseUnits('1.234567', 6), 1234567n, 'parseUnits("1.234567", 6)');
eq(parseUnits('0', 18), 0n, 'parseUnits("0", 18)');
eq(formatUnits(10n ** 18n, 18), '1', 'formatUnits 1e18');
eq(formatUnits(1500000000000000000n, 18), '1.5', 'formatUnits 1.5e18');
eq(formatUnits(1234567n, 6), '1.234567', 'formatUnits 6-dec');
eq(formatUnits(0n, 18), '0', 'formatUnits 0');

// Round-trip
eq(formatUnits(parseUnits('123.456789', 18), 18), '123.456789', 'parse/format roundtrip');

// decodeId — token in lower 160 bits, delay in upper 96 bits
const dai = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const idDay = (BigInt(dai)) | (86400n << 160n);
{
  const r = decodeId(idDay);
  eq(r.token.toLowerCase(), dai.toLowerCase(), 'decodeId DAI token');
  eq(r.delay, 86400, 'decodeId DAI delay');
}
{
  // Pure ETH id (token zero, delay 0)
  const r = decodeId(0n);
  eq(r.token, '0x0000000000000000000000000000000000000000', 'decodeId zero -> ETH');
  eq(r.delay, 0, 'decodeId zero -> 0 delay');
}
{
  // Max uint96 delay
  const id = (1n << 160n) - 1n | (((1n << 96n) - 1n) << 160n);
  const r = decodeId(id);
  eq(r.delay, Number((1n << 96n) - 1n), 'decodeId max uint96 delay');
}

// fmtTime
eq(fmtTime(0), '0s', 'fmtTime(0)');
eq(fmtTime(60), '1m', 'fmtTime(60)');
eq(fmtTime(3600), '1h 0m', 'fmtTime(3600)');
eq(fmtTime(86400), '1d 0h 0m', 'fmtTime(86400)');
eq(fmtTime(3661), '1h 1m', 'fmtTime(3661 — sec dropped when h present)');
eq(fmtTime(45), '45s', 'fmtTime(45)');

// isAddr / shortAddr
ok(isAddr('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), 'isAddr valid checksum');
ok(isAddr('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), 'isAddr lowercase');
ok(!isAddr('not-an-address'), 'isAddr garbage');
ok(!isAddr('0x123'), 'isAddr too short');
ok(!isAddr(''), 'isAddr empty');
eq(shortAddr('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), '0xA0b8...eB48', 'shortAddr');

// ─── Network resolution tests ──────────────────────────────────────────────
// Hits the live ENS registry and the WNS contract on Ethereum mainnet via the
// public RPC defined above. The reference identity is z0r0z.eth / ross.wei,
// both pointing at 0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20. If either name
// service moves or the address binding changes, these tests will tell you.
//
// These exercise: the dapp's namehash math against real registries, the WNS
// contract address, the `reverseResolve(address)` selector wiring, the TLD
// dispatcher (`.wei` → WNS, else → ENS), and reverse-priority (WNS first,
// then ENS).
console.log('Network resolution tests against mainnet RPC...');
const REF_ADDR = '0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20';
const REF_LOW = REF_ADDR.toLowerCase();

try {
  // WNS forward
  const wf = await wnsResolve('ross.wei');
  eq(wf?.toLowerCase(), REF_LOW, 'wnsResolve("ross.wei") -> ref address');

  // WNS reverse
  const wr = await wnsReverse(REF_ADDR);
  eq(wr, 'ross.wei', 'wnsReverse(ref) -> "ross.wei"');

  // ENS forward
  const ef = await ensResolve('z0r0z.eth');
  eq(ef?.toLowerCase(), REF_LOW, 'ensResolve("z0r0z.eth") -> ref address');

  // ENS reverse — verifies forward roundtrip per ENSIP-3
  const er = await ensReverse(REF_ADDR);
  eq(er, 'z0r0z.eth', 'ensReverse(ref) -> "z0r0z.eth"');

  // Dispatcher: .wei goes to WNS
  const rWei = await resolveName('ross.wei');
  eq(rWei?.toLowerCase(), REF_LOW, 'resolveName("ross.wei") routes via WNS');

  // Dispatcher: .eth goes to ENS
  const rEth = await resolveName('z0r0z.eth');
  eq(rEth?.toLowerCase(), REF_LOW, 'resolveName("z0r0z.eth") routes via ENS');

  // Reverse priority: tries WNS first (returns "ross.wei" without falling through to ENS)
  const ra = await reverseAny(REF_ADDR);
  eq(ra, 'ross.wei', 'reverseAny(ref) prefers WNS -> "ross.wei"');

  // Negative: a name that doesn't exist returns null cleanly (no throw)
  const miss = await wnsResolve('definitelynotaname-xyz123.wei');
  ok(miss === null, 'wnsResolve(unknown name) returns null');

  // ─── resolveRecipient — input validation pipeline ────────────────────────
  // The dapp's submit-button path runs every recipient input through this.
  // It dispatches address vs ENS vs WNS vs garbage and stamps S.resolved.
  //
  // The function reads `el.recipientInput.value` for a stale-input race check.
  // The recording proxy preserves writes, so we just set the value directly.

  // ENS name (z0r0z.eth) → resolves via ENS path
  el.recipientInput.value = 'z0r0z.eth';
  ok(await resolveRecipient('z0r0z.eth'), 'resolveRecipient: z0r0z.eth resolves');
  eq(S.resolved?.toLowerCase(), REF_LOW, 'resolveRecipient: ENS path → S.resolved');

  // WNS name (ross.wei) → resolves via WNS path
  el.recipientInput.value = 'ross.wei';
  ok(await resolveRecipient('ross.wei'), 'resolveRecipient: ross.wei resolves');
  eq(S.resolved?.toLowerCase(), REF_LOW, 'resolveRecipient: WNS path → S.resolved');

  // Plain address → kept as-is, S.resolved set
  el.recipientInput.value = REF_ADDR;
  ok(await resolveRecipient(REF_ADDR), 'resolveRecipient: address accepted');
  eq(S.resolved?.toLowerCase(), REF_LOW, 'resolveRecipient: address path → S.resolved');

  // Garbage (no dot, not address) → rejected
  el.recipientInput.value = 'garbage';
  ok(!await resolveRecipient('garbage'), 'resolveRecipient: garbage rejected');

  // Non-existent name → rejected (network call returns null, function reports failure)
  el.recipientInput.value = 'definitelynotaname-xyz123.eth';
  ok(!await resolveRecipient('definitelynotaname-xyz123.eth'),
    'resolveRecipient: unknown ENS rejected without throwing');
} catch (e) {
  fail++;
  failures.push(`  network resolution tests aborted: ${e.message}`);
}

// ─── fmtNum / fmtCustomTime — pure helpers, no network ─────────────────────
eq(fmtNum(1), '1', 'fmtNum integer');
eq(fmtNum(0), '0', 'fmtNum zero');
eq(fmtNum(1.5), '1.50', 'fmtNum 1.5 → minimum 2 fraction digits');
eq(fmtNum(0.123456), '0.123456', 'fmtNum 6-decimal');
eq(fmtNum('not a number'), 'not a number', 'fmtNum NaN passthrough');

eq(fmtCustomTime({d:0,h:0,m:0,s:0}).seconds, 0, 'fmtCustomTime zero seconds');
eq(fmtCustomTime({d:0,h:0,m:0,s:0}).display, '0S', 'fmtCustomTime zero display');
eq(fmtCustomTime({d:1,h:0,m:0,s:0}).seconds, 86400, 'fmtCustomTime 1 day seconds');
eq(fmtCustomTime({d:1,h:0,m:0,s:0}).display, '1D', 'fmtCustomTime 1 day display');
eq(fmtCustomTime({d:1,h:2,m:3,s:4}).seconds, 93784, 'fmtCustomTime mixed seconds');
eq(fmtCustomTime({d:1,h:2,m:3,s:4}).display, '1D 2H 3M 4S', 'fmtCustomTime mixed display');
eq(fmtCustomTime({d:'',h:'',m:'5',s:''}).seconds, 300, 'fmtCustomTime string-empty fields');
eq(fmtCustomTime({d:'',h:'',m:'5',s:''}).display, '5M', 'fmtCustomTime string-empty display');

// ─── State machine: setView / resetForm / disconnect ───────────────────────
// Pure JS state transitions — no chain, no DOM contracts beyond the proxy.

// Seed some state to verify it gets cleared.
S.token = '0xtoken';
S.symbol = 'TST';
S.amount = 5;
S.delay = 60;
S.delayDisplay = '1 MIN';
S.resolved = '0xabc';
S.resolving = true;
S.step = 2;

resetForm();
eq(S.token, null, 'resetForm clears S.token');
eq(S.symbol, null, 'resetForm clears S.symbol');
eq(S.amount, null, 'resetForm clears S.amount');
eq(S.delay, null, 'resetForm clears S.delay');
eq(S.delayDisplay, null, 'resetForm clears S.delayDisplay');
eq(S.resolved, null, 'resetForm clears S.resolved');
eq(S.resolving, false, 'resetForm clears S.resolving');
eq(S.step, 0, 'resetForm resets S.step');

// setView transitions: home → send (set), send again (toggles back to home)
S.view = 'home';
setView('send');
eq(S.view, 'send', 'setView("send") from home → send');
setView('send');
eq(S.view, 'home', 'setView("send") from send → toggles back to home');
setView('take');
eq(S.view, 'take', 'setView("take") from home → take');
setView('home');
eq(S.view, 'home', 'setView("home") explicit → home');

// disconnect — clears wallet identity + transfer lists.
S.account = '0xdeadbeef';
S.ensName = 'someone.eth';
S.out = [{id: '1'}];
S.inb = [{id: '2'}];
disconnect();
eq(S.account, null, 'disconnect clears S.account');
eq(S.ensName, null, 'disconnect clears S.ensName');
ok(Array.isArray(S.out) && S.out.length === 0, 'disconnect clears S.out');
ok(Array.isArray(S.inb) && S.inb.length === 0, 'disconnect clears S.inb');

// ─── ensureMainnet — chain-id check + switch fallback ──────────────────────
// Override window.ethereum.request just for these tests so we can drive each
// branch deterministically without spawning anvil.
const realRequest = window.ethereum.request;
function mockEthereum({chainId, switchOk}) {
  let switchCalled = 0;
  window.ethereum.request = async ({method}) => {
    if (method === 'eth_chainId') return chainId;
    if (method === 'wallet_switchEthereumChain') {
      switchCalled++;
      if (switchOk) return null;
      throw new Error('user rejected');
    }
    throw new Error(`unexpected method ${method}`);
  };
  return () => switchCalled;
}

// Already on mainnet → returns true without trying to switch.
{
  const calls = mockEthereum({chainId: '0x1', switchOk: true});
  ok(await ensureMainnet() === true, 'ensureMainnet on chainId 1 returns true');
  ok(calls() === 0, 'ensureMainnet on chainId 1 does NOT call wallet_switchEthereumChain');
}

// Off mainnet, switch succeeds → returns true.
{
  const calls = mockEthereum({chainId: '0x89', switchOk: true});
  ok(await ensureMainnet() === true, 'ensureMainnet off-chain + switch ok → true');
  ok(calls() === 1, 'ensureMainnet off-chain calls wallet_switchEthereumChain');
}

// Off mainnet, switch rejected → returns false.
{
  const calls = mockEthereum({chainId: '0x89', switchOk: false});
  ok(await ensureMainnet() === false, 'ensureMainnet off-chain + switch rejected → false');
  ok(calls() === 1, 'ensureMainnet off-chain attempted the switch even when rejected');
}

// Restore the real provider so any later code in this file (none currently) still works.
window.ethereum.request = realRequest;

// ─── Click handler wiring ──────────────────────────────────────────────────
// The IIFE binds onclick / addEventListener to the captured `el` map. With the
// recording proxy, those bindings are introspectable. This section verifies
// every load-bearing button has a handler and that the load-bearing ones do
// the right thing when invoked.

// Submit button must be wired to handleConfirm exactly. A regression here
// (e.g. someone wires it to a different function) would cause the deposit
// flow to silently misbehave.
ok(el.confirmBtn.onclick === handleConfirm,
  'confirmBtn.onclick === handleConfirm');

// Smoke check: every primary button has a click handler bound.
ok(typeof el.themeBtn.onclick === 'function', 'themeBtn click handler bound');
ok(typeof el.walletBtn.onclick === 'function', 'walletBtn click handler bound');
ok(typeof el.sendBox.onclick === 'function', 'sendBox click handler bound');
ok(typeof el.takeBox.onclick === 'function', 'takeBox click handler bound');
ok(typeof el.amountApply.onclick === 'function', 'amountApply click handler bound');
ok(typeof el.timeApply.onclick === 'function', 'timeApply click handler bound');
ok(typeof el.approveBtn.onclick === 'function', 'approveBtn click handler bound');

// addEventListener bindings — the dapp uses these for delegated clicks +
// recipient input debounce.
ok(Array.isArray(el.cryptoGrid.__listeners.click) && el.cryptoGrid.__listeners.click.length >= 1,
  'cryptoGrid has click delegate');
ok(Array.isArray(el.amountRow.__listeners.click) && el.amountRow.__listeners.click.length >= 1,
  'amountRow has click delegate');
ok(Array.isArray(el.timeRow.__listeners.click) && el.timeRow.__listeners.click.length >= 1,
  'timeRow has click delegate');
ok(Array.isArray(el.tabs.__listeners.click) && el.tabs.__listeners.click.length >= 1,
  'tabs has click delegate');
ok(Array.isArray(el.recipientInput.__listeners.input)
   && el.recipientInput.__listeners.input.length >= 1,
  'recipientInput has input listener (ENS debounce)');
ok(Array.isArray(el.recipientInput.__listeners.keydown)
   && el.recipientInput.__listeners.keydown.length >= 1,
  'recipientInput has keydown listener (Enter to submit)');

// sendBox.onclick toggles S.view between home and send (via setView semantics).
S.view = 'home';
el.sendBox.onclick();
eq(S.view, 'send', 'sendBox click from home → S.view = send');
el.sendBox.onclick();
eq(S.view, 'home', 'sendBox click again → S.view toggles back to home');

// amountApply with valid input sets S.amount; with zero/negative it doesn't.
S.amount = null;
el.amountInput.value = '0';
el.amountApply.onclick();
eq(S.amount, null, 'amountApply rejects 0 (S.amount stays null)');
el.amountInput.value = '-1';
el.amountApply.onclick();
eq(S.amount, null, 'amountApply rejects negative (S.amount stays null)');
el.amountInput.value = '1.5';
el.amountApply.onclick();
eq(S.amount, 1.5, 'amountApply accepts 1.5');
el.amountInput.value = 'abc';
S.amount = null;
el.amountApply.onclick();
eq(S.amount, null, 'amountApply rejects non-numeric');

// timeApply with all-zero is rejected; valid values land in S.delay.
S.delay = null;
el.dInput.value = '0'; el.hInput.value = '0';
el.mInput.value = '0'; el.sInput.value = '0';
el.timeApply.onclick();
eq(S.delay, null, 'timeApply rejects all-zero');
el.dInput.value = '1'; el.hInput.value = '0';
el.mInput.value = '0'; el.sInput.value = '0';
el.timeApply.onclick();
eq(S.delay, 86400, 'timeApply with 1 day → 86400 seconds');
el.dInput.value = '0'; el.hInput.value = '1';
el.mInput.value = '30'; el.sInput.value = '0';
el.timeApply.onclick();
eq(S.delay, 5400, 'timeApply with 1h30m → 5400 seconds');

// Tab switch: clicking a tab updates S.tab.
S.tab = 'outbound';
const tabHandler = el.tabs.__listeners.click[0];
tabHandler({target: {closest: () => ({dataset: {tab: 'inbound'}, classList: {toggle(){}}})}});
eq(S.tab, 'inbound', 'tab click → S.tab = inbound');

// ─── Report ────────────────────────────────────────────────────────────────
if (fail === 0) {
  console.log(`OK: ${pass} tests passed`);
  process.exit(0);
} else {
  console.error(`FAIL: ${fail}/${pass + fail} failed\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
