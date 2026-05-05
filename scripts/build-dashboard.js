import fs from 'fs';
import path from 'path';

const HISTORY_FILE = 'data/monitor-history.json';
const MAX_HISTORY = 50;

function readJSON(filePath, fallback = []) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// Load existing history
const history = fs.existsSync(HISTORY_FILE) ? readJSON(HISTORY_FILE) : [];

// Prepend current run (skip if called from single-url workflow or already in history)
if (fs.existsSync('data/monitor-report.json') && process.env.PHASE !== 'skip') {
  const report = readJSON('data/monitor-report.json', null);
  if (report) {
    const alreadyInHistory = history.some(e => e.timestamp === report.timestamp);
    if (!alreadyInHistory) {
      report.phase = process.env.PHASE || 'widget';
      history.unshift(report);
      if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    }
  }
}

// Load single-url history
const SINGLE_URL_HISTORY_FILE = 'data/single-url-history.json';
const singleUrlHistory = fs.existsSync(SINGLE_URL_HISTORY_FILE)
  ? readJSON(SINGLE_URL_HISTORY_FILE)
  : [];

// Copy compare view screenshots to docs/ — flat directory, no per-run subfolders
const screenshotsSrc = 'test-results/compare-view-screenshots';
const screenshotsDst = 'docs/compare-view-screenshots';
fs.mkdirSync(screenshotsDst, { recursive: true });

// Copy new screenshots and merge manifest.
// Screenshots are organised into named batch subfolders (e.g. "bottega-0421", "marui-0421",
// or legacy "YYYY-MM-DD") inside screenshotsSrc.
if (fs.existsSync(screenshotsSrc)) {
  const dstManifestPath = path.join(screenshotsDst, 'manifest.json');
  const dstManifest = fs.existsSync(dstManifestPath) ? readJSON(dstManifestPath) : [];

  // All subfolders treated as batch names, sorted oldest-first so newer batches overwrite PNGs
  const batchFolders = fs.readdirSync(screenshotsSrc)
    .filter(f => fs.statSync(path.join(screenshotsSrc, f)).isDirectory())
    .sort();

  let totalCopied = 0;
  for (const batch of batchFolders) {
    const srcDir = path.join(screenshotsSrc, batch);
    const srcManifestPath = path.join(srcDir, 'manifest.json');

    if (fs.existsSync(srcManifestPath)) {
      const srcManifest = readJSON(srcManifestPath);
      for (const entry of srcManifest) {
        const enriched = { ...entry, batch };
        // Key by sku+batch so same SKU in different batches stays separate
        const idx = dstManifest.findIndex(e => e.sku === entry.sku && e.batch === batch);
        if (idx >= 0) dstManifest[idx] = enriched;
        else dstManifest.push(enriched);
      }
    }

    const pngs = fs.readdirSync(srcDir).filter(f => f.endsWith('.png'));
    for (const f of pngs) {
      fs.copyFileSync(path.join(srcDir, f), path.join(screenshotsDst, f));
    }
    totalCopied += pngs.length;
  }

  if (batchFolders.length) {
    fs.writeFileSync(dstManifestPath, JSON.stringify(dstManifest, null, 2));
    console.log(`Merged ${batchFolders.length} batch folder(s), copied ${totalCopied} screenshot(s) to ${screenshotsDst}`);
  }
}

// Build compareImages: array of { sku, url, batch } from the manifest
const dstManifestPath = path.join(screenshotsDst, 'manifest.json');
const dstManifest = fs.existsSync(dstManifestPath) ? readJSON(dstManifestPath) : [];
const dstPngs = new Set(fs.readdirSync(screenshotsDst).filter(f => f.endsWith('.png')));
// Migrate old entries (no batch field) to 'older'
for (const e of dstManifest) { if (!e.batch) e.batch = 'older'; }
// Add any PNGs not yet in manifest
for (const f of dstPngs) {
  const sku = f.replace('.png', '');
  if (!dstManifest.some(e => e.sku === sku)) dstManifest.push({ sku, url: null, batch: 'older' });
}
const compareImages = dstManifest.filter(e => dstPngs.has(`${e.sku}.png`));

// Compute KPI metrics from history
function computeMetrics(history) {
  const widgetRuns = history.filter(r => (r.phase || 'widget') === 'widget');
  const latest = widgetRuns[0] || null;
  if (!latest) return { passRate: null, healthScore: null, missingCount: 0, ongoingCount: 0, newMissingCount: 0, botCount: 0, totalMonitored: 0, flakeRate: null, prevFlakeRate: null, passedCount: 0, alertCount: 0, lastUpdated: null };

  const s = latest.summary;
  const bots = latest.botProtected || [];
  const botCount = bots.length;
  const totalMonitored = s.total;
  const effectiveTotal = s.total - s.skipped;
  const passRate = effectiveTotal > 0 ? (s.passed / effectiveTotal * 100) : 0;

  const ongoingMissing = latest.ongoingMissing || [];
  const ongoingCount = ongoingMissing.length;
  const ongoingSet = new Set(ongoingMissing.map(o => o.store));
  const widgetMissingStores = latest.widgetMissingStores || [];
  const newMissingCount = widgetMissingStores.filter(ws => !ongoingSet.has(ws.store)).length;
  const missingCount = s.widgetMissing;
  const healthScore = Math.max(0, Math.round(passRate - (ongoingCount * 1.5)));

  function calcFlake(runs) {
    if (runs.length < 2) return null;
    const allStores = new Set();
    runs.forEach(r => (r.widgetMissingStores || []).forEach(ws => allStores.add(ws.store)));
    let flakeCount = 0;
    allStores.forEach(store => {
      const seenMissing = runs.some(r => (r.widgetMissingStores || []).some(ws => ws.store === store));
      const seenPassing = runs.some(r => !(r.widgetMissingStores || []).some(ws => ws.store === store));
      if (seenMissing && seenPassing) flakeCount++;
    });
    return runs[0]?.summary?.total > 0 ? (flakeCount / runs[0].summary.total * 100) : 0;
  }

  const flakeRaw = calcFlake(widgetRuns.slice(0, 14));
  const prevFlakeRaw = widgetRuns.length >= 15 ? calcFlake(widgetRuns.slice(1, 15)) : null;

  // Previous run metrics (for KPI deltas)
  const prev = widgetRuns[1] || null;
  let prevPassRate = null, prevMissingCount = null, prevHealthScore = null;
  if (prev) {
    const ps = prev.summary;
    const prevEff = ps.total - ps.skipped;
    prevPassRate = prevEff > 0 ? Math.round((ps.passed / prevEff * 100) * 10) / 10 : 0;
    prevMissingCount = ps.widgetMissing;
    const prevOngoing = (prev.ongoingMissing || []).length;
    prevHealthScore = Math.max(0, Math.round(prevPassRate - prevOngoing * 1.5));
  }

  return {
    passRate: Math.round(passRate * 10) / 10,
    healthScore,
    missingCount,
    ongoingCount,
    newMissingCount,
    botCount,
    totalMonitored,
    flakeRate: flakeRaw !== null ? Math.round(flakeRaw * 10) / 10 : null,
    prevFlakeRate: prevFlakeRaw !== null ? Math.round(prevFlakeRaw * 10) / 10 : null,
    prevPassRate,
    prevMissingCount,
    prevHealthScore,
    passedCount: s.passed,
    skippedCount: s.skipped,
    alertCount: newMissingCount + (s.failed || 0),
    lastUpdated: latest.timestamp,
  };
}

const metrics = computeMetrics(history);

// Generate dashboard HTML
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/index.html', generateDashboard(history, compareImages, singleUrlHistory, metrics));
console.log(`Dashboard written — ${history.length} monitor runs, ${singleUrlHistory.length} single-url runs`);

function generateDashboard(history, compareImages, singleUrlHistory, metrics) {
  const dataJson = JSON.stringify(history).replace(/<\/script>/gi, '<\\/script>');
  const compareJson = JSON.stringify(compareImages).replace(/<\/script>/gi, '<\\/script>');
  const singleUrlJson = JSON.stringify(singleUrlHistory).replace(/<\/script>/gi, '<\\/script>');

  const lastUpdated = metrics.lastUpdated
    ? new Date(metrics.lastUpdated).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : '—';
  const hsColor = metrics.healthScore === null ? 'kpi-white' : metrics.healthScore >= 90 ? 'kpi-green' : metrics.healthScore >= 75 ? 'kpi-amber' : 'kpi-red';
  const prColor = metrics.passRate === null ? 'kpi-white' : metrics.passRate >= 90 ? 'kpi-green' : metrics.passRate >= 75 ? 'kpi-amber' : 'kpi-red';
  const flakeColor = metrics.flakeRate === null ? 'kpi-white' : metrics.flakeRate <= 5 ? 'kpi-green' : metrics.flakeRate <= 10 ? 'kpi-amber' : 'kpi-red';
  const flakeTrend = metrics.flakeRate !== null && metrics.prevFlakeRate !== null
    ? (metrics.flakeRate > metrics.prevFlakeRate ? `↑ from ${metrics.prevFlakeRate}% (14d avg)` : `↓ from ${metrics.prevFlakeRate}% (14d avg)`)
    : 'Based on 14d history';
  const isHealthy = !history[0] || (history[0].summary.failed === 0 && metrics.missingCount <= 3);
  const alertBadge = metrics.alertCount > 0 ? `<span class="badge">${metrics.alertCount}</span>` : '';
  const missingColor = metrics.missingCount === 0 ? 'kpi-green' : metrics.missingCount > 3 ? 'kpi-red' : 'kpi-amber';
  const healthyStores = metrics.totalMonitored - metrics.missingCount - metrics.botCount - (metrics.skippedCount || 0);
  const botRatePct = metrics.totalMonitored > 0 ? (metrics.botCount / metrics.totalMonitored * 100).toFixed(1) : '0.0';

  // KPI delta helper — returns a <div> string
  const kpiDeltaHtml = (delta, fmt, upGood) => {
    if (delta === null) return `<div style="font-size:10px;color:#484f58;margin-top:4px">—</div>`;
    if (delta === 0)    return `<div style="font-size:10px;color:#484f58;margin-top:4px">— no change</div>`;
    const good = upGood ? delta > 0 : delta < 0;
    const color = good ? '#3fb950' : '#f85149';
    const arrow = delta > 0 ? '▲' : '▼';
    return `<div style="font-size:10px;color:${color};margin-top:4px">${arrow}${fmt(Math.abs(delta))}</div>`;
  };

  const hsDelta    = metrics.prevHealthScore  !== null ? metrics.healthScore  - metrics.prevHealthScore  : null;
  const prDelta    = metrics.prevPassRate     !== null ? Math.round((metrics.passRate - metrics.prevPassRate) * 10) / 10 : null;
  const misDelta   = metrics.prevMissingCount !== null ? metrics.missingCount - metrics.prevMissingCount  : null;
  const flkDelta   = metrics.flakeRate !== null && metrics.prevFlakeRate !== null
    ? Math.round((metrics.flakeRate - metrics.prevFlakeRate) * 10) / 10 : null;

  const hsDeltaHtml  = kpiDeltaHtml(hsDelta,  v => v + '%',          true);
  const prDeltaHtml  = kpiDeltaHtml(prDelta,  v => v.toFixed(1)+'%', true);
  const misDeltaHtml = kpiDeltaHtml(misDelta, v => String(v),         false);
  const flkDeltaHtml = kpiDeltaHtml(flkDelta, v => v.toFixed(1)+'%', false);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Virtusize QA Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Top header bar ── */
    #topbar {
      display: flex;
      align-items: center;
      height: 52px;
      background: #161b22;
      border-bottom: 1px solid #21262d;
      padding: 0 24px;
      flex-shrink: 0;
      gap: 0;
    }
    .brand {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: #f0f6fc;
      margin-right: 24px;
      white-space: nowrap;
    }
    .topnav { display: flex; gap: 2px; flex: 1; }
    .tnav-btn {
      background: none;
      border: none;
      color: #8b949e;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
    }
    .tnav-btn:hover { background: #21262d; color: #c9d1d9; }
    .tnav-btn.active { background: #21262d; color: #f0f6fc; font-weight: 500; }
    .sys-status {
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 12px;
      white-space: nowrap;
    }
    .sys-status.healthy  { color: #3fb950; background: rgba(63,185,80,0.1);  border: 1px solid rgba(63,185,80,0.2); }
    .sys-status.degraded { color: #d29922; background: rgba(210,153,34,0.1); border: 1px solid rgba(210,153,34,0.2); }

    /* ── Main content ── */
    #content { flex: 1; overflow-y: auto; }

    .panel { display: none; }
    .panel.active { display: block; }

    /* ── Page header (within each panel) ── */
    .page-hdr { padding: 24px 32px 0; margin-bottom: 20px; }
    .page-hdr h1 { font-size: 22px; font-weight: 700; color: #f0f6fc; margin-bottom: 4px; }
    .page-hdr .page-sub { font-size: 13px; color: #8b949e; }

    /* ── Sub-tab bar ── */
    .subtab-bar {
      display: flex;
      gap: 0;
      padding: 0 32px;
      margin-bottom: 24px;
      border-bottom: 1px solid #21262d;
    }
    .subtab {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: #8b949e;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      margin-bottom: -1px;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: color 0.15s, border-color 0.15s;
    }
    .subtab:hover { color: #c9d1d9; }
    .subtab.active { color: #f0f6fc; border-bottom-color: #58a6ff; }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: #f85149;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
    }

    /* ── KPI cards ── */
    .kpi-section { padding: 0 32px; margin-bottom: 24px; }
    .kpi-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 12px; }
    .kpi-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px 18px; }
    .kpi-label { font-size: 10px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: #8b949e; margin-bottom: 8px; }
    .kpi-val { font-size: 30px; font-weight: 700; line-height: 1; margin-bottom: 5px; }
    .kpi-green { color: #3fb950; }
    .kpi-amber { color: #d29922; }
    .kpi-red   { color: #f85149; }
    .kpi-blue  { color: #58a6ff; }
    .kpi-white { color: #f0f6fc; }
    .kpi-sub  { font-size: 11px; color: #8b949e; line-height: 1.4; }
    .kpi-dash { color: #484f58; }

    /* ── Panel body (padded content area below KPI) ── */
    .panel-body { padding: 0 32px 48px; }

    /* ── Flag bar ── */
    .flag-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      margin-bottom: 12px;
      font-size: 13px;
      color: #8b949e;
    }
    .flag-bar button {
      padding: 5px 12px;
      background: #238636;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    .flag-bar button:disabled {
      background: #21262d;
      color: #484f58;
      cursor: default;
    }

    h1 { font-size: 20px; font-weight: 600; color: #f0f6fc; margin-bottom: 6px; }
    .panel-subtitle { font-size: 13px; color: #8b949e; margin-bottom: 24px; }

    /* ── Summary card ── */
    .summary-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 18px 22px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .summary-card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-card .stat { font-size: 28px; font-weight: 700; line-height: 1; }
    .summary-card .stat-block { text-align: center; min-width: 64px; }
    .summary-card .divider { width: 1px; height: 40px; background: #21262d; }
    .stat.passed { color: #3fb950; }
    .stat.missing { color: #d29922; }
    .stat.failed { color: #f85149; }
    .stat.skipped { color: #8b949e; }

    /* ── Filters ── */
    .filters {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .filter-btn {
      padding: 4px 12px;
      border-radius: 20px;
      border: 1px solid #30363d;
      background: transparent;
      color: #8b949e;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover, .filter-btn.active {
      background: #21262d;
      color: #c9d1d9;
      border-color: #58a6ff;
    }

    /* ── Table ── */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    thead th {
      text-align: left;
      padding: 8px 12px;
      font-size: 12px;
      color: #8b949e;
      font-weight: 500;
      border-bottom: 1px solid #21262d;
      white-space: nowrap;
    }
    tbody tr.run-row {
      border-bottom: 1px solid #161b22;
      cursor: pointer;
      transition: background 0.1s;
    }
    tbody tr.run-row:hover { background: #161b22; }
    tbody td { padding: 10px 12px; vertical-align: middle; }
    .ts { color: #8b949e; font-size: 13px; white-space: nowrap; }
    .phase-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .phase-widget { background: #1f3a5f; color: #58a6ff; }
    .phase-api    { background: #2d1f5e; color: #a78bfa; }
    .flow-apparel  { background: #1a3a2a; color: #3fb950; }
    .flow-footwear { background: #1f3a5f; color: #58a6ff; }
    .flow-bag      { background: #3a2a1a; color: #d29922; }
    .flow-kids     { background: #3a1a2a; color: #f778ba; }
    .flow-noVisor  { background: #21262d; color: #8b949e; }
    .count { font-weight: 600; text-align: right; }
    .count.passed { color: #3fb950; }
    .count.missing { color: #d29922; }
    .count.failed { color: #f85149; }
    .count.skipped { color: #8b949e; }
    .count.zero { color: #30363d; font-weight: 400; }
    .run-link { font-size: 13px; }
    .chevron { color: #8b949e; font-size: 12px; transition: transform 0.2s; display: inline-block; }
    .chevron.open { transform: rotate(90deg); }

    /* ── Detail row ── */
    .detail-row { display: none; }
    .detail-row.open { display: table-row; }
    .detail-cell { padding: 0 12px 16px 12px; background: #0d1117; }
    .detail-inner {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 6px;
      padding: 14px 16px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 16px;
    }
    .detail-section h4 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b949e;
      margin-bottom: 8px;
    }
    .detail-section ul { list-style: none; }
    .detail-section li { font-size: 13px; padding: 2px 0; }
    .detail-section li .store { color: #c9d1d9; }
    .detail-section li a.store { color: #58a6ff; }
    .detail-section li a.store:hover { text-decoration: underline; }
    .detail-section li .meta { color: #8b949e; font-size: 12px; }
    .detail-section li .error-text {
      color: #f85149;
      font-size: 11px;
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    .none-label { color: #3fb950; font-size: 13px; }

    /* ── Status dot ── */
    .status-dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .dot-green  { background: #3fb950; }
    .dot-yellow { background: #d29922; }
    .dot-red    { background: #f85149; }

    /* ── Overlay gallery ── */
    .overlay-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-top: 20px;
    }
    .overlay-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .overlay-card img { width: 100%; display: block; }
    .overlay-card .card-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px 6px;
    }
    .overlay-card .card-sku {
      flex: 1;
      font-size: 13px;
      font-weight: 600;
      color: #f0f6fc;
    }
    /* ── Tag pills ── */
    .tag-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 4px 12px 12px;
    }
    .tag-btn {
      padding: 3px 10px;
      border: 1px solid var(--tag-color);
      border-radius: 20px;
      background: transparent;
      color: var(--tag-color);
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .tag-btn.active {
      background: var(--tag-color);
      color: #0d1117;
      font-weight: 600;
    }
    .tag-btn:hover:not(.active) {
      background: color-mix(in srgb, var(--tag-color) 18%, transparent);
    }
    /* ── Tag summary bar ── */
    .tag-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      font-size: 13px;
      color: #8b949e;
    }
    .tag-bar-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      flex: 1;
    }
    .tag-bar-item {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      white-space: nowrap;
    }
    .tag-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tag-bar button {
      padding: 5px 12px;
      background: #238636;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    .tag-bar button:disabled {
      background: #21262d;
      color: #484f58;
      cursor: default;
    }

    /* ── Info panel ── */
    .info-panel {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 32px;
      text-align: center;
      max-width: 480px;
    }
    .info-panel .icon { font-size: 36px; margin-bottom: 12px; }
    .info-panel p { color: #8b949e; font-size: 14px; line-height: 1.6; }
    .run-cmd {
      display: inline-block;
      background: #0d1117;
      border: 1px solid #21262d;
      color: #a5d6ff;
      font-family: monospace;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 6px;
      margin-top: 14px;
    }

    .empty-state { color: #8b949e; font-size: 14px; padding: 48px 0; text-align: center; }

    @media (max-width: 640px) {
      #topbar .topnav { display: none; }
      .kpi-section, .subtab-bar, .page-hdr { padding-left: 16px; padding-right: 16px; }
      .panel-body { padding-left: 16px; padding-right: 16px; }
      .kpi-row { grid-template-columns: repeat(2, 1fr); }
      .summary-card .divider { display: none; }
    }
  </style>
</head>
<body>

<header id="topbar">
  <div class="brand">Virtusize QA</div>
  <nav class="topnav">
    <button class="tnav-btn active" onclick="showPanel('monitor')" id="btn-monitor">Monitor</button>
    <button class="tnav-btn" onclick="showPanel('single')" id="btn-single">Single URL</button>
    <button class="tnav-btn" onclick="showPanel('compare')" id="btn-compare">Compare View</button>
    <button class="tnav-btn" onclick="showPanel('inpage')" id="btn-inpage">Inpage</button>
    <button class="tnav-btn" onclick="showPanel('cart')" id="btn-cart">Cart</button>
    <button class="tnav-btn" onclick="showPanel('cost')" id="btn-cost">Cost per client</button>
    <button class="tnav-btn" onclick="showPanel('alerting')" id="btn-alerting">Alerting</button>
  </nav>
  <div class="sys-status ${isHealthy ? 'healthy' : 'degraded'}">● System ${isHealthy ? 'healthy' : 'degraded'}</div>
</header>

<main id="content">

  <!-- Monitor -->
  <div class="panel active" id="panel-monitor">
    <div class="page-hdr">
      <h1>Monitor Health</h1>
      <p class="page-sub">Operational intelligence · Last updated ${lastUpdated}</p>
    </div>

    <div class="subtab-bar">
      <button class="subtab active" onclick="showMonitorSubtab('overview', this)">Overview</button>
      <button class="subtab" onclick="showMonitorSubtab('history', this)">History</button>
      <button class="subtab" onclick="showMonitorSubtab('missing', this)">Missing Stores</button>
      <button class="subtab" onclick="showMonitorSubtab('alerts', this)">Alerts \${alertBadge}</button>
    </div>

    <div id="monitor-overview">
    <div class="kpi-section">
      <div class="kpi-row">
        <div class="kpi-card">
          <div class="kpi-label">Health Score</div>
          <div class="kpi-val ${hsColor}">${metrics.healthScore !== null ? metrics.healthScore + '%' : '—'}</div>
          <div class="kpi-sub">target ≥ 90%</div>
          ${hsDeltaHtml}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Pass Rate</div>
          <div class="kpi-val ${prColor}">${metrics.passRate !== null ? metrics.passRate + '%' : '—'}</div>
          <div class="kpi-sub">${metrics.passedCount}/${metrics.totalMonitored} tests</div>
          ${prDeltaHtml}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Missing Stores</div>
          <div class="kpi-val ${missingColor}">${metrics.missingCount}</div>
          <div class="kpi-sub">${metrics.ongoingCount} ongoing · ${metrics.newMissingCount} new</div>
          ${misDeltaHtml}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Flake Rate</div>
          <div class="kpi-val ${flakeColor}">${metrics.flakeRate !== null ? metrics.flakeRate + '%' : '—'}</div>
          <div class="kpi-sub">${flakeTrend}</div>
          ${flkDeltaHtml}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg Exec Time</div>
          <div class="kpi-val kpi-white">—</div>
          <div class="kpi-sub kpi-dash">Not tracked yet</div>
          <div style="font-size:10px;color:#484f58;margin-top:4px">—</div>
        </div>
      </div>
      <div class="kpi-row">
        <div class="kpi-card">
          <div class="kpi-label">Monthly CI Cost</div>
          <div class="kpi-val kpi-white">—</div>
          <div class="kpi-sub kpi-dash">Not tracked yet</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Healthy Clients</div>
          <div class="kpi-val ${metrics.passRate >= 90 ? 'kpi-green' : 'kpi-amber'}">${healthyStores}/${metrics.totalMonitored}</div>
          <div class="kpi-sub">${metrics.botCount} bot-blocked</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Bot Block Rate</div>
          <div class="kpi-val ${metrics.botCount > 0 ? 'kpi-amber' : 'kpi-green'}">${botRatePct}%</div>
          <div class="kpi-sub">${metrics.botCount} of ${metrics.totalMonitored} stores</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">MTTR</div>
          <div class="kpi-val kpi-white">—</div>
          <div class="kpi-sub kpi-dash">Not tracked yet</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Deploy Correlation</div>
          <div class="kpi-val kpi-white">—</div>
          <div class="kpi-sub kpi-dash">Not tracked yet</div>
        </div>
      </div>
    </div>

    <div class="panel-body">
      <div class="summary-card" id="summary-card"></div>
      <div id="flaky-stores-section" style="margin-top:32px"></div>
    </div>
    </div>

    <div id="monitor-history" style="display:none">
    <div class="panel-body">
      <div class="filters" id="history-filters">
        <button class="filter-btn active" data-phase="all">All phases</button>
        <button class="filter-btn" data-phase="widget">Widget</button>
        <button class="filter-btn" data-phase="api">API</button>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width:20px"></th>
            <th>Date &amp; Time</th>
            <th>Phase</th>
            <th style="text-align:right">✅ Passed</th>
            <th style="text-align:right">⚠️ Missing</th>
            <th style="text-align:right">❌ Failed</th>
            <th style="text-align:center">Δ vs prev</th>
            <th style="text-align:right">⏭ Skipped</th>
            <th>Run</th>
          </tr>
        </thead>
        <tbody id="runs-body"></tbody>
      </table>
    </div>
    </div>
  </div>

  <!-- Single URL -->
  <div class="panel" id="panel-single">
    <div class="page-hdr">
      <h1>Single URL Tests</h1>
      <p class="page-sub">Per-URL tests run across chrome, firefox, and webkit</p>
    </div>
    <div class="panel-body">
    <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:16px;margin-bottom:24px">
      <div style="font-size:13px;font-weight:600;color:#c9d1d9;margin-bottom:12px">Run a new test</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">GitHub PAT (workflow scope) — saved in browser only</label>
          <input id="single-pat" type="password" placeholder="ghp_xxxxxxxxxxxx"
            style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 10px;font-size:13px"
            oninput="localStorage.setItem('gh_pat', this.value); document.getElementById('gh-pat').value = this.value">
        </div>
        <div>
          <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">Phase</label>
          <select id="single-phase"
            style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 10px;font-size:13px;cursor:pointer">
            <option value="full">full — complete flow</option>
            <option value="widget">widget — widget present &amp; opens</option>
            <option value="api">api — PDC integration check</option>
            <option value="onboarding">onboarding — onboarding flow only</option>
            <option value="compare">compare — compare view screenshot</option>
            <option value="events">events — events fired check</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">Product page URL</label>
        <input id="single-url-input" type="url" placeholder="https://example.com/product"
          style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 10px;font-size:13px">
      </div>
      <details style="margin-bottom:8px">
        <summary style="font-size:12px;color:#8b949e;cursor:pointer;user-select:none">Onboarding body (apparel &amp; noVisor only)</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:8px">
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Gender</label>
            <select id="single-ob-gender"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">Female (0)</option>
              <option value="1">Male (1)</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Age (years)</label>
            <input id="single-ob-age" type="number" value="35" min="10" max="99"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px">
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Height (cm)</label>
            <input id="single-ob-height" type="number" value="161" min="100" max="220"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px">
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Weight (kg)</label>
            <input id="single-ob-weight" type="number" value="54" min="30" max="200"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px">
          </div>
        </div>
      </details>
      <details style="margin-bottom:8px">
        <summary style="font-size:12px;color:#8b949e;cursor:pointer;user-select:none">Gift flow body (apparel only)</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:8px">
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Gender</label>
            <select id="single-gift-gender"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">Female (0)</option>
              <option value="1">Male (1)</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Age range</label>
            <select id="single-gift-age"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">16-19</option>
              <option value="1">20-25</option>
              <option value="2">26-29</option>
              <option value="3" selected>30-39</option>
              <option value="4">40-49</option>
              <option value="5">50-59</option>
              <option value="6">&gt;60</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Height (cm)</label>
            <select id="single-gift-height"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">145-149</option>
              <option value="1">150-154</option>
              <option value="2">155-159</option>
              <option value="3" selected>160-164</option>
              <option value="4">165-169</option>
              <option value="5">170-174</option>
              <option value="6">175-179</option>
              <option value="7">180-184</option>
              <option value="8">185-189</option>
              <option value="9">190-194</option>
              <option value="10">195+</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Body type (weight)</label>
            <select id="single-gift-bodytype"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">&lt;52 kg</option>
              <option value="1" selected>52 - 63 kg</option>
              <option value="2">63 - 74 kg</option>
              <option value="3">74 - 84 kg</option>
              <option value="4">85 - 98 kg</option>
              <option value="5">&gt;98 kg</option>
            </select>
          </div>
        </div>
      </details>
      <details style="margin-bottom:8px">
        <summary style="font-size:12px;color:#8b949e;cursor:pointer;user-select:none">Footwear onboarding (footwear flow only)</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px">
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Gender</label>
            <select id="single-fw-gender"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">Female (0)</option>
              <option value="1">Male (1)</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Brand</label>
            <select id="single-fw-brand"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">Under Armour</option>
              <option value="1" selected>Adidas</option>
              <option value="2">Asics</option>
              <option value="3">Converse</option>
              <option value="4">New Balance</option>
              <option value="5">Nike</option>
              <option value="6">Puma</option>
              <option value="7">Reebok</option>
              <option value="8">Vans</option>
              <option value="9">I don't know</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Shoe size</label>
            <select id="single-fw-size"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              ${Array.from({length: 37}, (_, i) => {
                const cm = (17 + i * 0.5).toFixed(1).replace('.0', '');
                return `<option value="${i}"${i === 17 ? ' selected' : ''}>${cm} cm</option>`;
              }).join('')}
            </select>
          </div>
        </div>
      </details>
      <details style="margin-bottom:12px">
        <summary style="font-size:12px;color:#8b949e;cursor:pointer;user-select:none">Kids onboarding (kids flow only)</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:8px">
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Gender</label>
            <select id="single-kids-gender"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              <option value="0">Girl (0)</option>
              <option value="1">Boy (1)</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Age</label>
            <select id="single-kids-age"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px;cursor:pointer">
              ${Array.from({length: 16}, (_, i) => `<option value="${i}"${i === 5 ? ' selected' : ''}>${i + 3} yr</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Height (cm)</label>
            <input id="single-kids-height" type="number" value="120" min="60" max="180"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px">
          </div>
          <div>
            <label style="font-size:11px;color:#8b949e;display:block;margin-bottom:3px">Weight (kg)</label>
            <input id="single-kids-weight" type="number" value="25" min="10" max="100"
              style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 8px;font-size:12px">
          </div>
        </div>
      </details>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:6px">Browsers</label>
        <div style="display:flex;gap:16px;align-items:center">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:#c9d1d9;cursor:default">
            <input type="checkbox" id="browser-chrome" checked disabled
              style="accent-color:#3fb950;width:14px;height:14px">
            Chrome
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:#c9d1d9;cursor:pointer">
            <input type="checkbox" id="browser-firefox"
              style="accent-color:#3fb950;width:14px;height:14px">
            Firefox
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:#c9d1d9;cursor:pointer">
            <input type="checkbox" id="browser-webkit"
              style="accent-color:#3fb950;width:14px;height:14px">
            WebKit
          </label>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <button onclick="triggerSingleRun()"
          style="padding:7px 18px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500">
          Run on GitHub Actions ▶
        </button>
        <span id="single-trigger-status" style="font-size:12px;color:#8b949e"></span>
      </div>
    </div>

    <div class="flag-bar">
      <span id="single-flag-count">0 items flagged</span>
      <button id="single-export-btn" onclick="exportSingleFlagged()" disabled>Export flagged URLs</button>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:20px"></th>
          <th style="width:32px"></th>
          <th>Date &amp; Time</th>
          <th>URL</th>
          <th>Store</th>
          <th>Flow</th>
          <th>Phase</th>
          <th>Chrome</th>
          <th>Firefox</th>
          <th>WebKit</th>
          <th>Run</th>
        </tr>
      </thead>
      <tbody id="single-url-body"></tbody>
    </table>
    </div>
  </div>

  <!-- Compare View -->
  <div class="panel" id="panel-compare">
    <div class="page-hdr">
      <h1>Compare View</h1>
      <p class="page-sub">Screenshots of the compare view after onboarding — bags, apparel, footwear</p>
    </div>
    <div class="panel-body">
    <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:16px;margin-bottom:24px">
      <div style="font-size:13px;font-weight:600;color:#c9d1d9;margin-bottom:12px">Run new screenshot test</div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">GitHub PAT (workflow scope) — saved in browser only</label>
        <input id="gh-pat" type="password" placeholder="ghp_xxxxxxxxxxxx"
          style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 10px;font-size:13px"
          oninput="localStorage.setItem('gh_pat', this.value); document.getElementById('single-pat').value = this.value">
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">Batch name — groups screenshots together (e.g. bottega-0421, marui-0421)</label>
        <input id="compare-batch" type="text" placeholder="bottega-0421"
          style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 10px;font-size:13px">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">URLs — one per line</label>
        <textarea id="compare-urls" rows="6" placeholder="https://example.com/product-1&#10;https://example.com/product-2"
          style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px 10px;font-size:12px;font-family:monospace;resize:vertical"></textarea>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <button onclick="triggerCompareRun()"
          style="padding:7px 18px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500">
          Run on GitHub Actions ▶
        </button>
        <span id="compare-trigger-status" style="font-size:12px;color:#8b949e"></span>
      </div>
    </div>

    <div id="compare-content"></div>
    </div>
  </div>

  <!-- Inpage -->
  <div class="panel" id="panel-inpage">
    <div class="page-hdr">
      <h1>Inpage QA</h1>
      <p class="page-sub">Full user journey through the inpage widget</p>
    </div>
    <div class="panel-body">
      <div class="info-panel">
        <div class="icon">🧪</div>
        <p>Run locally against any store or URL. Results appear in the Playwright HTML report.</p>
        <div class="run-cmd">npx playwright test tests/inpage.spec.js --project=chrome</div>
      </div>
    </div>
  </div>

  <!-- Add to Cart -->
  <div class="panel" id="panel-cart">
    <div class="page-hdr">
      <h1>Add to Cart</h1>
      <p class="page-sub">Validates the add-to-cart flow after size recommendation</p>
    </div>
    <div class="panel-body">
      <div class="info-panel">
        <div class="icon">🛒</div>
        <p>Run locally. Results appear in the Playwright HTML report.</p>
        <div class="run-cmd">npx playwright test tests/addToCart.spec.js --project=chrome</div>
      </div>
    </div>
  </div>

  <!-- Cost per client -->
  <div class="panel" id="panel-cost">
    <div class="page-hdr">
      <h1>Cost per Client</h1>
      <p class="page-sub">GitHub Actions CI spend estimates · 30 runs/month · $0.008/min</p>
    </div>
    <div class="kpi-section">
      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr)">
        <div class="kpi-card">
          <div class="kpi-label">Total monthly</div>
          <div class="kpi-val" style="color:#bc8cff">$73</div>
          <div class="kpi-sub">GH Actions estimate</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Wasted spend</div>
          <div class="kpi-val kpi-red">$30</div>
          <div class="kpi-sub">41% — broken/bot stores</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Productive</div>
          <div class="kpi-val kpi-green">$43</div>
          <div class="kpi-sub">73 healthy stores</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Cost/healthy test</div>
          <div class="kpi-val kpi-white">$0.56</div>
          <div class="kpi-sub">per passing test/mo</div>
        </div>
      </div>
    </div>
    <div class="panel-body">
      <div id="cost-chart-container"></div>
    </div>
  </div>

  <!-- Alerting -->
  <div class="panel" id="panel-alerting">
    <div class="page-hdr">
      <h1>Alerting</h1>
      <p class="page-sub">Alert rules, channels, and digest schedule</p>
    </div>
    <div class="panel-body">

      <div style="background:#3a1515;border:1px solid #f85149;border-radius:6px;padding:10px 14px;font-size:12px;color:#f85149;margin-bottom:24px">
        Channel updated: all alerts post to <strong>#qa-automation-run</strong> (changed from #qa-automation-alerts).
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">
        <div class="kpi-card">
          <div class="kpi-label">Immediate alerts</div>
          <div class="kpi-val kpi-red">8</div>
          <div class="kpi-sub">fire within 1 min</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Daily digest</div>
          <div class="kpi-val kpi-white">09:00</div>
          <div class="kpi-sub">GMT+9 after run</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Weekly summary</div>
          <div class="kpi-val kpi-white">Mon</div>
          <div class="kpi-sub">09:30 GMT+9</div>
        </div>
      </div>

      <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:18px 22px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#f0f6fc;margin-bottom:14px">IMMEDIATE ALERTS — FIRE WITHIN 1 MIN</div>
        <div style="display:flex;flex-direction:column;gap:6px">

          <div style="border-left:3px solid #f85149;padding:8px 11px;background:#0d1117;border-radius:0 4px 4px 0">
            <div style="font-size:13px;font-weight:600;color:#f85149;margin-bottom:3px">Any test → FAILED</div>
            <div style="font-size:12px;color:#8b949e">Store, URL, failure type, screenshot → #qa-automation-run</div>
          </div>

          <div style="border-left:3px solid #f85149;padding:8px 11px;background:#0d1117;border-radius:0 4px 4px 0">
            <div style="font-size:13px;font-weight:600;color:#f85149;margin-bottom:3px">New store enters MISSING</div>
            <div style="font-size:12px;color:#8b949e">Store name, last-passing timestamp → #qa-automation-run</div>
          </div>

          <div style="border-left:3px solid #f85149;padding:8px 11px;background:#0d1117;border-radius:0 4px 4px 0">
            <div style="font-size:13px;font-weight:600;color:#f85149;margin-bottom:3px">Health Score drops below 75%</div>
            <div style="font-size:12px;color:#8b949e">Score, delta, contributing factors → #qa-automation-run</div>
          </div>

          <div style="border-left:3px solid #d29922;padding:8px 11px;background:#0d1117;border-radius:0 4px 4px 0">
            <div style="font-size:13px;font-weight:600;color:#d29922;margin-bottom:3px">p95 exec time &gt; 45 minutes</div>
            <div style="font-size:12px;color:#8b949e">Top 3 slowest stores + durations → #qa-automation-run</div>
          </div>

          <div style="border-left:3px solid #d29922;padding:8px 11px;background:#0d1117;border-radius:0 4px 4px 0">
            <div style="font-size:13px;font-weight:600;color:#d29922;margin-bottom:3px">Store crosses 10-miss threshold</div>
            <div style="font-size:12px;color:#8b949e">Store, miss count, Jira link, owner → #qa-automation-run</div>
          </div>

          <div style="border-left:3px solid #3fb950;padding:8px 11px;background:#0d1117;border-radius:0 4px 4px 0">
            <div style="font-size:13px;font-weight:600;color:#3fb950;margin-bottom:3px">Store recovers (Phase 3)</div>
            <div style="font-size:12px;color:#8b949e">Store name, MTTR duration → #qa-automation-run</div>
          </div>

        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

        <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:18px 22px">
          <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#f0f6fc;margin-bottom:14px">DAILY DIGEST — 09:00 GMT+9</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">Full run summary + delta from yesterday</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#e3760e;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">All MISSING stores with consecutive-miss count</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#d29922;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">Flake rate for the run</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#bc8cff;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">Total CI cost for the day</span>
            </div>
          </div>
        </div>

        <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:18px 22px">
          <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#f0f6fc;margin-bottom:14px">WEEKLY SUMMARY — MON 09:30 GMT+9</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">7-day pass rate trend</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#e3760e;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">Aging missing stores — 5+ consecutive</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#d29922;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">Bot protection status until resolved</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="width:8px;height:8px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:4px"></span>
              <span style="font-size:13px;color:#c9d1d9">Action items requiring human attention</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

</main>

<script>
const HISTORY = ${dataJson};
const SINGLE_URL_HISTORY = ${singleUrlJson};
const COMPARE_IMAGES = ${compareJson};

// ── Monitor subtab switcher ──────────────────────────────────────────────────
function showMonitorSubtab(name, btn) {
  document.querySelectorAll('#panel-monitor .subtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('monitor-overview').style.display = name === 'overview' ? '' : 'none';
  document.getElementById('monitor-history').style.display  = name === 'history'  ? '' : 'none';
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tnav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('btn-' + name).classList.add('active');
  if (name === 'compare') renderCompareView();
  if (name === 'single') renderSingleUrl();
  if (name === 'cost') renderCostPanel();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
}

function statusDot(run) {
  if (run.summary.failed > 0) return '<span class="status-dot dot-red"></span>';
  if (run.summary.widgetMissing > 0) return '<span class="status-dot dot-yellow"></span>';
  return '<span class="status-dot dot-green"></span>';
}

function countClass(n, type) { return n === 0 ? 'zero' : type; }

// ── Monitor: summary card ─────────────────────────────────────────────────────
function renderSummary(run) {
  const el = document.getElementById('summary-card');
  if (!run) { el.textContent = 'No runs yet.'; return; }
  const s = run.summary;
  el.innerHTML = \`
    <div class="stat-block"><div class="label">Passed</div><div class="stat passed">\${s.passed}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Missing</div><div class="stat missing">\${s.widgetMissing}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Failed</div><div class="stat failed">\${s.failed}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Skipped</div><div class="stat skipped">\${s.skipped}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Total</div><div class="stat" style="color:#f0f6fc">\${s.total}</div></div>
    <div style="margin-left:auto;font-size:12px;color:#8b949e">Last run: \${fmt(run.timestamp)}</div>
  \`;
}

// ── Store sparkline (7-day bar chart) ────────────────────────────────────────
function storeSparkline(storeName) {
  const runs = HISTORY.filter(r => (r.phase || 'widget') === 'widget').slice(0, 7).reverse();
  const bars = [];
  for (let i = 0; i < 7; i++) {
    const r = runs[i];
    let color, height;
    if (!r) {
      color = '#30363d'; height = '2.4px';
    } else {
      const missing = (r.widgetMissingStores || []).some(s => s.store === storeName);
      const skipped = (r.skippedStores || []).some(s => (s.store || s) === storeName)
                   || (r.botProtected || []).includes(storeName);
      if (missing)       { color = '#f85149'; height = '2.4px'; }
      else if (skipped)  { color = '#30363d'; height = '2.4px'; }
      else               { color = '#3fb950'; height = '12px';  }
    }
    bars.push(\`<span style="width:3px;height:\${height};background:\${color};display:inline-block;border-radius:1px"></span>\`);
  }
  return \`<span style="display:inline-flex;align-items:flex-end;gap:1px;margin-left:8px;vertical-align:middle">\${bars.join('')}</span>\`;
}

// ── Monitor: expandable detail row ────────────────────────────────────────────
function renderDetail(run) {
  const issues = run.newIssues || [];
  const widgetMissingStores = run.widgetMissingStores || [];
  const ongoingMissing = run.ongoingMissing || [];
  const bots = run.botProtected || [];
  const skipped = run.skippedStores || [];

  const browserTag = (browsers) => browsers?.length
    ? \`<span class="meta">\${browsers.join(', ')}</span>\`
    : '';

  const issueHtml = issues.length === 0
    ? '<span class="none-label">None</span>'
    : issues.map(i => \`<li>
        \${i.url ? \`<a class="store" href="\${i.url}" target="_blank" rel="noopener">\${i.store}</a>\` : \`<span class="store">\${i.store}</span>\`}
        \${browserTag(i.browsers)}
        <span class="error-text">\${i.error || ''}</span>
      </li>\`).join('');

  const ongoingMap = Object.fromEntries(ongoingMissing.map(o => [o.store, o.consecutiveRuns]));
  const newMissing = widgetMissingStores.filter(s => !ongoingMap[s.store]);
  const recurring = widgetMissingStores.filter(s => ongoingMap[s.store]).map(s => ({ ...s, runs: ongoingMap[s.store] + 1 }));

  const newMissingHtml = newMissing.length === 0 ? '' :
    \`<div class="detail-section"><h4>⚠️ Widget missing (new)</h4><ul>\${newMissing.map(s => \`<li>
        \${s.url ? \`<a class="store" href="\${s.url}" target="_blank" rel="noopener">\${s.store}</a>\` : \`<span class="store">\${s.store}</span>\`}\${storeSparkline(s.store)}
        \${browserTag(s.browsers)}
      </li>\`).join('')}</ul></div>\`;

  const recurringHtml = recurring.length === 0 ? '' :
    \`<div class="detail-section"><h4>⚠️ Widget missing (ongoing)</h4><ul>\${recurring.map(m => \`<li>
        \${m.url ? \`<a class="store" href="\${m.url}" target="_blank" rel="noopener">\${m.store}</a>\` : \`<span class="store">\${m.store}</span>\`}\${storeSparkline(m.store)}
        \${browserTag(m.browsers)}
        <span class="meta">×\${m.runs} runs</span>
      </li>\`).join('')}</ul></div>\`;

  const botHtml = bots.length === 0
    ? '<span class="none-label">None</span>'
    : bots.map(b => \`<li><span class="store">\${b}</span></li>\`).join('');

  const skippedHtml = skipped.length === 0
    ? '<span class="none-label">None</span>'
    : skipped.map(s => \`<li><span class="store">\${s.store || s}</span>\${s.reason ? \` <span class="meta">(\${s.reason})</span>\` : ''}</li>\`).join('');

  return \`<div class="detail-inner">
    <div class="detail-section"><h4>❌ Failed</h4><ul>\${issueHtml}</ul></div>
    \${newMissingHtml}
    \${recurringHtml}
    <div class="detail-section"><h4>🤖 Bot protected</h4><ul>\${botHtml}</ul></div>
    <div class="detail-section"><h4>⏭ Skipped</h4><ul>\${skippedHtml}</ul></div>
  </div>\`;
}

// ── Monitor: history table ────────────────────────────────────────────────────
let activePhase = 'all';

function deltaCell(curr, prev) {
  if (!prev) return \`<td style="color:#484f58;font-size:10px;text-align:center">—</td>\`;
  const dM = curr.widgetMissing - prev.widgetMissing;
  const dP = curr.passed - prev.passed;
  if (dM === 0 && dP === 0) return \`<td style="color:#484f58;font-size:10px;text-align:center">— no change</td>\`;
  const parts = [];
  if (dM !== 0) {
    const col = dM > 0 ? '#f85149' : '#3fb950';
    parts.push(\`<span style="color:\${col}">\${dM > 0 ? '▲' : '▼'}\${Math.abs(dM)} missing</span>\`);
  }
  if (dP !== 0) {
    const col = dP < 0 ? '#f85149' : '#3fb950';
    parts.push(\`<span style="color:\${col}">\${dP > 0 ? '▲' : '▼'}\${Math.abs(dP)} passed</span>\`);
  }
  return \`<td style="font-size:10px;text-align:center;white-space:nowrap;line-height:1.6">\${parts.join('<br>')}</td>\`;
}

function renderTable() {
  const tbody = document.getElementById('runs-body');
  const filtered = activePhase === 'all' ? HISTORY : HISTORY.filter(r => (r.phase || 'widget') === activePhase);
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No runs yet.</td></tr>';
    return;
  }

  filtered.forEach((run, i) => {
    const s = run.summary;
    const phase = run.phase || 'widget';
    const runUrl = run.githubRunUrl || '#';
    const prevSummary = filtered[i + 1]?.summary ?? null;

    const row = document.createElement('tr');
    row.className = 'run-row';
    row.innerHTML = \`
      <td><span class="chevron" id="chev-\${i}">›</span></td>
      <td class="ts">\${statusDot(run)}\${fmt(run.timestamp)}</td>
      <td><span class="phase-badge phase-\${phase}">\${phase}</span></td>
      <td class="count passed \${countClass(s.passed,'passed')}">\${s.passed}</td>
      <td class="count missing \${countClass(s.widgetMissing,'missing')}">\${s.widgetMissing}</td>
      <td class="count failed \${countClass(s.failed,'failed')}">\${s.failed}</td>
      \${deltaCell(s, prevSummary)}
      <td class="count skipped \${countClass(s.skipped,'skipped')}">\${s.skipped}</td>
      <td class="run-link"><a href="\${runUrl}" target="_blank" rel="noopener">View →</a></td>
    \`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    const detailCell = document.createElement('td');
    detailCell.className = 'detail-cell';
    detailCell.colSpan = 9;
    detailCell.innerHTML = renderDetail(run);
    detailRow.appendChild(detailCell);

    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      const isOpen = detailRow.classList.contains('open');
      detailRow.classList.toggle('open', !isOpen);
      document.getElementById(\`chev-\${i}\`).classList.toggle('open', !isOpen);
    });

    tbody.appendChild(row);
    tbody.appendChild(detailRow);
  });
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activePhase = btn.dataset.phase;
    renderTable();
  });
});

// ── Single URL history ────────────────────────────────────────────────────────
const singleFlagged = new Map(); // index → url

function toggleSingleFlag(idx, url) {
  if (singleFlagged.has(idx)) {
    singleFlagged.delete(idx);
  } else {
    singleFlagged.set(idx, url);
  }
  const row = document.getElementById('single-row-' + idx);
  const chk = document.getElementById('single-chk-' + idx);
  const isFlagged = singleFlagged.has(idx);
  row.style.background = isFlagged ? 'rgba(248,81,73,0.08)' : '';
  chk.checked = isFlagged;
  document.getElementById('single-flag-count').textContent = singleFlagged.size + ' item' + (singleFlagged.size !== 1 ? 's' : '') + ' flagged';
  document.getElementById('single-export-btn').disabled = singleFlagged.size === 0;
}

function exportSingleFlagged() {
  const lines = [...singleFlagged.values()];
  downloadTxt(lines.join('\\n'), 'flagged-single-url.txt');
}

// Events that are expected to fire multiple times within a phase — suppress ×N badge
const EXPECTED_MULTIPLES = {
  kids: new Set(['user-updated-body-measurements::kids']),
};

const CHECKLISTS = {
  apparel: [
    // Widget
    { label: 'Widget present on page',        event: 'user-saw-widget-button' },
    { label: 'Widget opens',                  event: 'user-opened-widget' },
    { label: 'Product seen',                  event: 'user-saw-product' },
    // Onboarding
    { label: 'Onboarding complete',           event: 'user-completed-onboarding' },
    { label: 'Silhouette created',            event: 'user-created-silhouette' },
    // Recommendation
    { label: 'Recommendation API called',     event: 'user-got-size-recommendation' },
    { label: 'Try-it-on panel opened',        event: 'user-opened-panel-tryiton' },
    { label: 'Size selected',                 event: 'user-selected-size' },
    // Refresh
    { label: 'Refresh: widget re-mounts',     event: 'inpage-mounted::integration' },
    { label: 'Refresh: recommendation re-fires', event: 'user-got-size-recommendation::integration' },
    // Gift
    { label: 'Gift flow: recommendation',     event: 'user-opened-panel-rec::gift' },
  ],
  footwear: [
    { label: 'Widget present on page',        event: 'user-saw-widget-button' },
    { label: 'Widget opens',                  event: 'user-opened-widget' },
    { label: 'Product seen',                  event: 'user-saw-product' },
    { label: 'Footwear silhouette created',   event: 'user-created-footwear-silhouette' },
    { label: 'Recommendation panel opened',   event: 'user-opened-panel-rec' },
    { label: 'Size selected',                 event: 'user-selected-size' },
    { label: 'Refresh: widget re-mounts',     event: 'inpage-mounted' },
    { label: 'Refresh: recommendation re-fires', event: 'user-selected-size::inpage' },
  ],
  bag: [
    { label: 'Widget present on page',        event: 'user-saw-widget-button' },
    { label: 'Widget opens',                  event: 'user-opened-widget' },
    { label: 'Product seen',                  event: 'user-saw-product' },
  ],
  kids: [
    { label: 'Kids widget opens',             event: 'user-opened-widget' },
    { label: 'Onboarding screen shown',       event: 'user-saw-onboarding-screen' },
    { label: 'Gender selected',               event: 'user-selected-gender' },
    { label: 'Age selected',                  event: 'user-clicked-age' },
    { label: 'Measurements updated',          event: 'user-updated-body-measurements' },
    { label: 'Onboarding complete',           event: 'user-completed-onboarding' },
    { label: 'Recommendation shown',          event: 'user-selected-size-kids-rec' },
    { label: 'Refresh: recommendation re-fires', event: 'user-selected-size-kids-rec::kids' },
  ],
  noVisor: [
    { label: 'Widget present on page',        event: 'user-saw-widget-button' },
    { label: 'Widget opens',                  event: 'user-opened-widget' },
    { label: 'Product seen',                  event: 'user-saw-product' },
    { label: 'Silhouette created',            event: 'user-created-silhouette' },
    { label: 'Refresh: widget re-mounts',     event: 'inpage-mounted' },
  ],
};

function renderSingleDetail(entry) {
  const raw = entry.events || [];
  const flow = entry.flow;
  const checklist = CHECKLISTS[flow] || [];

  // Normalise: old entries are string[], new entries are {event, phase}[]
  const normEvents = raw.map(e =>
    typeof e === 'string' ? { event: e, phase: null } : e
  );

  // Checklist matching — name-only or exact name::source
  const firedFull      = new Set(normEvents.map(e => e.event));
  const firedNamesOnly = new Set(normEvents.map(e => e.event.split('::')[0]));
  const eventMatches   = (pattern) =>
    pattern.includes('::') ? firedFull.has(pattern) : firedNamesOnly.has(pattern);

  // Group by phase, count within-phase duplicates
  // byPhase: Map<phase, Map<event, count>>
  const byPhase = new Map();
  for (const { event, phase } of normEvents) {
    const key = phase || '—';
    if (!byPhase.has(key)) byPhase.set(key, new Map());
    const m = byPhase.get(key);
    m.set(event, (m.get(event) || 0) + 1);
  }

  const totalUnique = new Set(normEvents.map(e => e.event)).size;
  const totalFired  = normEvents.length;

  const expectedMultiples = EXPECTED_MULTIPLES[flow] || new Set();

  const eventsHtml = byPhase.size === 0
    ? '<span style="color:#8b949e;font-size:13px">No events recorded</span>'
    : [...byPhase.entries()].map(([phase, evMap]) => \`
        <div style="margin-bottom:8px">
          <div style="font-size:11px;color:#484f58;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">\${phase}</div>
          <ul style="list-style:none;padding:0;margin:0">
            \${[...evMap.entries()].map(([e, count]) => {
              const [name, src] = e.split('::');
              const isDuplicate = count > 1 && !expectedMultiples.has(e);
              return \`<li style="font-size:12px;padding:1px 0;color:#c9d1d9;display:flex;align-items:baseline;gap:4px">
                <span style="color:#58a6ff">\${name}</span>
                \${src ? \`<span style="color:#484f58">:: \${src}</span>\` : ''}
                \${isDuplicate ? \`<span style="color:#f85149;font-size:11px;font-weight:600">×\${count}</span>\` : ''}
              </li>\`;
            }).join('')}
          </ul>
        </div>\`).join('');

  const checklistHtml = checklist.length === 0
    ? '<span style="color:#8b949e;font-size:13px">No checklist for this flow</span>'
    : \`<ul style="list-style:none;padding:0;margin:0">\${checklist.map(item => {
        const passed = eventMatches(item.event);
        return \`<li style="font-size:12px;padding:3px 0;display:flex;align-items:center;gap:6px">
          <span style="color:\${passed ? '#3fb950' : '#484f58'}">\${passed ? '✅' : '⬜'}</span>
          <span style="color:\${passed ? '#c9d1d9' : '#484f58'}">\${item.label}</span>
        </li>\`;
      }).join('')}</ul>\`;

  const ob  = entry.onboarding;
  const kb  = entry.kidsOnboarding;
  const fwb = entry.footwearOnboarding;
  let obHtml = null;
  if (flow === 'apparel') {
    // Show adult onboarding body + gift recipient body
    const gb = entry.giftOnboarding;
    const adultRows = ob ? \`
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${ob.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${ob.age} yr</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${ob.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Weight</span> <span style="color:#c9d1d9">\${ob.weight} kg</span></li>\` : '';
    const giftRows = gb ? \`
      <li style="font-size:11px;padding:4px 0 2px;color:#484f58;text-transform:uppercase;letter-spacing:0.5px">Gift recipient</li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${gb.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${gb.age}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${gb.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Body type</span> <span style="color:#c9d1d9">\${gb.bodyType}</span></li>\` : '';
    obHtml = (adultRows || giftRows) ? \`<ul style="list-style:none;padding:0;margin:0">\${adultRows}\${giftRows}</ul>\` : null;
  } else if (flow === 'noVisor') {
    obHtml = ob ? \`<ul style="list-style:none;padding:0;margin:0">
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${ob.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${ob.age} yr</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${ob.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Weight</span> <span style="color:#c9d1d9">\${ob.weight} kg</span></li>
    </ul>\` : null;
  } else if (flow === 'footwear') {
    obHtml = fwb ? \`<ul style="list-style:none;padding:0;margin:0">
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${fwb.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Brand</span> <span style="color:#c9d1d9">\${fwb.brand}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Size</span> <span style="color:#c9d1d9">\${fwb.size}</span></li>
    </ul>\` : null;
  } else if (flow === 'kids') {
    obHtml = kb ? \`<ul style="list-style:none;padding:0;margin:0">
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${kb.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${kb.age} yr</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${kb.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Weight</span> <span style="color:#c9d1d9">\${kb.weight} kg</span></li>
    </ul>\` : null;
  }

  return \`<div class="detail-inner" style="grid-template-columns:1fr 1fr\${obHtml ? ' 160px' : ''}">
    <div class="detail-section">
      <h4>Test checklist\${flow ? \` — \${flow}\` : ''}</h4>
      \${checklistHtml}
    </div>
    <div class="detail-section">
      <h4>Events fired (\${totalUnique} unique\${totalFired !== totalUnique ? ', ' + totalFired + ' total' : ''})</h4>
      \${eventsHtml}
    </div>
    \${obHtml ? \`<div class="detail-section"><h4>Onboarding body</h4>\${obHtml}</div>\` : ''}
  </div>\`;
}

function renderSingleUrl() {
  const tbody = document.getElementById('single-url-body');
  if (SINGLE_URL_HISTORY.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No single URL tests yet.</td></tr>';
    return;
  }

  const iconFor = s => s === 'passed' ? '✅' : s === 'skipped' ? '⏭' : s === 'no_result' ? '—' : '❌';
  const shortUrl = url => { try { const u = new URL(url); return u.hostname.replace(/^www\\./, '') + u.pathname.slice(0, 30) + (u.pathname.length > 30 ? '…' : ''); } catch { return url; } };

  tbody.innerHTML = '';

  SINGLE_URL_HISTORY.forEach((entry, idx) => {
    const byBrowser = Object.fromEntries((entry.browsers || []).map(b => [b.browser, b]));

    const statusCell = (browserKey) => {
      const b = byBrowser[browserKey];
      if (!b) return \`<td style="text-align:center;color:#484f58">—</td>\`;
      const icon = iconFor(b.status);
      const tip = b.error ? \` title="\${b.error.replace(/"/g, '&quot;')}"\` : '';
      return \`<td style="text-align:center"\${tip}>\${icon}</td>\`;
    };

    const flow = entry.flow;
    const flowBadge = flow
      ? \`<span class="phase-badge flow-\${flow}">\${flow}</span>\`
      : '<span style="color:#484f58">—</span>';

    const row = document.createElement('tr');
    row.id = 'single-row-' + idx;
    row.className = 'run-row';
    row.innerHTML = \`
      <td><span class="chevron" id="single-chev-\${idx}">›</span></td>
      <td style="text-align:center" onclick="event.stopPropagation(); toggleSingleFlag(\${idx}, \${JSON.stringify(entry.url || '')})">
        <input type="checkbox" id="single-chk-\${idx}" style="accent-color:#f85149;cursor:pointer" onclick="event.stopPropagation(); toggleSingleFlag(\${idx}, \${JSON.stringify(entry.url || '')})">
      </td>
      <td class="ts">\${fmt(entry.timestamp)}</td>
      <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        <a href="\${entry.url}" target="_blank" rel="noopener" title="\${entry.url}" onclick="event.stopPropagation()">\${shortUrl(entry.url)}</a>
      </td>
      <td style="font-size:13px">\${entry.store || '—'}</td>
      <td>\${flowBadge}</td>
      <td><span class="phase-badge phase-\${entry.phase || 'full'}">\${entry.phase || 'full'}</span></td>
      \${statusCell('chrome')}
      \${statusCell('firefox')}
      \${statusCell('webkit')}
      <td class="run-link"><a href="\${entry.githubRunUrl || '#'}" target="_blank" rel="noopener" onclick="event.stopPropagation()">View →</a></td>
    \`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    const detailCell = document.createElement('td');
    detailCell.className = 'detail-cell';
    detailCell.colSpan = 11;
    detailCell.innerHTML = renderSingleDetail(entry);
    detailRow.appendChild(detailCell);

    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
      const isOpen = detailRow.classList.contains('open');
      detailRow.classList.toggle('open', !isOpen);
      document.getElementById(\`single-chev-\${idx}\`).classList.toggle('open', !isOpen);
    });

    tbody.appendChild(row);
    tbody.appendChild(detailRow);
  });
}

// ── Compare view gallery ──────────────────────────────────────────────────────
const TAG_DEFS = [
  { key: 'passed',           label: 'Passed',           color: '#3fb950' },
  { key: 'bigger',           label: 'Bigger',           color: '#58a6ff' },
  { key: 'smaller',          label: 'Smaller',          color: '#d29922' },
  { key: 'no_cleaned_image', label: 'No cleaned image', color: '#bc8cff' },
  { key: 'others',           label: 'Others',           color: '#8b949e' },
];
const TAG_MAP = Object.fromEntries(TAG_DEFS.map(t => [t.key, t]));
const TAGS_STORAGE_KEY = 'vs-compare-tags';

const tags = new Map(
  Object.entries(JSON.parse(localStorage.getItem(TAGS_STORAGE_KEY) || '{}'))
);

// Batch filter state — sorted newest-first, default to most recent
const ALL_BATCHES = [...new Set(COMPARE_IMAGES.map(img => img.batch || 'older'))].sort().reverse();
let currentBatch = ALL_BATCHES[0] || 'all';

function getFilteredImages() {
  return currentBatch === 'all'
    ? COMPARE_IMAGES
    : COMPARE_IMAGES.filter(img => (img.batch || 'older') === currentBatch);
}

function saveTags() {
  localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(Object.fromEntries(tags)));
}

function setTag(sku, key) {
  // Clicking the active tag again clears it
  if (tags.get(sku) === key) {
    tags.delete(sku);
  } else {
    tags.set(sku, key);
  }
  saveTags();
  updateCard(sku);
  updateTagSummary();
}

function updateCard(sku) {
  const card = document.getElementById('card-' + sku);
  if (!card) return;
  const activeKey = tags.get(sku);
  const def = activeKey ? TAG_MAP[activeKey] : null;
  card.style.borderColor = def ? def.color : '';
  card.style.boxShadow = def ? \`0 0 0 1px \${def.color}\` : '';
  TAG_DEFS.forEach(({ key }) => {
    const btn = document.getElementById(\`tag-\${sku}-\${key}\`);
    if (btn) btn.classList.toggle('active', activeKey === key);
  });
}

function updateTagSummary() {
  const filtered = getFilteredImages();
  const skuSet = new Set(filtered.map(({ sku }) => sku));
  const counts = Object.fromEntries(TAG_DEFS.map(({ key }) => [key, 0]));
  tags.forEach((tag, sku) => { if (skuSet.has(sku) && counts[tag] !== undefined) counts[tag]++; });
  const total = [...tags.keys()].filter(sku => skuSet.has(sku)).length;

  const totalEl = document.getElementById('tag-total');
  if (totalEl) totalEl.textContent = total + ' tagged';
  TAG_DEFS.forEach(({ key, color }) => {
    const el = document.getElementById('tag-count-' + key);
    if (el) {
      el.textContent = counts[key];
      el.style.color = counts[key] > 0 ? color : '#484f58';
    }
  });
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) exportBtn.disabled = tags.size === 0;
}

function renderGrid(images) {
  return images.map(({ sku, url }) => \`
    <div class="overlay-card" id="card-\${sku}">
      <img src="compare-view-screenshots/\${sku}.png" alt="">
      <div class="card-footer">
        <div class="card-sku">\${url ? \`<a href="\${url}" target="_blank">\${sku}</a>\` : sku}</div>
      </div>
      <div class="tag-pills">
        \${TAG_DEFS.map(({ key, label, color }) => \`
          <button class="tag-btn" id="tag-\${sku}-\${key}" style="--tag-color:\${color}"
            onclick="setTag('\${sku}', '\${key}')">\${label}</button>
        \`).join('')}
      </div>
    </div>
  \`).join('');
}

function filterBatch(batch) {
  currentBatch = batch;
  const grid = document.getElementById('compare-grid');
  if (grid) {
    grid.innerHTML = renderGrid(getFilteredImages());
    getFilteredImages().forEach(({ sku }) => updateCard(sku));
  }
  updateTagSummary();
  updateBatchCount();
}

function updateBatchCount() {
  const el = document.getElementById('batch-count');
  if (el) el.textContent = getFilteredImages().length + ' products';
}

function renderCompareView() {
  const el = document.getElementById('compare-content');
  if (COMPARE_IMAGES.length === 0) {
    el.innerHTML = \`<div class="info-panel">
      <div class="icon">🖼</div>
      <p>No screenshots yet. Run the compare view test to generate them.</p>
      <div class="run-cmd">npx playwright test tests/compare-view-screenshot.spec.js --project=chrome</div>
    </div>\`;
    return;
  }

  const batchOptions = ALL_BATCHES.map(b => \`<option value="\${b}"\${b === currentBatch ? ' selected' : ''}>\${b}</option>\`).join('');

  el.innerHTML = \`
    <div class="tag-bar">
      <span id="tag-total">0 tagged</span>
      <span class="tag-bar-counts">
        \${TAG_DEFS.map(({ key, label, color }) => \`
          <span class="tag-bar-item">
            <span class="tag-dot" style="background:\${color}"></span>
            \${label}: <strong id="tag-count-\${key}" style="color:#484f58">0</strong>
          </span>
        \`).join('')}
      </span>
      <button id="export-btn" onclick="exportTagged()" disabled>Export CSV</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <label style="font-size:13px;color:#8b949e;white-space:nowrap">Batch:</label>
      <select id="batch-filter" onchange="filterBatch(this.value)"
        style="background:#161b22;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 10px;font-size:13px;cursor:pointer">
        \${batchOptions}
        <option value="all"\${currentBatch === 'all' ? ' selected' : ''}>All batches</option>
      </select>
      <span id="batch-count" style="font-size:12px;color:#8b949e"></span>
    </div>
    <div class="overlay-grid" id="compare-grid">
      \${renderGrid(getFilteredImages())}
    </div>
  \`;

  getFilteredImages().forEach(({ sku }) => updateCard(sku));
  updateTagSummary();
  updateBatchCount();
}

function exportTagged() {
  // Deduplicate by SKU, preferring named batches over 'older' and latest name among named batches
  const batchRank = b => (b === 'older' || !b) ? '' : b;
  const latestBySku = new Map();
  COMPARE_IMAGES.forEach(({ sku, url, batch }) => {
    const current = latestBySku.get(sku);
    if (!current || batchRank(batch) >= batchRank(current.batch)) {
      latestBySku.set(sku, { url: url || '', batch: batch || '' });
    }
  });
  const rows = [['SKU', 'URL', 'Batch', 'Tag']];
  TAG_DEFS.forEach(({ key, label }) => {
    latestBySku.forEach(({ url, batch }, sku) => {
      if (tags.get(sku) === key) rows.push([sku, url, batch, label]);
    });
  });
  const csv = rows.map(r => r.map(c => \`"\${c}"\`).join(',')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'compare-view-tags.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Compare view trigger ──────────────────────────────────────────────────────
async function triggerCompareRun() {
  const pat = document.getElementById('gh-pat').value.trim();
  const urls = document.getElementById('compare-urls').value.trim();
  const batchName = document.getElementById('compare-batch').value.trim();
  const status = document.getElementById('compare-trigger-status');

  if (!pat) { status.textContent = '⚠️ Enter a GitHub PAT first'; status.style.color = '#d29922'; return; }
  if (!urls) { status.textContent = '⚠️ Enter at least one URL'; status.style.color = '#d29922'; return; }
  if (!batchName) { status.textContent = '⚠️ Enter a batch name (e.g. bottega-0421)'; status.style.color = '#d29922'; return; }

  status.textContent = 'Triggering…'; status.style.color = '#8b949e';

  const res = await fetch('https://api.github.com/repos/chengalore/vs-playwright-qa/actions/workflows/compare-view-screenshot.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { urls, batch_name: batchName } }),
  });

  if (res.status === 204) {
    status.textContent = '✅ Workflow triggered — results will appear here in ~5 min';
    status.style.color = '#3fb950';
    document.getElementById('compare-urls').value = '';
  } else {
    const body = await res.json().catch(() => ({}));
    status.textContent = '❌ ' + (body.message || 'Failed (' + res.status + ')');
    status.style.color = '#f85149';
  }
}

// ── Single URL trigger ────────────────────────────────────────────────────────
async function triggerSingleRun() {
  const pat     = document.getElementById('single-pat').value.trim();
  const testUrl = document.getElementById('single-url-input').value.trim();
  const phase   = document.getElementById('single-phase').value;
  const status  = document.getElementById('single-trigger-status');
  const gender      = document.getElementById('single-ob-gender').value;
  const age         = document.getElementById('single-ob-age').value;
  const height      = document.getElementById('single-ob-height').value;
  const weight      = document.getElementById('single-ob-weight').value;
  const giftGender   = document.getElementById('single-gift-gender').value;
  const giftAge      = document.getElementById('single-gift-age').value;
  const giftHeight   = document.getElementById('single-gift-height').value;
  const giftBodyType = document.getElementById('single-gift-bodytype').value;
  const fwGender    = document.getElementById('single-fw-gender').value;
  const fwBrand     = document.getElementById('single-fw-brand').value;
  const fwSize      = document.getElementById('single-fw-size').value;
  const kidsGender  = document.getElementById('single-kids-gender').value;
  const kidsAge     = document.getElementById('single-kids-age').value;
  const kidsHeight  = document.getElementById('single-kids-height').value;
  const kidsWeight  = document.getElementById('single-kids-weight').value;
  const browsers = ['chrome', 'firefox', 'webkit'].filter(b => {
    const el = document.getElementById('browser-' + b);
    return el && (el.checked || el.disabled); // chrome is disabled+checked
  });

  if (!pat) { status.textContent = '⚠️ Enter a GitHub PAT first'; status.style.color = '#d29922'; return; }
  if (!testUrl) { status.textContent = '⚠️ Enter a product URL'; status.style.color = '#d29922'; return; }

  status.textContent = 'Triggering…'; status.style.color = '#8b949e';

  const res = await fetch('https://api.github.com/repos/chengalore/vs-playwright-qa/actions/workflows/single-url-test.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: {
      url: testUrl, phase,
      browsers: JSON.stringify(browsers),
      gift_gender: giftGender,
      gift_age: giftAge,
      gift_height: giftHeight,
      gift_body_type: giftBodyType,
      onboarding_gender: gender,
      onboarding_age: age,
      onboarding_height: height,
      onboarding_weight: weight,
      footwear_gender: fwGender,
      footwear_brand:  fwBrand,
      footwear_size:   fwSize,
      kids_gender: kidsGender,
      kids_age: kidsAge,
      kids_height: kidsHeight,
      kids_weight: kidsWeight,
    }}),
  });

  if (res.status === 204) {
    status.textContent = '✅ Workflow triggered — results will appear here in ~5 min';
    status.style.color = '#3fb950';
    document.getElementById('single-url-input').value = '';
  } else {
    const body = await res.json().catch(() => ({}));
    status.textContent = '❌ ' + (body.message || 'Failed (' + res.status + ')');
    status.style.color = '#f85149';
  }
}

// ── Flaky Stores card ─────────────────────────────────────────────────────────
function renderFlakyStores() {
  const section = document.getElementById('flaky-stores-section');
  if (!section) return;

  const widgetRuns = HISTORY.filter(r => (r.phase || 'widget') === 'widget');

  // Overall flake rate: mirrors KPI card computation (14d)
  const runs14 = widgetRuns.slice(0, 14);
  const allStores14 = new Set();
  runs14.forEach(r => (r.widgetMissingStores || []).forEach(s => allStores14.add(s.store)));
  const totalMonitored = widgetRuns[0]?.summary?.total || 0;
  let flakeCount14 = 0;
  for (const s of allStores14) {
    const seenMiss = runs14.some(r => (r.widgetMissingStores || []).some(ws => ws.store === s));
    const seenPass = runs14.some(r => !(r.widgetMissingStores || []).some(ws => ws.store === s));
    if (seenMiss && seenPass) flakeCount14++;
  }
  const overallRate = totalMonitored > 0 ? Math.round(flakeCount14 / totalMonitored * 1000) / 10 : null;
  const overallStr  = overallRate !== null ? overallRate + '%' : '—';
  const aboveTarget = overallRate !== null && overallRate > 5;

  // Per-store flake rate from last 7 widget runs
  const runs7 = widgetRuns.slice(0, 7);
  const storeSet = new Set();
  runs7.forEach(r => (r.widgetMissingStores || []).forEach(s => storeSet.add(s.store)));

  const results = [];
  for (const store of storeSet) {
    const statuses = runs7.map(r => (r.widgetMissingStores || []).some(s => s.store === store) ? 'miss' : 'pass');
    let flips = 0, lastFlipIdx = -1;
    for (let i = 0; i < statuses.length - 1; i++) {
      if (statuses[i] !== statuses[i + 1]) { flips++; lastFlipIdx = i; }
    }
    if (flips === 0) continue;
    const flakeRate = Math.round(flips / 7 * 1000) / 10;
    let lastFlipDesc = '—';
    if (lastFlipIdx >= 0) {
      const from    = statuses[lastFlipIdx + 1] === 'pass' ? 'Pass' : 'Miss';
      const to      = statuses[lastFlipIdx]     === 'pass' ? 'Pass' : 'Miss';
      const runsAgo = lastFlipIdx + 1;
      lastFlipDesc  = \`\${from}→\${to} · \${runsAgo} run\${runsAgo !== 1 ? 's' : ''} ago\`;
    }
    results.push({ store, flakeRate, lastFlipDesc });
  }
  results.sort((a, b) => b.flakeRate - a.flakeRate);

  const barColor    = r => r > 15 ? '#f85149' : r >= 5 ? '#d29922' : '#3fb950';
  const statusBadge = r => r > 10
    ? \`<span style="display:inline-block;background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.3);color:#d29922;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">Watch</span>\`
    : \`<span style="display:inline-block;background:rgba(63,185,80,0.15);border:1px solid rgba(63,185,80,0.3);color:#3fb950;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">Stable</span>\`;

  const tableBody = results.length === 0
    ? \`<tr><td colspan="5" style="padding:16px 12px;color:#8b949e;font-size:13px">No flaky stores in the last 7 runs</td></tr>\`
    : results.map(({ store, flakeRate, lastFlipDesc }) => {
        const bc = barColor(flakeRate);
        return \`<tr style="border-bottom:1px solid #161b22">
          <td style="padding:10px 12px;font-weight:600;color:#f0f6fc">\${store}</td>
          <td style="padding:10px 12px">
            <div style="font-size:13px;color:#c9d1d9;margin-bottom:5px">\${flakeRate}%</div>
            <div style="height:3px;background:#21262d;border-radius:2px;max-width:120px">
              <div style="height:3px;background:\${bc};border-radius:2px;width:\${Math.min(flakeRate, 100)}%"></div>
            </div>
          </td>
          <td style="padding:10px 12px;color:#8b949e;font-size:13px">\${lastFlipDesc}</td>
          <td style="padding:10px 12px">\${statusBadge(flakeRate)}</td>
          <td style="padding:10px 12px"></td>
        </tr>\`;
      }).join('');

  section.innerHTML = \`
    <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:18px 22px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#f0f6fc">
          FLAKY STORES — \${overallStr} OVERALL
        </div>
        \${aboveTarget ? \`<span style="background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.3);color:#d29922;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">above 5% target</span>\` : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="border-bottom:1px solid #21262d">
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#8b949e;font-weight:500">Store</th>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#8b949e;font-weight:500">Flake rate (7d)</th>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#8b949e;font-weight:500">Last flip</th>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#8b949e;font-weight:500">Status</th>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#8b949e;font-weight:500">Action</th>
          </tr>
        </thead>
        <tbody>\${tableBody}</tbody>
      </table>
    </div>\`;
}

// ── Cost per client ───────────────────────────────────────────────────────────
const STORE_LIST = [
  'adidas','callawaygolf','banana_republic','andar_japan','coen','frans_boone','emmi',
  'lily_brown','miesrohe','brooks_brothers','paul_smith','re_edit','seilin_online_shop',
  'strasburgo','top_floor','hankyu_hanshin','agnes_b','barbour','another_address',
  'brooks_brothers_korea','camilla_and_marc','estnation','fray_i_d','cox','hankyu_mens',
  'llbean','milaowen','poppy','strasburgo_outlet','shel_tter','ua_taiwan','yohji_wildside',
  'reebok_korea','aoure','allsaints_korea','bshop','barneys_japan','celford',
  'fashion_square','furfur','denimlife','id_look','lumine','nagaileben','punyus','restir',
  'style_deli','under_armour','sixpad','asics_japan','beams','classico_global','dinos',
  'ameri_vintage','buyma','gap_japan','felissimo','ragtag','jamie_kay','makes','retouch',
  'natulan','studio_nicholson','yosoou','unitedarrows_global','snidel','bottega_veneta',
  'by_malene_birger','classico_taiwan','and_mall','azul_by_moussy','edwin','levi_japan',
  'flandre','ralph_lauren','marui','onward','sanyo_online_store','world',
  'standard_california','taion_wear','zuica','gelato_pique','bottega_veneta_japan',
  'bottega_veneta_korea','bottega'
];

const COST_DUR  = { healthy: 2.36, bot: 17.875, missing: 10.2 };
const COST_RATE = 0.008;
const RUNS_PER_MO = 30;

function renderCostPanel() {
  const container = document.getElementById('cost-chart-container');
  if (!container) return;

  const latest = HISTORY.filter(r => (r.phase || 'widget') === 'widget')[0];
  if (!latest) {
    container.innerHTML = '<p style="color:#8b949e">No monitor data yet.</p>';
    return;
  }

  const botSet     = new Set(latest.botProtected || []);
  const ongoingSet = new Set((latest.ongoingMissing || []).map(o => o.store));
  const newMissSet = new Set(
    (latest.widgetMissingStores || []).filter(s => !ongoingSet.has(s.store)).map(s => s.store)
  );

  const storeData = STORE_LIST.map(store => {
    let color, dur;
    if (botSet.has(store))          { color = '#d29922'; dur = COST_DUR.bot;     }
    else if (newMissSet.has(store)) { color = '#f85149'; dur = COST_DUR.missing; }
    else if (ongoingSet.has(store)) { color = '#e3760e'; dur = COST_DUR.missing; }
    else                            { color = '#3fb950'; dur = COST_DUR.healthy; }
    return { store, color, cost: RUNS_PER_MO * dur * COST_RATE };
  });

  storeData.sort((a, b) => b.cost - a.cost);
  const maxCost = storeData[0]?.cost || 1;

  const dot = c => \`<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:\${c};margin-right:5px;vertical-align:middle"></span>\`;
  const legendItem = (label, c) => \`<span style="font-size:11px;color:#8b949e;margin-right:16px">\${dot(c)}\${label}</span>\`;

  const bars = storeData.map(({ store, color, cost }) => {
    const pct = (cost / maxCost * 100).toFixed(1);
    return \`<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">
      <div style="width:170px;flex-shrink:0;text-align:right;font-size:12px;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${store}">\${store}</div>
      <div style="flex:1;height:14px;background:#21262d;border-radius:2px">
        <div style="height:100%;width:\${pct}%;background:\${color};border-radius:2px"></div>
      </div>
      <div style="width:38px;flex-shrink:0;font-size:12px;color:#c9d1d9;text-align:right">$\${cost.toFixed(2)}</div>
    </div>\`;
  }).join('');

  const tickMax = Math.ceil(maxCost);
  const ticks = Array.from({ length: tickMax + 1 }, (_, i) =>
    \`<span style="flex:1;text-align:center;font-size:10px;color:#484f58">$\${i}</span>\`
  ).join('');

  container.innerHTML = \`
    <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:18px 22px;margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#f0f6fc;margin-bottom:12px">CI SPEND BY STORE — MONTHLY</div>
      <div style="margin-bottom:14px">
        \${legendItem('Healthy', '#3fb950')}\${legendItem('Bot blocked', '#d29922')}\${legendItem('Missing', '#e3760e')}\${legendItem('Critical', '#f85149')}
      </div>
      <div style="max-height:560px;overflow-y:auto;padding-right:4px">\${bars}</div>
      <div style="display:flex;margin-left:180px;margin-top:6px;padding-right:38px">\${ticks}</div>
    </div>
    <div style="background:#3a1515;border-radius:6px;padding:10px;font-size:11px;color:#f85149">
      Removing bot-blocked stores (adidas, ralph_lauren, asics_japan) saves $12.87/mo immediately — zero loss of test value.
    </div>\`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
renderSummary(HISTORY[0] || null);
renderTable();
renderFlakyStores();
renderSingleUrl();
// Restore saved PAT into both PAT fields
const savedPat = localStorage.getItem('gh_pat');
if (savedPat) {
  document.getElementById('gh-pat').value = savedPat;
  document.getElementById('single-pat').value = savedPat;
}
</script>
</body>
</html>`;
}
