#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);
const ENV_PATH = join(ROOT_DIR, "liquidmesh.env");
const DEFAULT_LOG_DIR = join(ROOT_DIR, "data", "liquidmesh_probe", "samples");
const BASE_URL = "https://api.liquidmesh.io";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const FIXED_GAS_LIMIT = 350_000;
const MIN_INTERVAL_MS = 500;
const HTTP_TIMEOUT_MS = 15_000;
const SUMMARY_INTERVAL_MS = 60_000;

function parseEnv(path) {
  const result = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64ToBase64Url(value) {
  return Buffer.from(value, "base64").toString("base64url");
}

function authFields(env, suffix = "") {
  return {
    apiKey: env[`API_Key${suffix}`] || env[`API_KEY${suffix}`] || env[`LM_API_KEY${suffix}`],
    publicKey: env[`Public_Key${suffix}`] || env[`PUBLIC_KEY_BASE64${suffix}`],
    privateKey: env[`Private_Key${suffix}`] || env[`PRIVATE_KEY_BASE64${suffix}`],
  };
}

function buildAuthFromFields({ apiKey, publicKey, privateKey }, label) {
  if (!apiKey || !publicKey || !privateKey) {
    throw new Error(`Missing API_Key${label}/Public_Key${label}/Private_Key${label} in liquidmesh.env`);
  }
  const privateBytes = Buffer.from(privateKey, "base64");
  const seed = privateBytes.length >= 64 ? privateBytes.subarray(0, 32) : privateBytes;
  return {
    apiKey,
    jwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: base64ToBase64Url(publicKey),
      d: seed.toString("base64url"),
    },
  };
}

function buildAuths(env) {
  const auths = [buildAuthFromFields(authFields(env), "")];
  const second = authFields(env, "2");
  if (second.apiKey || second.publicKey || second.privateKey) {
    auths.push(buildAuthFromFields(second, "2"));
  }
  return auths;
}

function signJwt({ apiKey, jwk }, method, path, body) {
  const timestampMs = Date.now();
  const preimage = `${timestampMs}${method.toUpperCase()}${path}${body}`;
  const message = createHash("sha256").update(preimage).digest("hex");
  const nowSec = Math.floor(timestampMs / 1000);
  const header = { typ: "JWT", alg: "EdDSA" };
  const payload = { tim: timestampMs, message, iss: apiKey, iat: nowSec, exp: nowSec + 2 };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const signature = sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${base64Url(signature)}`;
}

function getArg(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function getBoolArg(name, fallback) {
  const value = getArg(name, null);
  if (value == null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function shortText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: shortText(text) };
    }
    return { status: response.status, ok: response.ok, json };
  } catch (error) {
    return {
      status: null,
      ok: false,
      json: null,
      error: error?.name === "AbortError" ? "request timeout" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildQuotePath({
  wallet,
  inputToken,
  outputToken,
  amount,
  dexes,
  excludeDexes,
  maxHops,
  maxSwaps,
}) {
  const query = new URLSearchParams({
    chainId: "56",
    inputToken,
    outputToken,
    amount,
    userAddress: wallet,
  });
  if (dexes) query.set("dexes", dexes);
  if (excludeDexes) query.set("excludeDexes", excludeDexes);
  if (maxHops) query.set("maxHops", maxHops);
  if (maxSwaps) query.set("maxSwaps", maxSwaps);
  return `/v1/bsc/quote?${query.toString()}`;
}

async function liquidMeshQuote(auth, params) {
  const path = buildQuotePath(params);
  const token = signJwt(auth, "GET", path, "");
  return fetchJson(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "LM-API-KEY": auth.apiKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

async function liquidMeshSwap(auth, {
  wallet,
  slippageBps,
  swapInfo,
}) {
  const path = "/v1/bsc/swap";
  const bodyObject = {
    userAddress: wallet,
    receiver: wallet,
    slippageBps,
    swapInfo,
    disableSimulate: true,
    bypassChecks: true,
  };
  const body = JSON.stringify(bodyObject);
  const token = signJwt(auth, "POST", path, body);
  return fetchJson(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "LM-API-KEY": auth.apiKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });
}

function quoteData(payload) {
  return payload?.json?.data || payload?.json?.result || payload?.json || {};
}

function swapData(payload) {
  return payload?.json?.data || payload?.json?.result || payload?.json || {};
}

function extractEstimatedGasLimit(payload) {
  const data = quoteData(payload);
  const value = data.estimatedGasLimit ?? data.estimatedGas ?? data.gasLimit ?? data.gas;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractOutputAmount(payload) {
  const data = quoteData(payload);
  return data.outputAmount || data.toAmount || data.amountOut || null;
}

function minReceiveAmount(outputAmount, slippageBps) {
  if (outputAmount == null) return null;
  return ((BigInt(outputAmount) * BigInt(10_000 - slippageBps)) / 10_000n).toString();
}

function routeDexes(payload) {
  const data = quoteData(payload);
  return (data.routePlans || []).flatMap((route) =>
    (route.subRouters || []).flatMap((sub) =>
      (sub.dexes || []).map((dex) => dex.dex).filter(Boolean),
    ),
  );
}

function routeSummary(payload) {
  return [...new Set(routeDexes(payload))].join(",");
}

function extractInnerBytes(payload) {
  const callData = swapData(payload)?.callMsg?.data;
  return callData?.startsWith("0x") ? (callData.length - 2) / 2 : null;
}

function extractInnerSelector(payload) {
  const callData = swapData(payload)?.callMsg?.data;
  return callData?.startsWith("0x") ? callData.slice(0, 10) : null;
}

function sampleLogPath(logDir, timestampMs) {
  const date = new Date(timestampMs).toISOString().slice(0, 10);
  return join(logDir, `${date}.jsonl`);
}

function appendSample(logDir, sample) {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(sampleLogPath(logDir, sample.ts), `${JSON.stringify(sample)}\n`);
}

function errorSample({ error, direction, amount, threshold, targetInnerBytes }) {
  const ts = Date.now();
  return {
    ts,
    iso: new Date(ts).toISOString(),
    ok: false,
    passReason: "probe-error",
    threshold,
    targetInnerBytes,
    fixedGasLimit: FIXED_GAS_LIMIT,
    liquidMeshEstimatedGasLimit: null,
    quoteHttp: null,
    quoteCode: null,
    quoteMsg: null,
    swapHttp: null,
    swapCode: null,
    swapMsg: null,
    error: error.message || String(error),
    provider: "LiquidMesh",
    apiSlot: null,
    path: "liquidmesh_quote_with_swap_inner",
    direction,
    amount,
    route: "",
    innerBytes: null,
    innerSelector: null,
    outputAmount: null,
    minOutputAmount: null,
  };
}

function formatShortError(error) {
  if (!error) return "";
  const short = String(error).replace(/\s+/g, " ").trim();
  return short.length > 96 ? `${short.slice(0, 93)}...` : short;
}

function formatSample(sample) {
  const time = new Date(sample.ts).toLocaleTimeString("zh-CN", { hour12: false });
  const state = sample.ok ? "PASS" : "BLOCK";
  const lmGas = sample.liquidMeshEstimatedGasLimit ?? "-";
  const inner = sample.innerBytes ?? "-";
  const route = sample.route || "-";
  const err = formatShortError(sample.error);
  return [
    `[${time}]`,
    state,
    sample.direction,
    `api=${sample.apiSlot ?? "-"}`,
    `lmGas=${lmGas}`,
    `inner=${inner}`,
    `target=${sample.targetInnerBytes}`,
    `route=${route}`,
    err ? `err=${err}` : null,
  ].filter(Boolean).join(" ");
}

function createSummaryStats(startedAt = Date.now()) {
  return {
    startedAt,
    lastPrintedAt: startedAt,
    count: 0,
    passCount: 0,
    errorCount: 0,
    byDirection: {
      "USDT->quq": { count: 0, passCount: 0 },
      "quq->USDT": { count: 0, passCount: 0 },
    },
  };
}

function updateSummaryStats(stats, sample) {
  stats.count += 1;
  if (sample.ok) stats.passCount += 1;
  if (sample.error) stats.errorCount += 1;
  const direction = stats.byDirection[sample.direction];
  if (direction) {
    direction.count += 1;
    if (sample.ok) direction.passCount += 1;
  }
}

function directionSummary(direction, stats) {
  const rate = stats.count ? Math.round((stats.passCount / stats.count) * 100) : 0;
  return `${direction}=${stats.passCount}/${stats.count}(${rate}%)`;
}

function formatSummary(stats, now = Date.now()) {
  const elapsedSec = Math.max(1, Math.round((now - stats.startedAt) / 1000));
  const rate = stats.count ? Math.round((stats.passCount / stats.count) * 100) : 0;
  return [
    `[${new Date(now).toLocaleTimeString("zh-CN", { hour12: false })}]`,
    "SUMMARY",
    `samples=${stats.count}`,
    `pass=${stats.passCount}/${stats.count}(${rate}%)`,
    directionSummary("USDT->quq", stats.byDirection["USDT->quq"]),
    directionSummary("quq->USDT", stats.byDirection["quq->USDT"]),
    `errors=${stats.errorCount}`,
    `elapsed=${elapsedSec}s`,
  ].join(" ");
}

function maybePrintSummary(stats, force = false) {
  const now = Date.now();
  if (!force && now - stats.lastPrintedAt < SUMMARY_INTERVAL_MS) return;
  if (stats.count === 0) return;
  console.log(formatSummary(stats, now));
  stats.lastPrintedAt = now;
}

async function runSample({
  auth,
  apiSlot,
  wallet,
  inputToken,
  outputToken,
  amount,
  threshold,
  targetInnerBytes,
  slippageBps,
  dexes,
  excludeDexes,
  maxHops,
  maxSwaps,
  direction,
}) {
  const startedAt = Date.now();
  const quote = await liquidMeshQuote(auth, {
    wallet,
    inputToken,
    outputToken,
    amount,
    dexes,
    excludeDexes,
    maxHops,
    maxSwaps,
  });
  const quoteError = quote.error || (quote.status === 200 && quote.json?.code === 0
    ? null
    : quote.json?.msg || quote.json?.message || quote.json?.raw || `quote http ${quote.status}`);
  const swap = quoteError
    ? { status: null, json: null, error: "swap skipped because quote failed" }
    : await liquidMeshSwap(auth, {
        wallet,
        slippageBps,
        swapInfo: quoteData(quote),
      });
  const liquidMeshEstimatedGasLimit = extractEstimatedGasLimit(quote);
  const outputAmount = extractOutputAmount(quote);
  const innerBytes = extractInnerBytes(swap);
  const routeDexList = routeDexes(quote);
  const route = routeSummary(quote);
  const singleV3Route = (
    routeDexList.length === 1 &&
    ["pancakeswap_v3", "uniswap_v3"].includes(routeDexList[0])
  );
  const ok = (
    singleV3Route &&
    innerBytes === targetInnerBytes &&
    liquidMeshEstimatedGasLimit === threshold
  );
  const swapError = swap.error || (swap.status === 200 && swap.json?.code === 0
    ? null
    : swap.json?.msg || swap.json?.message || swap.json?.raw || `swap http ${swap.status}`);
  return {
    ts: startedAt,
    iso: new Date(startedAt).toISOString(),
    ok,
    passReason: ok ? "single-v3-inner-and-lmGas-match" : "route-inner-or-lmGas-not-target",
    threshold,
    targetInnerBytes,
    fixedGasLimit: FIXED_GAS_LIMIT,
    liquidMeshEstimatedGasLimit,
    quoteHttp: quote.status,
    quoteCode: quote.json?.code ?? null,
    quoteMsg: quote.json?.msg ?? null,
    swapHttp: swap.status,
    swapCode: swap.json?.code ?? null,
    swapMsg: swap.json?.msg ?? null,
    error: quoteError || swapError,
    provider: "LiquidMesh",
    apiSlot,
    path: "liquidmesh_quote_with_swap_inner",
    direction,
    amount,
    slippageBps,
    dexes,
    excludeDexes,
    maxHops,
    maxSwaps,
    route,
    innerBytes,
    innerSelector: extractInnerSelector(swap),
    outputAmount,
    minOutputAmount: minReceiveAmount(outputAmount, slippageBps),
  };
}

async function main() {
  const env = parseEnv(ENV_PATH);
  const auths = buildAuths(env);
  const wallet = getArg("wallet", env.WALLET || env.USER_ADDRESS || "");
  if (!wallet) throw new Error("Missing wallet. Set WALLET in liquidmesh.env or pass --wallet.");
  const forwardInputToken = getArg("input-token", env.INPUT_TOKEN || USDT);
  const forwardOutputToken = getArg("output-token", env.OUTPUT_TOKEN || "");
  if (!forwardOutputToken) throw new Error("Missing output token. Set OUTPUT_TOKEN in liquidmesh.env or pass --output-token.");
  const forwardAmount = getArg("amount", env.PROBE_AMOUNT || "");
  if (!forwardAmount) throw new Error("Missing probe amount. Set PROBE_AMOUNT in liquidmesh.env or pass --amount.");
  const reverseAmount = getArg("reverse-amount", env.REVERSE_AMOUNT || "");
  if (!reverseAmount) throw new Error("Missing reverse amount. Set REVERSE_AMOUNT in liquidmesh.env or pass --reverse-amount.");
  const samples = Number(getArg("samples", "1"));
  const intervalMs = Math.max(Number(getArg("interval-ms", "500")), MIN_INTERVAL_MS);
  const logDir = getArg("log-dir", DEFAULT_LOG_DIR);
  const shouldLog = getBoolArg("log", true);
  const format = getArg("format", "compact");
  const stdoutMode = getArg("stdout", samples === 0 ? "summary" : "sample");
  const threshold = Number(getArg("threshold", "155000"));
  const targetInnerBytes = Number(getArg("target-inner", "1380"));
  if (!Number.isFinite(targetInnerBytes)) throw new Error("Missing target inner bytes. Pass --target-inner 1380.");
  const slippageBps = Number(getArg("slippage-bps", "1"));
  const dexes = getArg("dexes", "");
  const excludeDexes = getArg("exclude-dexes", "uniswap_v4,pancakeswap_v4,lista_stable,fluid_t1,nomiswap_stable");
  const maxHops = getArg("max-hops", "");
  const maxSwaps = getArg("max-swaps", "");
  let lastForwardMinOutputAmount = null;
  let nextDirection = "USDT->quq";
  const summaryStats = createSummaryStats();

  if (samples === 0 && stdoutMode === "summary") {
    console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] sampler started interval=${intervalMs}ms auths=${auths.length} log=${shouldLog ? logDir : "off"}`);
  }

  for (let i = 0; samples === 0 || i < samples; i += 1) {
    const isReverse = nextDirection === "quq->USDT";
    const amount = isReverse ? (lastForwardMinOutputAmount || reverseAmount) : forwardAmount;
    const authIndex = i % auths.length;
    let sample;
    try {
      sample = await runSample({
        auth: auths[authIndex],
        apiSlot: authIndex + 1,
        wallet,
        inputToken: isReverse ? forwardOutputToken : forwardInputToken,
        outputToken: isReverse ? forwardInputToken : forwardOutputToken,
        amount,
        threshold,
        targetInnerBytes,
        slippageBps,
        dexes,
        excludeDexes,
        maxHops,
        maxSwaps,
        direction: nextDirection,
      });
    } catch (error) {
      sample = errorSample({ error, direction: nextDirection, amount, threshold, targetInnerBytes });
      sample.apiSlot = authIndex + 1;
    }
    if (shouldLog) appendSample(logDir, sample);
    updateSummaryStats(summaryStats, sample);
    if (stdoutMode === "sample") {
      console.log(format === "json" ? JSON.stringify(sample) : formatSample(sample));
    } else if (stdoutMode === "json") {
      console.log(JSON.stringify(sample));
    } else if (stdoutMode === "summary") {
      if (sample.error) console.error(formatSample(sample));
      maybePrintSummary(summaryStats);
    }
    if (!isReverse && sample.minOutputAmount) {
      lastForwardMinOutputAmount = sample.minOutputAmount;
    }
    nextDirection = isReverse ? "USDT->quq" : "quq->USDT";

    if (samples === 0 || i + 1 < samples) {
      const elapsed = Date.now() - sample.ts;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - elapsed)));
    }
  }
  if (stdoutMode === "summary") maybePrintSummary(summaryStats, true);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
