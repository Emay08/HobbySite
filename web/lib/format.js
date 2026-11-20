const tixFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tixFmt3 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const TZ = process.env.DISPLAY_TIMEZONE || 'America/Vancouver';
const intFmt = new Intl.NumberFormat('en-US');

function tix(n) {
  if (n === null || n === undefined) return '—';
  // cheap cards differ in the third decimal (0.002 vs 0.020 tix)
  const f = n !== 0 && Math.abs(n) < 0.1 ? tixFmt3 : tixFmt;
  return `${f.format(n)} tix`;
}

function int(n) {
  return intFmt.format(n || 0);
}

function date(d) {
  if (!d) return '—';
  // Plain YYYY-MM-DD strings are calendar dates, not instants: don't shift them by timezone
  const dateOnly = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return new Date(d).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: dateOnly ? 'UTC' : TZ,
  });
}

function dateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-CA', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ,
  });
}

function ago(d) {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Builds an SVG polyline path for a value-history sparkline. */
function sparkline(points, width = 600, height = 120, pad = 6, key = 'totalValue') {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p[key]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = (width - pad * 2) / (points.length - 1);
  const coords = vals.map((v, i) => [pad + i * step, height - pad - ((v - min) / span) * (height - pad * 2)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${height - pad} L${pad},${height - pad} Z`;
  return { line, area, min, max, width, height, first: points[0], last: points[points.length - 1] };
}

/** Signed percentage with arrow class, e.g. { text: '+12%', cls: 'up' }. */
function pct(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return { text: '—', cls: 'muted' };
  const s = `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) < 10 && digits === 0 ? 1 : digits)}%`;
  return { text: s, cls: n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'muted' };
}

/** Link to a card's page. */
function cardUrl(name) {
  return `/mtgo/card/${encodeURIComponent(name || '')}`;
}

module.exports = { tix, int, date, dateTime, ago, sparkline, pct, cardUrl };
