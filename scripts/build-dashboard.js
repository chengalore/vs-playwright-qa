import fs from 'fs';
import path from 'path';

const HISTORY_FILE = 'data/monitor-history.json';
const MAX_HISTORY = 50;

// Load existing history
const history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  : [];

// Prepend current run (skip if called from single-url workflow or already in history)
if (fs.existsSync('data/monitor-report.json') && process.env.PHASE !== 'skip') {
  const report = JSON.parse(fs.readFileSync('data/monitor-report.json', 'utf8'));
  const alreadyInHistory = history.some(e => e.timestamp === report.timestamp);
  if (!alreadyInHistory) {
    report.phase = process.env.PHASE || 'widget';
    history.unshift(report);
    if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  }
}

// Load single-url history
const SINGLE_URL_HISTORY_FILE = 'data/single-url-history.json';
const singleUrlHistory = fs.existsSync(SINGLE_URL_HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(SINGLE_URL_HISTORY_FILE, 'utf8'))
  : [];

// Copy compare view screenshots to docs/ — one subfolder per run
// test-results/compare-view-screenshots/{run-folder}/ → docs/compare-view-screenshots/{run-folder}/
const screenshotsSrc = 'test-results/compare-view-screenshots';
const screenshotsDst = 'docs/compare-view-screenshots';
fs.mkdirSync(screenshotsDst, { recursive: true });

// Copy any new run folders from test-results to docs
if (fs.existsSync(screenshotsSrc)) {
  const runFolders = fs.readdirSync(screenshotsSrc, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  for (const folder of runFolders) {
    const src = path.join(screenshotsSrc, folder);
    const dst = path.join(screenshotsDst, folder);
    fs.mkdirSync(dst, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, file), path.join(dst, file));
    }
  }
  if (runFolders.length) console.log(`Copied run folders: ${runFolders.join(', ')}`);
}

// Build compareRuns: array of { folder, images: [{sku, url}] } sorted newest first
const compareRuns = fs.readdirSync(screenshotsDst, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()
  .reverse()
  .map(folder => {
    const manifestPath = path.join(screenshotsDst, folder, 'manifest.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : [];
    const pngs = fs.readdirSync(path.join(screenshotsDst, folder)).filter(f => f.endsWith('.png'));
    // Merge: prefer manifest entries (have URLs), fall back to bare filenames
    const skusInManifest = new Set(manifest.map(e => e.sku));
    for (const f of pngs) {
      const sku = f.replace('.png', '');
      if (!skusInManifest.has(sku)) manifest.push({ sku, url: null });
    }
    return { folder, images: manifest.filter(e => pngs.includes(`${e.sku}.png`)) };
  })
  .filter(r => r.images.length > 0);

// Generate dashboard HTML
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/index.html', generateDashboard(history, compareRuns, singleUrlHistory));
console.log(`Dashboard written — ${history.length} monitor runs, ${singleUrlHistory.length} single-url runs`);

function generateDashboard(history, compareRuns, singleUrlHistory) {
  const dataJson = JSON.stringify(history).replace(/<\/script>/gi, '<\\/script>');
  const compareJson = JSON.stringify(compareRuns).replace(/<\/script>/gi, '<\\/script>');
  const singleUrlJson = JSON.stringify(singleUrlHistory).replace(/<\/script>/gi, '<\\/script>');

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
      height: 100vh;
      overflow: hidden;
    }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Sidebar ── */
    #sidebar {
      width: 210px;
      background: #010409;
      border-right: 1px solid #21262d;
      display: flex;
      flex-direction: column;
      padding: 20px 0;
      flex-shrink: 0;
    }
    #sidebar .sidebar-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #484f58;
      padding: 0 16px 14px;
    }
    #sidebar button {
      background: none;
      border: none;
      color: #8b949e;
      text-align: left;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      border-left: 2px solid transparent;
      transition: background 0.15s, color 0.15s;
      width: 100%;
    }
    #sidebar button:hover { background: #161b22; color: #c9d1d9; }
    #sidebar button.active {
      background: #161b22;
      border-left-color: #58a6ff;
      color: #f0f6fc;
    }

    /* ── Main ── */
    #main {
      flex: 1;
      overflow-y: auto;
      padding: 28px 32px 48px;
    }

    .panel { display: none; }
    .panel.active { display: block; }

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
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
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
    .overlay-card.flagged {
      border-color: #f85149;
      box-shadow: 0 0 0 1px #f85149;
    }
    .overlay-card img { width: 100%; display: block; }
    .overlay-card .card-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px 10px;
    }
    .overlay-card .card-sku {
      flex: 1;
      font-size: 13px;
      font-weight: 600;
      color: #f0f6fc;
    }
    .overlay-card .flag-checkbox {
      width: 16px;
      height: 16px;
      accent-color: #f85149;
      cursor: pointer;
      flex-shrink: 0;
    }
    .flag-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      font-size: 13px;
      color: #8b949e;
    }
    .flag-bar span { flex: 1; }
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
      #sidebar { display: none; }
      #main { padding: 20px 16px; }
      .summary-card .divider { display: none; }
    }
  </style>
</head>
<body>

<nav id="sidebar">
  <div class="sidebar-title">Virtusize QA</div>
  <button onclick="showPanel('monitor')" id="btn-monitor" class="active">📡 Monitor</button>
  <button onclick="showPanel('single')" id="btn-single">🔗 Single URL</button>
  <button onclick="showPanel('compare')" id="btn-compare">🖼 Compare View</button>
  <button onclick="showPanel('inpage')" id="btn-inpage">🧪 Inpage</button>
  <button onclick="showPanel('cart')" id="btn-cart">🛒 Add to Cart</button>
</nav>

<main id="main">

  <!-- Monitor -->
  <div class="panel active" id="panel-monitor">
    <h1>Monitor</h1>
    <p class="panel-subtitle">Multi-store widget health — run automatically on a schedule</p>
    <div class="summary-card" id="summary-card"></div>
    <div class="filters">
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
          <th style="text-align:right">⏭ Skipped</th>
          <th>Run</th>
        </tr>
      </thead>
      <tbody id="runs-body"></tbody>
    </table>
  </div>

  <!-- Single URL -->
  <div class="panel" id="panel-single">
    <h1>Single URL Tests</h1>
    <p class="panel-subtitle">Per-URL tests run across chrome, firefox, and webkit</p>

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

  <!-- Compare View -->
  <div class="panel" id="panel-compare">
    <h1>Compare View</h1>
    <p class="panel-subtitle">Screenshots of the compare view after onboarding — bags, apparel, footwear</p>

    <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:16px;margin-bottom:24px">
      <div style="font-size:13px;font-weight:600;color:#c9d1d9;margin-bottom:12px">Run new screenshot test</div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">GitHub PAT (workflow scope) — saved in browser only</label>
        <input id="gh-pat" type="password" placeholder="ghp_xxxxxxxxxxxx"
          style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 10px;font-size:13px"
          oninput="localStorage.setItem('gh_pat', this.value); document.getElementById('single-pat').value = this.value">
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px">Run label (optional)</label>
        <input id="compare-run-name" type="text" placeholder="e.g. bottega-spring"
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

  <!-- Inpage -->
  <div class="panel" id="panel-inpage">
    <h1>Inpage QA</h1>
    <p class="panel-subtitle">Full user journey through the inpage widget</p>
    <div class="info-panel">
      <div class="icon">🧪</div>
      <p>Run locally against any store or URL. Results appear in the Playwright HTML report.</p>
      <div class="run-cmd">npx playwright test tests/inpage.spec.js --project=chrome</div>
    </div>
  </div>

  <!-- Add to Cart -->
  <div class="panel" id="panel-cart">
    <h1>Add to Cart</h1>
    <p class="panel-subtitle">Validates the add-to-cart flow after size recommendation</p>
    <div class="info-panel">
      <div class="icon">🛒</div>
      <p>Run locally. Results appear in the Playwright HTML report.</p>
      <div class="run-cmd">npx playwright test tests/addToCart.spec.js --project=chrome</div>
    </div>
  </div>

</main>

<script>
const HISTORY = ${dataJson};
const SINGLE_URL_HISTORY = ${singleUrlJson};
const COMPARE_RUNS = ${compareJson};

// ── Navigation ────────────────────────────────────────────────────────────────
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#sidebar button').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('btn-' + name).classList.add('active');
  if (name === 'compare') renderCompareView();
  if (name === 'single') renderSingleUrl();
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
        \${s.url ? \`<a class="store" href="\${s.url}" target="_blank" rel="noopener">\${s.store}</a>\` : \`<span class="store">\${s.store}</span>\`}
        \${browserTag(s.browsers)}
      </li>\`).join('')}</ul></div>\`;

  const recurringHtml = recurring.length === 0 ? '' :
    \`<div class="detail-section"><h4>⚠️ Widget missing (ongoing)</h4><ul>\${recurring.map(m => \`<li>
        \${m.url ? \`<a class="store" href="\${m.url}" target="_blank" rel="noopener">\${m.store}</a>\` : \`<span class="store">\${m.store}</span>\`}
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

function renderTable() {
  const tbody = document.getElementById('runs-body');
  const filtered = activePhase === 'all' ? HISTORY : HISTORY.filter(r => (r.phase || 'widget') === activePhase);
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No runs yet.</td></tr>';
    return;
  }

  filtered.forEach((run, i) => {
    const s = run.summary;
    const phase = run.phase || 'widget';
    const runUrl = run.githubRunUrl || '#';

    const row = document.createElement('tr');
    row.className = 'run-row';
    row.innerHTML = \`
      <td><span class="chevron" id="chev-\${i}">›</span></td>
      <td class="ts">\${statusDot(run)}\${fmt(run.timestamp)}</td>
      <td><span class="phase-badge phase-\${phase}">\${phase}</span></td>
      <td class="count passed \${countClass(s.passed,'passed')}">\${s.passed}</td>
      <td class="count missing \${countClass(s.widgetMissing,'missing')}">\${s.widgetMissing}</td>
      <td class="count failed \${countClass(s.failed,'failed')}">\${s.failed}</td>
      <td class="count skipped \${countClass(s.skipped,'skipped')}">\${s.skipped}</td>
      <td class="run-link"><a href="\${runUrl}" target="_blank" rel="noopener">View →</a></td>
    \`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    const detailCell = document.createElement('td');
    detailCell.className = 'detail-cell';
    detailCell.colSpan = 8;
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
    { label: 'Refresh: recommendation re-fires', event: 'user-got-size-recommendation' },
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

  const kb  = entry.kidsOnboarding;
  const fwb = entry.footwearOnboarding;
  let obHtml = null;
  if (flow === 'apparel' || flow === 'noVisor') {
    obHtml = ob ? \`<ul style="list-style:none;padding:0;margin:0">
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${ob.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${ob.age} yr</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${ob.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Weight</span> <span style="color:#c9d1d9">\${ob.weight} kg</span></li>
    </ul>\` : null;
  } else if (flow === 'apparel' && entry.giftOnboarding) {
    // Show both adult onboarding body AND gift body for apparel
    const gb = entry.giftOnboarding;
    const adultRows = ob ? \`
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${ob.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${ob.age} yr</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${ob.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Weight</span> <span style="color:#c9d1d9">\${ob.weight} kg</span></li>\` : '';
    obHtml = \`<ul style="list-style:none;padding:0;margin:0">
      \${adultRows}
      <li style="font-size:11px;padding:4px 0 2px;color:#484f58;text-transform:uppercase;letter-spacing:0.5px">Gift recipient</li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Gender</span> <span style="color:#c9d1d9">\${gb.gender}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Age</span> <span style="color:#c9d1d9">\${gb.age}</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Height</span> <span style="color:#c9d1d9">\${gb.height} cm</span></li>
      <li style="font-size:12px;padding:2px 0"><span style="color:#8b949e">Body type</span> <span style="color:#c9d1d9">\${gb.bodyType}</span></li>
    </ul>\`;
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
    const chrome  = byBrowser['chrome']  || {};
    const firefox = byBrowser['firefox'] || {};
    const webkit  = byBrowser['webkit']  || {};

    const statusCell = (b) => {
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
      \${statusCell(chrome)}
      \${statusCell(firefox)}
      \${statusCell(webkit)}
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
function renderCompareView() {
  const el = document.getElementById('compare-content');
  if (COMPARE_RUNS.length === 0) {
    el.innerHTML = \`<div class="info-panel">
      <div class="icon">🖼</div>
      <p>No screenshots yet. Run the compare view test to generate them.</p>
      <div class="run-cmd">npx playwright test tests/compare-view-screenshot.spec.js --project=chrome</div>
    </div>\`;
    return;
  }

  el.innerHTML = \`
    <div class="flag-bar">
      <span id="flag-count">0 items flagged</span>
      <button id="export-btn" onclick="exportFlagged()" disabled>Export flagged URLs</button>
    </div>
    \` + COMPARE_RUNS.map(run => \`
    <div style="margin-bottom:32px">
      <h2 style="font-size:14px;font-weight:600;color:#c9d1d9;margin:0 0 12px">\${run.folder} — \${run.images.length} product\${run.images.length !== 1 ? 's' : ''}</h2>
      <div class="overlay-grid">
        \${run.images.map(({ sku, url }) => \`
          <div class="overlay-card" id="card-\${sku}" onclick="toggleFlag(event, '\${sku}', \${JSON.stringify(url)})">
            <img src="compare-view-screenshots/\${encodeURIComponent(run.folder)}/\${sku}.png" alt="">
            <div class="card-footer">
              <div class="card-sku">\${url ? \`<a href="\${url}" target="_blank" onclick="event.stopPropagation()">\${sku}</a>\` : sku}</div>
              <input class="flag-checkbox" type="checkbox" id="chk-\${sku}" onclick="event.stopPropagation(); toggleFlag(event, '\${sku}', \${JSON.stringify(url)}, true)">
            </div>
          </div>
        \`).join('')}
      </div>
    </div>
  \`).join('');
}

const flagged = new Map(); // sku → url

function toggleFlag(event, sku, url, fromCheckbox = false) {
  if (flagged.has(sku)) {
    flagged.delete(sku);
  } else {
    flagged.set(sku, url);
  }
  const card = document.getElementById('card-' + sku);
  const chk = document.getElementById('chk-' + sku);
  const isFlagged = flagged.has(sku);
  card.classList.toggle('flagged', isFlagged);
  chk.checked = isFlagged;
  document.getElementById('flag-count').textContent = flagged.size + ' item' + (flagged.size !== 1 ? 's' : '') + ' flagged';
  document.getElementById('export-btn').disabled = flagged.size === 0;
}

function downloadTxt(content, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function exportFlagged() {
  const lines = [...flagged.entries()].map(([sku, url]) => url || sku);
  downloadTxt(lines.join('\\n'), 'flagged-compare-view.txt');
}

// ── Compare view trigger ──────────────────────────────────────────────────────
async function triggerCompareRun() {
  const pat = document.getElementById('gh-pat').value.trim();
  const urls = document.getElementById('compare-urls').value.trim();
  const runName = document.getElementById('compare-run-name').value.trim();
  const status = document.getElementById('compare-trigger-status');

  if (!pat) { status.textContent = '⚠️ Enter a GitHub PAT first'; status.style.color = '#d29922'; return; }
  if (!urls) { status.textContent = '⚠️ Enter at least one URL'; status.style.color = '#d29922'; return; }

  status.textContent = 'Triggering…'; status.style.color = '#8b949e';

  const res = await fetch('https://api.github.com/repos/chengalore/vs-playwright-qa/actions/workflows/compare-view-screenshot.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { urls, run_name: runName } }),
  });

  if (res.status === 204) {
    status.textContent = '✅ Workflow triggered — results will appear here in ~5 min';
    status.style.color = '#3fb950';
    document.getElementById('compare-urls').value = '';
    document.getElementById('compare-run-name').value = '';
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

  if (!pat) { status.textContent = '⚠️ Enter a GitHub PAT first'; status.style.color = '#d29922'; return; }
  if (!testUrl) { status.textContent = '⚠️ Enter a product URL'; status.style.color = '#d29922'; return; }

  status.textContent = 'Triggering…'; status.style.color = '#8b949e';

  const res = await fetch('https://api.github.com/repos/chengalore/vs-playwright-qa/actions/workflows/single-url-test.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: {
      url: testUrl, phase,
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

// ── Init ──────────────────────────────────────────────────────────────────────
renderSummary(HISTORY[0] || null);
renderTable();
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
