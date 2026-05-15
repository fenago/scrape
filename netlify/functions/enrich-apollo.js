// Apollo.io enrichment via Mixed People Search.
//
// Apollo's /organizations/enrich endpoint REQUIRES a domain (not a name) and
// is for enriching an org you already know the domain of. For our use case
// (we have a debtor business NAME, not a domain), the right endpoint is
// /mixed_people/api_search with q_organization_name — one call returns both
// the org details and the matching people (owners/founders/CEOs).
//
// Note: Apollo deprecated /mixed_people/search for API callers in 2024 and
// replaced it with /mixed_people/api_search. Same payload shape.
//
// Apollo docs: https://docs.apollo.io/reference/people-api-search
// Auth: X-Api-Key header. Get a key at https://app.apollo.io/#/settings/integrations/api
// Required Netlify env var: APOLLO_API_KEY

const APOLLO_PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/api_search';

const OWNER_TITLES = [
  'founder', 'co-founder', 'cofounder', 'owner', 'co-owner', 'president',
  'ceo', 'chief executive', 'chief executive officer',
  'managing partner', 'managing director', 'managing member',
  'principal', 'proprietor', 'general manager',
];

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return json(500, { error: 'APOLLO_API_KEY env var is not set on Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const businessName = (body.businessName || '').trim();
  if (!businessName) return json(400, { error: 'businessName is required' });

  // Strip common LLC/INC/CORP suffixes — Apollo's name match works better
  // against the bare brand than against the legal entity form.
  const searchName = businessName
    .replace(/[,.]/g, '')
    .replace(/\s+(LLC|INC\.?|CORP\.?|CORPORATION|L\.L\.C\.?|L\.P\.?|LP|LLP|CO\.?)$/i, '')
    .trim();

  const t0 = Date.now();
  console.log(`[apollo] search businessName="${businessName}" searchName="${searchName}"`);

  let res;
  try {
    res = await fetch(APOLLO_PEOPLE_SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        q_organization_name: searchName,
        person_titles: OWNER_TITLES,
        page: 1,
        per_page: 10,
      }),
    });
  } catch (err) {
    console.error(`[apollo] fetch threw for "${searchName}": ${err.message}`);
    return json(502, { status: 'error', error: `Apollo request failed: ${err.message}`, searchedName: searchName });
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    console.error(`[apollo] non-JSON response for "${searchName}" (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    return json(502, { status: 'error', error: `Apollo returned non-JSON (HTTP ${res.status})`, body: raw.slice(0, 300), searchedName: searchName });
  }

  if (!res.ok) {
    const errMsg = stringifyApolloError(data) || `Apollo HTTP ${res.status}`;
    console.error(`[apollo] HTTP ${res.status} for "${searchName}": ${errMsg}`);
    return json(200, {
      status: 'apollo_error',
      httpStatus: res.status,
      error: errMsg,
      searchedName: searchName,
      raw: data,
    });
  }

  const people = data.people || data.contacts || [];
  const totalEntries = data.pagination?.total_entries ?? null;
  console.log(`[apollo] "${searchName}" → ${people.length} people, total_entries=${totalEntries}, ${Date.now() - t0}ms`);
  if (!people.length) {
    return json(200, {
      status: 'no_match',
      message: `Apollo has no owner/founder/CEO contacts for any organization named "${searchName}". Common for small LLCs not indexed in Apollo.`,
      searchedName: searchName,
      pagination: data.pagination || null,
    });
  }

  // Score and pick the best-fit owner. Founder/owner > president/principal > CEO.
  const score = p => {
    const t = (p.title || '').toLowerCase();
    if (/founder|co-?founder/.test(t)) return 5;
    if (/owner|proprietor/.test(t)) return 4;
    if (/president/.test(t)) return 3;
    if (/managing\s+(partner|director|member)/.test(t)) return 3;
    if (/principal/.test(t)) return 2;
    if (/ceo|chief\s+executive/.test(t)) return 2;
    return 1;
  };
  const sorted = [...people].sort((a, b) => score(b) - score(a));
  const owner = sorted[0];
  const org = owner.organization || {};

  return json(200, {
    status: 'ok',
    business: {
      name: org.name || businessName,
      phone: org.primary_phone?.number || org.phone || org.sanitized_phone || '',
      website: org.website_url || org.primary_domain || '',
      industry: org.industry || '',
      employees: org.estimated_num_employees || null,
      city: org.city || '',
      state: org.state || '',
      linkedin_url: org.linkedin_url || '',
      founded_year: org.founded_year || null,
    },
    owner: {
      first_name: owner.first_name || '',
      last_name: owner.last_name || '',
      full_name: owner.name || `${owner.first_name || ''} ${owner.last_name || ''}`.trim(),
      title: owner.title || '',
      email: owner.email || '',
      phone:
        owner.phone_numbers?.[0]?.sanitized_number ||
        owner.phone_numbers?.[0]?.raw_number ||
        owner.phone || '',
      linkedin_url: owner.linkedin_url || '',
      city: owner.city || '',
      state: owner.state || '',
    },
    matchCount: people.length,
    searchedName: searchName,
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Apollo's error shape varies: { error: "..." }, { message: "..." },
// { errors: ["..."] }, or { errors: [{ message: "..." }] }. Flatten to a string.
function stringifyApolloError(data) {
  if (!data) return '';
  if (typeof data.error === 'string') return data.error;
  if (typeof data.message === 'string') return data.message;
  if (Array.isArray(data.errors)) {
    return data.errors.map(e => typeof e === 'string' ? e : (e?.message || JSON.stringify(e))).join('; ');
  }
  if (typeof data.errors === 'string') return data.errors;
  return '';
}
