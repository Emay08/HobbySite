/** Small timezone helpers (no dependencies). Default zone: Pacific, as used by MTGO. */
const PT = 'America/Los_Angeles';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Minutes east of UTC for `tz` at instant `date` (e.g. -480 for PST). */
function offsetMinutes(date, tz = PT) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // "GMT-08:00" or "GMT"
  const m = part.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Converts a wall-clock time in `tz` to a Date. */
function zonedToUtc(year, month, day, hour = 0, minute = 0, tz = PT) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** Wall-clock parts of `date` in `tz`. */
function zonedParts(date, tz = PT) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute };
}

function parseClock(text) {
  if (/\bnoon\b/i.test(text)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/i.test(text)) return { hour: 0, minute: 0 };
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === 'p') hour += 12;
  return { hour, minute: m[2] ? parseInt(m[2], 10) : 0 };
}

/** "11/9/2026 1 p.m. PT" → Date (Pacific). */
function parseNumericDate(text, tz = PT) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const clock = parseClock(text) || { hour: 0, minute: 0 };
  return zonedToUtc(+m[3], +m[1], +m[2], clock.hour, clock.minute, tz);
}

/**
 * "December 9, 10 a.m." → Date (Pacific). The page usually omits the year, so the
 * first matching date on or after `reference` (minus a day of slack) is used.
 */
function parseNextUpdate(text, reference = new Date(), tz = PT) {
  const s = String(text || '');
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  let month, day, year;
  if (m) {
    month = MONTHS.findIndex((n) => n.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    day = parseInt(m[2], 10);
    year = m[3] ? parseInt(m[3], 10) : null;
  } else {
    const n = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (!n) return null;
    month = +n[1];
    day = +n[2];
    year = n[3] ? +n[3] : null;
  }
  const clock = parseClock(s) || { hour: 0, minute: 0 };
  if (year) return zonedToUtc(year, month, day, clock.hour, clock.minute, tz);
  const refYear = zonedParts(reference, tz).year;
  for (const y of [refYear, refYear + 1]) {
    const d = zonedToUtc(y, month, day, clock.hour, clock.minute, tz);
    if (d.getTime() >= reference.getTime() - 86400000) return d;
  }
  return null;
}

module.exports = { PT, offsetMinutes, zonedToUtc, zonedParts, parseNextUpdate, parseNumericDate, parseClock };
