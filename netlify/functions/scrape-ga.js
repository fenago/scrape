// Scrape GA Secured Party UCC search (search.gsccca.org).
//
// GA's site is plain ASP — no SPA, no JS rendering, no Firecrawl needed. Just
// classic form posts with session cookies. Per-query cost is effectively zero.
//
// Flow:
//   1. POST login.asp with GSCCCA creds → capture ASPSESSIONID cookie.
//   2. For each lender (in parallel): POST securedresults.asp with the
//      cookie + search params → get full HTML results page.
//   3. Parse the results table with cheerio.
//   4. Aggregate + dedupe, return JSON to the UI.
//
// Required Netlify env vars: GSCCCA_USER, GSCCCA_PASS

import * as cheerio from 'cheerio';

const LOGIN_URL = 'https://apps.gsccca.org/login.asp?sFormAction=';
const SEARCH_URL = 'https://search.gsccca.org/UCC_Search/securedresults.asp';
const PER_QUERY_TIMEOUT_MS = 8000;

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = process.env.GSCCCA_USER;
  const pass = process.env.GSCCCA_PASS;
  if (!user || !pass) return json(500, { error: 'GSCCCA_USER / GSCCCA_PASS env vars not set' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const lenders = (Array.isArray(body.lenders) ? body.lenders : [])
    .map(s => (s || '').trim())
    .filter(Boolean);
  if (!lenders.length) return json(400, { error: 'At least one lender name is required' });
  if (lenders.length > 25) return json(400, { error: 'Max 25 lenders per batch (Netlify 10s timeout)' });

  const fromDate = body.fromDate || '01/01/2024';
  const toDate = body.toDate || todayMMDDYYYY();
  const maxrows = clamp(parseInt(body.maxrows, 10) || 100, 10, 100);
  const stemSearch = body.stemSearch !== false; // default true (fuzzy)

  // Step 1: log in once.
  let cookie;
  try {
    cookie = await login(user, pass);
  } catch (err) {
    return json(502, { error: `Login failed: ${err.message}` });
  }
  if (!cookie) return json(502, { error: 'Login produced no session cookie (bad creds?)' });

  // Step 2: search all lenders in parallel.
  const perQuery = await Promise.all(lenders.map(async (lender) => {
    const t0 = Date.now();
    try {
      const { html, status } = await searchLender(cookie, lender, fromDate, toDate, maxrows, stemSearch);
      const parsed = parseResults(html);
      return {
        lender,
        httpStatus: status,
        leadCount: parsed.leads.length,
        totalMatched: parsed.totalMatched,
        leads: parsed.leads.map(l => ({ ...l, source_lender: lender })),
        elapsedMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        lender,
        httpStatus: 0,
        leadCount: 0,
        totalMatched: '',
        leads: [],
        error: err.message,
        elapsedMs: Date.now() - t0,
      };
    }
  }));

  // Step 3: aggregate + dedupe across queries.
  const seen = new Set();
  const allLeads = [];
  for (const q of perQuery) {
    for (const l of q.leads) {
      const key = `${l.file_number || ''}|${l.debtor_name || ''}|${l.county || ''}`;
      if (key === '||' || seen.has(key)) continue;
      seen.add(key);
      allLeads.push(l);
    }
  }

  return json(200, {
    leads: allLeads,
    perQuery: perQuery.map(({ leads, ...rest }) => rest), // drop nested leads from per-query summary
    params: { fromDate, toDate, maxrows, stemSearch },
    completedAt: new Date().toISOString(),
  });
}

async function login(user, pass) {
  const body = new URLSearchParams({ txtUserID: user, txtPassword: pass });
  const res = await fetchWithTimeout(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; UCC-Lead-App/0.2)',
    },
    body: body.toString(),
    redirect: 'manual',
  }, PER_QUERY_TIMEOUT_MS);

  // GSCCCA sets ASPSESSIONID + login cookies on a 302 redirect after successful login.
  const setCookieRaw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!setCookieRaw.length) {
    const single = res.headers.get('set-cookie');
    if (single) setCookieRaw.push(single);
  }
  if (!setCookieRaw.length) {
    throw new Error(`No Set-Cookie returned (HTTP ${res.status}). Login likely failed.`);
  }
  return setCookieRaw.map(c => c.split(';')[0]).join('; ');
}

async function searchLender(cookie, lender, fromDate, toDate, maxrows, stemSearch) {
  const body = new URLSearchParams({
    securedsearch: '0',                       // 0 = Organization, 1 = Individual
    SecuredPartyOrganizationName: lender,
    SecuredPartyLastName: '',
    SecuredPartyFirstName: '',
    SecuredPartyMiddleName: '',
    SecuredPartyExact: stemSearch ? '0' : '1', // 0 = Stem (fuzzy), 1 = Exact
    FromDate: fromDate,
    ToDate: toDate,
    maxrows: String(maxrows),
  });
  const res = await fetchWithTimeout(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (compatible; UCC-Lead-App/0.2)',
      Referer: 'https://search.gsccca.org/UCC_Search/search.asp?searchtype=SecuredParty',
    },
    body: body.toString(),
  }, PER_QUERY_TIMEOUT_MS);

  const html = await res.text();
  return { html, status: res.status };
}

// Parse the GA results page. Handles three cases:
//   1. "No items matching your search" → empty leads, totalMatched: "0"
//   2. A real results table with rows → parsed leads
//   3. Login expired / error page → throws so the caller surfaces it
function parseResults(html) {
  const $ = cheerio.load(html);
  const bodyText = $.root().text().replace(/\s+/g, ' ').trim();

  // Case 1: explicit no-results message.
  if (/no\s+items?\s+matching\s+your\s+search/i.test(bodyText) ||
      /no\s+(?:records?|results?)\s+(?:were\s+)?found/i.test(bodyText)) {
    return { leads: [], totalMatched: '0' };
  }

  // Case 3: redirected back to login page = session died.
  if (/please\s+enter.*login\s+name\s+and\s+password/i.test(bodyText) ||
      $('input[name="txtUserID"]').length > 0) {
    throw new Error('GSCCCA session expired or login bounced (page returned login form)');
  }

  // Case 2: find a real results table. Required signal: a header row that
  // mentions "debtor" AND ("file" OR "instrument" OR "date").
  let resultsTable = null;
  $('table').each((i, t) => {
    const headers = $(t).find('tr').first().find('th, td').map((j, c) => $(c).text().trim().toLowerCase()).get();
    const joined = headers.join(' ');
    if (joined.includes('debtor') && /\b(file|instrument|date|document)\b/.test(joined)) {
      resultsTable = $(t);
      return false;
    }
  });

  const leads = [];
  if (resultsTable) {
    const headerCells = resultsTable.find('tr').first().find('th, td').map((i, c) => $(c).text().trim().toLowerCase()).get();
    const colIdx = (...candidates) => {
      for (const cand of candidates) {
        const i = headerCells.findIndex(h => h.includes(cand));
        if (i >= 0) return i;
      }
      return -1;
    };
    const idx = {
      debtor:      colIdx('debtor', 'name'),
      file_number: colIdx('file', 'document', 'instrument'),
      filing_date: colIdx('date'),
      filing_type: colIdx('type'),
      secured:     colIdx('secured', 'party'),
      county:      colIdx('county'),
      status:      colIdx('status'),
    };

    resultsTable.find('tr').slice(1).each((i, row) => {
      const cells = $(row).find('td').map((j, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
      if (cells.length < 2) return;
      const pick = i => (i >= 0 && i < cells.length ? cells[i] : '');
      const lead = {
        debtor_name: pick(idx.debtor),
        file_number: pick(idx.file_number),
        filing_date: pick(idx.filing_date),
        filing_type: pick(idx.filing_type),
        secured_party: pick(idx.secured),
        county: pick(idx.county),
        status: pick(idx.status),
        address: '', city: '', state: '', zip: '',
        raw_cells: cells,
      };
      // Skip junk rows (header re-shows, pagination, etc).
      if (!lead.debtor_name || lead.debtor_name.length < 2) return;
      if (/^\s*query\s+made/i.test(lead.debtor_name)) return;
      if (/^\s*display\s+results/i.test(lead.debtor_name)) return;
      leads.push(lead);
    });
  }

  const totalMatch = bodyText.match(/(\d+(?:,\d{3})*)\s+(?:records?|results?|items?)\s+(?:matched|found)/i);
  const totalMatched = totalMatch ? totalMatch[1] : (leads.length ? String(leads.length) : '');

  return { leads, totalMatched };
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function todayMMDDYYYY() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
