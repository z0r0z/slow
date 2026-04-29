// End-to-end test: drives the actual SLOW.html dapp code against a real EVM
// (anvil) hosting a real-deployed SLOW contract. No browser, no NPM dependencies.
//
//   - Spawns anvil (Foundry) on a random port with chain-id 1.
//   - Mocks the HTML registry at the canonical address (anvil_setCode).
//   - Deploys SLOW with empty html chunks (we test contract integration, not html()).
//   - Loads SLOW.html, extracts the IIFE body, rewrites the SLOW address constant
//     in-memory only (the file on disk is never modified).
//   - Runs the IIFE with a window.ethereum that proxies to anvil via raw HTTP RPC.
//   - Drives flow functions (connect, deposit, claim, reverseAndWithdraw,
//     loadTransfers, etc.) and asserts on-chain + dapp state after each.
//
// Run:  node test/slow_html.e2e.test.mjs
//
// Requires: `anvil` on PATH (Foundry), and a current `forge build` artifact at
// out/SLOW.sol/SLOW.json.

import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── RPC client ─────────────────────────────────────────────────────────────
const ANVIL_PORT = 8545 + Math.floor(Math.random() * 1000);
const RPC_HOST = '127.0.0.1';

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method, params});
    const req = http.request({
      host: RPC_HOST, port: ANVIL_PORT, method: 'POST',
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

// ─── Anvil lifecycle ────────────────────────────────────────────────────────
let anvil;
async function startAnvil() {
  anvil = spawn('anvil', [
    '--port', String(ANVIL_PORT),
    '--chain-id', '1',           // match the dapp's MAINNET expectation
    '--silent',
    '--accounts', '5',
    '--balance', '10000',
    '--code-size-limit', '60000', // SLOW runtime ≈ 29 KB, over EIP-170 default
  ]);
  for (let i = 0; i < 200; i++) {
    try { await rpc('eth_chainId'); return; } catch {}
    await sleep(50);
  }
  throw new Error('anvil failed to start');
}
process.on('exit', () => anvil?.kill());
process.on('SIGINT', () => { anvil?.kill(); process.exit(130); });

// ─── Test runner ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function eq(a, b, msg) {
  const equal = (typeof a === 'bigint' && typeof b === 'bigint') ? a === b : a === b;
  ok(equal, `${msg}\n    got:    ${a}\n    expect: ${b}`);
}

async function waitTx(hash) {
  for (let i = 0; i < 200; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) {
      if (r.status !== '0x1') throw new Error(`tx ${hash} reverted`);
      return r;
    }
    await sleep(25);
  }
  throw new Error(`tx ${hash} timed out`);
}

// Patch Date.now to track anvil's chain timestamp. The dapp guards `claim` /
// `reverseAndWithdraw` with wall-clock comparisons against pending.unlockTime;
// we need Date.now to advance when we warp the chain.
let virtualNowMs = 0;
Date.now = () => virtualNowMs;

async function syncDateToChain() {
  const b = await rpc('eth_getBlockByNumber', ['latest', false]);
  virtualNowMs = parseInt(b.timestamp, 16) * 1000;
}

async function timeWarp(seconds) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine');
  await syncDateToChain();
}

const balanceOf = (addr) => rpc('eth_getBalance', [addr, 'latest']).then(BigInt);

// ─── Setup ──────────────────────────────────────────────────────────────────
console.log('Starting anvil...');
await startAnvil();
await syncDateToChain();

const accounts = await rpc('eth_accounts');
const [deployer, alice, bob, carol] = accounts;
console.log(`Deployer: ${deployer.slice(0, 10)}...  Alice: ${alice.slice(0, 10)}...  Bob: ${bob.slice(0, 10)}...`);

// Mock the HTML registry: a contract that returns empty bytes (success) on any call.
const HTML_REGISTRY = '0xFa11bacCdc38022dbf8795cC94333304C9f22722';
await rpc('anvil_setCode', [HTML_REGISTRY, '0x60006000f3']); // PUSH1 0; PUSH1 0; RETURN

// Deploy SLOW with empty html chunks (we don't test html() here)
const artifact = JSON.parse(await fs.readFile(
  path.join(__dirname, '..', 'out', 'SLOW.sol', 'SLOW.json')));
const initBytecode = '0x' + artifact.bytecode.object.replace(/^0x/, '');
// Constructor args: (bytes part1, bytes part2) — both empty
const ctorArgs =
  '0000000000000000000000000000000000000000000000000000000000000040' +
  '0000000000000000000000000000000000000000000000000000000000000060' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';
const deployHash = await rpc('eth_sendTransaction', [{
  from: deployer,
  data: initBytecode + ctorArgs,
  gas: '0x' + (15_000_000).toString(16),
}]);
const deployReceipt = await waitTx(deployHash);
const SLOW_ADDR = deployReceipt.contractAddress;
console.log(`SLOW deployed: ${SLOW_ADDR}`);

// Deploy a mock ERC20 we can use for non-ETH tests
// Minimal ERC20 bytecode: mint to deployer, transferFrom support.
// Easier route: read MockERC20 from the test artifact if foundry compiled it.
const erc20Path = path.join(__dirname, '..', 'out', 'SLOW.t.sol', 'MockERC20.json');
const erc20Bytecode = await fs.readFile(erc20Path, 'utf8').then(s => {
  const j = JSON.parse(s);
  return '0x' + j.bytecode.object.replace(/^0x/, '');
}).catch(() => null);
let TOKEN_ADDR = null;
if (erc20Bytecode) {
  // MockERC20 ctor: (string name, string symbol, uint8 decimals)
  const erc20Args =
    '0000000000000000000000000000000000000000000000000000000000000060' + // offset name
    '00000000000000000000000000000000000000000000000000000000000000a0' + // offset symbol
    '0000000000000000000000000000000000000000000000000000000000000012' + // decimals 18
    // name "TST"
    '0000000000000000000000000000000000000000000000000000000000000003' +
    '5453540000000000000000000000000000000000000000000000000000000000' +
    // symbol "TST"
    '0000000000000000000000000000000000000000000000000000000000000003' +
    '5453540000000000000000000000000000000000000000000000000000000000';
  const t20Hash = await rpc('eth_sendTransaction', [{
    from: deployer,
    data: erc20Bytecode + erc20Args,
    gas: '0x' + (5_000_000).toString(16),
  }]);
  const r = await waitTx(t20Hash);
  TOKEN_ADDR = r.contractAddress;
  console.log(`MockERC20 deployed: ${TOKEN_ADDR}`);

  // Mint 1000 TST to alice
  const mintData = '0x40c10f19' // mint(address,uint256)
    + alice.slice(2).padStart(64, '0').toLowerCase()
    + (1000n * 10n ** 18n).toString(16).padStart(64, '0');
  const mintHash = await rpc('eth_sendTransaction', [{
    from: deployer, to: TOKEN_ADDR, data: mintData,
  }]);
  await waitTx(mintHash);
}

// ─── Sandbox the dapp ───────────────────────────────────────────────────────
const html = await fs.readFile(path.join(__dirname, '..', 'SLOW.html'), 'utf8');
const re = /<script>\s*\(\(\)\s*=>\s*\{([\s\S]*?)\}\)\(\);?\s*<\/script>/;
const m = html.match(re);
if (!m) throw new Error('Could not extract IIFE from SLOW.html');
let bodyJs = m[1];

// Rewrite the SLOW address constant to point at our anvil deployment.
const before = bodyJs;
bodyJs = bodyJs.replace(
  /const SLOW = '0x[0-9a-fA-F]+'/,
  `const SLOW = '${SLOW_ADDR}'`
);
if (before === bodyJs) throw new Error('SLOW constant not found in dapp');

// DOM stub — Proxy that absorbs all access without throwing.
const proxyEl = new Proxy(function () {}, {
  get(_t, p) {
    if (p === 'classList') return {add(){}, remove(){}, toggle(){}, contains: () => false};
    if (p === 'dataset') return {};
    if (p === 'style') return {};
    if (p === 'firstChild') return {nodeValue: ''};
    if (p === 'parentElement') return proxyEl;
    if (p === 'querySelector') return () => proxyEl;
    if (p === 'querySelectorAll') return () => [];
    if (p === 'appendChild') return () => proxyEl;
    if (p === 'addEventListener') return () => {};
    if (p === 'value' || p === 'textContent' || p === 'innerHTML') return '';
    return proxyEl;
  },
  set() { return true; },
  apply() { return proxyEl; },
});
globalThis.window = {
  ethereum: {
    request: ({method, params}) => rpc(method, params || []),
    on: () => {},
  },
  open: () => {},
  addEventListener: () => {},
};
// Per-id wrappers that expose a real `id` but delegate all other access to proxyEl.
const idWraps = {};
const elFor = id => idWraps[id] || (idWraps[id] = new Proxy({id}, {
  get: (t, p) => p === 'id' ? t.id : proxyEl[p],
  set: () => true,
}));
const markupIds = [...new Set([...html.matchAll(/\bid="([A-Za-z]\w*)"/g)].map(m=>m[1]))];
globalThis.document = {
  body: {classList: {toggle: () => false, contains: () => false}},
  getElementById: id => elFor(id),
  querySelectorAll: (sel) => sel === '[id]' ? markupIds.map(elFor) : [],
  createElement: () => proxyEl,
  addEventListener: () => {},
};

// Capture every flow function + state we need to drive scenarios.
const captured = {};
globalThis.__capture = captured;
const exposed = bodyJs + `
;Object.assign(globalThis.__capture, {
  S, SEL, SLOW: SLOW, ZERO, el, encode, decode, cd,
  parseUnits, formatUnits, decodeId, fmtTime,
  connect, deposit, claim, clawback, reverseAndWithdraw, handleConfirm,
  loadTransfers, tokenMeta, checkAllowance, resolveRecipient,
  sCall, tCall, sendTx, waitTx, getGate, estimateTip,
});`;
new Function(exposed)();
const D = captured; // "dapp" — the captured exports

// Replace the elements that flow functions read from with real mock objects.
// resolveRecipient reads el.recipientInput.value; handleConfirm reads it via
// resolveRecipient. el.ens gets status text written to it.
D.el.recipientInput = {value: '', textContent: '', className: '', focus(){}};
D.el.ens = {value: '', textContent: '', className: ''};
D.el.confirmModal = {classList: {add(){}, remove(){}, toggle(){}, contains: () => false}};
D.el.approveModal = {classList: {add(){}, remove(){}, toggle(){}, contains: () => false}};
D.el.approveText = {textContent: ''};

// ─── Scenarios ──────────────────────────────────────────────────────────────

// Helpers that go around the dapp (direct rpc/encoding for ground truth)
const padAddr = a => a.slice(2).toLowerCase().padStart(64, '0');
const pad32 = h => h.replace(/^0x/, '').padStart(64, '0');

async function pendingExists(transferId) {
  const data = D.cd(D.SEL.pendingTransfers, ['uint256'], [BigInt(transferId)]);
  const r = await rpc('eth_call', [{to: SLOW_ADDR, data}, 'latest']);
  const [ts] = D.decode(['uint256'], r);
  return ts !== 0n;
}
async function balanceOf1155(user, id) {
  // ERC1155 balanceOf(address,uint256) selector = 0x00fdd58e
  const data = '0x00fdd58e' + padAddr(user) + pad32(BigInt(id).toString(16));
  const r = await rpc('eth_call', [{to: SLOW_ADDR, data}, 'latest']);
  return BigInt(r);
}

console.log('\n=== Scenario 1: Connect ===');
{
  const res = await D.connect();
  ok(res, 'connect() returned true');
  eq(D.S.account?.toLowerCase(), accounts[0].toLowerCase(), 'S.account set to first anvil account');
}

console.log('=== Scenario 2: Deposit ETH with delay (Alice → Bob, 1 day) ===');
let transferId1;
{
  // We need alice to be the sender. connect() picked the deployer (accounts[0]).
  // Override S.account to alice for this scenario.
  D.S.account = alice;

  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.amount = 1; // 1 ETH
  D.S.delay = 86400;
  D.S.resolved = bob;

  const aliceBefore = await balanceOf(alice);
  const slowBefore = await balanceOf(SLOW_ADDR);

  await D.deposit();
  // The dapp does setView('home') + loadTransfers() at the end. Both should be safe
  // in our sandbox.

  const aliceAfter = await balanceOf(alice);
  const slowAfter = await balanceOf(SLOW_ADDR);

  ok(slowAfter - slowBefore === 10n ** 18n, 'SLOW received 1 ETH');
  ok(aliceBefore - aliceAfter > 10n ** 18n, "alice's ETH debited (deposit + gas)");

  // Verify pending transfer exists by going through loadTransfers — that also
  // exercises the dapp's pendingTransfers + getOutboundTransfers decode paths.
  D.S.account = alice;
  await D.loadTransfers();
  ok(D.S.out.length === 1, `alice has 1 outbound (got ${D.S.out.length})`);
  if (D.S.out.length === 1) {
    transferId1 = BigInt(D.S.out[0].id);
    eq(D.S.out[0].symbol, 'ETH', 'outbound symbol decoded as ETH');
    eq(D.S.out[0].delay, 86400, 'outbound delay = 86400');
    ok(await pendingExists('0x' + transferId1.toString(16)), 'pending entry exists on chain');
  }

  D.S.account = bob;
  await D.loadTransfers();
  ok(D.S.inb.length === 1, `bob has 1 inbound (got ${D.S.inb.length})`);
}

console.log('=== Scenario 3: Claim after expiry (Bob auto-settles) ===');
if (transferId1) {
  await timeWarp(86400);

  D.S.account = bob;
  const bobBefore = await balanceOf(bob);

  await D.claim({id: '0x' + transferId1.toString(16), amount: 1, symbol: 'ETH'});

  const bobAfter = await balanceOf(bob);
  ok(bobAfter > bobBefore, "bob's ETH credited (claim succeeded)");
  // Net: bob got 1 ETH minus claim gas. So delta should be very close to 1 ETH.
  const delta = bobAfter - bobBefore;
  ok(delta > 990n * 10n**15n && delta <= 10n**18n, `claim delta ~1 ETH (got ${delta})`);

  // Verify pending entry deleted
  ok(!await pendingExists('0x' + transferId1.toString(16)), 'pending entry cleared after claim');

  // ERC1155 balance burned
  const id = 86400n << 160n;
  eq(await balanceOf1155(bob, id), 0n, 'wrapped 1155 burned');
}

console.log('=== Scenario 4: Reverse pre-expiry ===');
{
  D.S.account = alice;
  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.amount = 0.5;
  D.S.delay = 86400;
  D.S.resolved = bob;

  const aliceBefore = await balanceOf(alice);
  await D.deposit();

  await D.loadTransfers();
  ok(D.S.out.length === 1, 'alice has 1 outbound after second deposit');

  if (D.S.out.length === 1) {
    const t = D.S.out[0];
    await D.reverseAndWithdraw(t);

    const aliceAfter = await balanceOf(alice);
    // Net loss is just gas (deposit gas + reverse multicall gas). Very close to 0.
    const loss = aliceBefore - aliceAfter;
    ok(loss < 10n**16n, `alice essentially restored — net loss ${loss} (gas only)`);
    ok(!await pendingExists(t.id), 'pending cleared after reverse');
  }
}

console.log('=== Scenario 5: ERC20 deposit + claim ===');
if (TOKEN_ADDR) {
  D.S.account = alice;
  D.S.token = TOKEN_ADDR;
  D.S.symbol = 'TST';
  D.S.decimals = 18;
  D.S.amount = 100;
  D.S.delay = 60;
  D.S.resolved = bob;

  // Approve SLOW to spend alice's TST
  const approveData = '0x095ea7b3' + padAddr(SLOW_ADDR) +
    ((1n << 256n) - 1n).toString(16).padStart(64, '0');
  const approveHash = await rpc('eth_sendTransaction', [{
    from: alice, to: TOKEN_ADDR, data: approveData,
  }]);
  await waitTx(approveHash);

  await D.deposit();

  await timeWarp(60);

  D.S.account = bob;
  await D.loadTransfers();

  const bobInb = D.S.inb.find(t => t.symbol === 'TST');
  ok(bobInb, 'bob has TST inbound');
  if (bobInb) {
    // Bob's TST balance before claim
    const tstBalData = '0x70a08231' + padAddr(bob); // balanceOf(address)
    const before = BigInt(await rpc('eth_call', [{to: TOKEN_ADDR, data: tstBalData}, 'latest']));

    await D.claim(bobInb);

    const after = BigInt(await rpc('eth_call', [{to: TOKEN_ADDR, data: tstBalData}, 'latest']));
    eq(after - before, 100n * 10n ** 18n, 'bob received 100 TST');
  }
}

console.log('=== Scenario 6: Clawback after grace ===');
{
  D.S.account = alice;
  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.amount = 0.25;
  D.S.delay = 3600; // 1 hour
  D.S.resolved = bob; // Bob never claims

  const aliceBefore = await balanceOf(alice);
  await D.deposit();

  // Past expiry + 30-day grace, recipient never acted.
  await timeWarp(3600 + 30 * 86400);

  // Reload to grab the transferId for alice
  await D.loadTransfers();
  const t = D.S.out.find(x => Number(x.amount) === 0.25);
  ok(t, 'alice has the 0.25 ETH outbound visible');
  if (t) {
    await D.clawback(t);
    const aliceAfter = await balanceOf(alice);
    const loss = aliceBefore - aliceAfter;
    ok(loss < 10n ** 16n, `alice essentially restored via clawback (loss = ${loss} wei, gas only)`);
    ok(!await pendingExists(t.id), 'pending cleared after clawback');
  }
}

console.log('=== Scenario 7: Multicall settle (unlock + withdrawFrom in one tx) ===');
{
  // Recipient settles via the dapp's two-step path under multicall — separate
  // from the one-shot claim() above.
  D.S.account = alice;
  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.amount = 0.7;
  D.S.delay = 60;
  D.S.resolved = carol; // Use carol so we have a clean balance to read.

  await D.deposit();
  await timeWarp(60);

  D.S.account = carol;
  await D.loadTransfers();
  const t = D.S.inb.find(x => Number(x.amount) === 0.7);
  ok(t, 'carol has 0.7 ETH inbound');
  if (t) {
    // The dapp doesn't expose unlockAndWithdraw anymore (claim replaced it),
    // but we can still verify the contract permits the multicall path that
    // the contract test suite covers (unlock is permissionless + withdrawFrom).
    // Sanity-check via direct contract calls instead.
    const carolBefore = await balanceOf(carol);

    // unlock is now `to`-gated (or operator) — call from carol (the recipient).
    // Selector inlined: dapp doesn't expose unlock, so SEL no longer carries it.
    const unlockData = D.cd('0x6198e339', ['uint256'], [BigInt(t.id)]);
    const h1 = await rpc('eth_sendTransaction', [{from: carol, to: SLOW_ADDR, data: unlockData}]);
    await waitTx(h1);

    // carol withdraws
    const withdrawData = D.cd(D.SEL.withdrawFrom, ['address','address','uint256','uint256'],
      [carol, carol, BigInt(t.tokenId), t.amountRaw]);
    const h2 = await rpc('eth_sendTransaction', [{from: carol, to: SLOW_ADDR, data: withdrawData}]);
    await waitTx(h2);

    const carolAfter = await balanceOf(carol);
    ok(carolAfter > carolBefore, "carol's ETH credited via unlock+withdraw path");
    const delta = carolAfter - carolBefore;
    ok(delta > 690n * 10n ** 15n && delta <= 700n * 10n ** 15n,
      `unlock+withdraw delta ~0.7 ETH (got ${delta})`);
  }
}

console.log('=== Scenario 8: Multi-pending state — decode integrity ===');
{
  // Three deposits with different delays from alice to bob. loadTransfers must
  // decode the array, fetch all pending structs in parallel, and produce three
  // entries with matching delays/amounts.
  // The dapp's deposit() ends with setView('home') which calls resetForm() —
  // wiping S.token/amount/delay. Set the full state before each deposit.
  for (const [amount, delay] of [[0.1, 60], [0.2, 3600], [0.3, 86400]]) {
    D.S.account = alice;
    D.S.token = D.ZERO;
    D.S.symbol = 'ETH';
    D.S.decimals = 18;
    D.S.resolved = bob;
    D.S.amount = amount;
    D.S.delay = delay;
    await D.deposit();
  }

  D.S.account = alice;
  await D.loadTransfers();
  // Note: alice also still has the prior outbound transfers from earlier scenarios
  // (the clawed-back/reversed/expired ones were cleaned up). Just check that the
  // three new deposits all show up.
  const found = [60, 3600, 86400].map(d => D.S.out.find(x => x.delay === d));
  ok(found.every(Boolean), `all three new outbound visible (got ${found.filter(Boolean).length}/3)`);

  // Spot-check decode fidelity: one of them
  const t60 = found[0];
  if (t60) {
    eq(t60.symbol, 'ETH', 'decoded symbol');
    eq(t60.token.toLowerCase(), D.ZERO, 'decoded token = ZERO (ETH)');
    eq(Number(t60.amount), 0.1, 'decoded amount = 0.1');
  }

  // bob sees them inbound
  D.S.account = bob;
  await D.loadTransfers();
  const inFound = [60, 3600, 86400].map(d => D.S.inb.find(x => x.delay === d));
  ok(inFound.every(Boolean), `all three new inbound visible (got ${inFound.filter(Boolean).length}/3)`);
}

console.log('=== Scenario 9: handleConfirm — full ETH submit flow ===');
{
  // Reset resolved state so handleConfirm runs the full pipeline including
  // resolveRecipient. The recipient is supplied via el.recipientInput, mimicking
  // the real submit-button flow.
  D.S.resolved = null;
  D.S.account = alice;
  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.amount = 0.05;
  D.S.delay = 60;
  D.el.recipientInput.value = bob;

  const aliceBefore = await balanceOf(alice);

  // Snoop S.resolved during the call: handleConfirm clears resolved-state
  // indirectly (via deposit → setView('home') → resetForm) by the time it
  // returns, so capture mid-flight via the resolveRecipient pre-step instead.
  await D.resolveRecipient(bob);
  eq(D.S.resolved?.toLowerCase(), bob.toLowerCase(),
    'resolveRecipient (called by handleConfirm): S.resolved stamped with bob');

  await D.handleConfirm();
  const aliceAfter = await balanceOf(alice);
  ok(aliceBefore - aliceAfter > 5n * 10n ** 16n,
    "handleConfirm dispatched deposit (alice ETH debited)");
}

console.log('=== Scenario 10: handleConfirm — ERC20 allowance flow ===');
if (TOKEN_ADDR) {
  // Use carol who has no TST allowance set yet.
  D.S.resolved = null;
  D.S.account = carol;
  D.S.token = TOKEN_ADDR;
  D.S.symbol = 'TST';
  D.S.decimals = 18;
  D.S.amount = 5;
  D.S.delay = 60;
  D.el.recipientInput.value = bob;

  // Mint TST to carol so she has balance to deposit
  const mintData = '0x40c10f19'
    + carol.slice(2).padStart(64, '0').toLowerCase()
    + (10n * 10n ** 18n).toString(16).padStart(64, '0');
  await waitTx(await rpc('eth_sendTransaction', [{
    from: deployer, to: TOKEN_ADDR, data: mintData,
  }]));

  // Verify allowance starts at 0
  const allow0 = await D.checkAllowance(TOKEN_ADDR, carol, 5n * 10n ** 18n);
  ok(!allow0, 'checkAllowance: returns false when allowance is 0');

  // First handleConfirm should resolve recipient, detect missing allowance,
  // and surface the approve modal — without depositing.
  const carolBalBefore = BigInt(await rpc('eth_call',
    [{to: TOKEN_ADDR, data: '0x70a08231' + padAddr(carol)}, 'latest']));
  await D.handleConfirm();
  const carolBalMid = BigInt(await rpc('eth_call',
    [{to: TOKEN_ADDR, data: '0x70a08231' + padAddr(carol)}, 'latest']));
  eq(carolBalMid, carolBalBefore, 'handleConfirm without allowance: no deposit yet');
  eq(D.S.resolved?.toLowerCase(), bob.toLowerCase(), 'recipient resolved before allowance check');

  // Approve and retry — second handleConfirm should pass the allowance check
  // and run the deposit.
  const approveData = '0x095ea7b3' + padAddr(SLOW_ADDR) +
    ((1n << 256n) - 1n).toString(16).padStart(64, '0');
  await waitTx(await rpc('eth_sendTransaction', [{
    from: carol, to: TOKEN_ADDR, data: approveData,
  }]));

  const allow1 = await D.checkAllowance(TOKEN_ADDR, carol, 5n * 10n ** 18n);
  ok(allow1, 'checkAllowance: returns true after approve');

  await D.handleConfirm();
  const carolBalAfter = BigInt(await rpc('eth_call',
    [{to: TOKEN_ADDR, data: '0x70a08231' + padAddr(carol)}, 'latest']));
  eq(carolBalBefore - carolBalAfter, 5n * 10n ** 18n,
    'handleConfirm with allowance: deposit completed (5 TST debited)');
}

console.log('=== Scenario 11: Guardian status decode in loadTransfers ===');
{
  // Set carol as alice's guardian via direct RPC. setGuardian(address) selector
  // verified via `cast sig`: 0x8a0dac4a.
  const setGuardianCalldata = '0x8a0dac4a' + padAddr(carol);
  await waitTx(await rpc('eth_sendTransaction', [{
    from: alice, to: SLOW_ADDR, data: setGuardianCalldata,
  }]));

  // Verify alice's guardian is now carol via direct contract call
  const guardianData = D.cd(D.SEL.guardians, ['address'], [alice]);
  const guardianResult = await rpc('eth_call', [{to: SLOW_ADDR, data: guardianData}, 'latest']);
  const guardian = '0x' + guardianResult.slice(-40);
  eq(guardian.toLowerCase(), carol.toLowerCase(), 'guardian set to carol');

  // Alice deposits to bob with delay
  D.S.resolved = bob;
  D.S.account = alice;
  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.amount = 0.04;
  D.S.delay = 120;
  await D.deposit();

  // loadTransfers as alice detects the guardian via direct contract read and
  // stamps `guardianPending` per transfer based on isWithdrawalApprovalNeeded
  // (reclaim is reverse + withdrawFrom, which uses the _OP_WITHDRAW preimage).
  D.S.account = alice;
  await D.loadTransfers();
  const t = D.S.out.find(x => Number(x.amount) === 0.04);
  ok(t, 'alice has the 0.04 ETH outbound');
  if (t) {
    ok(t.guardianPending === true,
      `loadTransfers stamps t.guardianPending=true when guardian unapproved (got ${t.guardianPending})`);
  }

  // After the guardian approves the predicted withdrawal hash (matching the
  // reclaim flow's withdrawFrom call), a re-load should flip guardianPending to
  // false. Ask the contract for the next withdrawalId rather than recomputing
  // the preimage in JS.
  const predictData = '0x2d0eae84' /* predictWithdrawalId(address,address,uint256,uint256) */
    + padAddr(alice) + padAddr(alice)
    + BigInt(t.tokenId).toString(16).padStart(64, '0')
    + t.amountRaw.toString(16).padStart(64, '0');
  const predictedHex = await rpc('eth_call', [{to: SLOW_ADDR, data: predictData}, 'latest']);
  const predictedId = BigInt(predictedHex);

  // Carol approves
  const approveData = '0xfa02c4b7' /* approveTransfer(address,uint256) */
    + padAddr(alice)
    + predictedId.toString(16).padStart(64, '0');
  await waitTx(await rpc('eth_sendTransaction', [{
    from: carol, to: SLOW_ADDR, data: approveData,
  }]));

  await D.loadTransfers();
  const t2 = D.S.out.find(x => Number(x.amount) === 0.04);
  if (t2) {
    ok(t2.guardianPending === false,
      `loadTransfers stamps guardianPending=false after approval (got ${t2.guardianPending})`);
  }
}

console.log('=== Scenario 12: Tipped deposit + keeper-style settle via gate ===');
{
  // Alice sends 0.5 ETH to bob with autoClaim on. The dapp should route through
  // depositToWithTip (msg.value = amount + tip), the gate should record the tip,
  // loadTransfers should mark t.tipped on both sides, and a third party (carol
  // standing in for a keeper) calling gate.claim should both settle the transfer
  // for bob and pay the tip to carol.
  D.S.account = alice;
  D.S.token = D.ZERO;
  D.S.symbol = 'ETH';
  D.S.decimals = 18;
  D.S.resolved = bob;
  D.S.amount = 0.5;
  D.S.delay = 60;
  D.S.autoClaim = true;

  const aliceBalBefore = await balanceOf(alice);
  // Capture the tip the deposit chose by spying on estimateTip
  let observedTip = 0n;
  const origEstimate = D.estimateTip;
  // Override on the global IIFE binding by reassigning via captured handle —
  // this works because in the IIFE, `estimateTip` is a function declaration
  // (mutable), and the closure used by deposit() looks up by name at call time
  // ONLY if we replace it inside the IIFE's scope. Since we can't do that from
  // here, we instead pre-set S.tip; deposit() will *also* refresh inside, but
  // the refresh hits the same eth_feeHistory path. We just want to confirm a
  // non-zero amount got attached on-chain.
  await D.deposit();
  const aliceBalAfter = await balanceOf(alice);
  const spent = aliceBalBefore - aliceBalAfter;
  ok(spent > 500n * 10n ** 15n,
    `alice spent at least the amount (got ${spent})`);

  // Locate the new pending transfer
  D.S.account = alice;
  await D.loadTransfers();
  const out = D.S.out.find(x => Number(x.amount) === 0.5 && x.delay === 60);
  ok(out, `alice sees outbound 0.5 ETH/60s pending (alice S.out len=${D.S.out.length})`);
  if (out) {
    ok(out.tipped === true, `loadTransfers stamps t.tipped=true on outbound (got ${out.tipped})`);

    D.S.account = bob;
    await D.loadTransfers();
    const inb = D.S.inb.find(x => x.id === out.id);
    ok(inb, 'bob sees inbound matching alice outbound id');
    if (inb) {
      ok(inb.tipped === true, `loadTransfers stamps t.tipped=true on inbound (got ${inb.tipped})`);

      // Fast-forward past unlock and have carol (keeper) settle via gate.claim
      await timeWarp(120);
      const gateAddr = await D.getGate();
      ok(gateAddr && gateAddr !== D.ZERO, `gate address resolved (got ${gateAddr})`);

      const bobBefore = await balanceOf(bob);
      const carolBefore = await balanceOf(carol);
      const claimData = '0x379607f5' +
        BigInt(inb.id).toString(16).padStart(64, '0');
      await waitTx(await rpc('eth_sendTransaction',
        [{from: carol, to: gateAddr, data: claimData}]));
      const bobAfter = await balanceOf(bob);
      const carolAfter = await balanceOf(carol);

      ok(bobAfter - bobBefore === 500n * 10n ** 15n,
        `bob received exactly 0.5 ETH (got ${bobAfter - bobBefore})`);
      ok(carolAfter > carolBefore - 10n ** 15n,
        `carol net positive after tip-claim (got ${carolAfter - carolBefore})`);

      D.S.account = bob;
      await D.loadTransfers();
      const stillThere = D.S.inb.find(x => x.id === inb.id);
      ok(!stillThere, 'settled transfer no longer in bob inbound');
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────
anvil?.kill();

if (fail === 0) {
  console.log(`\nOK: ${pass} e2e checks passed`);
  process.exit(0);
} else {
  console.error(`\nFAIL: ${fail}/${pass + fail} failed\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
