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
  const response = await fetch(path, {
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
      return `
        <article class="metric-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${displayCardValue(card)}</strong>
          <small class="${directionClass}">${sign}${number(card.delta, 1)}% vs baseline</small>
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
