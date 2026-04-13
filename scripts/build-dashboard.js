import fs from 'fs';

const HISTORY_FILE = 'data/monitor-history.json';
const MAX_HISTORY = 50;

// Load existing history
const history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  : [];

// Prepend current run
if (fs.existsSync('data/monitor-report.json')) {
  const report = JSON.parse(fs.readFileSync('data/monitor-report.json', 'utf8'));
  report.phase = process.env.PHASE || 'widget';
  history.unshift(report);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Generate dashboard HTML
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/index.html', generateDashboard(history));
console.log(`Dashboard written — ${history.length} runs in history`);

function generateDashboard(history) {
  const dataJson = JSON.stringify(history).replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VS Monitor Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 24px 16px 48px;
    }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .container { max-width: 1100px; margin: 0 auto; }

    header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 28px;
      padding-bottom: 16px;
      border-bottom: 1px solid #21262d;
    }
    header h1 { font-size: 22px; font-weight: 600; color: #f0f6fc; }
    header .subtitle { font-size: 13px; color: #8b949e; }

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
    tbody td {
      padding: 10px 12px;
      vertical-align: middle;
    }
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

    .count { font-weight: 600; text-align: right; }
    .count.passed { color: #3fb950; }
    .count.missing { color: #d29922; }
    .count.failed { color: #f85149; }
    .count.skipped { color: #8b949e; }
    .count.zero { color: #30363d; font-weight: 400; }

    .run-link { font-size: 13px; }
    .chevron { color: #8b949e; font-size: 12px; transition: transform 0.2s; display: inline-block; }
    .chevron.open { transform: rotate(90deg); }

    .detail-row { display: none; }
    .detail-row.open { display: table-row; }
    .detail-cell {
      padding: 0 12px 16px 12px;
      background: #0d1117;
    }
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
    .empty { color: #3fb950; font-size: 13px; }

    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .dot-green { background: #3fb950; }
    .dot-yellow { background: #d29922; }
    .dot-red { background: #f85149; }

    @media (max-width: 640px) {
      .summary-card { gap: 10px; }
      .summary-card .divider { display: none; }
      thead th:nth-child(6), tbody td:nth-child(6) { display: none; }
    }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>VS Monitor Dashboard</h1>
    <span class="subtitle" id="last-updated"></span>
  </header>

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

<script>
const HISTORY = ${dataJson};

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
}

function statusDot(run) {
  if (run.summary.failed > 0) return '<span class="status-dot dot-red"></span>';
  if (run.summary.widgetMissing > 0) return '<span class="status-dot dot-yellow"></span>';
  return '<span class="status-dot dot-green"></span>';
}

function renderSummary(run) {
  if (!run) { document.getElementById('summary-card').textContent = 'No runs yet.'; return; }
  const s = run.summary;
  document.getElementById('last-updated').textContent = 'Last run: ' + fmt(run.timestamp);
  document.getElementById('summary-card').innerHTML = \`
    <div class="stat-block"><div class="label">Passed</div><div class="stat passed">\${s.passed}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Missing</div><div class="stat missing">\${s.widgetMissing}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Failed</div><div class="stat failed">\${s.failed}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Skipped</div><div class="stat skipped">\${s.skipped}</div></div>
    <div class="divider"></div>
    <div class="stat-block"><div class="label">Total</div><div class="stat" style="color:#f0f6fc">\${s.total}</div></div>
  \`;
}

function countClass(n, type) {
  if (n === 0) return 'zero';
  return type;
}

function renderDetail(run) {
  const issues = (run.newIssues || []);
  const widgetMissingStores = (run.widgetMissingStores || []);
  const ongoingMissing = (run.ongoingMissing || []);
  const bots = (run.botProtected || []);
  const skipped = (run.skippedStores || []);

  const issueHtml = issues.length === 0
    ? '<span class="empty">None</span>'
    : issues.map(i => \`<li><span class="store">\${i.store}</span><span class="error-text">\${i.error || ''}</span></li>\`).join('');

  // Split widget missing into new (first time) vs ongoing (consecutive runs)
  const ongoingMap = Object.fromEntries(ongoingMissing.map(o => [o.store, o.consecutiveRuns]));
  const newMissing = widgetMissingStores.filter(s => !ongoingMap[s]);
  const recurringMissing = widgetMissingStores.filter(s => ongoingMap[s]).map(s => ({ store: s, runs: ongoingMap[s] + 1 }));

  const newMissingHtml = newMissing.length === 0 ? '' :
    \`<div class="detail-section"><h4>⚠️ Widget missing (new)</h4><ul>\${newMissing.map(s => \`<li><span class="store">\${s}</span></li>\`).join('')}</ul></div>\`;

  const recurringMissingHtml = recurringMissing.length === 0 ? '' :
    \`<div class="detail-section"><h4>⚠️ Widget missing (ongoing)</h4><ul>\${recurringMissing.map(m => \`<li><span class="store">\${m.store}</span> <span class="meta">×\${m.runs} runs</span></li>\`).join('')}</ul></div>\`;

  const botHtml = bots.length === 0
    ? '<span class="empty">None</span>'
    : bots.map(b => \`<li><span class="store">\${b}</span></li>\`).join('');

  const skippedHtml = skipped.length === 0
    ? '<span class="empty">None</span>'
    : skipped.map(s => \`<li><span class="store">\${s.store || s}</span>\${s.reason ? \` <span class="meta">(\${s.reason})</span>\` : ''}</li>\`).join('');

  return \`<div class="detail-inner">
    <div class="detail-section"><h4>❌ Failed</h4><ul>\${issueHtml}</ul></div>
    \${newMissingHtml}
    \${recurringMissingHtml}
    <div class="detail-section"><h4>🤖 Bot protected</h4><ul>\${botHtml}</ul></div>
    <div class="detail-section"><h4>⏭ Skipped</h4><ul>\${skippedHtml}</ul></div>
  </div>\`;
}

let activePhase = 'all';

function renderTable() {
  const tbody = document.getElementById('runs-body');
  const filtered = activePhase === 'all' ? HISTORY : HISTORY.filter(r => (r.phase || 'widget') === activePhase);
  tbody.innerHTML = '';

  filtered.forEach((run, i) => {
    const s = run.summary;
    const phase = run.phase || 'widget';
    const runUrl = run.githubRunUrl || '#';
    const hasIssues = (run.newIssues && run.newIssues.length > 0) ||
                      (run.ongoingMissing && run.ongoingMissing.length > 0);

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
    detailRow.id = 'detail-\${i}';
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

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:#8b949e">No runs yet.</td></tr>';
  }
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activePhase = btn.dataset.phase;
    renderTable();
  });
});

renderSummary(HISTORY[0] || null);
renderTable();
</script>
</body>
</html>`;
}
