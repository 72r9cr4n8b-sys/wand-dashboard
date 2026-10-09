/*
 * Vermittler für das Wand-Dashboard (Cloudflare Worker).
 *
 * Geheimnisse liegen NUR bei Cloudflare (wrangler secret put …), nie im Code:
 *   ICAL_URL    – private iCal-Adresse des Google-Kalenders
 *   ACCESS_KEY  – Zugangsschlüssel, der auf dem Tablet eingetragen wird
 *
 * GET /calendar?days=7  (Header: Authorization: Bearer <ACCESS_KEY>)
 * → nur Titel und Zeiten der Termine im Zeitraum, keine Beschreibungen,
 *   Orte oder Teilnehmer. Nur lesen, nie schreiben.
 */

const ALLOWED_ORIGIN = 'https://72r9cr4n8b-sys.github.io';
const TZ = 'Europe/Berlin';
const CACHE_MS = 10 * 60 * 1000;
const DAY = 86400000;

let memo = null; // { at, days, dayKey, body } – Zwischenspeicher je Instanz

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (status, data) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reply(405, { error: 'method' });

    const url = new URL(request.url);
    if (url.pathname !== '/calendar') return reply(404, { error: 'not found' });

    if (!env.ACCESS_KEY || !env.ICAL_URL) return reply(500, { error: 'not configured' });
    const auth = request.headers.get('Authorization') || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!given || !(await sameSecret(given, env.ACCESS_KEY))) return reply(401, { error: 'unauthorized' });

    const days = Math.min(14, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    const todayW = startOfDayW(utcToWall(Date.now(), TZ));
    const dayKey = fmtDate(todayW);
    if (memo && memo.days === days && memo.dayKey === dayKey && Date.now() - memo.at < CACHE_MS) {
      return reply(200, memo.body);
    }

    let ics;
    try {
      const r = await fetch(env.ICAL_URL, { headers: { 'User-Agent': 'wand-dashboard' } });
      if (!r.ok) throw new Error('status ' + r.status);
      ics = await r.text();
    } catch (e) {
      return reply(502, { error: 'calendar unreachable' });
    }

    const events = expand(parseIcs(ics), todayW, todayW + days * DAY);
    const body = { updated: new Date().toISOString(), from: dayKey, days, events };
    memo = { at: Date.now(), days, dayKey, body };
    return reply(200, body);
  },
};

/* ---------- Schlüsselvergleich in konstanter Zeit ---------- */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/* ---------- Zeit: "Wanduhr-Zeit" W = Date.UTC(lokale Komponenten) in Berlin ---------- */
const dtfCache = {};
function utcToWall(ms, tz) {
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
function zonedToUtc(w, tz) {
  let utc = w - (utcToWall(w, tz) - w);
  utc = w - (utcToWall(utc, tz) - utc);
  return utc;
}
function startOfDayW(w) { return Math.floor(w / DAY) * DAY; }
function fmtDate(w) { return new Date(w).toISOString().slice(0, 10); }
function fmtTime(w) { return new Date(w).toISOString().slice(11, 16); }

/* ---------- iCal einlesen ---------- */
function unescapeText(s) {
  return s.replace(/\\([nN]|\\|;|,)/g, (_, c) => (c === 'n' || c === 'N') ? ' ' : c);
}
function parseLine(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(';');
  const params = {};
  for (let k = 1; k < parts.length; k++) {
    const eq = parts[k].indexOf('=');
    if (eq > 0) params[parts[k].slice(0, eq).toUpperCase()] = parts[k].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}
// Liefert { w, allDay } in Berliner Wanduhr-Zeit
function parseDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const w = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[4] || params.VALUE === 'DATE') return { w, allDay: true };
  if (m[7]) return { w: utcToWall(w, TZ), allDay: false };
  const tz = params.TZID;
  if (tz && tz !== TZ) {
    try { return { w: utcToWall(zonedToUtc(w, tz), TZ), allDay: false }; } catch (e) { /* unbekannte Zone: wie Berlin */ }
  }
  return { w, allDay: false };
}
function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
  if (!m) return 0;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
  return m[1] === '-' ? -ms : ms;
}
function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null, depth = 0;
  for (const raw of lines) {
    if (!raw) continue;
    if (raw === 'BEGIN:VEVENT') { ev = { exdates: new Set() }; depth = 0; continue; }
    if (!ev) continue;
    if (raw === 'END:VEVENT') { if (ev.start && ev.status !== 'CANCELLED') out.push(ev); ev = null; continue; }
    if (raw.startsWith('BEGIN:')) { depth++; continue; } // z. B. VALARM überspringen
    if (raw.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const p = parseLine(raw);
    switch (p.name) {
      case 'UID': ev.uid = p.value; break;
      case 'SUMMARY': ev.title = unescapeText(p.value).trim(); break;
      case 'STATUS': ev.status = p.value.toUpperCase(); break;
      case 'DTSTART': { const d = parseDate(p.value, p.params); if (d) { ev.start = d.w; ev.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(p.value, p.params); if (d) ev.end = d.w; break; }
      case 'DURATION': ev.duration = parseDuration(p.value); break;
      case 'RRULE': ev.rrule = p.value; break;
      case 'EXDATE':
        for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) ev.exdates.add(d.w); }
        break;
      case 'RECURRENCE-ID': { const d = parseDate(p.value, p.params); if (d) ev.recurrenceId = d.w; break; }
    }
  }
  for (const e of out) {
    if (e.end == null) e.end = e.duration != null ? e.start + e.duration : e.start + (e.allDay ? DAY : 0);
    e.len = Math.max(0, e.end - e.start);
  }
  return out;
}

/* ---------- Wiederholungen auflösen ---------- */
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRule(s) {
  const r = {};
  for (const part of s.split(';')) { const [k, v] = part.split('='); if (k && v) r[k.toUpperCase()] = v; }
  return {
    freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null,
    until: r.UNTIL ? (parseDate(r.UNTIL, {}) || {}).w : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
  };
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
function nthWeekday(y, m, wd, n) {
  const dim = daysInMonth(y, m);
  if (n > 0) { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7; return d <= dim ? d : null; }
  const last = new Date(Date.UTC(y, m, dim)).getUTCDay(); const d = dim - ((last - wd + 7) % 7) + (n + 1) * 7; return d >= 1 ? d : null;
}
function daysOfMonth(y, m, rule, startDay) {
  let ds = [];
  if (rule.bymonthday) {
    const dim = daysInMonth(y, m);
    ds = rule.bymonthday.map(d => d < 0 ? dim + d + 1 : d).filter(d => d >= 1 && d <= dim);
  } else if (rule.byday) {
    for (const b of rule.byday) {
      if (b.n) { const d = nthWeekday(y, m, b.wd, b.n); if (d) ds.push(d); }
      else for (let d = 1; d <= daysInMonth(y, m); d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === b.wd) ds.push(d);
    }
  } else if (startDay <= daysInMonth(y, m)) ds = [startDay];
  return [...new Set(ds)].sort((a, b) => a - b);
}
// Startzeiten aller Vorkommen, die den Zeitraum [from, to) berühren
function occurrences(e, from, to) {
  if (!e.rrule) return [e.start];
  const rule = parseRule(e.rrule);
  const s = new Date(e.start);
  const tod = e.start - startOfDayW(e.start);
  const res = [];
  let n = 0, period = 0, guard = 0;

  // Ohne COUNT darf direkt in die Nähe des Zeitraums gesprungen werden
  const periodLen = { DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 28 * DAY, YEARLY: 365 * DAY }[rule.freq];
  if (!periodLen) return [e.start];
  if (rule.count == null && from - e.len > e.start) {
    period = Math.max(0, Math.floor((from - e.len - e.start) / (periodLen * rule.interval)) - 2);
  }

  const weekStart = startOfDayW(e.start) - ((s.getUTCDay() + 6) % 7) * DAY; // Montag der ersten Woche
  while (guard++ < 5000) {
    const k = period * rule.interval;
    let cands = [];
    if (rule.freq === 'DAILY') cands = [e.start + k * DAY];
    else if (rule.freq === 'WEEKLY') {
      const ws = weekStart + k * 7 * DAY;
      const wds = rule.byday ? rule.byday.map(b => b.wd) : [s.getUTCDay()];
      cands = wds.map(wd => ws + ((wd + 6) % 7) * DAY + tod).sort((a, b) => a - b);
    } else if (rule.freq === 'MONTHLY') {
      const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + k) / 12), m = (s.getUTCMonth() + k) % 12;
      cands = daysOfMonth(y, m, rule, s.getUTCDate()).map(d => Date.UTC(y, m, d) + tod);
    } else { // YEARLY
      const y = s.getUTCFullYear() + k;
      const months = rule.bymonth ? rule.bymonth.map(x => x - 1) : [s.getUTCMonth()];
      for (const m of months) cands.push(...daysOfMonth(y, m, (rule.byday || rule.bymonthday) ? rule : { }, s.getUTCDate()).map(d => Date.UTC(y, m, d) + tod));
      cands.sort((a, b) => a - b);
    }
    let done = false;
    for (const c of cands) {
      if (c < e.start) continue;
      if (rule.until != null && c > rule.until + (e.allDay ? DAY - 1 : 0)) { done = true; break; }
      if (rule.count != null && ++n > rule.count) { done = true; break; }
      if (c >= to) { done = true; break; }
      if (c + Math.max(e.len, 1) > from) res.push(c);
    }
    if (done) break;
    period++;
  }
  return res;
}
function expand(events, from, to) {
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId != null) overrides.set(e.uid + '|' + e.recurrenceId, true);

  const out = [];
  for (const e of events) {
    const starts = e.recurrenceId != null ? [e.start] : occurrences(e, from, to);
    for (const st of starts) {
      if (e.recurrenceId == null && e.rrule && (e.exdates.has(st) || overrides.has(e.uid + '|' + st))) continue;
      const en = st + e.len;
      if (st >= to || (en <= from && !(e.len === 0 && st >= from))) continue;
      out.push({
        title: e.title || '(ohne Titel)',
        allDay: !!e.allDay,
        start: fmtDate(st),
        end: fmtDate(e.allDay ? en - DAY : en),
        startTime: e.allDay ? null : fmtTime(st),
        endTime: e.allDay ? null : fmtTime(en),
      });
    }
  }
  out.sort((a, b) => (a.start + (a.allDay ? '0' : '1') + (a.startTime || '')).localeCompare(b.start + (b.allDay ? '0' : '1') + (b.startTime || '')));
  return out;
}
