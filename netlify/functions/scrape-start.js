// Submit one Firecrawl batch scrape job.
//
// Two modes:
//   mode='variants'  → login + search, stop on the variants page
//                      (returns the list of secured-party name variants)
//   mode='drill'     → login + search + click a SPECIFIC variant by name,
//                      stop on the filings page (returns the actual debtors)
//
// Client orchestrates: scrape variants for each lender, then scrape drill
// for each variant. This decomposition means:
//   - Each Firecrawl job is much smaller (<60s) — no 180s wall
//   - Every variant gets drilled (no missed leads from "drill the biggest")
//   - One variant failing doesn't kill the whole lender
//
// Required Netlify env vars: FIRECRAWL_API_KEY, GSCCCA_USER, GSCCCA_PASS

const FIRECRAWL_BATCH = 'https://api.firecrawl.dev/v1/batch/scrape';
const MAX_LOOKBACK_DAYS = 365;

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const fcKey = process.env.FIRECRAWL_API_KEY;
  const user = process.env.GSCCCA_USER;
  const pass = process.env.GSCCCA_PASS;
  if (!fcKey) return json(500, { error: 'FIRECRAWL_API_KEY env var not set' });
  if (!user || !pass) return json(500, { error: 'GSCCCA_USER / GSCCCA_PASS env vars not set' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const mode = body.mode === 'drill' ? 'drill' : 'variants';
  const lender = (body.lender || '').trim();
  const variantName = (body.variantName || '').trim();
  if (!lender) return json(400, { error: 'lender is required' });
  if (mode === 'drill' && !variantName) return json(400, { error: 'variantName is required when mode=drill' });

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

  // Drill into the variant whose SECURED PARTY NAME column matches the
  // requested name exactly. Falls back to largest-instrument variant if
  // no exact name match (defensive).
  const drillByNameJs = (
    `(function(){` +
      `const target=${JSON.stringify(variantName)};` +
      "let exactRow=null,bestRow=null,bestCount=-1;" +
      "document.querySelectorAll('table tr').forEach(tr=>{" +
        "const cells=tr.querySelectorAll('td');" +
        "if(cells.length>=3&&cells[0].querySelector('input[type=radio]')){" +
          "const nameCell=cells[2]?cells[2].textContent.trim().replace(/\\s+/g,' '):'';" +
          "const count=parseInt((cells[1].textContent||'').replace(/,/g,'').trim(),10);" +
          "if(nameCell===target)exactRow=tr;" +
          "if(!isNaN(count)&&count>bestCount){bestCount=count;bestRow=tr;}" +
        "}" +
      "});" +
      "const row=exactRow||bestRow;" +
      "if(row){" +
        "const radio=row.querySelector('input[type=radio]');" +
        "if(radio)radio.checked=true;" +
        "const btn=Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]'))" +
          ".find(b=>((b.textContent||'')+(b.value||'')).toLowerCase().includes('display details'));" +
        "if(btn)btn.click();" +
      "}" +
    "})();"
  );

  const baseActions = [
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
    { type: 'wait', milliseconds: 5000 },  // wait for variants page to render
  ];

  const actions = mode === 'drill'
    ? [
        ...baseActions,
        { type: 'executeJavascript', script: drillByNameJs },
        { type: 'wait', milliseconds: 5000 },  // wait for filings page
      ]
    : baseActions;  // variants mode stops here

  const payload = {
    urls: ['https://apps.gsccca.org/login.asp'],
    formats: ['markdown'],
    onlyMainContent: false,
    waitFor: 1000,
    timeout: 90000,
    actions,
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
    mode,
    lender,
    variantName: variantName || null,
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
