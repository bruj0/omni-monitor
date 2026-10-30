/**
 * Chart rendering with chart.js.
 *
 * The panel embeds chart.js from the packaged bundle; see media/dashboard.js.
 * These helpers build the config objects. Colours come from the VS Code theme
 * variables so the charts follow the user's theme, which is what GCMP does.
 */

/** Read a CSS custom property, falling back when the theme omits it. */
function themeColor(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

export function chartPalette() {
  return {
    blue: themeColor("--vscode-charts-blue", "#4e8cff"),
    green: themeColor("--vscode-charts-green", "#4cc38a"),
    yellow: themeColor("--vscode-charts-yellow", "#d7ba7d"),
    orange: themeColor("--vscode-charts-orange", "#e88b3f"),
    purple: themeColor("--vscode-charts-purple", "#a17ee0"),
    foreground: themeColor("--vscode-foreground", "#ccc"),
    border: themeColor("--vscode-panel-border", "#3c3c3c"),
  };
}

const SERIES_COLORS = ["blue", "green", "yellow", "orange", "purple"];

/** Deterministic color per label, so a provider keeps its color across renders. */
export function colorForLabel(label, palette) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return palette[SERIES_COLORS[hash % SERIES_COLORS.length]];
}

/**
 * Line chart of requests and tokens per bucket.
 *
 * A point is `{ label, requests?, totalTokens }`. `requests` is optional
 * because a per-provider daily series only carries tokens: the server exposes
 * per-provider request counts by date on a different endpoint, and plotting a
 * guess would be worse than plotting one series. When `requests` is absent the
 * chart drops that dataset, moves tokens onto the left axis and hides the right
 * axis, rather than leaving an empty scale behind.
 */
export function trendChartConfig(points, palette) {
  const rows = Array.isArray(points) ? points : [];
  const hasRequests = rows.length > 0 && rows.every((row) => typeof row.requests === "number");

  const datasets = [];
  if (hasRequests) {
    datasets.push({
      label: "Requests",
      data: rows.map((row) => row.requests),
      borderColor: palette.blue,
      backgroundColor: palette.blue,
      tension: 0.25,
      pointRadius: 2,
      yAxisID: "y",
    });
  }
  datasets.push({
    label: "Tokens",
    data: rows.map((row) => row.totalTokens),
    borderColor: palette.green,
    backgroundColor: palette.green,
    tension: 0.25,
    pointRadius: 2,
    yAxisID: hasRequests ? "y1" : "y",
  });

  const y1 = hasRequests
    ? {
        position: "right",
        ticks: { color: palette.foreground, font: { size: 10 }, callback: (v) => compact(v) },
        grid: { drawOnChartArea: false },
      }
    : { display: false };

  return {
    type: "line",
    data: {
      labels: rows.map((row) => row.label),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: palette.foreground, boxWidth: 10, font: { size: 10 } } },
        tooltip: { enabled: true },
      },
      scales: {
        y: {
          position: "left",
          ticks: {
            color: palette.foreground,
            font: { size: 10 },
            callback: hasRequests ? undefined : (v) => compact(v),
          },
          grid: { color: palette.border },
        },
        y1,
        x: { ticks: { color: palette.foreground, font: { size: 10 } }, grid: { color: palette.border } },
      },
    },
  };
}

/** Doughnut of share by a labelled numeric field, mirroring GCMP's donut. */
export function donutConfig(rows, labelKey, valueKey, palette, title) {
  const entries = rows.filter((row) => (row[valueKey] ?? 0) > 0);
  return {
    type: "doughnut",
    data: {
      labels: entries.map((row) => row[labelKey]),
      datasets: [
        {
          data: entries.map((row) => row[valueKey]),
          backgroundColor: entries.map((row) => colorForLabel(String(row[labelKey]), palette)),
          borderColor: palette.border,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: title, color: palette.foreground, font: { size: 11 } },
        legend: { display: false },
        tooltip: { enabled: true },
      },
    },
  };
}

function compact(value) {
  const abs = Math.abs(value);
  if (abs >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
  if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}