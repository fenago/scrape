// One-lender Firecrawl scrape: login → search → drill into biggest variant → extract debtor filings.
//
// The client calls this once per selected lender, in sequence, so we never
// hold two concurrent GSCCCA sessions (free accounts get bounced if we try).
//
// Flow inside Firecrawl (single browser session, ~15s per lender, ~12 credits):
//   1. Visit login.asp, fill creds, submit
//   2. Navigate to Secured Party Search form
//   3. Fill form (org name, stem search, dates) and submit → variants page
//   4. Inside the page, find the variant row with the most instruments and
//      click it → filings page (level-2 with actual debtor rows)
//   5. Firecrawl AI-extracts both the variant list and the filings list

const FIRECRAWL_SCRAPE = 'https://api.firecrawl.dev/v1/scrape';
const PER_QUERY_TIMEOUT_MS = 100000;
const MAX_LOOKBACK_DAYS = 365;

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    page_kind: {
      type: 'string',
      description:
        'Which GSCCCA page is currently rendered: ' +
        '"filings" if it shows individual UCC filings (debtor/file/date columns); ' +
        '"variants" if it shows secured-party NAME variants with instrument counts; ' +
        '"none" if no items matching; "login" if bounced to login; else "other".',
    },
    total_matched: { type: 'string' },
    variants: {
      type: 'array',
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

  const lender = (body.lender || '').trim();
  if (!lender) return json(400, { error: 'lender is required' });

  const today = new Date();
  const earliest = new Date(today.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fromDate = clampDateAtLeast(body.fromDate || mmddyyyy(earliest), earliest);
  const toDate = body.toDate || mmddyyyy(today);
  const maxrows = clamp(parseInt(body.maxrows, 10) || 100, 10, 100);
  const stemSearch = body.stemSearch !== false;

  const t0 = Date.now();
  try {
    const result = await scrapeLender({ fcKey, user, pass, lender, fromDate, toDate, maxrows, stemSearch });
    return json(200, {
      lender,
      status: 'ok',
      page_kind: result.page_kind,
      total_matched: result.total_matched,
      variants: result.variants || [],
      filings: result.filings || [],
      params: { fromDate, toDate, maxrows, stemSearch },
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    return json(200, {
      lender,
      status: 'error',
      error: err.message,
      variants: [],
      filings: [],
      params: { fromDate, toDate, maxrows, stemSearch },
      elapsedMs: Date.now() - t0,
    });
  }
}

async function scrapeLender({ fcKey, user, pass, lender, fromDate, toDate, maxrows, stemSearch }) {
  // 1. JS to fill+submit search form on the Secured Party Search page.
  const fillSearchFormJs = (
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

  // 2. JS to drill into the biggest-instrument variant on the level-1 page.
  //    Strategy: find all <tr> with a numeric instrument cell, pick the one
  //    with the highest count, click its drill-in element (link or radio +
  //    form submit). GSCCCA's variants page typically has either:
  //      a) <a href="securedresults.asp?...&Variation=N"> in each row, or
  //      b) <input type=radio name=Variation value=N> + a Display button.
  //    We try (a) first by clicking any link in the row, then fall back to
  //    submitting frmViewSwitch with the selected variation.
  const drillIntoBiggestVariantJs = (
    "(function(){" +
      "const rows=Array.from(document.querySelectorAll('tr'));" +
      "let best=null,bestCount=-1;" +
      "for(const r of rows){" +
        "const cells=Array.from(r.querySelectorAll('td')).map(c=>c.textContent.trim());" +
        // look for a row where one cell is a small integer and another is a name
        "for(const c of cells){" +
          "const n=parseInt(c.replace(/,/g,''),10);" +
          "if(!isNaN(n)&&n>0&&n<100000&&n>bestCount){bestCount=n;best=r;break;}" +
        "}" +
      "}" +
      "if(best){" +
        "const link=best.querySelector('a[href*=\"securedresults\"], a[href*=\"Result\"], a[href]');" +
        "if(link){link.click();return;}" +
        "const radio=best.querySelector('input[type=\"radio\"]');" +
        "if(radio){radio.checked=true;" +
          "const form=radio.form||document.forms[0];" +
          "if(form){form.submit();return;}" +
        "}" +
      "}" +
    "})();"
  );

  const payload = {
    url: 'https://apps.gsccca.org/login.asp',
    formats: ['json', 'markdown'],
    jsonOptions: {
      schema: LEAD_SCHEMA,
      prompt:
        'Look at the GSCCCA UCC search results page. ' +
        'Determine page_kind: "filings" if rows show individual UCC filings (with debtor/file number/date columns); ' +
        '"variants" if rows show secured-party NAME variants with instrument counts; ' +
        '"none" if "no items matching"; "login" if a login form is showing; else "other". ' +
        'Extract every variant row (secured_party_name + instrument_count) AND every filing row ' +
        '(debtor_name, file_number, filing_date, filing_type, secured_party, county, status). ' +
        'Also capture any "N records" / "N variations" / "N instruments" header text into total_matched.',
    },
    onlyMainContent: false,
    waitFor: 1000,
    timeout: 90000,
    actions: [
      // 1. Log in.
      { type: 'wait', milliseconds: 1500 },
      { type: 'executeJavascript', script:
        `document.frmLogin.txtUserID.value=${JSON.stringify(user)};` +
        `document.frmLogin.txtPassword.value=${JSON.stringify(pass)};` +
        "document.frmLogin.submit();"
      },
      { type: 'wait', milliseconds: 4500 },
      // 2. Navigate to Secured Party Search.
      { type: 'executeJavascript', script:
        "window.location.href='https://search.gsccca.org/UCC_Search/search.asp?searchtype=SecuredParty';"
      },
      { type: 'wait', milliseconds: 4500 },
      // 3. Fill + submit search.
      { type: 'executeJavascript', script: fillSearchFormJs },
      { type: 'wait', milliseconds: 6000 },
      // 4. Drill into biggest variant if we're on the variants page.
      { type: 'executeJavascript', script: drillIntoBiggestVariantJs },
      { type: 'wait', milliseconds: 6000 },
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

  const j = data?.data?.json || data?.data?.extract || {};
  return {
    page_kind: j.page_kind || 'unknown',
    total_matched: j.total_matched || '',
    variants: Array.isArray(j.variants) ? j.variants : [],
    filings: Array.isArray(j.filings) ? j.filings : [],
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

function mmddyyyy(date) { return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`; }
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
