/*
 * Vermittler für das Wand-Dashboard (Cloudflare Worker).
 *
 * Geheimnisse liegen NUR bei Cloudflare (wrangler secret put …), nie im Code:
 *   ICAL_URL    – private iCal-Adresse des Google-Kalenders
 *   ACCESS_KEY  – Zugangsschlüssel, der auf dem Tablet eingetragen wird
 *   AHA_ADRESSE – Adresse für die Müllabfuhr, z. B. "Musterweg 5" oder "Musterweg 5a, Ahlten"
 *   GOVEE_KEY   – API-Schlüssel aus der Govee-Home-App
 *   TOMTOM_KEY, COMMUTE_FROM, COMMUTE_TO – Verkehrsdienst und Adressen für den Arbeitsweg
 *
 * Alle Abfragen brauchen den Header  Authorization: Bearer <ACCESS_KEY>
 * GET /calendar?days=7 → nur Titel und Zeiten der Termine im Zeitraum, keine
 *   Beschreibungen, Orte oder Teilnehmer. Nur lesen, nie schreiben.
 * GET /trash → nächste Abholtermine je Tonne (aha Region Hannover, Gemeinde Lehrte).
 * GET /climate → Temperatur und Luftfeuchte des Govee-Thermometers.
 * GET /list/einkauf → Einkaufsliste aus dem gemeinsamen Speicher (KV "DATA")
 * POST /list/einkauf  {op:"add",text} | {op:"addMany",texts} | {op:"toggle",id} | {op:"remove",id} | {op:"clearDone"}
 * GET /meter → Zählerstände und Tarif
 * POST /meter  {op:"add",date,strom,gas} | {op:"removeLast"} | {op:"import",readings} | {op:"tariff",kind,grund,arbeit,abschlag,start,faktor?}
 * GET /notes → Zettel der Pinnwand
 * POST /notes  {op:"add",text,color} | {op:"edit",id,text,color} | {op:"pin",id} | {op:"remove",id}
 * GET /birthdays → Geburtstagsliste
 * POST /birthdays  {op:"add",name,day,month,year?} | {op:"edit",id,name,day,month,year?} | {op:"remove",id}
 * GET /commute → aktuelle Fahrzeit zur Arbeit mit Verkehr (TomTom)
 * GET /tasks → Aufgaben
 * POST /tasks  {op:"add"|"edit",id?,text,due,important,repeat} | {op:"done",id} | {op:"undo",id} | {op:"remove",id} | {op:"clearDone"}
 * GET /meals → Essensideen (beim ersten Abruf mit einer Startsammlung gefüllt)
 * POST /meals  {op:"add"|"edit",id?,name,ingredients,quick,veggie,season} | {op:"remove",id} | {op:"cooked",id}
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
    const writable = listName || ['/meter', '/notes', '/birthdays', '/meals', '/tasks'].includes(url.pathname);
    if (!listName && !['/calendar', '/trash', '/climate', '/meter', '/notes', '/birthdays', '/meals', '/commute', '/tasks'].includes(url.pathname)) return reply(404, { error: 'not found' });
    if (request.method !== 'GET' && !(writable && request.method === 'POST')) return reply(405, { error: 'method' });

    if (!env.ACCESS_KEY) return reply(500, { error: 'not configured' });
    const auth = request.headers.get('Authorization') || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!given || !(await sameSecret(given, env.ACCESS_KEY))) return reply(401, { error: 'unauthorized' });

    if (listName) return list(request, env, reply, listName);
    if (url.pathname === '/meter') return meter(request, env, reply);
    if (url.pathname === '/notes') return notes(request, env, reply);
    if (url.pathname === '/birthdays') return birthdays(request, env, reply);
    if (url.pathname === '/meals') return meals(request, env, reply);
    if (url.pathname === '/commute') return commute(env, reply);
    if (url.pathname === '/tasks') return tasks(request, env, reply);
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
  let result;
  try { result = await goveeRead(env); }
  catch (e) {
    console.log('govee retry after:', e.message);
    await new Promise(r => setTimeout(r, 1500));
    try { result = await goveeRead(env); } catch (e2) { result = { error: e2.message }; }
  }
  if (result.body) {
    climateMemo = { at: Date.now(), body: result.body };
    // Letzten guten Wert für Govee-Aussetzer aufheben, höchstens alle 15 Minuten schreiben (KV-Tageslimit)
    const last = env.DATA && await env.DATA.get('climate:last', 'json');
    if (env.DATA && (!last || Date.now() - Date.parse(last.updated) > 15 * 60 * 1000)) await env.DATA.put('climate:last', JSON.stringify(result.body));
    return reply(200, result.body);
  }
  console.log('govee failed:', result.error);
  if (result.error === 'govee key') return reply(502, { error: 'govee key' });
  if (result.error === 'no thermometer') return reply(404, { error: 'no thermometer' });
  const reason = result.error === 'offline' ? 'offline' : 'unreachable';
  const last = env.DATA && await env.DATA.get('climate:last', 'json');
  if (last && Date.now() - Date.parse(last.updated) < 12 * 60 * 60 * 1000) return reply(200, { ...last, stale: true, reason });
  return reply(502, { error: reason === 'offline' ? 'offline' : 'govee unreachable' });
}
// Liest das Thermometer einmal aus; wirft bei Fehlern (Meldung ohne Schlüssel, fürs Protokoll)
async function goveeRead(env) {
  const headers = { 'Govee-API-Key': env.GOVEE_KEY, 'Content-Type': 'application/json' };
  const why = async (r, step) => {
    let msg = '';
    try { const j = await r.json(); msg = (j.code || '') + ' ' + (j.msg || j.message || ''); } catch (e) {}
    return step + ' HTTP ' + r.status + ' ' + msg.trim();
  };
  if (!goveeDevice) {
    const r = await fetch(GOVEE_API + '/user/devices', { headers });
    if (r.status === 401 || r.status === 403) return { error: 'govee key' };
    if (!r.ok) throw new Error(await why(r, 'devices'));
    const list = ((await r.json()).data || []);
    const d = list.find(x => /^H5179/i.test(x.sku)) ||
      list.find(x => (x.capabilities || []).some(c => c.instance === 'sensorTemperature'));
    if (!d) return { error: 'no thermometer' };
    goveeDevice = { sku: d.sku, device: d.device };
  }
  const r = await fetch(GOVEE_API + '/device/state', {
    method: 'POST', headers,
    body: JSON.stringify({ requestId: crypto.randomUUID(), payload: goveeDevice }),
  });
  if (r.status === 401 || r.status === 403) return { error: 'govee key' };
  if (!r.ok) throw new Error(await why(r, 'state'));
  const json = await r.json();
  const caps = ((json.payload || {}).capabilities) || [];
  const val = name => { const c = caps.find(x => x.instance === name); return c && c.state ? c.state.value : null; };
  let t = val('sensorTemperature'), h = val('sensorHumidity'), online = val('online');
  if (h && typeof h === 'object') h = h.currentHumidity;
  if (typeof t === 'number' && t > 45) t = (t - 32) * 5 / 9; // Govee liefert °F
  if (typeof t !== 'number' && typeof h !== 'number') {
    if (online === false) return { error: 'offline' }; // Thermometer hat gerade keine WLAN-Verbindung zur Govee-Cloud
    goveeDevice = null;
    throw new Error('state ohne Messwerte (code ' + (json.code || '?') + ', online ' + online + ')');
  }
  return { body: {
    updated: new Date().toISOString(),
    temperature: typeof t === 'number' ? Math.round(t * 10) / 10 : null,
    humidity: typeof h === 'number' ? Math.round(h) : null,
    online: online !== false,
  } };
}

/* ---------- Gemeinsame Listen (KV) ---------- */
async function readBody(request, limit) {
  const raw = await request.text();
  if (raw.length > limit) throw new Error('too large');
  return JSON.parse(raw);
}
async function list(request, env, reply, name) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  const key = 'list:' + name;
  const data = (await env.DATA.get(key, 'json')) || { items: [], recent: [], updated: null };
  if (request.method === 'GET') return reply(200, data);

  let body;
  try { body = await readBody(request, 2000); } catch (e) { return reply(400, { error: 'bad request' }); }

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
  } else if (body.op === 'addMany') {
    if (!Array.isArray(body.texts) || body.texts.length > 40) return reply(400, { error: 'bad request' });
    let added = 0;
    for (const raw of body.texts) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      if (!text) continue;
      const same = items.find(x => x.text.toLowerCase() === text.toLowerCase());
      if (same) { if (same.done) { same.done = false; added++; } continue; }
      if (items.length >= MAX_ITEMS) break;
      items.push({ id: crypto.randomUUID().slice(0, 8), text, done: false, added: new Date().toISOString() });
      added++;
    }
    data.added = added;
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

/* ---------- Zählerstände und Tarif (KV) ---------- */
const MAX_READINGS = 500;
function num(v, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) && n >= 0 && n <= max ? Math.round(n * 1e6) / 1e6 : undefined;
}
function isDay(d) {
  const m = typeof d === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); // 2026-02-30 würde zum 2. März – das zählt nicht
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
async function meter(request, env, reply) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  const data = (await env.DATA.get('meter', 'json')) || { readings: [], tariff: {}, updated: null };
  if (request.method === 'GET') return reply(200, data);

  let body;
  try { body = await readBody(request, 60000); } catch (e) { return reply(400, { error: 'bad request' }); }
  const R = data.readings;
  const clean = r => {
    const strom = num(r.strom, 1e8), gas = num(r.gas, 1e8);
    if (!isDay(r.date) || strom === undefined || gas === undefined || (strom === null && gas === null)) return null;
    return { id: crypto.randomUUID().slice(0, 8), date: r.date, strom, gas, added: new Date().toISOString() };
  };
  if (body.op === 'add') {
    const r = clean(body);
    if (!r) return reply(400, { error: 'invalid' });
    if (R.length >= MAX_READINGS) return reply(409, { error: 'full' });
    R.push(r);
  } else if (body.op === 'import') {
    // Einmalige Übernahme vom Tablet; doppelte Einträge (gleiches Datum und gleiche Werte) werden übersprungen
    if (!Array.isArray(body.readings) || body.readings.length > MAX_READINGS) return reply(400, { error: 'invalid' });
    for (const x of body.readings) {
      const r = clean(x);
      if (r && R.length < MAX_READINGS && !R.some(y => y.date === r.date && y.strom === r.strom && y.gas === r.gas)) R.push(r);
    }
  } else if (body.op === 'removeLast') {
    if (R.length) {
      let i = 0;
      R.forEach((r, k) => { if ((r.added || '') >= (R[i].added || '')) i = k; });
      R.splice(i, 1);
    }
  } else if (body.op === 'tariff') {
    if (!['strom', 'gas'].includes(body.kind)) return reply(400, { error: 'invalid' });
    const t = { grund: num(body.grund, 1000), arbeit: num(body.arbeit, 10), abschlag: num(body.abschlag, 10000), start: body.start };
    if ([t.grund, t.arbeit, t.abschlag].some(v => v === undefined || v === null) || !isDay(t.start)) return reply(400, { error: 'invalid' });
    if (body.kind === 'gas') { // kWh pro m³ (Brennwert × Zustandszahl)
      t.faktor = num(body.faktor, 20);
      if (!t.faktor) return reply(400, { error: 'invalid' });
    }
    data.tariff = data.tariff || {};
    data.tariff[body.kind] = t;
  } else {
    return reply(400, { error: 'unknown op' });
  }
  R.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.added < b.added ? -1 : 1));
  data.updated = new Date().toISOString();
  await env.DATA.put('meter', JSON.stringify(data));
  return reply(200, data);
}

/* ---------- Pinnwand (KV) ---------- */
const MAX_NOTES = 60, MAX_NOTE_TEXT = 500;
const NOTE_COLORS = ['gelb', 'rosa', 'gruen', 'blau', 'lila'];
async function notes(request, env, reply) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  const data = (await env.DATA.get('notes', 'json')) || { notes: [], updated: null };
  if (request.method === 'GET') return reply(200, data);

  let body;
  try { body = await readBody(request, 4000); } catch (e) { return reply(400, { error: 'bad request' }); }
  const N = data.notes;
  const i = N.findIndex(x => x.id === body.id);
  const text = String(body.text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_NOTE_TEXT);
  const color = NOTE_COLORS.includes(body.color) ? body.color : 'gelb';
  const now = new Date().toISOString();
  if (body.op === 'add') {
    if (!text) return reply(400, { error: 'empty' });
    if (N.length >= MAX_NOTES) return reply(409, { error: 'full' });
    N.push({ id: crypto.randomUUID().slice(0, 8), text, color, pinned: false, created: now, edited: null });
  } else if (body.op === 'edit') {
    if (i < 0) return reply(404, { error: 'gone' });
    if (!text) return reply(400, { error: 'empty' });
    N[i].text = text; N[i].color = color; N[i].edited = now;
  } else if (body.op === 'pin') {
    if (i < 0) return reply(404, { error: 'gone' });
    N[i].pinned = !N[i].pinned;
  } else if (body.op === 'remove') {
    if (i >= 0) N.splice(i, 1);
  } else {
    return reply(400, { error: 'unknown op' });
  }
  data.updated = now;
  await env.DATA.put('notes', JSON.stringify(data));
  return reply(200, data);
}

/* ---------- Geburtstage (KV) ---------- */
const MAX_BIRTHDAYS = 300;
async function birthdays(request, env, reply) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  const data = (await env.DATA.get('birthdays', 'json')) || { people: [], updated: null };
  if (request.method === 'GET') return reply(200, data);

  let body;
  try { body = await readBody(request, 2000); } catch (e) { return reply(400, { error: 'bad request' }); }
  const P = data.people;
  const i = P.findIndex(x => x.id === body.id);
  if (body.op === 'remove') {
    if (i >= 0) P.splice(i, 1);
  } else if (body.op === 'add' || body.op === 'edit') {
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const day = Number(body.day), month = Number(body.month);
    const year = body.year === null || body.year === undefined || body.year === '' ? null : Number(body.year);
    const thisYear = new Date().getUTCFullYear();
    // 29. Februar ist erlaubt; mit Jahr muss das Datum in genau diesem Jahr existieren
    const valid = name && Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 &&
      day <= new Date(Date.UTC(year || 2000, month, 0)).getUTCDate() &&
      (year === null || (Number.isInteger(year) && year >= 1900 && year <= thisYear));
    if (!valid) return reply(400, { error: 'invalid' });
    if (body.op === 'add') {
      if (P.length >= MAX_BIRTHDAYS) return reply(409, { error: 'full' });
      P.push({ id: crypto.randomUUID().slice(0, 8), name, day, month, year });
    } else {
      if (i < 0) return reply(404, { error: 'gone' });
      Object.assign(P[i], { name, day, month, year });
    }
  } else {
    return reply(400, { error: 'unknown op' });
  }
  data.updated = new Date().toISOString();
  await env.DATA.put('birthdays', JSON.stringify(data));
  return reply(200, data);
}

/* ---------- Essensideen (KV) ---------- */
const MAX_MEALS = 200;
// Startsammlung: Abendessen für zwei, Zutaten ohne Mengen und ohne Grundzutaten (Salz, Öl, Gewürze)
// [Name, Zutaten, schnell (bis 30 Min.), vegetarisch, passt zu 'warm' | 'kalt' | '']
const STARTER_MEALS = [
  ['Spaghetti Bolognese', 'Hackfleisch, Spaghetti, passierte Tomaten, Zwiebel, Knoblauch, Karotte, Parmesan', false, false, ''],
  ['Gemüse-Curry mit Reis', 'Kokosmilch, Currypaste, Paprika, Zucchini, Kichererbsen, Reis', true, true, ''],
  ['Hähnchen-Gemüse-Pfanne mit Reis', 'Hähnchenbrust, Paprika, Brokkoli, Sojasoße, Reis', true, false, ''],
  ['Kartoffelsuppe mit Würstchen', 'Kartoffeln, Suppengrün, Wiener Würstchen, Gemüsebrühe', false, false, 'kalt'],
  ['Linsen-Dal mit Fladenbrot', 'Rote Linsen, Kokosmilch, Dosentomaten, Zwiebel, Ingwer, Fladenbrot', true, true, ''],
  ['Ofengemüse mit Feta', 'Kartoffeln, Paprika, Zucchini, Rote Zwiebel, Feta', false, true, ''],
  ['Lachs mit Ofenkartoffeln und Spinat', 'Lachsfilet, Kartoffeln, Blattspinat, Zitrone', false, false, ''],
  ['Chili con Carne', 'Hackfleisch, Kidneybohnen, Mais, Dosentomaten, Paprika, Zwiebel', false, false, 'kalt'],
  ['Flammkuchen', 'Flammkuchenteig, Schmand, Speckwürfel, Zwiebel', true, false, ''],
  ['Kartoffelpuffer mit Apfelmus', 'Kartoffeln, Eier, Zwiebel, Apfelmus', false, true, 'kalt'],
  ['Spaghetti Aglio e Olio', 'Spaghetti, Knoblauch, Chili, Petersilie, Parmesan', true, true, ''],
  ['Gnocchi mit Tomaten und Mozzarella', 'Gnocchi, Kirschtomaten, Mozzarella, Basilikum', true, true, 'warm'],
  ['Schnitzel mit Bratkartoffeln', 'Schweineschnitzel, Paniermehl, Eier, Kartoffeln, Zwiebel', false, false, ''],
  ['Gulasch mit Bandnudeln', 'Rindergulasch, Zwiebeln, Paprika, Tomatenmark, Bandnudeln', false, false, 'kalt'],
  ['Bauernfrühstück', 'Kartoffeln, Eier, Speckwürfel, Zwiebel, Gewürzgurken', true, false, ''],
  ['Hähnchen-Wraps', 'Tortilla-Wraps, Hähnchenbrust, Eisbergsalat, Tomaten, Mais, Joghurt', true, false, 'warm'],
  ['Gefüllte Paprika', 'Paprika, Hackfleisch, Reis, Tomatensoße, Reibekäse', false, false, ''],
  ['Pilzrisotto', 'Risottoreis, Champignons, Parmesan, Zwiebel, Weißwein, Gemüsebrühe', false, true, 'kalt'],
  ['Fischstäbchen mit Kartoffelpüree und Erbsen', 'Fischstäbchen, Kartoffeln, Milch, Butter, Erbsen', true, false, ''],
  ['Griechischer Salat mit Fladenbrot', 'Gurke, Tomaten, Feta, Oliven, Paprika, Rote Zwiebel, Fladenbrot', true, true, 'warm'],
  ['Burger', 'Burgerbrötchen, Rinderhack, Cheddar, Salat, Tomate, Gurke', true, false, 'warm'],
  ['Grillabend mit Kartoffelsalat', 'Bratwürstchen, Grillgemüse, Kartoffeln, Gewürzgurken, Mayonnaise', false, false, 'warm'],
  ['Kürbissuppe', 'Hokkaido-Kürbis, Kartoffel, Zwiebel, Kokosmilch, Ingwer', false, true, 'kalt'],
  ['Lasagne', 'Lasagneplatten, Hackfleisch, passierte Tomaten, Milch, Butter, Mehl, Reibekäse', false, false, 'kalt'],
  ['Pizza selbst belegt', 'Pizzateig, Tomatensoße, Mozzarella, Salami, Paprika', true, false, ''],
  ['Asia-Nudeln mit Gemüse', 'Mie-Nudeln, Paprika, Möhren, Zuckerschoten, Sojasoße, Eier', true, true, ''],
  ['Käsespätzle mit Salat', 'Spätzle, Bergkäse, Zwiebeln, Butter, Salat', true, true, 'kalt'],
  ['Ofenkartoffel mit Kräuterquark', 'Große Kartoffeln, Quark, Kräuter, Salat', false, true, 'warm'],
  ['Frikadellen mit Kartoffelsalat', 'Hackfleisch, Brötchen, Eier, Zwiebel, Kartoffeln, Gewürzgurken', false, false, ''],
  ['Tortellini in Sahnesoße mit Schinken', 'Tortellini, Sahne, Kochschinken, Erbsen, Parmesan', true, false, ''],
  ['Couscous-Salat mit Halloumi', 'Couscous, Halloumi, Gurke, Tomaten, Minze, Zitrone', true, true, 'warm'],
  ['Grüner Bohneneintopf', 'Grüne Bohnen, Kartoffeln, Mettwürstchen, Zwiebel, Gemüsebrühe', false, false, 'kalt'],
  ['Shakshuka mit Brot', 'Eier, Dosentomaten, Paprika, Zwiebel, Feta, Brot', true, true, ''],
  ['Hähnchenschenkel mit Ofenkartoffeln', 'Hähnchenschenkel, Kartoffeln, Paprika, Rosmarin', false, false, ''],
  ['Quiche Lorraine mit Salat', 'Mürbeteig, Speckwürfel, Eier, Sahne, Reibekäse, Lauch, Salat', false, false, ''],
  ['Zucchini-Nudeln mit Garnelen', 'Zucchini, Garnelen, Knoblauch, Kirschtomaten, Chili', true, false, 'warm'],
];
function mealFrom(body) {
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const list = Array.isArray(body.ingredients) ? body.ingredients : String(body.ingredients || '').split(/[,\n;]/);
  const seen = new Set(), ingredients = [];
  for (const x of list) {
    const t = String(x).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (t && !seen.has(t.toLowerCase()) && ingredients.length < 30) { seen.add(t.toLowerCase()); ingredients.push(t); }
  }
  const season = ['warm', 'kalt'].includes(body.season) ? body.season : '';
  return name ? { name, ingredients, quick: !!body.quick, veggie: !!body.veggie, season } : null;
}
async function meals(request, env, reply) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  let data = await env.DATA.get('meals', 'json');
  if (!data) {
    data = { ideas: STARTER_MEALS.map(m => ({ id: crypto.randomUUID().slice(0, 8), name: m[0], ingredients: m[1].split(', '),
      quick: m[2], veggie: m[3], season: m[4], lastCooked: null, cooked: 0 })), updated: new Date().toISOString() };
    await env.DATA.put('meals', JSON.stringify(data));
  }
  if (request.method === 'GET') return reply(200, data);

  let body;
  try { body = await readBody(request, 4000); } catch (e) { return reply(400, { error: 'bad request' }); }
  const I = data.ideas, i = I.findIndex(x => x.id === body.id);
  if (body.op === 'add' || body.op === 'edit') {
    const m = mealFrom(body);
    if (!m) return reply(400, { error: 'invalid' });
    if (body.op === 'add') {
      if (I.length >= MAX_MEALS) return reply(409, { error: 'full' });
      I.push({ id: crypto.randomUUID().slice(0, 8), ...m, lastCooked: null, cooked: 0 });
    } else {
      if (i < 0) return reply(404, { error: 'gone' });
      Object.assign(I[i], m);
    }
  } else if (body.op === 'remove') {
    if (i >= 0) I.splice(i, 1);
  } else if (body.op === 'cooked') {
    if (i < 0) return reply(404, { error: 'gone' });
    I[i].lastCooked = fmtDate(utcToWall(Date.now(), TZ));
    I[i].cooked = (I[i].cooked || 0) + 1;
  } else {
    return reply(400, { error: 'unknown op' });
  }
  data.updated = new Date().toISOString();
  await env.DATA.put('meals', JSON.stringify(data));
  return reply(200, data);
}

/* ---------- Arbeitsweg (TomTom, nur lesen) ---------- */
const COMMUTE_CACHE_MS = 4 * 60 * 1000;
let commuteMemo = null; // { at, key, body }
let geoMemo = {};       // Adresse → { lat, lon }
async function geocode(env, address) {
  if (geoMemo[address]) return geoMemo[address];
  // lat/lon bevorzugt Treffer in der Nähe von Lehrte (gleichnamige Straßen in anderen Städten rutschen nach hinten)
  const r = await fetch('https://api.tomtom.com/search/2/geocode/' + encodeURIComponent(address) + '.json?countrySet=DE&limit=1&language=de-DE&lat=52.3726&lon=9.9787&key=' + env.TOMTOM_KEY);
  if (r.status === 401 || r.status === 403) throw new Error('key');
  if (!r.ok) throw new Error('net');
  const hit = ((await r.json()).results || [])[0];
  if (!hit || !hit.position) throw new Error('address');
  return (geoMemo[address] = { lat: hit.position.lat, lon: hit.position.lon, found: (hit.address || {}).freeformAddress || '' });
}
async function commute(env, reply) {
  if (!env.TOMTOM_KEY || !env.COMMUTE_FROM || !env.COMMUTE_TO) return reply(500, { error: 'not configured' });
  const memoKey = env.COMMUTE_FROM + '|' + env.COMMUTE_TO;
  if (commuteMemo && commuteMemo.key === memoKey && Date.now() - commuteMemo.at < COMMUTE_CACHE_MS) return reply(200, commuteMemo.body);
  try {
    const [a, b] = await Promise.all([geocode(env, env.COMMUTE_FROM), geocode(env, env.COMMUTE_TO)]);
    const r = await fetch('https://api.tomtom.com/routing/1/calculateRoute/' + a.lat + ',' + a.lon + ':' + b.lat + ',' + b.lon +
      '/json?traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all&departAt=now&key=' + env.TOMTOM_KEY);
    if (r.status === 401 || r.status === 403) throw new Error('key');
    if (!r.ok) { console.log('tomtom route HTTP', r.status); throw new Error('net'); }
    const sum = (((await r.json()).routes || [])[0] || {}).summary;
    if (!sum) throw new Error('net');
    const min = sec => Math.round((sec || 0) / 60);
    const body = {
      updated: new Date().toISOString(),
      minutes: min(sum.travelTimeInSeconds),
      delay: min(sum.trafficDelayInSeconds),                     // Verlust durch Verkehr gegenüber freier Fahrt
      usual: min(sum.historicTrafficTravelTimeInSeconds || sum.noTrafficTravelTimeInSeconds),
      km: Math.round((sum.lengthInMeters || 0) / 100) / 10,
      arrival: sum.arrivalTime ? fmtTime(utcToWall(Date.parse(sum.arrivalTime), TZ)) : null,
      fromFound: a.found, toFound: b.found,   // was TomTom unter den Adressen verstanden hat (zum Prüfen)
      maps: 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + encodeURIComponent(env.COMMUTE_FROM) + '&destination=' + encodeURIComponent(env.COMMUTE_TO),
    };
    commuteMemo = { at: Date.now(), key: memoKey, body };
    return reply(200, body);
  } catch (e) {
    console.log('commute failed:', e.message);
    if (e.message === 'key') return reply(502, { error: 'tomtom key' });
    if (e.message === 'address') { geoMemo = {}; return reply(422, { error: 'address' }); }
    if (commuteMemo && commuteMemo.key === memoKey && Date.now() - commuteMemo.at < 60 * 60 * 1000) return reply(200, { ...commuteMemo.body, stale: true });
    return reply(502, { error: 'tomtom unreachable' });
  }
}

/* ---------- Aufgaben (KV) ---------- */
const MAX_TASKS = 300, MAX_TASK_TEXT = 200;
const REPEAT_UNITS = ['day', 'week', 'month', 'year'];
// Datum (JJJJ-MM-TT) um n Einheiten weiterschieben; Monatsende wird gekappt (31. Jan + 1 Monat = 28./29. Feb)
function addInterval(day, n, unit) {
  const [y, m, d] = day.split('-').map(Number);
  if (unit === 'day' || unit === 'week') return fmtDate(Date.UTC(y, m - 1, d + n * (unit === 'week' ? 7 : 1)));
  const months = unit === 'year' ? n * 12 : n;
  const ty = y + Math.floor((m - 1 + months) / 12), tm = (m - 1 + months) % 12;
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fmtDate(Date.UTC(ty, tm, Math.min(d, dim)));
}
function taskFrom(body) {
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_TEXT);
  if (!text) return null;
  const due = body.due ? String(body.due) : null;
  if (due !== null && !isDay(due)) return null;
  let repeat = null;
  if (body.repeat) {
    const every = Number(body.repeat.every), unit = body.repeat.unit;
    if (!Number.isInteger(every) || every < 1 || every > 365 || !REPEAT_UNITS.includes(unit)) return null;
    repeat = { every, unit };
  }
  return { text, due, important: !!body.important, repeat };
}
async function tasks(request, env, reply) {
  if (!env.DATA) return reply(500, { error: 'not configured' });
  const data = (await env.DATA.get('tasks', 'json')) || { tasks: [], updated: null };
  if (request.method === 'GET') return reply(200, data);

  let body;
  try { body = await readBody(request, 3000); } catch (e) { return reply(400, { error: 'bad request' }); }
  const T = data.tasks, i = T.findIndex(x => x.id === body.id);
  const today = fmtDate(utcToWall(Date.now(), TZ));
  const now = new Date().toISOString();
  if (body.op === 'add' || body.op === 'edit') {
    const t = taskFrom(body);
    if (!t) return reply(400, { error: 'invalid' });
    if (t.repeat && !t.due) t.due = today; // Wiederholungen brauchen einen Starttermin
    t.anchor = t.repeat ? t.due : null;    // Bezugstermin, damit z. B. „jeden 31.“ nicht auf den 28. abrutscht
    if (body.op === 'add') {
      if (T.length >= MAX_TASKS) return reply(409, { error: 'full' });
      T.push({ id: crypto.randomUUID().slice(0, 8), ...t, done: false, doneAt: null, lastDone: null, created: now });
    } else {
      if (i < 0) return reply(404, { error: 'gone' });
      Object.assign(T[i], t);
    }
  } else if (body.op === 'done') {
    if (i < 0) return reply(404, { error: 'gone' });
    const t = T[i];
    if (t.repeat) {
      // Wiederkehrend: nächster Plantermin nach dem aktuellen, aber nie heute oder in der Vergangenheit
      const anchor = t.anchor || t.due || today, from = (t.due && t.due > today) ? t.due : today;
      let k = 1, next = addInterval(anchor, t.repeat.every, t.repeat.unit);
      while (next <= from && k < 5000) next = addInterval(anchor, ++k * t.repeat.every, t.repeat.unit);
      t.prevDue = t.due; t.due = next; t.lastDone = now;
    } else {
      t.done = true; t.doneAt = now;
    }
  } else if (body.op === 'undo') {
    if (i < 0) return reply(404, { error: 'gone' });
    const t = T[i];
    if (t.repeat && t.prevDue) { t.due = t.prevDue; t.prevDue = null; t.lastDone = null; }
    else { t.done = false; t.doneAt = null; }
  } else if (body.op === 'remove') {
    if (i >= 0) T.splice(i, 1);
  } else if (body.op === 'clearDone') {
    data.tasks = T.filter(x => !x.done);
  } else {
    return reply(400, { error: 'unknown op' });
  }
  data.updated = now;
  await env.DATA.put('tasks', JSON.stringify(data));
  return reply(200, data);
}
