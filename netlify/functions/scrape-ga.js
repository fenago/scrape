// Scrape GA Secured Party UCC search via Firecrawl's actions API.
//
// The direct-POST approach failed silently — GSCCCA's ASP backend returns
// "no items matching" for our function's POST but returns full results for a
// real browser session with the same form values. We don't know which session
// var / hidden state we're missing, and chasing it has already burned hours.
//
// Switching to Firecrawl REST: each search runs in a real browser, so we get
// exactly what a logged-in user would see. Costs ~10-15 Firecrawl credits per
// lender, but reliable.
//
// Required Netlify env vars: GSCCCA_USER, GSCCCA_PASS, FIRECRAWL_API_KEY

const FIRECRAWL_SCRAPE = 'https://api.firecrawl.dev/v1/scrape';
const PER_QUERY_TIMEOUT_MS = 90000;

// Date range limit: GSCCCA free "limited use" accounts silently clamp FromDate
// to 1 year ago. Surfacing it here so the UI can warn users + we don't bother
// sending older dates that will just get clamped.
export const MAX_LOOKBACK_DAYS = 365;

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    page_kind: {
      type: 'string',
      description:
        'Which type of GSCCCA results page is rendered: ' +
        '"variants" if the page lists secured-party NAME variants with instrument counts (columns include SELECT/INSTRUMENTS/SECURED PARTY NAME); ' +
        '"filings" if the page lists individual UCC filings (columns include FILE NUMBER/DATE/DEBTOR/SECURED PARTY); ' +
        '"none" if the page says no items matching the search; ' +
        '"login" if the page is the login form (session expired); ' +
        '"other" otherwise.',
    },
    total_matched: {
      type: 'string',
      description: 'The "N records matched" or "N variations of the name found" text near the top of results.',
    },
    variants: {
      type: 'array',
      description: 'When page_kind = "variants": each row showing a secured-party name and its instrument count.',
      items: {
        type: 'object',
        properties: {
          secured_party_name: { type: 'string' },
          instrument_count: { type: 'number' },
        },
      },
    },
    filings: {
      type: 'array',
      description: 'When page_kind = "filings": each UCC filing row with debtor + filing info.',
      items: {
        type: 'object',
        properties: {
          debtor_name: { type: 'string' },
          file_number: { type: 'string' },
          filing_date: { type: 'string' },
          filing_type: { type: 'string' },
          secured_party: { type: 'string' },
          county: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  },
  required: ['page_kind'],
};

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const fcKey = process.env.FIRECRAWL_API_KEY;
  const user = process.env.GSCCCA_USER;
  const pass = process.env.GSCCCA_PASS;
  if (!fcKey) return json(500, { error: 'FIRECRAWL_API_KEY env var not set' });
  if (!user || !pass) return json(500, { error: 'GSCCCA_USER / GSCCCA_PASS env vars not set' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const lenders = (Array.isArray(body.lenders) ? body.lenders : [])
    .map(s => (s || '').trim())
    .filter(Boolean);
  if (!lenders.length) return json(400, { error: 'At least one lender name is required' });
  if (lenders.length > 10) return json(400, { error: 'Max 10 lenders per batch (Firecrawl cost cap, ~10 credits each)' });

  // Clamp FromDate to MAX_LOOKBACK_DAYS — GSCCCA limited-use accounts cap it
  // server-side anyway, surfacing it here so the user sees what's actually used.
  const today = new Date();
  const earliestAllowed = new Date(today.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const requestedFromDate = body.fromDate || mmddyyyy(earliestAllowed);
  const requestedToDate = body.toDate || mmddyyyy(today);
  const fromDate = clampDateAtLeast(requestedFromDate, earliestAllowed);
  const toDate = requestedToDate;
  const dateClamped = fromDate !== requestedFromDate;

  const maxrows = clamp(parseInt(body.maxrows, 10) || 100, 10, 100);
  const stemSearch = body.stemSearch !== false;

  // For each lender, kick off Firecrawl in parallel.
  const perQuery = await Promise.all(lenders.map(async (lender) => {
    const t0 = Date.now();
    try {
      const result = await runFirecrawlSearch({
        fcKey, user, pass, lender, fromDate, toDate, maxrows, stemSearch,
      });
      return {
        lender,
        status: 'ok',
        page_kind: result.page_kind,
        total_matched: result.total_matched,
        variants: result.variants || [],
        filings: result.filings || [],
        elapsedMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        lender,
        status: 'error',
        error: err.message,
        variants: [],
        filings: [],
        elapsedMs: Date.now() - t0,
      };
    }
  }));

  // Aggregate leads (filings) across all lenders + dedupe.
  const seen = new Set();
  const leads = [];
  for (const q of perQuery) {
    for (const f of q.filings) {
      const key = `${f.file_number || ''}|${f.debtor_name || ''}|${f.county || ''}`;
      if (key === '||' || seen.has(key)) continue;
      seen.add(key);
      leads.push({ ...f, source_lender: q.lender });
    }
  }

  return json(200, {
    leads,
    perQuery,
    params: { fromDate, toDate, requestedFromDate, dateClamped, maxrows, stemSearch },
    completedAt: new Date().toISOString(),
  });
}

async function runFirecrawlSearch({ fcKey, user, pass, lender, fromDate, toDate, maxrows, stemSearch }) {
  // JS payload that runs inside the page after login.
  // Has to be a single-line-friendly string (escape carefully).
  const fillFormJs = (
    "const f=document.frmSearch;" +
    "if(typeof TurnSPIndOff==='function')TurnSPIndOff();" +
    "f.SecuredPartyOrganizationName.disabled=false;" +
    `f.SecuredPartyOrganizationName.value=${JSON.stringify(lender)};` +
    "Array.from(f.securedsearch).forEach(r=>r.checked=(r.value==='0'));" +
    `Array.from(f.SecuredPartyExact).forEach(r=>r.checked=(r.value===${stemSearch ? "'0'" : "'1'"}));` +
    `f.FromDate.value=${JSON.stringify(fromDate)};` +
    `f.ToDate.value=${JSON.stringify(toDate)};` +
    `f.maxrows.value=${JSON.stringify(String(maxrows))};` +
    "f.submit();"
  );

  const payload = {
    url: 'https://apps.gsccca.org/login.asp',
    formats: ['json', 'markdown'],
    jsonOptions: {
      schema: LEAD_SCHEMA,
      prompt:
        'You are looking at a Georgia GSCCCA UCC search results page. Determine page_kind: ' +
        '"variants" if the page lists matching secured-party NAME variants (each row has an instrument count and a name); ' +
        '"filings" if the page lists individual UCC filings with debtor and file number columns; ' +
        '"none" if the body contains text like "no items matching your search"; ' +
        '"login" if the page shows a login form (session expired); ' +
        'else "other". Extract every row of variants or filings. Also extract any "N records matched" / "N variations of the name found" text.',
    },
    onlyMainContent: false,
    waitFor: 1000,
    timeout: 75000,
    actions: [
      // 1. Log in.
      { type: 'wait', milliseconds: 1500 },
      { type: 'executeJavascript', script:
        `document.frmLogin.txtUserID.value=${JSON.stringify(user)};` +
        `document.frmLogin.txtPassword.value=${JSON.stringify(pass)};` +
        "document.frmLogin.submit();"
      },
      { type: 'wait', milliseconds: 4000 },
      // 2. Navigate to Secured Party Search form.
      { type: 'executeJavascript', script:
        "window.location.href='https://search.gsccca.org/UCC_Search/search.asp?searchtype=SecuredParty';"
      },
      { type: 'wait', milliseconds: 4500 },
      // 3. Fill + submit search form.
      { type: 'executeJavascript', script: fillFormJs },
      // 4. Wait for results page to render.
      { type: 'wait', milliseconds: 7500 },
    ],
  };

  const res = await fetchWithTimeout(FIRECRAWL_SCRAPE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fcKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, PER_QUERY_TIMEOUT_MS);

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new Error(`Firecrawl returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || `Firecrawl HTTP ${res.status}`);
  }

  const json = data?.data?.json || data?.data?.extract || {};
  return {
    page_kind: json.page_kind || 'unknown',
    total_matched: json.total_matched || '',
    variants: Array.isArray(json.variants) ? json.variants : [],
    filings: Array.isArray(json.filings) ? json.filings : [],
  };
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

function mmddyyyy(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}
function clampDateAtLeast(s, minDate) {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return mmddyyyy(minDate);
  const d = new Date(+m[3], +m[1] - 1, +m[2]);
  return d < minDate ? mmddyyyy(minDate) : s;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
