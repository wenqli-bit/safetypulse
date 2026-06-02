const state = {
  days: 7,
  surface: "all",
  metric: "violation_rate",
};

const $ = (selector) => document.querySelector(selector);

const els = {
  apiStatus: $("#apiStatus"),
  refreshBtn: $("#refreshBtn"),
  seedBtn: $("#seedBtn"),
  windowSelect: $("#windowSelect"),
  surfaceSelect: $("#surfaceSelect"),
  metricSelect: $("#metricSelect"),
  metricCards: $("#metricCards"),
  latestDate: $("#latestDate"),
  trendMeta: $("#trendMeta"),
  trendMetricBadge: $("#trendMetricBadge"),
  forecastSummary: $("#forecastSummary"),
  trendChart: $("#trendChart"),
  surfaceRows: $("#surfaceRows"),
  surfaceBarChart: $("#surfaceBarChart"),
  policyBarChart: $("#policyBarChart"),
  regionBarChart: $("#regionBarChart"),
  anomalyMeta: $("#anomalyMeta"),
  anomalyList: $("#anomalyList"),
  rootMeta: $("#rootMeta"),
  rootMetricBadge: $("#rootMetricBadge"),
  rootSummary: $("#rootSummary"),
  rootBars: $("#rootBars"),
  accountMeta: $("#accountMeta"),
  accountCount: $("#accountCount"),
  accountRows: $("#accountRows"),
  clusterBarChart: $("#clusterBarChart"),
  actionRows: $("#actionRows"),
  toast: $("#toast"),
};

function number(value, digits = 0) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Number(value || 0));
}

function compact(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2400);
}

async function api(path, options = {}) {
  // Add cache-bust timestamp so browser never serves stale data
  const sep = path.includes("?") ? "&" : "?";
  const bustPath = `${path}${sep}_t=${Date.now()}`;
  const response = await fetch(bustPath, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setStatus(ok, text) {
  els.apiStatus.textContent = text;
  els.apiStatus.classList.toggle("ok", ok);
  els.apiStatus.classList.toggle("error", !ok);
}

function displayCardValue(card) {
  if (card.key === "exposures" || card.key === "risk_accounts") return compact(card.value);
  const suffix = card.unit ? ` ${card.unit}` : "";
  return `${number(card.value, card.key.includes("rate") ? 2 : 1)}${suffix}`;
}

function displayMetricValue(value, metric, unit = "") {
  if (metric === "risk_accounts" || metric === "incidents" || metric === "exposures") return compact(value);
  const suffix = unit ? ` ${unit}` : "";
  return `${number(value, metric.includes("rate") ? 2 : 1)}${suffix}`;
}

function renderCards(cards) {
  els.metricCards.innerHTML = cards
    .map((card) => {
      const directionClass = card.direction === "up" ? "up" : "down";
      const sign = card.delta > 0 ? "+" : "";
      const isCount = card.key === "exposures" || card.key === "risk_accounts" || card.key === "incidents";
      const windowLabel = isCount ? `<span class="card-window">近 ${state.days} 天</span>` : "";
      return `
        <article class="metric-card">
          <span>${escapeHtml(card.label)}${windowLabel}</span>
          <strong>${displayCardValue(card)}</strong>
          <small class="${directionClass}">${sign}${number(card.delta, 1)}% vs 上期</small>
        </article>
      `;
    })
    .join("");
}

function pointsToPath(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function renderStatStrip(target, items) {
  target.innerHTML = items
    .map(
      (item) => `
        <div>
          <span>${escapeHtml(item.label)}</span>
          <strong class="${item.className || ""}">${escapeHtml(item.value)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderTrend(trend) {
  els.trendMetricBadge.textContent = trend.metric_label || "-";
  const actual = trend.actual || [];
  const forecast = trend.forecast || [];
  const summary = trend.summary || {};
  const sign = summary.forecast_delta_pct > 0 ? "+" : "";
  els.trendMeta.textContent = `${actual.length} 天历史，未来 7 天预测`;
  renderStatStrip(els.forecastSummary, [
    { label: "当前", value: displayMetricValue(summary.current, trend.metric, trend.unit) },
    { label: "7 天预测", value: displayMetricValue(summary.forecast_7d, trend.metric, trend.unit) },
    {
      label: "预测变化",
      value: `${sign}${number(summary.forecast_delta_pct, 1)}%`,
      className: summary.forecast_delta_pct >= 0 ? "up" : "down",
    },
  ]);

  if (!actual.length) {
    els.trendChart.innerHTML = '<div class="empty">暂无趋势数据</div>';
    return;
  }

  const width = 760;
  const height = 270;
  const pad = { left: 46, right: 22, top: 20, bottom: 34 };
  const allValues = [
    ...actual.flatMap((point) => [point.value, point.baseline]),
    ...forecast.flatMap((point) => [point.value, point.lower, point.upper]),
  ];
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const spread = Math.max(max - min, Math.abs(max) * 0.08, 1);
  const yMin = Math.max(0, min - spread * 0.15);
  const yMax = max + spread * 0.18;
  const total = actual.length + forecast.length;
  const xStep = (width - pad.left - pad.right) / Math.max(total - 1, 1);
  const yScale = (value) => pad.top + ((yMax - value) / (yMax - yMin)) * (height - pad.top - pad.bottom);
  const pointFor = (value, index) => ({ x: pad.left + xStep * index, y: yScale(value) });

  const actualPoints = actual.map((point, index) => pointFor(point.value, index));
  const baselinePoints = actual.map((point, index) => pointFor(point.baseline, index));
  const forecastPoints = forecast.map((point, index) => pointFor(point.value, actual.length + index));
  const upperPoints = forecast.map((point, index) => pointFor(point.upper, actual.length + index));
  const lowerPoints = forecast.map((point, index) => pointFor(point.lower, actual.length + index)).reverse();
  const bandPath = upperPoints.length
    ? `${pointsToPath(upperPoints)} L ${lowerPoints.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")} Z`
    : "";
  const splitX = pad.left + xStep * (actual.length - 1);
  const firstDate = actual[0].date.slice(5);
  const lastDate = forecast.length ? forecast[forecast.length - 1].date.slice(5) : actual.at(-1).date.slice(5);

  els.trendChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(trend.metric_label)}趋势">
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <line class="split" x1="${splitX}" y1="${pad.top}" x2="${splitX}" y2="${height - pad.bottom}"></line>
      ${bandPath ? `<path class="forecast-band" d="${bandPath}"></path>` : ""}
      <path class="baseline-line" d="${pointsToPath(baselinePoints)}"></path>
      <path class="actual-line" d="${pointsToPath(actualPoints)}"></path>
      <path class="forecast-line" d="${pointsToPath([actualPoints.at(-1), ...forecastPoints])}"></path>
      ${actualPoints
        .slice(-8)
        .map((point) => `<circle class="actual-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"></circle>`)
        .join("")}
      ${forecastPoints
        .map((point) => `<circle class="forecast-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"></circle>`)
        .join("")}
      <text class="axis-label" x="${pad.left}" y="${height - 8}">${firstDate}</text>
      <text class="axis-label" x="${width - pad.right - 38}" y="${height - 8}">${lastDate}</text>
      <text class="axis-label" x="${pad.left + 6}" y="${pad.top + 12}">${number(yMax, trend.metric.includes("rate") ? 2 : 1)}</text>
      <text class="axis-label" x="${pad.left + 6}" y="${height - pad.bottom - 8}">${number(yMin, trend.metric.includes("rate") ? 2 : 1)}</text>
    </svg>
  `;
}

function renderSurfaceRows(surfaces) {
  if (!surfaces.length) {
    els.surfaceRows.innerHTML = '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
    return;
  }
  els.surfaceRows.innerHTML = surfaces
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.surface)}</td>
          <td>${compact(row.exposures)}</td>
          <td>${number(row.report_rate, 2)}</td>
          <td>${number(row.violation_rate, 2)}</td>
          <td>${number(row.incidents)}</td>
        </tr>
      `,
    )
    .join("");
}

// Color palette for charts
const CHART_COLORS = {
  teal:   { fill: "#0d9488", light: "rgba(13,148,136,0.12)" },
  blue:   { fill: "#3b82f6", light: "rgba(59,130,246,0.12)" },
  violet: { fill: "#8b5cf6", light: "rgba(139,92,246,0.12)" },
  rose:   { fill: "#f43f5e", light: "rgba(244,63,94,0.12)"  },
  amber:  { fill: "#f59e0b", light: "rgba(245,158,11,0.12)" },
};

// Y-axis grid lines
function yGridLines(pad, width, height, max, digits) {
  const steps = 4;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const val = (max / steps) * (steps - i);
    const y = pad.top + (i / steps) * (height - pad.top - pad.bottom);
    return `
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"
            stroke="#f3f4f6" stroke-width="1"/>
      <text x="${(pad.left - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}"
            text-anchor="end" class="axis-label" style="font-size:10.5px">
        ${number(val, digits || 0)}
      </text>`;
  }).join("");
}

function renderGroupedBars(target, rows, options) {
  if (!rows.length) {
    target.innerHTML = '<div class="empty">暂无图表数据</div>';
    return;
  }
  const width = 680;
  const height = 240;
  const pad = { left: 44, right: 16, top: 16, bottom: 48 };
  const series = options.series;
  const colors = [CHART_COLORS.teal, CHART_COLORS.blue, CHART_COLORS.violet];
  const max = Math.max(...rows.flatMap((row) => series.map((item) => Number(row[item.key]) || 0)), 1);
  const niceMax = max * 1.15;

  const groupWidth = (width - pad.left - pad.right) / rows.length;
  const gap = 4;
  const totalBarW = Math.min(groupWidth * 0.72, 56);
  const barWidth = Math.max(6, (totalBarW - gap * (series.length - 1)) / series.length);

  const y = (value) => pad.top + (1 - value / niceMax) * (height - pad.top - pad.bottom);

  const bars = rows.map((row, rowIndex) => {
    const groupCenterX = pad.left + rowIndex * groupWidth + groupWidth / 2;
    const totalW = barWidth * series.length + gap * (series.length - 1);
    return series.map((item, si) => {
      const color = colors[si] || CHART_COLORS.teal;
      const value = Number(row[item.key]) || 0;
      const x = groupCenterX - totalW / 2 + si * (barWidth + gap);
      const barY = y(value);
      const barH = Math.max(2, height - pad.bottom - barY);
      const valText = value > 0
        ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(barY - 4).toFixed(1)}"
               text-anchor="middle" class="axis-label" style="font-size:10px;fill:${color.fill};font-weight:700">
             ${number(value, options.digits || 1)}
           </text>`
        : "";
      return `
        <rect fill="${color.fill}" x="${x.toFixed(1)}" y="${barY.toFixed(1)}"
              width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" rx="4"/>
        ${valText}`;
    }).join("");
  }).join("");

  // x-axis labels — full text, rotated if needed
  const labelMaxLen = rows.reduce((m, r) => Math.max(m, String(r[options.labelKey]).length), 0);
  const rotate = labelMaxLen > 8 || rows.length > 5;
  const labels = rows.map((row, index) => {
    const x = pad.left + index * groupWidth + groupWidth / 2;
    const label = escapeHtml(String(row[options.labelKey]));
    if (rotate) {
      return `<text x="${x.toFixed(1)}" y="${height - pad.bottom + 12}"
                    class="axis-label" style="font-size:11px"
                    text-anchor="end"
                    transform="rotate(-35,${x.toFixed(1)},${height - pad.bottom + 12})">
                ${label}
              </text>`;
    }
    return `<text x="${x.toFixed(1)}" y="${height - pad.bottom + 16}"
                  text-anchor="middle" class="axis-label" style="font-size:11.5px">
              ${label}
            </text>`;
  }).join("");

  // Legend — rendered as HTML below the SVG
  const legendHtml = series.map((item, si) => {
    const color = (colors[si] || CHART_COLORS.teal).fill;
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#6b7280;font-weight:500">
      <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color}"></span>
      ${escapeHtml(item.label)}
    </span>`;
  }).join("");

  target.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.ariaLabel)}">
      ${yGridLines(pad, width, height, niceMax, options.digits)}
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}"
            x2="${width - pad.right}" y2="${height - pad.bottom}"/>
      ${bars}
      ${labels}
    </svg>
    <div style="display:flex;gap:14px;padding:0 18px 14px;flex-wrap:wrap">${legendHtml}</div>
  `;
}

function renderSingleBars(target, rows, options) {
  if (!rows.length) {
    target.innerHTML = '<div class="empty">暂无图表数据</div>';
    return;
  }
  const width = 680;
  const height = 240;
  const pad = { left: 44, right: 16, top: 16, bottom: 48 };
  const max = Math.max(...rows.map((row) => Number(row[options.valueKey]) || 0), 1);
  const niceMax = max * 1.15;

  const groupWidth = (width - pad.left - pad.right) / rows.length;
  const barWidth = Math.min(72, groupWidth * 0.62);
  const y = (value) => pad.top + (1 - value / niceMax) * (height - pad.top - pad.bottom);

  // Use a gradient of teal→blue shades per bar for visual interest
  const palette = ["#0d9488","#0891b2","#2563eb","#7c3aed","#db2777","#dc2626"];

  const labelMaxLen = rows.reduce((m, r) => Math.max(m, String(r[options.labelKey]).length), 0);
  const rotate = labelMaxLen > 8 || rows.length > 5;

  const bars = rows.map((row, index) => {
    const value = Number(row[options.valueKey]) || 0;
    const x = pad.left + index * groupWidth + groupWidth / 2 - barWidth / 2;
    const barY = y(value);
    const barH = Math.max(2, height - pad.bottom - barY);
    const color = palette[index % palette.length];
    const label = escapeHtml(String(row[options.labelKey]));
    const xLabel = (x + barWidth / 2).toFixed(1);
    const yLabelBase = height - pad.bottom + 12;
    const labelEl = rotate
      ? `<text x="${xLabel}" y="${yLabelBase}" class="axis-label" style="font-size:11px"
               text-anchor="end" transform="rotate(-35,${xLabel},${yLabelBase})">${label}</text>`
      : `<text x="${xLabel}" y="${(yLabelBase + 4).toFixed(1)}" text-anchor="middle"
               class="axis-label" style="font-size:11.5px">${label}</text>`;
    const valEl = value > 0
      ? `<text x="${xLabel}" y="${(barY - 4).toFixed(1)}" text-anchor="middle"
               class="axis-label" style="font-size:10.5px;fill:${color};font-weight:700">
           ${compact(value)}
         </text>`
      : "";
    return `
      <rect fill="${color}" x="${x.toFixed(1)}" y="${barY.toFixed(1)}"
            width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" rx="5"/>
      ${valEl}
      ${labelEl}`;
  }).join("");

  target.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.ariaLabel)}">
      ${yGridLines(pad, width, height, niceMax, 0)}
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}"
            x2="${width - pad.right}" y2="${height - pad.bottom}"/>
      ${bars}
    </svg>
  `;
}

function renderHorizontalBars(target, rows, options) {
  if (!rows.length) {
    target.innerHTML = '<div class="empty">暂无图表数据</div>';
    return;
  }
  const max = Math.max(...rows.map((row) => Number(row[options.valueKey]) || 0), 1);
  target.innerHTML = `
    <div class="rank-bars">
      ${rows
        .map((row, index) => {
          const value = Number(row[options.valueKey]) || 0;
          const width = Math.max(5, Math.round((value / max) * 100));
          return `
            <div class="rank-row">
              <span>${escapeHtml(row[options.labelKey])}</span>
              <div class="bar-track"><div class="bar-fill ${index % 2 ? "blue" : ""}" style="width:${width}%"></div></div>
              <strong>${options.format ? options.format(value) : compact(value)}</strong>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAnalytics(summary) {
  renderGroupedBars(els.surfaceBarChart, summary.surfaces || [], {
    labelKey: "surface",
    ariaLabel: "业务域举报率与违规率",
    digits: 2,
    series: [
      { key: "report_rate", label: "举报/千", className: "bar-primary" },
      { key: "violation_rate", label: "违规/千", className: "bar-secondary" },
    ],
  });
  renderSingleBars(els.policyBarChart, summary.policy_mix || [], {
    labelKey: "policy",
    valueKey: "violations",
    ariaLabel: "政策违规量",
    className: "bar-warning",
  });
  renderHorizontalBars(els.regionBarChart, summary.region_mix || [], {
    labelKey: "region",
    valueKey: "risk_accounts",
    format: (value) => number(value),
  });
}

function renderAnomalies(payload) {
  const anomalies = payload.anomalies || [];
  els.latestDate.textContent = payload.latest_date || "-";
  els.anomalyMeta.textContent = `${number(anomalies.length)} 个活跃异常`;

  if (!anomalies.length) {
    els.anomalyList.innerHTML = '<div class="empty">当前窗口未发现显著异常</div>';
    return;
  }

  els.anomalyList.innerHTML = anomalies
    .slice(0, 8)
    .map(
      (item) => `
        <article class="anomaly-item">
          <div class="severity ${item.severity.toLowerCase()}">${escapeHtml(item.severity)}</div>
          <div>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.recommendation)}</p>
            <div class="anomaly-meta">
              <span>当前 ${number(item.current, 2)}</span>
              <span>基线 ${number(item.baseline, 2)}</span>
              <span>${item.delta_pct > 0 ? "+" : ""}${number(item.delta_pct, 1)}%</span>
              <span>score ${number(item.score, 2)}</span>
            </div>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderRoot(root) {
  els.rootMetricBadge.textContent = root.metric_label || "-";
  const summary = root.summary || {};
  const sign = summary.delta_pct > 0 ? "+" : "";
  els.rootMeta.textContent = `${number(summary.current, 2)} vs ${number(summary.baseline, 2)} baseline`;
  renderStatStrip(els.rootSummary, [
    { label: "当前", value: number(summary.current, 2) },
    { label: "基线", value: number(summary.baseline, 2) },
    {
      label: "变化",
      value: `${sign}${number(summary.delta_pct, 1)}%`,
      className: summary.delta_pct >= 0 ? "up" : "down",
    },
  ]);

  const segments = root.segments || [];
  if (!segments.length) {
    els.rootBars.innerHTML = '<div class="empty">暂无贡献切片</div>';
    return;
  }
  const max = Math.max(...segments.map((item) => Math.max(item.contribution, 0)), 1);
  els.rootBars.innerHTML = segments
    .slice(0, 8)
    .map((item) => {
      const width = Math.max(4, Math.round((Math.max(item.contribution, 0) / max) * 100));
      return `
        <div class="rank-row">
          <span>${escapeHtml(item.segment)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <strong>${number(item.contribution, 1)}%</strong>
        </div>
      `;
    })
    .join("");
}

function renderAccounts(payload) {
  const accounts = payload.accounts || [];
  els.accountCount.textContent = number(accounts.length);
  els.accountMeta.textContent = state.surface === "all" ? "按风险分排序的账号样本" : `${state.surface} 账号样本`;

  if (!accounts.length) {
    els.accountRows.innerHTML = '<div class="empty">暂无高风险账号</div>';
    els.clusterBarChart.innerHTML = '<div class="empty">暂无账号簇数据</div>';
    return;
  }

  els.accountRows.innerHTML = accounts
    .map(
      (account) => `
        <article class="account-card">
          <div class="account-main">
            <div>
              <h3>${escapeHtml(account.account_id)}</h3>
              <p>${escapeHtml(account.status)} · last seen ${escapeHtml(account.last_seen.slice(5, 16))}</p>
            </div>
            <span class="risk-score ${String(account.risk_level).toLowerCase()}">${number(account.risk_score, 1)}</span>
          </div>
          <div class="account-tags">
            <span>${escapeHtml(account.surface)} / ${escapeHtml(account.region)} / ${escapeHtml(account.policy)}</span>
            <span>${escapeHtml(account.cluster)}</span>
            <span>${escapeHtml(account.signup_source)} · ${number(account.device_count)} devices</span>
            <span>${number(account.report_count)} 举报 / ${number(account.violation_count)} 违规</span>
          </div>
          <p class="account-reco">${escapeHtml(account.recommendation)}</p>
        </article>
      `,
    )
    .join("");

  const clusterCounts = new Map();
  for (const account of accounts) {
    clusterCounts.set(account.cluster, (clusterCounts.get(account.cluster) || 0) + 1);
  }
  const clusters = Array.from(clusterCounts.entries())
    .map(([cluster, count]) => ({ cluster, count }))
    .sort((a, b) => b.count - a.count);
  renderHorizontalBars(els.clusterBarChart, clusters, {
    labelKey: "cluster",
    valueKey: "count",
    format: (value) => number(value),
  });
}

function renderActions(actions) {
  if (!actions.length) {
    els.actionRows.innerHTML = '<tr><td colspan="6" class="empty">暂无治理动作</td></tr>';
    return;
  }
  els.actionRows.innerHTML = actions
    .map(
      (action) => `
        <tr>
          <td><span class="severity inline ${action.priority.toLowerCase()}">${escapeHtml(action.priority)}</span></td>
          <td>${escapeHtml(action.status)}</td>
          <td>${escapeHtml(action.owner)}</td>
          <td>${escapeHtml(action.segment)}</td>
          <td>${escapeHtml(action.title)}</td>
          <td>${escapeHtml(action.expected_impact)}</td>
        </tr>
      `,
    )
    .join("");
}

function summaryQuery() {
  return `/api/safety/summary?days=${state.days}&surface=${encodeURIComponent(state.surface)}`;
}

function rootQuery() {
  return `/api/safety/root-cause?days=${state.days}&surface=${encodeURIComponent(state.surface)}&metric=${state.metric}`;
}

function trendQuery() {
  return `/api/safety/trends?days=30&surface=${encodeURIComponent(state.surface)}&metric=${state.metric}`;
}

function accountQuery() {
  return `/api/safety/accounts?limit=18&surface=${encodeURIComponent(state.surface)}`;
}

async function refresh() {
  try {
    const [health, summary, trends, accounts, anomalies, root, actions] = await Promise.all([
      api("/api/health"),
      api(summaryQuery()),
      api(trendQuery()),
      api(accountQuery()),
      api("/api/safety/anomalies?lookback_days=14"),
      api(rootQuery()),
      api("/api/safety/actions"),
    ]);
    setStatus(Boolean(health.ok), "已连接");
    renderCards(summary.cards);
    renderTrend(trends);
    renderSurfaceRows(summary.surfaces || []);
    renderAnalytics(summary);
    renderAccounts(accounts);
    renderAnomalies(anomalies);
    renderRoot(root);
    renderActions(actions.actions || []);
  } catch (error) {
    setStatus(false, "连接失败");
    showToast(error.message);
  }
}

function syncControls() {
  els.windowSelect.value = String(state.days);
  els.surfaceSelect.value = state.surface;
  els.metricSelect.value = state.metric;
}

function wireNavigation() {
  document.querySelectorAll(".side-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".side-nav a").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
    });
  });
}

els.windowSelect.addEventListener("change", () => {
  state.days = Number(els.windowSelect.value);
  showToast(`已切换至近 ${state.days} 天数据`);
  refresh();
});

els.surfaceSelect.addEventListener("change", () => {
  state.surface = els.surfaceSelect.value;
  refresh();
});

els.metricSelect.addEventListener("change", () => {
  state.metric = els.metricSelect.value;
  refresh();
});

els.refreshBtn.addEventListener("click", refresh);

els.seedBtn.addEventListener("click", async () => {
  try {
    const result = await api("/api/safety/seed?reset=true", { method: "POST", body: "{}" });
    showToast(`已生成 ${number(result.metrics)} 条指标和 ${number(result.accounts)} 个账号样本`);
    refresh();
  } catch (error) {
    showToast(error.message);
  }
});

syncControls();
wireNavigation();
refresh();

/* ══════════════════════════════════════
   漏斗分析
══════════════════════════════════════ */
const FUNNEL_STAGES = [
  { key: "reported",  label: "内容举报",  color: "#3b82f6", desc: "用户 / 系统上报的违规内容" },
  { key: "triaged",   label: "分诊队列",  color: "#0d9488", desc: "经过优先级排序进入审核队列" },
  { key: "reviewed",  label: "人工审核",  color: "#7c3aed", desc: "审核员完成内容核查" },
  { key: "actioned",  label: "处置决定",  color: "#d97706", desc: "内容下架 / 账号封禁等执行" },
  { key: "appealed",  label: "申诉受理",  color: "#dc2626", desc: "用户发起申诉并进入复核" },
];

const ACTION_TYPES = [
  { label: "内容下架", pct: 41 },
  { label: "警告提示", pct: 28 },
  { label: "账号封禁", pct: 17 },
  { label: "功能限制", pct: 9  },
  { label: "无需处置", pct: 5  },
];

function funnelMockData(days, surface) {
  const seed = days * 7 + (surface === "all" ? 0 : surface.charCodeAt(0));
  const rng = (min, max, s = 0) => min + ((seed + s) % (max - min));
  const base = rng(40000, 70000);
  const counts = [
    base,
    Math.round(base * (0.68 + rng(0, 10, 1) / 100)),
    Math.round(base * (0.68 + rng(0, 10, 1) / 100) * (0.71 + rng(0, 8, 2) / 100)),
    Math.round(base * (0.68 + rng(0, 10, 1) / 100) * (0.71 + rng(0, 8, 2) / 100) * (0.88 + rng(0, 8, 3) / 100)),
    Math.round(base * 0.055 + rng(0, 800, 4)),
  ];
  const times = [0, 2.1 + rng(0, 20, 5) / 10, 18 + rng(0, 60, 6) / 10, 0.8 + rng(0, 10, 7) / 10, 48 + rng(0, 30, 8)];
  return { counts, times };
}

function renderFunnel() {
  const days = Number(document.getElementById("funnelWindowSelect").value);
  const surface = document.getElementById("funnelSurfaceSelect").value;
  const { counts, times } = funnelMockData(days, surface);
  const total = counts[0];

  document.getElementById("funnelTotalBadge").textContent = compact(total) + " 举报";
  document.getElementById("funnelMeta").textContent =
    `近 ${days} 天 · ${surface === "all" ? "全部业务域" : surface}`;

  // 漏斗图
  const maxCount = counts[0];
  const minPct = 40; // 最窄也保留 40% 宽度
  const wrap = document.getElementById("funnelChart");
  wrap.innerHTML = FUNNEL_STAGES.map((stage, i) => {
    const count = counts[i];
    const widthPct = minPct + ((count / maxCount) * (100 - minPct));
    const convRate = i === 0 ? null : ((count / counts[i - 1]) * 100).toFixed(1);
    const rateClass = convRate === null ? "" : convRate >= 85 ? "good" : convRate >= 65 ? "warn" : "bad";

    const connector = i === 0 ? "" : `
      <div class="funnel-connector">
        <div class="funnel-connector-line"></div>
        <span class="funnel-rate-badge ${rateClass}">
          <span class="rate-val">${convRate}%</span>
          转化 · 损失 ${compact(counts[i-1] - count)}
        </span>
      </div>`;

    return `
      ${connector}
      <div class="funnel-stage">
        <div class="funnel-side-label">${stage.label}</div>
        <div class="funnel-bar-wrap">
          <div class="funnel-bar" style="width:${widthPct.toFixed(1)}%;background:${stage.color}">
            <div class="funnel-bar-label">
              <span class="funnel-bar-count">${compact(count)}</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join("");

  // 耗时
  const timeMax = Math.max(...times.filter(Boolean));
  document.getElementById("funnelTimeList").innerHTML = FUNNEL_STAGES
    .filter((_, i) => i > 0)
    .map((stage, i) => {
      const t = times[i + 1];
      const w = Math.max(8, Math.round((t / timeMax) * 100));
      return `<div class="rank-row">
        <span>${stage.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${stage.color}"></div></div>
        <strong>${t.toFixed(1)}h</strong>
      </div>`;
    }).join("");

  // 处置类型
  document.getElementById("funnelActionList").innerHTML = ACTION_TYPES.map((a, i) => {
    const colors = ["#0d9488","#3b82f6","#dc2626","#d97706","#9ca3af"];
    return `<div class="rank-row">
      <span>${a.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${a.pct}%;background:${colors[i]}"></div></div>
      <strong>${a.pct}%</strong>
    </div>`;
  }).join("");
}

document.getElementById("funnelWindowSelect").addEventListener("change", renderFunnel);
document.getElementById("funnelSurfaceSelect").addEventListener("change", renderFunnel);
renderFunnel();

/* ══════════════════════════════════════
   行为路径
══════════════════════════════════════ */
const TL_EVENT_TEMPLATES = [
  { type: "system",    title: "账号注册",          desc: "新账号通过手机号注册，来源：{source}",              tags: ["系统事件"] },
  { type: "report",    title: "收到用户举报",        desc: "内容被 {n} 名用户举报，类型：{policy}",            tags: ["举报"] },
  { type: "system",    title: "机器审核触发",        desc: "AI 模型置信度 {score}%，命中策略：{policy}",       tags: ["自动审核"] },
  { type: "violation", title: "确认违规",           desc: "审核员判定违规，适用政策：{policy}",                tags: ["违规", "人工审核"] },
  { type: "action",    title: "执行处置",           desc: "{action}，预计影响时长：{duration}",               tags: ["处置"] },
  { type: "report",    title: "再次收到举报",        desc: "新增 {n} 条举报，风险分上升 {delta}",              tags: ["举报", "风险上升"] },
  { type: "appeal",    title: "用户发起申诉",        desc: "申诉理由：内容符合社区准则，复核优先级：{priority}", tags: ["申诉"] },
  { type: "system",    title: "申诉驳回",           desc: "复核结论：原处置决定维持，政策依据：{policy}",       tags: ["申诉", "系统事件"] },
  { type: "violation", title: "二次违规记录",        desc: "触发累计违规阈值，自动升级账号风险等级",            tags: ["违规", "风险上升"] },
  { type: "action",    title: "账号永久封禁",        desc: "累计违规次数超限，账号已永久停用",                  tags: ["处置", "高风险"] },
];

const POLICIES = ["仇恨言论","成人内容","骚扰","虚假信息","垃圾内容","暴力内容"];
const ACTIONS  = ["内容下架并警告","限制发布功能 7 天","账号暂停 30 天"];
const SOURCES  = ["手机号","第三方登录","邮箱"];

function fillTemplate(tpl, rng) {
  return tpl
    .replace("{source}",   SOURCES[rng(0, 3)])
    .replace("{n}",        String(rng(3, 40)))
    .replace("{policy}",   POLICIES[rng(0, 6)])
    .replace("{score}",    String(rng(72, 98)))
    .replace("{action}",   ACTIONS[rng(0, 3)])
    .replace("{duration}", rng(3, 31) + " 天")
    .replace("{delta}",    String(rng(5, 20)))
    .replace("{priority}", ["P0","P1","P2"][rng(0, 3)]);
}

function buildTimeline(accountId) {
  let seed = accountId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = (min, max) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return min + (seed % (max - min)); };

  const now = new Date("2026-05-31T18:00:00");
  const nEvents = rng(5, 11);
  const selectedIndices = [];
  while (selectedIndices.length < nEvents) {
    const idx = rng(0, TL_EVENT_TEMPLATES.length);
    if (!selectedIndices.includes(idx)) selectedIndices.push(idx);
  }
  selectedIndices.sort((a, b) => a - b);

  let t = new Date(now.getTime() - rng(60, 180) * 24 * 3600000);
  return selectedIndices.map(idx => {
    const tpl = TL_EVENT_TEMPLATES[idx];
    t = new Date(t.getTime() + rng(1, 72) * 3600000);
    return {
      type:  tpl.type,
      title: tpl.title,
      desc:  fillTemplate(tpl.desc, rng),
      tags:  tpl.tags,
      time:  new Date(t),
    };
  });
}

function buildProfile(account) {
  return [
    { label: "User ID",    value: account.account_id },
    { label: "风险等级",   value: account.risk_level },
    { label: "风险分",     value: account.risk_score.toFixed(1) },
    { label: "账号状态",   value: account.status },
    { label: "业务域",     value: account.surface },
    { label: "地区",       value: account.region },
    { label: "举报次数",   value: account.report_count },
    { label: "违规次数",   value: account.violation_count },
    { label: "所属簇",     value: account.cluster },
    { label: "最近活跃",   value: account.last_seen.slice(0, 10) },
  ];
}

let cachedAccounts = [];

function populateTimelineSelect(accounts) {
  cachedAccounts = accounts;
  const sel = document.getElementById("timelineAccountSelect");
  sel.innerHTML = '<option value="">选择账号…</option>' +
    accounts.map(a =>
      `<option value="${escapeHtml(a.account_id)}">${escapeHtml(a.account_id)} · 风险分 ${a.risk_score.toFixed(0)}</option>`
    ).join("");
}

function renderTimeline(accountId) {
  const account = cachedAccounts.find(a => a.account_id === accountId);
  if (!account) return;

  // 画像
  const profile = buildProfile(account);
  document.getElementById("timelineProfile").innerHTML = profile.map(row =>
    `<div class="profile-stat">
       <span>${escapeHtml(row.label)}</span>
       <strong>${escapeHtml(String(row.value))}</strong>
     </div>`
  ).join("");

  // 时间线
  const events = buildTimeline(accountId);
  document.getElementById("timelineEventMeta").textContent =
    `${events.length} 个事件 · ${events[0].time.toLocaleDateString("zh-CN")} — ${events.at(-1).time.toLocaleDateString("zh-CN")}`;

  document.getElementById("timelineEvents").innerHTML = events.map(ev => {
    const timeStr = ev.time.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) +
      " " + ev.time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const tagsHtml = ev.tags.map(t => `<span class="tl-tag ${ev.type}">${escapeHtml(t)}</span>`).join("");
    return `
      <div class="tl-event">
        <div class="tl-time">${timeStr}</div>
        <div class="tl-dot"><div class="tl-dot-inner ${ev.type}"></div></div>
        <div class="tl-body">
          <div class="tl-title">${escapeHtml(ev.title)}</div>
          <div class="tl-desc">${escapeHtml(ev.desc)}</div>
          <div class="tl-tags">${tagsHtml}</div>
        </div>
      </div>`;
  }).join("");
}

document.getElementById("timelineAccountSelect").addEventListener("change", e => {
  if (e.target.value) renderTimeline(e.target.value);
});

document.getElementById("timelineRefreshBtn").addEventListener("click", () => {
  const sel = document.getElementById("timelineAccountSelect");
  if (sel.value) renderTimeline(sel.value);
});

/* ══════════════════════════════════════
   实时查询
══════════════════════════════════════ */
const RT_EVENT_NAMES = [
  "video_upload","live_start","comment_post","report_submit",
  "violation_detected","action_taken","appeal_filed","login",
  "follow_user","content_share","dm_send","search_query"
];

const RT_EVENT_DETAILS = {
  video_upload:       "时长 {s}s · 标签：{tag}",
  live_start:         "直播间 {room} · 预计观众 {n}",
  comment_post:       "内容被 {n} 人点赞",
  report_submit:      "举报类型：{policy} · 优先级 {pri}",
  violation_detected: "命中策略：{policy} · AI 置信度 {score}%",
  action_taken:       "动作：{action} · 执行人：{who}",
  appeal_filed:       "申诉编号 #{id} · 状态：待复核",
  login:              "设备：{device} · IP：{ip}",
  follow_user:        "关注了 {n} 个账号",
  content_share:      "分享至 {platform}",
  dm_send:            "私信 {n} 名用户",
  search_query:       '搜索词："…"',
};

const RT_TAGS = { video_upload:"system", live_start:"system", comment_post:"system",
  report_submit:"report", violation_detected:"violation", action_taken:"action",
  appeal_filed:"appeal", login:"system", follow_user:"system",
  content_share:"system", dm_send:"system", search_query:"system" };

function fillRtDetail(name, rng) {
  const tpl = RT_EVENT_DETAILS[name] || "";
  return tpl
    .replace("{s}",       String(rng(15, 180)))
    .replace("{tag}",     POLICIES[rng(0,6)])
    .replace("{room}",    "#" + rng(10000, 99999))
    .replace("{n}",       String(rng(1, 200)))
    .replace("{policy}",  POLICIES[rng(0,6)])
    .replace("{pri}",     ["P0","P1","P2"][rng(0,3)])
    .replace("{score}",   String(rng(70,99)))
    .replace("{action}",  ACTIONS[rng(0,3)])
    .replace("{who}",     "审核员_" + rng(100,999))
    .replace("{id}",      String(rng(100000,999999)))
    .replace("{device}",  ["iOS","Android","Web"][rng(0,3)])
    .replace("{ip}",      `${rng(1,255)}.${rng(0,255)}.x.x`)
    .replace("{platform}",["微博","微信","Twitter"][rng(0,3)]);
}

function buildRealtimeData(userId) {
  const account = cachedAccounts.find(a => a.account_id === userId);
  let seed = userId.split("").reduce((a, c) => a + c.charCodeAt(0), 42);
  const rng = (min, max) => { seed = (seed * 6364136223846793005n ? seed : (seed * 1103515245 + 12345)) & 0x7fffffff; return min + (seed % (max - min)); };

  const risk_score   = account ? account.risk_score   : 40 + rng(0, 55);
  const risk_level   = account ? account.risk_level   : (risk_score > 75 ? "Critical" : risk_score > 55 ? "High" : "Medium");
  const region       = account ? account.region       : ["US","BR","ID","VN","TH"][rng(0,5)];
  const surface      = account ? account.surface      : ["Video","Live","Account"][rng(0,3)];
  const report_count = account ? account.report_count : rng(0, 30);
  const violation_count = account ? account.violation_count : rng(0, report_count + 1);

  const now = new Date("2026-05-31T18:30:00");
  const nEvents = 12;
  const events = Array.from({ length: nEvents }, (_, i) => {
    const name = RT_EVENT_NAMES[rng(0, RT_EVENT_NAMES.length)];
    const minutesAgo = rng(0, 72 * 60);
    const t = new Date(now.getTime() - minutesAgo * 60000);
    return { name, detail: fillRtDetail(name, rng), time: t, type: RT_TAGS[name] };
  }).sort((a, b) => b.time - a.time);

  return { userId, risk_score, risk_level, region, surface, report_count, violation_count, events };
}

function renderRealtimeResult(data) {
  const avatarColors = { Critical:"#dc2626", High:"#d97706", Medium:"#2563eb", Low:"#16a34a" };
  const avatarColor = avatarColors[data.risk_level] || "#6b7280";
  const initial = data.userId.slice(0, 2).toUpperCase();

  const riskBadgeClass = { Critical:"critical", High:"high", Medium:"medium" }[data.risk_level] || "";

  document.getElementById("realtimeResult").innerHTML = `
    <div class="rt-profile-grid">
      <!-- 左：用户画像卡 -->
      <div class="rt-card">
        <div class="rt-user-hero">
          <div class="rt-avatar" style="background:${avatarColor}">${escapeHtml(initial)}</div>
          <div>
            <div class="rt-user-name">${escapeHtml(data.userId)}</div>
            <div class="rt-user-sub">${escapeHtml(data.region)} · ${escapeHtml(data.surface)}</div>
          </div>
          <span class="risk-score ${riskBadgeClass}" style="margin-left:auto">${data.risk_score.toFixed(0)}</span>
        </div>
        <div class="rt-stats-grid">
          <div class="rt-stat">
            <span>举报次数</span>
            <strong>${data.report_count}</strong>
          </div>
          <div class="rt-stat">
            <span>违规次数</span>
            <strong style="color:${data.violation_count > 0 ? 'var(--red)' : 'inherit'}">${data.violation_count}</strong>
          </div>
          <div class="rt-stat">
            <span>风险等级</span>
            <strong style="color:${avatarColor}">${escapeHtml(data.risk_level)}</strong>
          </div>
        </div>
        <div class="rt-card-body" style="padding-top:12px">
          <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin-bottom:10px">查询时间</div>
          <div style="font-size:13px;color:var(--ink)">2026-05-31 18:30:00</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">数据延迟 &lt; 5s · 验证环境</div>
        </div>
      </div>

      <!-- 右：最近事件 -->
      <div class="rt-card">
        <div class="rt-card-header">
          <h3>最近 72 小时事件</h3>
          <span class="badge">${data.events.length} 条</span>
        </div>
        <div class="rt-events-list">
          ${data.events.map(ev => {
            const timeStr = ev.time.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"}) +
              " " + ev.time.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});
            return `<div class="rt-event-row">
              <div class="rt-event-time">${timeStr}</div>
              <div>
                <div class="rt-event-name">${escapeHtml(ev.name)}</div>
                <div class="rt-event-detail">${escapeHtml(ev.detail)}</div>
              </div>
              <span class="tl-tag ${ev.type}" style="justify-self:end;align-self:start">${escapeHtml(ev.type)}</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>`;
}

function doRealtimeQuery() {
  const uid = document.getElementById("realtimeInput").value.trim();
  if (!uid) { showToast("请输入 User ID"); return; }
  const data = buildRealtimeData(uid);
  renderRealtimeResult(data);
  showToast(`已拉取 ${uid} 的实时画像`);
}

document.getElementById("realtimeQueryBtn").addEventListener("click", doRealtimeQuery);
document.getElementById("realtimeInput").addEventListener("keydown", e => {
  if (e.key === "Enter") doRealtimeQuery();
});
document.getElementById("realtimeDemoBtn").addEventListener("click", () => {
  const demoIds = cachedAccounts.length ? cachedAccounts.slice(0,3).map(a=>a.account_id) : ["user_li