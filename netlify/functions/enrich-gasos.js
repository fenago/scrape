// Georgia Secretary of State business enrichment.
//
// Path: search /BusinessSearch by business name → results table has
// business + registered agent + principal address on a single page.
// One Firecrawl scrape per business; results parsed deterministically from
// the rawHtml `<table id="grid_businessList">`.
//
// What you get:
//   - Business name, control number, type, status
//   - Principal office address
//   - Registered agent name (often the owner for small LLCs)
//   - first/last name split for downstream skip-tracing (BatchData)
//
// What you DON'T get from this page: officer/member/manager names. Those
// live inside Annual Registration PDFs which we'd have to download + parse
// — out of scope for v1.
//
// Required Netlify env var: FIRECRAWL_API_KEY

const FIRECRAWL_SCRAPE = 'https://api.firecrawl.dev/v1/scrape';
const GASOS_SEARCH = 'https://ecorp.sos.ga.gov/BusinessSearch';

// Names that mean "this is a corporate registered-agent service, not the
// actual owner". Match case-insensitively against the agent name string.
const CRA_NAME_PATTERNS = [
  /registered\s+agents?\s+(inc|llc)/i,
  /northwest\s+registered\s+agent/i,
  /harbor\s+compliance/i,
  /incfile/i,
  /legalzoom/i,
  /\bct\s+corporation/i,
  /corporation\s+service\s+company/i,
  /\bcsc\b/i,
  /national\s+registered\s+agents/i,
  /united\s+states\s+corporation\s+agents/i,
  /paracorp/i,
  /the\s+corporation\s+company/i,
  /capitol\s+(corporate|services)/i,
  /cogency\s+global/i,
  /\binc\.?$/i,
  /,\s*(inc|llc|corp|p\.?c\.?)\.?$/i,
];

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!fcKey) return json(500, { error: 'FIRECRAWL_API_KEY env var not set on Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const businessName = (body.businessName || '').trim();
  if (!businessName) return json(400, { error: 'businessName is required' });

  // Strip the legal-form suffix. GA SoS stores the full legal name, but
  // "Contains" search matches better against the brand portion.
  const searchName = businessName
    .replace(/[.]/g, '')
    .replace(/,\s*(LLC|INC|CORP|CORPORATION|L\.L\.C|L\.P|LP|LLP|CO|PC|P\.C)\.?$/i, '')
    .trim();

  const t0 = Date.now();
  console.log(`[gasos] search businessName="${businessName}" searchName="${searchName}"`);

  // Drive the existing $.submitForm helper on the page. SearchCriteria=Contains
  // is forgiving for variations in spacing/punctuation (e.g. "Black Water" vs
  // "BlackWater"). The page does a real form POST and navigates to the
  // results page (same URL, different content).
  const submitSearchJs =
    `$.submitForm('/BusinessSearch', { search: { ` +
      `SearchType: 'BusinessName', ` +
      `SearchValue: ${JSON.stringify(searchName)}, ` +
      `SearchCriteria: 'Contains' ` +
    `} });`;

  const payload = {
    url: GASOS_SEARCH,
    formats: ['rawHtml'],
    onlyMainContent: false,
    waitFor: 1500,
    timeout: 60000,
    actions: [
      { type: 'wait', milliseconds: 1500 },
      { type: 'executeJavascript', script: submitSearchJs },
      { type: 'wait', milliseconds: 4500 },
    ],
  };

  let res;
  try {
    res = await fetch(FIRECRAWL_SCRAPE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fcKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[gasos] firecrawl fetch threw for "${searchName}": ${err.message}`);
    return json(502, { status: 'error', error: `Firecrawl request failed: ${err.message}`, searchedName: searchName });
  }

  const raw = await res.text();
  let fcData;
  try { fcData = JSON.parse(raw); } catch {
    console.error(`[gasos] firecrawl non-JSON for "${searchName}" (HTTP ${res.status})`);
    return json(502, { status: 'error', error: `Firecrawl returned non-JSON (HTTP ${res.status})`, body: raw.slice(0, 300), searchedName: searchName });
  }
  if (!res.ok || fcData.success === false) {
    console.error(`[gasos] firecrawl error for "${searchName}": ${fcData.error || fcData.message}`);
    return json(200, {
      status: 'error',
      error: fcData.error || fcData.message || `Firecrawl HTTP ${res.status}`,
      searchedName: searchName,
    });
  }

  const html = fcData.data?.rawHtml || fcData.rawHtml || '';
  if (!html) {
    return json(200, { status: 'error', error: 'No HTML returned from Firecrawl', searchedName: searchName });
  }

  const rows = parseResultsTable(html);
  console.log(`[gasos] "${searchName}" → ${rows.length} rows, ${Date.now() - t0}ms`);

  if (!rows.length) {
    return json(200, {
      status: 'no_match',
      message: `GA SoS has no business records matching "${searchName}".`,
      searchedName: searchName,
    });
  }

  // Prefer active entities. Among those, prefer the closest name match so we
  // don't accidentally pick an unrelated business sharing a substring.
  const active = rows.filter(r => /active/i.test(r.status));
  const candidates = (active.length ? active : rows).map(r => ({
    ...r,
    nameDistance: nameDistance(searchName, r.businessName),
  })).sort((a, b) => a.nameDistance - b.nameDistance);
  const pick = candidates[0];

  const agent = parseAgentName(pick.agentName);

  return json(200, {
    status: 'ok',
    business: {
      name: pick.businessName,
      controlNumber: pick.controlNumber,
      type: pick.type,
      status: pick.status,
      principal_address: pick.principalAddress,
      businessId: pick.businessId,
      detail_url: pick.detailUrl ? `https://ecorp.sos.ga.gov${pick.detailUrl}` : '',
    },
    registered_agent: {
      full_name: pick.agentName,
      first_name: agent.first,
      last_name: agent.last,
      likely_commercial: agent.likelyCommercial,
    },
    searchedName: searchName,
    matchCount: rows.length,
    activeCount: active.length,
    // Surface alternates so the user can see other potential matches.
    alternates: candidates.slice(1, 4).map(c => ({
      name: c.businessName,
      status: c.status,
      controlNumber: c.controlNumber,
      agent: c.agentName,
    })),
  });
}

// --- HTML parsing helpers (no external deps; same approach as scrape-poll.js) ---

function parseResultsTable(html) {
  // Find the businessList table.
  const tableMatch = html.match(/<table[^>]*id=["']grid_businessList["'][\s\S]*?<\/table>/i);
  if (!tableMatch) return [];
  const tableHtml = tableMatch[0];
  const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return [];

  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(tbodyMatch[1])) !== null) {
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let c;
    while ((c = cellRegex.exec(m[1])) !== null) cells.push(c[1]);
    if (cells.length < 6) continue;

    const linkMatch = cells[0].match(/<a[^>]*href=["']([^"']*businessId=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    rows.push({
      businessName: stripTags(linkMatch ? linkMatch[3] : cells[0]),
      businessId: linkMatch ? linkMatch[2] : '',
      detailUrl: linkMatch ? decodeHtml(linkMatch[1]) : '',
      controlNumber: stripTags(cells[1]),
      type: stripTags(cells[2]),
      principalAddress: stripTags(cells[3]),
      agentName: stripTags(cells[4]),
      status: stripTags(cells[5]),
    });
  }
  return rows;
}

function stripTags(s) {
  return decodeHtml((s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(s) {
  return (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Crude name-distance: number of words in the search name NOT present (as a
// case-insensitive substring) in the candidate business name. Lower = closer.
function nameDistance(search, candidate) {
  const candNorm = (candidate || '').toLowerCase();
  const words = (search || '').toLowerCase().split(/\s+/).filter(Boolean);
  let missing = 0;
  for (const w of words) if (!candNorm.includes(w)) missing++;
  return missing;
}

// Parse a registered-agent name string. Returns first/last and a flag if it
// looks like a commercial registered-agent SERVICE rather than a real person.
function parseAgentName(fullName) {
  if (!fullName) return { first: '', last: '', likelyCommercial: false };
  const trimmed = fullName.trim();
  const likelyCommercial = CRA_NAME_PATTERNS.some(re => re.test(trimmed));
  if (likelyCommercial) return { first: '', last: '', likelyCommercial: true };

  // Strip generational suffixes (JR/SR/II/III) and trailing punctuation.
  const cleaned = trimmed
    .replace(/[,.](?:\s*(JR|SR|II|III|IV))?\s*$/i, '')
    .replace(/\s+(JR|SR|II|III|IV)\.?\s*$/i, '')
    .replace(/[.,]/g, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] || '', last: '', likelyCommercial: false };
  const first = parts[0];
  const last = parts[parts.length - 1];
  return { first, last, likelyCommercial: false };
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
