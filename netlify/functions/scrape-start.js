// Async start endpoint: submits one lender's scrape job to Firecrawl's
// /v1/batch/scrape (async), returns the job ID instantly. Netlify Free's
// 10s sync timeout is no longer a concern because the heavy work happens
// on Firecrawl's infrastructure.
//
// The client calls this once per selected lender (sequential, to avoid
// concurrent GSCCCA logins), then polls /api/scrape-poll for results.

const FIRECRAWL_BATCH = 'https://api.firecrawl.dev/v1/batch/scrape';
const MAX_LOOKBACK_DAYS = 365;

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    page_kind: {
      type: 'string',
      description:
        '"filings" if rows are individual UCC filings (debtor/file/date columns); ' +
        '"variants" if rows are secured-party NAME variants with instrument counts; ' +
        '"none" if no items matching; "login" if bounced to login page; else "other".',
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
      description:
        'When the page shows individual UCC filings (after drilling into a variant) — ' +
        'GA columns are FILE NUMBER, DOCUMENT TYPE, DEBTOR NAME, DATE FILED, ORIGINAL FILE NUMBER.',
      items: {
        type: 'object',
        properties: {
          file_number:          { type: 'string', description: 'Like 007-2025-024314' },
          document_type:        { type: 'string', description: 'Original / Termination / Continuation / Amendment / etc.' },
          debtor_name:          { type: 'string', description: 'The actual business name (the lead).' },
          date_filed:           { type: 'string', description: 'Date filed text from the page.' },
          original_file_number: { type: 'string', description: 'For non-Original docs, the original file # referenced.' },
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

  // GA's variants page uses: radio button per row + a "Display Details"
  // button below the table. Verified live via Firecrawl interact session.
  // Clicking radio + Display Details navigates to occurrences.asp with the
  // selected variant's actual filings (debtor names, file numbers, etc.).
  const drillJs = (
    "(function(){" +
      "let bestRow=null,bestCount=-1;" +
      "document.querySelectorAll('table tr').forEach(tr=>{" +
        "const cells=tr.querySelectorAll('td');" +
        "if(cells.length>=3){" +
          "const n=parseInt((cells[1].textContent||'').replace(/,/g,'').trim(),10);" +
          "if(!isNaN(n)&&n>bestCount&&cells[0].querySelector('input[type=radio]')){" +
            "bestCount=n;bestRow=tr;" +
          "}" +
        "}" +
      "});" +
      "if(bestRow){" +
        "const radio=bestRow.querySelector('input[type=radio]');" +
        "if(radio)radio.checked=true;" +
        "const btn=Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]'))" +
          ".find(b=>((b.textContent||'')+(b.value||'')).toLowerCase().includes('display details'));" +
        "if(btn)btn.click();" +
      "}" +
    "})();"
  );

  const payload = {
    urls: ['https://apps.gsccca.org/login.asp'],
    formats: ['json'],
    jsonOptions: {
      schema: LEAD_SCHEMA,
      prompt:
        'GSCCCA Georgia UCC results page. Determine page_kind: ' +
        '"filings" if the table has columns FILE NUMBER, DOCUMENT TYPE, DEBTOR NAME, DATE FILED, ORIGINAL FILE NUMBER ' +
        '(this is the drilled-into page showing individual UCC filings); ' +
        '"variants" if columns are SELECT, INSTRUMENTS, SECURED PARTY NAME (the upper-level name-variants page); ' +
        '"none" if body contains "no items matching"; "login" if a login form is showing; else "other". ' +
        'For filings: extract every row\'s file_number (format like 007-YYYY-NNNNNN), document_type, debtor_name, date_filed, original_file_number. ' +
        'For variants: extract secured_party_name + instrument_count per row. ' +
        'Capture any "N Records Found" / "N Variations of the Name Found" text into total_matched.',
    },
    onlyMainContent: false,
    waitFor: 1000,
    timeout: 90000,
    actions: [
      { type: 'wait', milliseconds: 1000 },
      { type: 'executeJavascript', script:
        `document.frmLogin.txtUserID.value=${JSON.stringify(user)};` +
        `document.frmLogin.txtPassword.value=${JSON.stringify(pass)};` +
        "document.frmLogin.submit();"
      },
      { type: 'wait', milliseconds: 3000 },
      { type: 'executeJavascript', script:
        "window.location.href='https://search.gsccca.org/UCC_Search/search.asp?searchtype=SecuredParty';"
      },
      { type: 'wait', milliseconds: 3000 },
      { type: 'executeJavascript', script: fillSearchFormJs },
      { type: 'wait', milliseconds: 4500 },
      { type: 'executeJavascript', script: drillJs },
      { type: 'wait', milliseconds: 4500 },
    ],
  };

  let res;
  try {
    res = await fetch(FIRECRAWL_BATCH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fcKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(502, { error: `Firecrawl submit failed: ${err.message}` });
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    return json(502, { error: 'Firecrawl returned non-JSON', body: raw.slice(0, 300) });
  }
  if (!res.ok || data.success === false) {
    return json(res.status || 502, { error: data.error || data.message || 'Firecrawl error', firecrawl: data });
  }

  return json(200, {
    jobId: data.id,
    lender,
    params: { fromDate, toDate, maxrows, stemSearch },
    submittedAt: new Date().toISOString(),
  });
}

function mmddyyyy(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
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
