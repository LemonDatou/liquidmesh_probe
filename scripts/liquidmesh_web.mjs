#!/usr/bin/env node

import { createServer } from "node:http";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);
const SAMPLE_DIR = join(ROOT_DIR, "data", "liquidmesh_probe", "samples");
const DEFAULT_PORT = 19988;
const DEFAULT_HOST = "0.0.0.0";
const UPDATE_INTERVAL_MS = 60_000;
const HISTORY_POINTS = 60;
const WINDOWS = [
  { key: "p1m", label: "1分钟", ms: 60_000 },
  { key: "p3m", label: "3分钟", ms: 180_000 },
  { key: "p5m", label: "5分钟", ms: 300_000 },
  { key: "p10m", label: "10分钟", ms: 600_000 },
  { key: "p30m", label: "30分钟", ms: 1_800_000 },
  { key: "p1h", label: "1小时", ms: 3_600_000 },
];
const STATUS_RULES = [
  { state: "super-green", title: "超级流畅", color: "#10b981", minRate: 0.75, exclusive: true },
  { state: "green", title: "流畅", color: "#10b981", minRate: 0.55 },
  { state: "yellow", title: "可刷", color: "#f59e0b", minRate: 0.35 },
  { state: "orange", title: "卡顿", color: "#f97316", minRate: 0.15 },
  { state: "red", title: "卡飞了", color: "#f43f5e", minRate: 0 },
];
const ANOMALY_STATUS = { state: "anomaly", title: "探针异常", color: "#9ca3af" };
const DIRECTIONS = ["USDT->quq", "quq->USDT"];
const MAX_WINDOW_MS = Math.max(...WINDOWS.map((window) => window.ms));
const HISTORY_LOOKBACK_MS = MAX_WINDOW_MS * (HISTORY_POINTS + 1);
const ESTIMATE_TARGET_ROUND_TRIPS = 16;
const ESTIMATE_TARGET_SWAPS = ESTIMATE_TARGET_ROUND_TRIPS * 2;
const ESTIMATE_SWITCH_MS = 20_000;
const ESTIMATE_REFRESH_MS = 1_500;
const ESTIMATE_MAX_SAMPLE_DISTANCE_MS = 2_500;

let cachedPayload = null;
let nextUpdateAt = 0;
const sampleOffsets = new Map();
let inMemorySamples = [];
let verboseLogs = false;

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

function sampleFiles(sampleDir) {
  if (!existsSync(sampleDir)) return [];
  return readdirSync(sampleDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => join(sampleDir, name));
}

function latestSampleFile(sampleDir) {
  const files = sampleFiles(sampleDir);
  if (files.length === 0) return null;
  return files[files.length - 1];
}

function recentSampleFiles(sampleDir) {
  return sampleFiles(sampleDir).slice(-4);
}

function readSampleLines(lines, cutoffTs = -Infinity) {
  const samples = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const sample = JSON.parse(line);
      const pass = parsePass(sample);
      if (pass == null || typeof sample.ts !== "number" || sample.ts < cutoffTs) continue;
        samples.push({ ts: sample.ts, pass, direction: sample.direction || "" });
    } catch {
      // Ignore incomplete trailing lines.
    }
  }
  return samples;
}

function readWholeSampleFile(file, cutoffTs = -Infinity) {
  if (!file || !existsSync(file)) return [];
  return readSampleLines(readFileSync(file, "utf8").split(/\r?\n/), cutoffTs);
}

function readNewSamples(file) {
  if (!file || !existsSync(file)) return [];
  const size = statSync(file).size;
  const oldOffset = sampleOffsets.get(file) ?? 0;
  const offset = oldOffset <= size ? oldOffset : 0;
  if (size === offset) return [];

  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    sampleOffsets.set(file, size);
    return readSampleLines(buffer.toString("utf8").split(/\r?\n/));
  } finally {
    closeSync(fd);
  }
}

function bootstrapSamples(sampleDir) {
  const files = recentSampleFiles(sampleDir);
  const latestFile = files[files.length - 1] || null;
  if (!latestFile) return { latest: null, samples: [] };

  const latestSamples = readWholeSampleFile(latestFile);
  const latest = latestSamples[latestSamples.length - 1] || null;
  const referenceTs = latest?.ts ?? Date.now();
  const cutoffTs = referenceTs - HISTORY_LOOKBACK_MS;

  const samples = [];
  for (const file of files) {
    samples.push(...readWholeSampleFile(file, cutoffTs));
    sampleOffsets.set(file, statSync(file).size);
  }

  samples.sort((a, b) => a.ts - b.ts);
  return { latest, samples };
}

function updateSamplesFromDisk(sampleDir) {
  if (inMemorySamples.length === 0) {
    const bootstrapped = bootstrapSamples(sampleDir);
    inMemorySamples = bootstrapped.samples;
    return bootstrapped.latest;
  }

  const files = readdirSync(sampleDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  for (const name of files.slice(-4)) {
    inMemorySamples.push(...readNewSamples(join(sampleDir, name)));
  }

  inMemorySamples.sort((a, b) => a.ts - b.ts);
  const latest = inMemorySamples[inMemorySamples.length - 1] || null;
  const cutoffTs = (latest?.ts ?? Date.now()) - HISTORY_LOOKBACK_MS;
  inMemorySamples = inMemorySamples.filter((sample) => sample.ts >= cutoffTs);
  return latest;
}

function parsePass(sample) {
  if (typeof sample.ok === "boolean") return sample.ok;
  if (typeof sample.pass === "boolean") return sample.pass;
  const raw = sample.ok ?? sample.pass;
  if (typeof raw === "string") {
    const value = raw.toLowerCase();
    if (["true", "pass", "1", "yes"].includes(value)) return true;
    if (["false", "block", "0", "no"].includes(value)) return false;
  }
  return null;
}

function calcWindow(samples, referenceTs, windowMs) {
  const start = referenceTs - windowMs;
  let count = 0;
  let passCount = 0;
  const byDirection = Object.fromEntries(
    DIRECTIONS.map((direction) => [direction, { count: 0, passCount: 0, rate: null }]),
  );
  for (const sample of samples) {
    if (sample.ts < start || sample.ts > referenceTs) continue;
    count += 1;
    if (sample.pass) passCount += 1;
    if (byDirection[sample.direction]) {
      byDirection[sample.direction].count += 1;
      if (sample.pass) byDirection[sample.direction].passCount += 1;
    }
  }
  for (const direction of Object.keys(byDirection)) {
    const item = byDirection[direction];
    item.rate = item.count ? item.passCount / item.count : null;
  }
  const directionRates = DIRECTIONS.map((direction) => byDirection[direction].rate)
    .filter((rate) => rate != null);
  const balancedRate = directionRates.length === DIRECTIONS.length
    ? directionRates.reduce((sum, rate) => sum + rate, 0) / directionRates.length
    : null;
  return {
    count,
    passCount,
    rawRate: count ? passCount / count : null,
    rate: balancedRate,
    byDirection,
  };
}

function alignTs(ts, windowMs) {
  return Math.floor(ts / windowMs) * windowMs;
}

function windowStats(samples, referenceTs) {
  const alignedReference = alignTs(referenceTs, 60_000);
  const result = {};
  for (const window of WINDOWS) {
    result[window.key] = {
      label: window.label,
      referenceTs: alignedReference,
      ...calcWindow(samples, alignedReference, window.ms),
    };
  }
  return result;
}

function historyByWindow(samples, referenceTs) {
  const result = {};
  for (const window of WINDOWS) {
    const alignedReference = alignTs(referenceTs, window.ms);
    result[window.key] = Array.from({ length: HISTORY_POINTS }, (_, index) => {
      const ts = alignedReference - (HISTORY_POINTS - 1 - index) * window.ms;
      return { ts, ...calcWindow(samples, ts, window.ms) };
    });
  }
  return result;
}

function slimHistory(history) {
  return Object.fromEntries(
    Object.entries(history).map(([key, points]) => [
      key,
      points.map((point) => ({
        ts: point.ts,
        count: point.count,
        passCount: point.passCount,
        rate: point.rate,
      })),
    ]),
  );
}

function classify(rate, count) {
  if (!count || rate == null) return ANOMALY_STATUS;
  return STATUS_RULES.find((rule) => rule.exclusive ? rate > rule.minRate : rate >= rule.minRate) || ANOMALY_STATUS;
}

function upperBound(samples, ts) {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestDirectionalSample(samples, ts) {
  const index = upperBound(samples, ts);
  const prev = index > 0 ? samples[index - 1] : null;
  const next = index < samples.length ? samples[index] : null;
  const nearest = !prev ? next : !next ? prev
    : Math.abs(prev.ts - ts) <= Math.abs(next.ts - ts) ? prev : next;
  if (!nearest || Math.abs(nearest.ts - ts) > ESTIMATE_MAX_SAMPLE_DISTANCE_MS) return null;
  return nearest;
}

function estimateBrushTime(samples) {
  const byDirection = Object.fromEntries(DIRECTIONS.map((direction) => [direction, []]));
  for (const sample of samples) {
    if (byDirection[sample.direction]) byDirection[sample.direction].push(sample);
  }
  for (const direction of DIRECTIONS) {
    if (byDirection[direction].length === 0) return { ok: false, reason: "insufficient-direction-samples" };
  }

  const latestTs = Math.max(...DIRECTIONS.map((direction) => byDirection[direction].at(-1).ts));
  const firstTs = Math.min(...DIRECTIONS.map((direction) => byDirection[direction][0].ts));
  let ts = latestTs;
  let direction = "USDT->quq";
  let doneSwaps = 0;
  let refreshAttempts = 0;
  let switchCount = 0;
  let iterations = 0;
  const maxIterations = 200_000;

  while (doneSwaps < ESTIMATE_TARGET_SWAPS && ts >= firstTs && iterations < maxIterations) {
    iterations += 1;
    const sample = nearestDirectionalSample(byDirection[direction], ts);
    if (sample?.pass) {
      doneSwaps += 1;
      if (doneSwaps < ESTIMATE_TARGET_SWAPS) {
        direction = direction === "USDT->quq" ? "quq->USDT" : "USDT->quq";
        ts -= ESTIMATE_SWITCH_MS;
        switchCount += 1;
      }
    } else {
      ts -= ESTIMATE_REFRESH_MS;
      refreshAttempts += 1;
    }
  }

  if (doneSwaps < ESTIMATE_TARGET_SWAPS) {
    return {
      ok: false,
      reason: iterations >= maxIterations ? "iteration-limit" : "insufficient-lookback",
      startTs: latestTs,
      endTs: ts,
      doneSwaps,
      targetSwaps: ESTIMATE_TARGET_SWAPS,
      targetRoundTrips: ESTIMATE_TARGET_ROUND_TRIPS,
    };
  }

  const elapsedMs = latestTs - ts;
  return {
    ok: true,
    startTs: latestTs,
    endTs: ts,
    elapsedMs,
    elapsedMinutes: Math.ceil((elapsedMs / 60_000) * 10) / 10,
    refreshAttempts,
    switchCount,
    doneSwaps,
    targetSwaps: ESTIMATE_TARGET_SWAPS,
    targetRoundTrips: ESTIMATE_TARGET_ROUND_TRIPS,
    switchSeconds: ESTIMATE_SWITCH_MS / 1000,
    refreshSeconds: ESTIMATE_REFRESH_MS / 1000,
    sampleMode: "nearest-directional-sample",
  };
}

function buildPayload() {
  const sampleFile = latestSampleFile(SAMPLE_DIR);
  updateSamplesFromDisk(SAMPLE_DIR);
  const referenceTs = Date.now();
  const samples = inMemorySamples;
  const windows = windowStats(samples, referenceTs);
  const history = slimHistory(historyByWindow(samples, referenceTs));
  const status = classify(windows.p3m.rate, windows.p3m.count);
  const brushEstimate = estimateBrushTime(samples);
  return {
    generatedAt: Date.now(),
    nextUpdateAt,
    referenceTs,
    sampleFile,
    totalSamples: samples.length,
    statusRules: STATUS_RULES,
    anomalyStatus: ANOMALY_STATUS,
    status,
    brushEstimate,
    windows,
    history,
  };
}

function refreshCache() {
  nextUpdateAt = Date.now() + UPDATE_INTERVAL_MS;
  cachedPayload = buildPayload();
  if (verboseLogs) console.log(`cache refreshed ${new Date(cachedPayload.generatedAt).toISOString()}`);
}

function msUntilNextMinute(offsetMs = 0) {
  const now = Date.now();
  return Math.floor(now / 60_000) * 60_000 + 60_000 + offsetMs - now;
}

function scheduleCacheRefresh() {
  setTimeout(() => {
    refreshCache();
    scheduleCacheRefresh();
  }, Math.max(0, msUntilNextMinute()));
}

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LiquidMesh Probe Monitor</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8fafc;
      --fg: #111827;
      --muted: #6b7280;
      --soft: #9ca3af;
      --line: #e5e7eb;
      --panel: #ffffff;
      --green: #10b981;
      --yellow: #f59e0b;
      --orange: #f97316;
      --red: #f43f5e;
      --empty: #e5e7eb;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    main { max-width: 1180px; margin: 0 auto; padding: 20px; }
    header { margin-bottom: 18px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    .status { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 14px; margin-top: 8px; white-space: nowrap; }
    .dot { width: 12px; height: 12px; border-radius: 999px; background: var(--empty); }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
    .value { font-size: 32px; line-height: 1; font-variant-numeric: tabular-nums; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }
    .subLine { line-height: 1.45; }
    .historyTitle { color: var(--soft); font-size: 11px; font-weight: 700; letter-spacing: .12em; margin-top: 14px; text-transform: uppercase; }
    .bars { display: grid; grid-template-columns: repeat(60, minmax(2px, 1fr)); gap: 2px; align-items: stretch; margin-top: 7px; min-width: 0; }
    .bar { height: 30px; border-radius: 2px; background: var(--empty); }
    .axis { display: flex; justify-content: space-between; color: var(--soft); font-size: 10px; font-weight: 700; letter-spacing: .12em; margin-top: 6px; }
    .trend { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-top: 12px; }
    .trendHead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
    .trendTitle { color: var(--muted); font-size: 13px; }
    .trendValue { font-size: 20px; font-variant-numeric: tabular-nums; }
    .trendSvg { display: block; width: 100%; height: 220px; }
    .trendAxis { display: flex; justify-content: space-between; color: var(--soft); font-size: 10px; font-weight: 700; letter-spacing: .12em; margin-top: 4px; }
    .trendTip { display: none; position: fixed; z-index: 10; max-width: min(260px, calc(100vw - 24px)); padding: 8px 10px; border-radius: 6px; background: rgba(17, 24, 39, .94); color: #fff; font-size: 12px; line-height: 1.45; pointer-events: none; box-shadow: 0 8px 24px rgba(15, 23, 42, .18); }
    .trendTip strong { display: block; font-size: 13px; margin-bottom: 2px; }
    .hitPoint { cursor: crosshair; touch-action: none; pointer-events: all; }
    .trendHitArea { cursor: crosshair; touch-action: none; pointer-events: all; }
    @media (max-width: 900px) {
      main { padding: 16px; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .bar { height: 24px; }
      .trendSvg { height: 190px; }
    }
    @media (max-width: 560px) {
      main { padding: 14px 12px; }
      h1 { font-size: 22px; }
      .status { align-items: flex-start; flex-wrap: wrap; gap: 6px 10px; font-size: 13px; }
      .metrics { grid-template-columns: 1fr; gap: 10px; }
      .card { padding: 12px; }
      .value { font-size: 30px; }
      .bars { gap: 1px; }
      .bar { height: 22px; }
      .trend { padding: 12px; }
      .trendHead { align-items: flex-start; flex-direction: column; gap: 3px; }
      .trendValue { font-size: 18px; }
      .trendSvg { height: 170px; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>LiquidMesh Probe Monitor</h1>
    <div class="status"><span class="dot" id="statusDot"></span><strong id="statusText">-</strong><span id="updatedText"></span><span id="estimateText"></span></div>
  </header>

  <section class="metrics" id="metrics"></section>
  <section class="trend" id="hourTrend"></section>
</main>
<div class="trendTip" id="trendTip"></div>
<script>
const windows = ['p1m', 'p3m', 'p5m', 'p10m', 'p30m', 'p1h'];
const directions = ['USDT->quq', 'quq->USDT'];
const windowNames = { p1m: '1 MIN', p3m: '3 MIN', p5m: '5 MIN', p10m: '10 MIN', p30m: '30 MIN', p1h: '1 HOUR' };
const fmtPct = (rate) => rate == null ? '-' : Math.round(rate * 100) + '%';
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const fmtMinute = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtHour = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtAxisHour = (ts) => new Date(ts).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtAxisDate = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour12: false });
const fmtShortTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
let statusRules = [];
let anomalyStatus = { state: 'anomaly', title: '无数据', color: '#e5e7eb' };
function estimateHtml(estimate, color) {
  if (!estimate?.ok) return '刷16次预估：-';
  return '刷16次预估：<strong style="color:' + color + '">' + estimate.elapsedMinutes + '分钟</strong>';
}
function classifyClient(rate, count) {
  if (!count || rate == null) return anomalyStatus;
  return statusRules.find((rule) => rule.exclusive ? rate > rule.minRate : rate >= rule.minRate) || anomalyStatus;
}
function statusRank(status) {
  const index = statusRules.findIndex((rule) => rule.state === status.state);
  return index >= 0 ? index : statusRules.length;
}
function directionStatus(item) {
  const statuses = directions.map((direction) => {
    const stats = item.byDirection?.[direction] || { count: 0, passCount: 0, rate: null };
    return { direction, status: classifyClient(stats.rate, stats.count) };
  });
  const worst = statuses.reduce((current, next) =>
    statusRank(next.status) > statusRank(current.status) ? next : current
  );
  const sameState = statuses.every((entry) => entry.status.state === worst.status.state);
  const worstIsBrushable = ['super-green', 'green', 'yellow'].includes(worst.status.state);
  return {
    title: sameState || worstIsBrushable ? worst.status.title : worst.direction + ' ' + worst.status.title,
    color: worst.status.color,
  };
}
function historyBlock(key, points) {
  const bars = points.map((point) => {
    const title = fmtTime(point.ts) + ' ' + (point.count ? Math.round(point.rate * 100) + '% ' + point.passCount + '/' + point.count + ' 通过' : '无数据');
    return '<div class="bar" title="' + title + '" style="background:' + classifyClient(point.rate, point.count).color + '"></div>';
  }).join('');
  return '<div class="historyTitle">' + windowNames[key] + ' HISTORY</div><div class="bars">' + bars + '</div><div class="axis"><span>PAST</span><span>NOW</span></div>';
}
function subText(key, item) {
  return directions.map((direction) => {
    const stats = item.byDirection?.[direction] || { count: 0, passCount: 0 };
    const suffix = stats.passCount ? '平均要刷' + Math.ceil(stats.count / stats.passCount) + '次通过' : '该方向一次都没成功';
    return '<div class="subLine">' + direction + ' ' + stats.passCount + '/' + stats.count + ' ' + suffix + '</div>';
  }).join('');
}
function metricCard(key, item, points) {
  const status = directionStatus(item);
  return '<div class="card"><div class="label">' + item.label + '</div><div class="value" style="color:' + status.color + '">' + fmtPct(item.rate) + ' (' + status.title + ')</div><div class="sub">' + subText(key, item) + '</div>' + historyBlock(key, points) + '</div>';
}
function hourlyTrend(points) {
  const valid = points.filter((point) => point.count && point.rate != null);
  const latest = valid[valid.length - 1];
  const width = 600;
  const height = 205;
  const padX = 34;
  const padY = 16;
  const bottomPad = 32;
  const chartW = width - padX * 2;
  const chartH = height - padY - bottomPad;
  const xFor = (index) => padX + chartW * index / Math.max(points.length - 1, 1);
  const yFor = (rate) => padY + chartH * (1 - rate);
  const pathPoints = points.map((point, index) => {
    if (!point.count || point.rate == null) return null;
    return { x: xFor(index), y: yFor(point.rate), point };
  });
  const lines = [];
  for (let index = 1; index < pathPoints.length; index += 1) {
    const prev = pathPoints[index - 1];
    const current = pathPoints[index];
    if (!prev || !current) continue;
    lines.push('<line x1="' + prev.x.toFixed(1) + '" y1="' + prev.y.toFixed(1) + '" x2="' + current.x.toFixed(1) + '" y2="' + current.y.toFixed(1) + '" stroke="#111827" stroke-width="2.5" stroke-linecap="round" />');
  }
  const circles = pathPoints.filter(Boolean).map((item) => {
    const status = classifyClient(item.point.rate, item.point.count);
    return '<circle cx="' + item.x.toFixed(1) + '" cy="' + item.y.toFixed(1) + '" r="2.8" fill="' + status.color + '"></circle>';
  }).join('');
  const hitPoints = points.map((point, index) => {
    if (!point.count || point.rate == null) return '';
    const x = xFor(index);
    const bucketWidth = chartW / Math.max(points.length - 1, 1);
    const left = Math.max(padX, x - bucketWidth / 2);
    const right = Math.min(width - padX, x + bucketWidth / 2);
    const start = point.ts - 3_600_000;
    const label = fmtAxisDate(start) + ' ' + fmtShortTime(start) + ' - ' + fmtShortTime(point.ts);
    return '<rect class="hitPoint" x="' + left.toFixed(1) + '" y="' + padY + '" width="' + (right - left).toFixed(1) + '" height="' + chartH + '" fill="transparent" data-cx="' + x.toFixed(1) + '" data-index="' + index + '" data-rate="' + fmtPct(point.rate) + '" data-range="' + label + '"></rect>';
  }).join('');
  const grid = [0, .25, .5, .75, 1].map((rate) => {
    const y = yFor(rate).toFixed(1);
    return '<line x1="' + padX + '" y1="' + y + '" x2="' + (width - padX) + '" y2="' + y + '" stroke="#e5e7eb" stroke-width="1" /><text x="4" y="' + (Number(y) + 4) + '" fill="#9ca3af" font-size="10">' + Math.round(rate * 100) + '%</text>';
  }).join('');
  const tickIndexes = [0, 12, 24, 36, 48, 59].filter((index) => index < points.length);
  const axisY = padY + chartH;
  const ticks = tickIndexes.map((index) => {
    const point = points[index];
    const x = xFor(index);
    const hourLabel = point ? fmtAxisHour(point.ts) : '';
    const label = hourLabel === '00:00' && point ? fmtAxisDate(point.ts) + ' 00:00' : hourLabel;
    return '<line x1="' + x.toFixed(1) + '" y1="' + axisY.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + (axisY + 5).toFixed(1) + '" stroke="#9ca3af" stroke-width="1" />'
      + '<text x="' + x.toFixed(1) + '" y="' + (axisY + 19).toFixed(1) + '" fill="#9ca3af" font-size="10" text-anchor="middle">' + label + '</text>';
  }).join('');
  return '<div class="trendHead"><div class="trendTitle">过去60小时成功率变化</div><div class="trendValue">' + fmtPct(latest?.rate) + '</div></div>'
    + '<svg class="trendSvg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="过去60小时成功率变化图">'
    + grid
    + '<line x1="' + padX + '" y1="' + axisY.toFixed(1) + '" x2="' + (width - padX) + '" y2="' + axisY.toFixed(1) + '" stroke="#9ca3af" stroke-width="1" />'
    + ticks
    + '<line class="trendGuide" x1="' + padX + '" y1="' + padY + '" x2="' + padX + '" y2="' + axisY.toFixed(1) + '" stroke="#111827" stroke-width="1.5" stroke-dasharray="4 4" opacity="0" />'
    + lines.join('')
    + circles
    + hitPoints
    + '</svg><div class="trendAxis"><span>PAST</span><span>NOW</span></div>';
}
function bindTrendTooltip() {
  const tip = document.getElementById('trendTip');
  const points = Array.from(document.querySelectorAll('.hitPoint'));
  const guide = document.querySelector('.trendGuide');
  const hide = () => {
    tip.style.display = 'none';
    if (guide) guide.setAttribute('opacity', '0');
  };
  const show = (event, point) => {
    if (!point) return hide();
    tip.innerHTML = '<strong>' + point.dataset.rate + '</strong><span>' + point.dataset.range + '</span>';
    tip.style.display = 'block';
    if (guide) {
      guide.setAttribute('x1', point.dataset.cx);
      guide.setAttribute('x2', point.dataset.cx);
      guide.setAttribute('opacity', '.72');
    }
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, Math.max(12, event.clientX + 12));
    const y = Math.min(window.innerHeight - tip.offsetHeight - 12, Math.max(12, event.clientY + 12));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  for (const point of points) {
    point.addEventListener('pointerenter', (event) => show(event, point));
    point.addEventListener('pointermove', (event) => show(event, point));
    point.addEventListener('pointerdown', (event) => show(event, point));
    point.addEventListener('pointerleave', hide);
    point.addEventListener('pointercancel', hide);
  }
  window.addEventListener('scroll', hide, { passive: true });
}
async function load() {
  const res = await fetch('api/status', { cache: 'no-store' });
  const data = await res.json();
  statusRules = data.statusRules || [];
  anomalyStatus = data.anomalyStatus || anomalyStatus;
  document.getElementById('statusText').textContent = data.status.title;
  document.getElementById('statusDot').style.background = data.status.color;
  document.getElementById('updatedText').textContent = fmtMinute(data.windows.p1m.referenceTs);
  document.getElementById('estimateText').innerHTML = estimateHtml(data.brushEstimate, data.status.color);
  document.getElementById('metrics').innerHTML = windows.map((key) => metricCard(key, data.windows[key], data.history[key])).join('');
  document.getElementById('hourTrend').innerHTML = hourlyTrend(data.history.p1h || []);
  bindTrendTooltip();
}
function msUntilNextMinute(offsetMs = 0) {
  const now = Date.now();
  return Math.floor(now / 60000) * 60000 + 60000 + offsetMs - now;
}
function scheduleLoad() {
  setTimeout(async () => {
    await load();
    scheduleLoad();
  }, Math.max(0, msUntilNextMinute(3000)));
}
load();
scheduleLoad();
</script>
</body>
</html>`;

refreshCache();
scheduleCacheRefresh();

const server = createServer((req, res) => {
  if (req.url === "/api/status") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(cachedPayload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
});

const port = Number(getArg("port", String(DEFAULT_PORT)));
const host = getArg("host", DEFAULT_HOST);
verboseLogs = getBoolArg("verbose", false);
server.listen(port, host, () => {
  console.log(`LiquidMesh monitor web: http://${host}:${port}`);
});
