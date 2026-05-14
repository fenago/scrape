// Submit a batch of FL UCC search URLs to Firecrawl's async batch/scrape endpoint.
// Returns a job ID instantly (well under Netlify's 10s sync timeout). The client
// then polls /api/scrape-status?id=<jobId> to retrieve results as they complete.

const FIRECRAWL_BATCH = 'https://api.firecrawl.dev/v1/batch/scrape';

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      description: 'Every UCC filing row visible in the result table, sorted newest first.',
      items: {
        type: 'object',
        properties: {
          debtor_name: { type: 'string' },
          file_number: { type: 'string' },
          filing_date: { type: 'string', description: 'MM/DD/YYYY' },
          filing_type: { type: 'string' },
          secured_party: { type: 'string' },
          address: { type: 'string' },
        },
      },
    },
    filings_completed_through: { type: 'string' },
  },
};

const SEARCH_TYPE_MAP = {
  debtor: { searchOptionType: 'OrganizationDebtorName', searchOptionSubOption: 'FiledCompactDebtorNameList' },
  lender: { searchOptionType: 'SecuredPartyName',       searchOptionSubOption: 'FiledCompactSecuredPartyNameList' },
};

const PREFIXES_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return json(500, { error: 'FIRECRAWL_API_KEY env var is not set.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const searchType = SEARCH_TYPE_MAP[body.searchType] ? body.searchType : 'debtor';
  const matchMode = body.matchMode === 'Exact' ? 'Exact' : 'BeginsWith';

  // Build query list: explicit `prefixes` array, or `sweep: true` for A-Z + 0-9,
  // or `customNames` for free-form lender names / prefixes.
  let prefixes = [];
  if (Array.isArray(body.prefixes)) prefixes.push(...body.prefixes);
  if (body.sweep) prefixes.push(...PREFIXES_ALPHABET);
  if (Array.isArray(body.customNames)) prefixes.push(...body.customNames);
  prefixes = [...new Set(prefixes.map(p => (p || '').trim()).filter(Boolean))];

  // Hard cap on number of queries to limit Firecrawl spend.
  const maxQueries = clamp(parseInt(body.maxQueries, 10) || 36, 1, 50);
  if (prefixes.length > maxQueries) prefixes = prefixes.slice(0, maxQueries);
  if (!prefixes.length) return json(400, { error: 'No prefixes provided' });

  const cfg = SEARCH_TYPE_MAP[searchType];
  const urls = prefixes.map(p =>
    `https://floridaucc.com/search` +
    `?text=${encodeURIComponent(p)}` +
    `&searchOptionType=${cfg.searchOptionType}` +
    `&searchOptionSubOption=${cfg.searchOptionSubOption}` +
    `&searchCategory=${matchMode}`
  );

  const payload = {
    urls,
    formats: ['json'],
    jsonOptions: {
      schema: LEAD_SCHEMA,
      prompt:
        'Extract every visible UCC filing row from the results list. Each row should ' +
        'have debtor name, file number, filing date (MM/DD/YYYY), filing type, secured ' +
        'party, and address if shown. Also capture the "UCC Filings Completed Through" ' +
        'header date. If only the search form or a Terms of Use modal is visible (no ' +
        'result rows), return an empty leads array.',
    },
    onlyMainContent: false,
    waitFor: 3000,
    timeout: 90000,
    actions: [
      { type: 'wait', milliseconds: 2500 },
      { type: 'click', selector: 'input[type="checkbox"]' },
      { type: 'wait', milliseconds: 500 },
      { type: 'click', selector: 'button.MuiButton-contained' },
      { type: 'wait', milliseconds: 5000 },
    ],
  };

  let res;
  try {
    res = await fetch(FIRECRAWL_BATCH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(502, { error: `Firecrawl request failed: ${err.message}` });
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    return json(502, { error: 'Firecrawl returned non-JSON response', body: raw.slice(0, 500) });
  }

  if (!res.ok || data.success === false) {
    return json(res.status || 502, {
      error: data.error || data.message || 'Firecrawl returned an error',
      firecrawl_status: res.status,
      firecrawl_details: data,
    });
  }

  return json(200, {
    jobId: data.id,
    statusUrl: data.url,
    totalQueries: prefixes.length,
    prefixes,
    searchType,
    matchMode,
  });
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
