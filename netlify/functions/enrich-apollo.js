// Apollo.io enrichment: business name + state → business contact + owner identification.
//
// Two-step flow:
//   1. POST /api/v1/organizations/enrich       — find the org, get primary phone / website / industry
//   2. POST /api/v1/mixed_people/search        — find owner/founder/CEO at that org
//
// Apollo auth: X-Api-Key header. Get a key at https://app.apollo.io/#/settings/integrations/api
// Required Netlify env var: APOLLO_API_KEY

const APOLLO_ORG_ENRICH = 'https://api.apollo.io/api/v1/organizations/enrich';
const APOLLO_PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/search';

const OWNER_TITLES = [
  'founder', 'co-founder', 'cofounder', 'owner', 'co-owner', 'president',
  'ceo', 'chief executive', 'managing partner', 'managing director',
  'principal', 'proprietor',
];

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return json(500, { error: 'APOLLO_API_KEY env var is not set on Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const businessName = (body.businessName || '').trim();
  const state = (body.state || 'GA').trim();
  if (!businessName) return json(400, { error: 'businessName is required' });

  // Step 1: org enrich.
  let org;
  try {
    const res = await fetch(APOLLO_ORG_ENRICH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({ name: businessName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json(200, {
        status: 'org_enrich_failed',
        error: data.error || data.message || `Apollo HTTP ${res.status}`,
      });
    }
    org = data.organization || null;
  } catch (err) {
    return json(502, { status: 'error', error: `Apollo org request failed: ${err.message}` });
  }

  if (!org) {
    return json(200, { status: 'no_match', message: 'Apollo found no organization match.' });
  }

  // Step 2: search for owner/founder at this org.
  let owner = null;
  let peopleAttempted = false;
  if (org.id || org.organization_id) {
    peopleAttempted = true;
    try {
      const res = await fetch(APOLLO_PEOPLE_SEARCH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({
          organization_ids: [org.id || org.organization_id],
          person_titles: OWNER_TITLES,
          page: 1,
          per_page: 5,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const people = data.people || data.contacts || [];
        if (people.length) {
          // Prefer a founder/owner over CEO if both present.
          const score = p => {
            const t = (p.title || '').toLowerCase();
            if (/founder|owner|proprietor/.test(t)) return 3;
            if (/president|principal/.test(t)) return 2;
            if (/ceo|chief executive|managing/.test(t)) return 1;
            return 0;
          };
          people.sort((a, b) => score(b) - score(a));
          owner = people[0];
        }
      }
    } catch { /* non-fatal */ }
  }

  return json(200, {
    status: 'ok',
    business: {
      name: org.name || businessName,
      phone: org.primary_phone?.number || org.phone || '',
      website: org.website_url || org.primary_domain || '',
      industry: org.industry || '',
      employees: org.estimated_num_employees || null,
      city: org.city || '',
      state: org.state || '',
      linkedin_url: org.linkedin_url || '',
      founded_year: org.founded_year || null,
    },
    owner: owner ? {
      first_name: owner.first_name || '',
      last_name: owner.last_name || '',
      full_name: owner.name || `${owner.first_name || ''} ${owner.last_name || ''}`.trim(),
      title: owner.title || '',
      email: owner.email || '',
      phone: owner.phone_numbers?.[0]?.sanitized_number || owner.phone_numbers?.[0]?.raw_number || '',
      linkedin_url: owner.linkedin_url || '',
      city: owner.city || '',
      state: owner.state || '',
    } : null,
    peopleAttempted,
    creditsHint: peopleAttempted ? '~2 credits' : '~1 credit',
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
