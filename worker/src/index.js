/*
 * Vermittler für das Wand-Dashboard (Cloudflare Worker).
 *
 * Geheimnisse liegen NUR bei Cloudflare (wrangler secret put …), nie im Code:
 *   ICAL_URL    – private iCal-Adresse des Google-Kalenders
 *   ACCESS_KEY  – Zugangsschlüssel, der auf dem Tablet eingetragen wird
 *   AHA_ADRESSE – Adresse für die Müllabfuhr, z. B. "Musterweg 5" oder "Musterweg 5a, Ahlten"
 *   GOVEE_KEY   – API-Schlüssel aus der Govee-Home-App
 *
 * Alle Abfragen brauchen den Header  Authorization: Bearer <ACCESS_KEY>
 * GET /calendar?days=7 → nur Titel und Zeiten der Termine im Zeitraum, keine
 *   Beschreibungen, Orte oder Teilnehmer. Nur lesen, nie schreiben.
 * GET /trash → nächste Abholtermine je Tonne (aha Region Hannover, Gemeinde Lehrte).
 * GET /climate → Temperatur und Luftfeuchte des Govee-Thermometers.
 * GET /list/einkauf → Einkaufsliste aus dem gemeinsamen Speicher (KV "DATA")
 * POST /list/einkauf  {op:"add",text} | {op:"toggle",id} | {op:"remove",id} | {op:"clearDone"}
 */

const ALLOWED_ORIGIN = 'https://72r9cr4n8b-sys.github.io';
const TZ = 'Europe/Berlin';
const CACHE_MS = 10 * 60 * 1000;
const AHA_URL = 'https://www.aha-region.de/abholtermine/abfuhrkalender';
const AHA_GEMEINDE = 'Lehrte';
const TRASH_CACHE_MS = 6 * 60 * 60 * 1000;
const GOVEE_API = 'https://openapi.api.govee.com/router/api/v1';
const CLIMATE_CACHE_MS = 2 * 60 * 1000;
const LISTS = ['einkauf'];
const MAX_ITEMS = 150, MAX_TEXT = 80, MAX_RECENT = 30;
const DAY = 86400000;

let memo = null;      // { at, days, dayKey, body } – Zwischenspeicher je Instanz
let trashMemo = null; // { at, addr, dayKey, body }
let climateMemo = null; // { at, body }
let goveeDevice = null; // { sku, device } – Gerät merken, spart eine Abfrage

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Cache-Control, Pragma', // Safari schickt bei cache: 'no-store' die letzten beiden mit
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (status, data) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const listName = (/^\/list\/([a-z]+)$/.exec(url.pathname) || [])[1];
    if (listName && !LISTS.includes(listName)) return reply(404, { error: 'not found' });
    if (!listName && !['/calendar', '/trash', '/climate'].includes(url.pathname)) return reply(404, { error: 'not found' });
    if (request.method !== 'GET' && !(listName && request.method === 'POST')) return reply(405, { error: 'method' });

    if (!env.ACCESS_KEY) return reply(500, { error: 'not configured' });
    const auth = request.headers.get('Authorization') || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!given || !(await sameSecret(given, env.ACCESS_KEY))) return reply(401, { error: 'unauthorized' });

    if (listName) return list(request, env, reply, listName);
    if (url.pathname === '/trash') return trash(env, reply);
    if (url.pathname === '/climate') return climate(env, reply);
    if (!env.ICAL_URL) return reply(500, { error: 'not configured' });

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

/* ---------- Müllabfuhr (aha) ---------- */
async function trash(env, reply) {
  if (!env.AHA_ADRESSE) return reply(500, { error: 'not configured' });
  const dayKey = fmtDate(utcToWall(Date.now(), TZ));
  if (trashMemo && trashMemo.addr === env.AHA_ADRESSE && trashMemo.dayKey === dayKey && Date.now() - trashMemo.at < TRASH_CACHE_MS) return reply(200, trashMemo.body);

  const addr = parseAddress(env.AHA_ADRESSE);
  if (!addr) return reply(422, { error: 'address' });
  let html;
  try {
    const list = await ahaPost({ gemeinde: AHA_GEMEINDE, aktuelle_gemeinde: AHA_GEMEINDE, von: addr.letter });
    const opts = [...list.matchAll(/<option value='(\d+@[^']*)'/g)].map(m => m[1]);
    const hits = opts.filter(o => norm(o.split('@')[1].split(' / ')[0]) === norm(addr.street));
    const pick = hits.length > 1 && addr.ortsteil ? hits.filter(o => norm(o.split('@')[2] || '') === norm(addr.ortsteil)) : hits;
    if (pick.length === 0) return reply(422, { error: hits.length ? 'ortsteil' : 'street' });
    if (pick.length > 1) return reply(422, { error: 'ambiguous', ortsteile: pick.map(o => o.split('@')[2] || '') });
    html = await ahaPost({ gemeinde: AHA_GEMEINDE, aktuelle_gemeinde: AHA_GEMEINDE, von: addr.letter, strasse: pick[0], hausnr: addr.nr, hausnraddon: addr.addon, anzeigen: 'Suchen' });
  } catch (e) {
    return reply(502, { error: 'aha unreachable' });
  }
  const bins = parseTrash(html);
  if (!bins.length) return reply(422, { error: 'housenumber' });
  const body = { updated: new Date().toISOString(), bins };
  trashMemo = { at: Date.now(), addr: env.AHA_ADRESSE, dayKey, body };
  return reply(200, body);
}
async function ahaPost(fields) {
  const r = await fetch(AHA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (wand-dashboard)' },
    body: new URLSearchParams(fields).toString(),
  });
  if (!r.ok) throw new Error('status ' + r.status);
  return r.text();
}
function norm(s) {
  return s.toLowerCase().replace(/stra(ss|ß)e\b/g, 'str.').replace(/str\b(?!\.)/g, 'str.').replace(/\s+/g, ' ').trim();
}
// "Musterweg 5a, Ahlten" → { street, nr, addon, ortsteil, letter }
function parseAddress(s) {
  const [main, ortsteil = ''] = s.split(',').map(x => x.trim());
  const m = /^(.+?)\s+(\d+)\s*([a-zA-Z]?)$/.exec(main || '');
  if (!m) return null;
  const first = m[1][0].toUpperCase();
  return { street: m[1], nr: m[2], addon: m[3], ortsteil, letter: { 'Ä': 'A', 'Ö': 'O', 'Ü': 'U' }[first] || first };
}
function parseTrash(html) {
  const t = html.indexOf('table-abfuhr');
  if (t < 0) return [];
  const table = html.slice(t, html.indexOf('</table>', t));
  const out = [];
  const parts = table.split(/<strong>/).slice(1);
  for (const part of parts) {
    const name = part.slice(0, part.indexOf('</strong>')).trim();
    const dates = [...part.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)].map(m => m[3] + '-' + m[2] + '-' + m[1]);
    if (name && dates.length) out.push({ type: name, dates });
  }
  return out;
}

/* ---------- Govee-Thermometer (nur lesen) ---------- */
async function climate(env, reply) {
  if (!env.GOVEE_KEY) return reply(500, { error: 'not configured' });
  if (climateMemo && Date.now() - climateMemo.at < CLIMATE_CACHE_MS) return reply(200, climateMemo.body);
  const headers = { 'Govee-API-Key': env.GOVEE_KEY, 'Content-Type': 'application/json' };
  try {
    if (!goveeDevice) {
      const r = await fetch(GOVEE_API + '/user/devices', { headers });
      if (r.status === 401 || r.status === 403) return reply(502, { error: 'govee key' });
      if (!r.ok) throw new Error('status ' + r.status);
      const list = ((await r.json()).data || []);
      const d = list.find(x => /^H5179/i.test(x.sku)) ||
        list.find(x => (x.capabilities || []).some(c => c.instance === 'sensorTemperature'));
      if (!d) return reply(404, { error: 'no thermometer' });
      goveeDevice = { sku: d.sku, device: d.device };
    }
    const r = await fetch(GOVEE_API + '/device/state', {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: crypto.randomUUID(), payload: goveeDevice }),
    });
    if (r.status === 401 || r.status === 403) return reply(502, { error: 'govee key' });
    if (!r.ok) throw new Error('status ' + r.status);
    const caps = (((await r.json()).payload || {}).capabilities) || [];
    const val = name => { const c = caps.find(x => x.instance === name); return c && c.state ? c.state.value : null; };
    let t = val('sensorTemperature'), h = val('sensorHumidity'), online = val('online');
    if (h && typeof h === 'object') h = h.currentHumidity;
    if (typeof t === 'number' && t > 45) t = (t - 32) * 5 / 9; // Govee liefert °F
    if (typeof t !== 'number' && typeof h !== 'number') { goveeDevice = null; return reply(502, { error: 'no data' }); }
    const body = {
      updated: new Date().toISOString(),
      temperature: typeof t === 'number' ? Math.round(t * 10) / 10 : null,
      humidity: typeof h === 'number' ? Math.round(h) : null,
      online: online !== false,
    };
    climateMemo = { at: Date.now(), body };
    return reply(200, body);
  } catch (e) {
    return reply(502, { error: 'govee unreachable' });
  }
}

/* ---------- Gemeinsame Listen (KV) ---------- */
async function list(request, env, reply, name) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  const key = 'list:' + name;
  const data = (await env.DATA.get(key, 'json')) || { items: [], recent: [], updated: null };
  if (request.method === 'GET') return reply(200, data);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return reply(413, { error: 'too large' });
    body = JSON.parse(raw);
  } catch (e) { return reply(400, { error: 'bad request' }); }

  const items = data.items;
  const find = id => items.findIndex(x => x.id === id);
  const remember = text => {
    data.recent = [text].concat(data.recent.filter(t => t.toLowerCase() !== text.toLowerCase())).slice(0, MAX_RECENT);
  };
  if (body.op === 'add') {
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) return reply(400, { error: 'empty' });
    const same = items.find(x => x.text.toLowerCase() === text.toLowerCase());
    if (same) same.done = false; // schon auf der Liste: wieder aktivieren statt doppelt
    else {
      if (items.length >= MAX_ITEMS) return reply(409, { error: 'full' });
      items.push({ id: crypto.randomUUID().slice(0, 8), text, done: false, added: new Date().toISOString() });
    }
  } else if (body.op === 'toggle') {
    const i = find(body.id);
    if (i < 0) return reply(200, data); // inzwischen woanders gelöscht
    items[i].done = !items[i].done;
  } else if (body.op === 'remove') {
    const i = find(body.id);
    if (i >= 0) { remember(items[i].text); items.splice(i, 1); }
  } else if (body.op === 'clearDone') {
    items.filter(x => x.done).forEach(x => remember(x.text));
    data.items = items.filter(x => !x.done);
  } else {
    return reply(400, { error: 'unknown op' });
  }
  data.updated = new Date().toISOString();
  await env.DATA.put(key, JSON.stringify(data));
  return reply(200, data);
}
