// Netlify Function: scrape Florida UCC search results via Firecrawl.
//
// Florida UCC (floridaucc.com) gates search behind a disclaimer page and uses
// ASP.NET WebForms postbacks. The right Firecrawl mode for this is /v1/scrape
// with `actions` (to click "Accept" + fill + submit) and a structured
// `formats: ['json']` schema so we get parsed rows back instead of raw HTML.

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';
const START_URL = 'https://www.floridaucc.com/uccweb/SearchDisclaimer.aspx';

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      description: 'Each row from the UCC search results table.',
      items: {
        type: 'object',
        properties: {
          debtor_name: { type: 'string', description: 'Debtor name (business or individual).' },
          file_number: { type: 'string', description: 'UCC file/document number.' },
          filing_date: { type: 'string', description: 'Date the UCC was filed (MM/DD/YYYY).' },
          secured_party: { type: 'string', description: 'Secured party / creditor name.' },
          address: { type: 'string', description: 'Debtor address if shown in result row or detail.' },
        },
        required: ['debtor_name'],
      },
    },
  },
  required: ['leads'],
};

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'FIRECRAWL_API_KEY env var is not set.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const debtorName = (body.debtorName || '').trim();
  const searchType = body.searchType === 'Individual' ? 'Individual' : 'Organization';
  if (!debtorName) return json(400, { error: 'debtorName is required' });

  const payload = {
    url: START_URL,
    formats: [
      'markdown',
      {
        type: 'json',
        schema: LEAD_SCHEMA,
        prompt:
          'Extract every row from the Florida UCC search results table. ' +
          'For each row capture the debtor name, file/document number, filing date, ' +
          'secured party, and any address shown. If no results are present, return an empty array.',
      },
    ],
    onlyMainContent: false,
    waitFor: 1500,
    timeout: 60000,
    actions: [
      // Accept the disclaimer.
      { type: 'wait', milliseconds: 1500 },
      { type: 'click', selector: 'input[type=submit][value*="Accept" i], input[id*="Accept" i], button:has-text("Accept")' },
      { type: 'wait', milliseconds: 2500 },
      // Choose Organization vs Individual radio if present.
      {
        type: 'click',
        selector:
          searchType === 'Individual'
            ? 'input[type=radio][value*="Individual" i], label:has-text("Individual") input[type=radio]'
            : 'input[type=radio][value*="Organization" i], label:has-text("Organization") input[type=radio]',
      },
      { type: 'wait', milliseconds: 500 },
      // Fill the debtor name field. Florida's field id varies; we try a few likely matches.
      {
        type: 'write',
        selector:
          'input[id*="DebtorName" i], input[id*="OrgName" i], input[name*="Debtor" i], input[type=text]',
        text: debtorName,
      },
      { type: 'wait', milliseconds: 500 },
      // Submit search.
      { type: 'click', selector: 'input[type=submit][value*="Search" i], button:has-text("Search")' },
      { type: 'wait', milliseconds: 4000 },
    ],
  };

  let firecrawlRes;
  try {
    firecrawlRes = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(502, { error: `Firecrawl request failed: ${err.message}` });
  }

  const data = await firecrawlRes.json().catch(() => ({}));
  if (!firecrawlRes.ok || data.success === false) {
    return json(firecrawlRes.status || 502, {
      error: data.error || data.message || 'Firecrawl returned an error',
      details: data,
    });
  }

  const leads = data?.data?.json?.leads || data?.data?.extract?.leads || [];

  return json(200, {
    leads,
    source: START_URL,
    debtorName,
    searchType,
  });
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
