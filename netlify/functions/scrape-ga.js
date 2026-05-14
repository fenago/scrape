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

// Parse the GA results page. The first time we see the actual HTML in
// production, this may need to be tightened. For now we use a flexible
// table-scan approach: find any <table> whose rows look like result data
// (≥4 cells, first cell looks like a name/number).
function parseResults(html) {
  const $ = cheerio.load(html);

  // Try to find the results table by looking for a header row mentioning
  // typical UCC columns.
  let resultsTable = null;
  $('table').each((i, t) => {
    const headers = $(t).find('th, td').first().parent().find('th, td').map((j, c) => $(c).text().trim().toLowerCase()).get();
    const joined = headers.join(' ');
    if (
      (joined.includes('debtor') || joined.includes('name')) &&
      (joined.includes('file') || joined.includes('ucc') || joined.includes('document') || joined.includes('date'))
    ) {
      resultsTable = $(t);
      return false; // break
    }
  });

  // Fallback: largest table with >2 rows of data
  if (!resultsTable) {
    let bestCount = 0;
    $('table').each((i, t) => {
      const rowCount = $(t).find('tr').length;
      if (rowCount > bestCount && rowCount >= 3) {
        bestCount = rowCount;
        resultsTable = $(t);
      }
    });
  }

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
      file_number: colIdx('file', 'document', 'ucc'),
      filing_date: colIdx('date'),
      filing_type: colIdx('type', 'instrument'),
      secured:     colIdx('secured', 'party'),
      county:      colIdx('county'),
      status:      colIdx('status'),
      address:     colIdx('address'),
      city:        colIdx('city'),
      state:       colIdx('state'),
      zip:         colIdx('zip', 'postal'),
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
        address: pick(idx.address),
        city: pick(idx.city),
        state: pick(idx.state),
        zip: pick(idx.zip),
        raw_cells: cells,
      };
      if (lead.debtor_name || lead.file_number) leads.push(lead);
    });
  }

  // Try to extract "N records matched" text from the body.
  const bodyText = $.root().text();
  const totalMatch = bodyText.match(/(\d+(?:,\d{3})*)\s+(?:records?|results?)\s+(?:matched|found)/i);
  const totalMatched = totalMatch ? totalMatch[1] : '';

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
