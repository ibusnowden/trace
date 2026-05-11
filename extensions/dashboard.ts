/**
 * Web Dashboard — generates a self-contained HTML file for browsing thinking traces.
 *
 * The dashboard includes:
 * - Search/filter across all traces
 * - Model comparison table
 * - Thinking length distribution chart (bar chart drawn with CSS)
 * - Timeline view
 * - Full trace viewer with expandable content
 * - All CSS/JS inline, zero dependencies
 */
export function generateDashboardHtml(traces: import("./index.ts").ThinkingTrace[]): string {
	const byModel: Record<string, typeof traces> = {};
	for (const t of traces) {
		const key = `${t.provider}/${t.model}`;
		if (!byModel[key]) byModel[key] = [];
		byModel[key].push(t);
	}

	const totalTraces = traces.length;
	const totalTokens = traces.reduce((s, t) => s + Math.ceil(t.thinking.length / 4), 0);
	const modelKeys = Object.keys(byModel).sort();
	const sortedByTime = [...traces].sort((a, b) => a.timestamp - b.timestamp);

	// Length distribution
	const buckets = [0, 200, 500, 1000, 2000, 5000, 10000, Infinity];
	const bucketLabels = ["0-200", "200-500", "500-1K", "1K-2K", "2K-5K", "5K-10K", "10K+"];
	const bucketCounts = new Array(buckets.length - 1).fill(0);
	for (const t of traces) {
		const len = t.thinking.length;
		for (let b = 0; b < buckets.length - 1; b++) {
			if (len >= buckets[b] && len < buckets[b + 1]) { bucketCounts[b]++; break; }
		}
	}
	const maxBucket = Math.max(...bucketCounts, 1);

	// Per-model stats
	const modelStats = modelKeys.map((key) => {
		const mTraces = byModel[key];
		const avgLen = mTraces.reduce((s, t) => s + t.thinking.length, 0) / mTraces.length;
		const avgTok = mTraces.reduce((s, t) => s + Math.ceil(t.thinking.length / 4), 0) / mTraces.length;
		return { key, count: mTraces.length, avgLen: Math.round(avgLen), avgTok: Math.round(avgTok) };
	});

	const traceDataJson = JSON.stringify(traces.map((t) => ({
		id: t.id,
		model: `${t.provider}/${t.model}`,
		turn: t.turnIndex,
		time: new Date(t.timestamp).toISOString(),
		length: t.thinking.length,
		tokens: Math.ceil(t.thinking.length / 4),
		thinking: t.thinking,
	})));

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🧠 Reasoning Trace Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --success: #3fb950;
    --warning: #d29922;
    --error: #f85149;
    --thinking: #79c0ff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 { font-size: 1.8rem; margin-bottom: 8px; color: var(--accent); }
  h2 { font-size: 1.3rem; margin: 24px 0 12px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 1.1rem; margin: 16px 0 8px; }
  .subtitle { color: var(--text-dim); margin-bottom: 20px; }

  /* Stats grid */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }
  .stat-card .value { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
  .stat-card .label { font-size: 0.8rem; color: var(--text-dim); margin-top: 4px; }

  /* Table */
  table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-dim); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.5px; }
  td { font-size: 0.9rem; }

  /* Chart bars */
  .chart-container { margin: 12px 0 24px; }
  .chart-row { display: flex; align-items: center; margin-bottom: 4px; }
  .chart-label { width: 80px; font-size: 0.8rem; color: var(--text-dim); flex-shrink: 0; }
  .chart-bar-wrap { flex: 1; height: 20px; background: var(--surface); border-radius: 4px; overflow: hidden; }
  .chart-bar { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
  .chart-count { width: 50px; text-align: right; font-size: 0.8rem; color: var(--text-dim); flex-shrink: 0; margin-left: 8px; }

  /* Search */
  .search-bar {
    width: 100%;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.95rem;
    margin-bottom: 12px;
    outline: none;
  }
  .search-bar:focus { border-color: var(--accent); }
  .search-bar::placeholder { color: var(--text-dim); }

  /* Trace cards */
  .trace-count { color: var(--text-dim); font-size: 0.85rem; margin-bottom: 12px; }
  .trace-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .trace-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    cursor: pointer;
    user-select: none;
  }
  .trace-header:hover { background: rgba(88,166,255,0.05); }
  .trace-model { font-weight: 600; color: var(--accent); font-size: 0.9rem; }
  .trace-meta { color: var(--text-dim); font-size: 0.8rem; }
  .trace-meta span { margin-right: 12px; }
  .trace-content {
    padding: 0 14px 14px;
    display: none;
    white-space: pre-wrap;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.8rem;
    color: var(--text-dim);
    line-height: 1.5;
    max-height: 600px;
    overflow-y: auto;
  }
  .trace-card.expanded .trace-content { display: block; }
  .trace-card.expanded .expand-icon { transform: rotate(180deg); }
  .expand-icon {
    display: inline-block;
    transition: transform 0.2s;
    color: var(--text-dim);
    font-size: 0.7rem;
    margin-left: 8px;
  }

  /* No results */
  .no-results { text-align: center; padding: 40px; color: var(--text-dim); }

  /* Footer */
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text-dim); font-size: 0.8rem; text-align: center; }

  /* Model badges */
  .model-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .model-deepseek { background: rgba(79,195,247,0.15); color: #4FC3F7; }
  .model-anthropic { background: rgba(212,165,116,0.15); color: #D4A574; }
  .model-google { background: rgba(129,199,132,0.15); color: #81C784; }
  .model-openai { background: rgba(116,170,156,0.15); color: #74AA9C; }
  .model-other { background: rgba(144,164,174,0.15); color: #90A4AE; }

  @media (max-width: 600px) {
    body { padding: 12px; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .trace-header { flex-direction: column; align-items: flex-start; gap: 4px; }
  }
</style>
</head>
<body>

<h1>🧠 Reasoning Trace Dashboard</h1>
<p class="subtitle">Generated: ${new Date().toISOString()} &middot; ${totalTraces} traces &middot; ~${totalTokens.toLocaleString()} thinking tokens</p>

<!-- Stats -->
<div class="stats-grid">
  <div class="stat-card"><div class="value">${totalTraces}</div><div class="label">Total Traces</div></div>
  <div class="stat-card"><div class="value">${totalTokens.toLocaleString()}</div><div class="label">Est. Thinking Tokens</div></div>
  <div class="stat-card"><div class="value">${modelKeys.length}</div><div class="label">Models</div></div>
  <div class="stat-card"><div class="value">${(totalTraces > 0 ? (totalTokens / totalTraces).toFixed(0) : '0')}</div><div class="label">Avg Tokens/Trace</div></div>
</div>

<!-- Per-Model Breakdown -->
<h2>📊 Per-Model Breakdown</h2>
<table>
  <tr><th>Model</th><th>Traces</th><th>Avg Length</th><th>Avg Tokens</th></tr>
  ${modelStats.map((m) => `<tr><td><span class="model-badge model-${m.key.toLowerCase().includes('deepseek') ? 'deepseek' : m.key.toLowerCase().includes('anthropic') || m.key.toLowerCase().includes('claude') ? 'anthropic' : m.key.toLowerCase().includes('google') || m.key.toLowerCase().includes('gemini') ? 'google' : m.key.toLowerCase().includes('openai') || m.key.toLowerCase().includes('gpt') ? 'openai' : 'other'}">${m.key}</span></td><td>${m.count}</td><td>${m.avgLen.toLocaleString()} chars</td><td>${m.avgTok.toLocaleString()}</td></tr>`).join('\n  ')}
</table>

<!-- Length Distribution -->
<h2>📈 Length Distribution</h2>
<div class="chart-container">
  ${bucketLabels.map((label, i) => `
  <div class="chart-row">
    <div class="chart-label">${label}</div>
    <div class="chart-bar-wrap">
      <div class="chart-bar" style="width: ${(bucketCounts[i] / maxBucket * 100).toFixed(1)}%"></div>
    </div>
    <div class="chart-count">${bucketCounts[i]}</div>
  </div>`).join('')}
</div>

<!-- Timeline -->
<h2>⏱ Timeline</h2>
<table>
  <tr><th>#</th><th>Time</th><th>Model</th><th>Length</th><th>Tokens</th></tr>
  ${sortedByTime.slice(0, 50).map((t, i) => `
  <tr>
    <td>${i + 1}</td>
    <td>${new Date(t.timestamp).toLocaleString()}</td>
    <td><span class="model-badge model-${t.provider.toLowerCase().includes('deepseek') ? 'deepseek' : t.provider.toLowerCase().includes('anthropic') ? 'anthropic' : t.provider.toLowerCase().includes('google') ? 'google' : 'other'}">${t.provider}/${t.model}</span></td>
    <td>${t.thinking.length.toLocaleString()}</td>
    <td>${Math.ceil(t.thinking.length / 4).toLocaleString()}</td>
  </tr>`).join('\n  ')}
  ${sortedByTime.length > 50 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">... and ${sortedByTime.length - 50} more</td></tr>` : ''}
</table>

<!-- Search & Traces -->
<h2>🔍 All Traces</h2>
<input type="text" class="search-bar" id="search" placeholder="Search traces by content, model, or provider..." oninput="filterTraces()">
<div id="traceCount" class="trace-count">Showing ${traces.length} trace(s)</div>
<div id="traceList">
  ${traces.map((t, i) => `
  <div class="trace-card" data-index="${i}" data-search="${(t.thinking + ' ' + t.model + ' ' + t.provider).toLowerCase().replace(/"/g, '&quot;')}">
    <div class="trace-header" onclick="toggleTrace(${i})">
      <div>
        <span class="trace-model">${t.provider}/${t.model}</span>
        <span class="trace-meta">
          <span>Turn ${t.turnIndex}</span>
          <span>${t.thinking.length.toLocaleString()} chars</span>
          <span>${Math.ceil(t.thinking.length / 4).toLocaleString()} tok</span>
          <span>${new Date(t.timestamp).toLocaleString()}</span>
        </span>
      </div>
      <span class="expand-icon">▾</span>
    </div>
    <div class="trace-content">${escapeHtml(t.thinking)}</div>
  </div>`).join('\n  ')}
</div>

<div class="footer">
  Generated with <a href="https://github.com/ibusnowden/trace" style="color:var(--accent)">Reasoning Trace Visualizer</a> &middot; Data from pi sessions
</div>

<script>
const tracesData = ${traceDataJson};

function toggleTrace(index) {
  const card = document.querySelectorAll('.trace-card')[index];
  if (card) card.classList.toggle('expanded');
}

function filterTraces() {
  const query = document.getElementById('search').value.toLowerCase().trim();
  const cards = document.querySelectorAll('.trace-card');
  let visible = 0;
  cards.forEach((card) => {
    const searchText = card.dataset.search || '';
    const match = !query || searchText.includes(query);
    card.style.display = match ? '' : 'none';
    if (match) visible++;
    // Collapse all on new search
    card.classList.remove('expanded');
  });
  document.getElementById('traceCount').textContent = 'Showing ' + visible + ' trace(s)' + (query ? ' matching "' + query + '"' : '');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
</script>
</body>
</html>`;
}