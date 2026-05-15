// Apollo.io enrichment — two-step flow.
//
// Step 1: /mixed_people/api_search with q_organization_name → finds the best-fit
//         person at that org. This endpoint returns ONLY obfuscated data
//         (first_name, last_name_obfuscated, title, has_email boolean) — no
//         actual email or phone. By design — Apollo gates contact data behind
//         the enrichment endpoint as of their 2024 API rework.
//
// Step 2 (only if revealEmail/revealPhone): /people/match with the person's id
//         + reveal_personal_emails:true → unlocked first/last name + email.
//         Costs 1 email credit per unlock on Apollo's plan.
//
// IMPORTANT: reveal_phone_number on /people/match is ASYNCHRONOUS — it
// requires a webhook_url parameter and Apollo POSTs the phone to that URL
// minutes later. We don't have a webhook receiver yet, so phone reveal is
// not wired up. The revealPhone request flag is accepted but ignored.
//
// Apollo docs:
//   https://docs.apollo.io/reference/people-api-search
//   https://docs.apollo.io/reference/people-enrichment
//
// Auth: X-Api-Key header. Get a key at https://app.apollo.io/#/settings/integrations/api
// Required Netlify env var: APOLLO_API_KEY

const APOLLO_PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const APOLLO_PEOPLE_MATCH  = 'https://api.apollo.io/api/v1/people/match';

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

  // Reveal flags. Email = synchronous (~1 credit per unlock on Apollo plan).
  // Phone = ignored for now — Apollo's reveal_phone_number is async via
  // webhook, which we don't have wired up yet. Pass-through left in place
  // so the UI toggle keeps working when we add a webhook receiver.
  const revealEmail = body.revealEmail !== false;
  const revealPhone = false; // body.revealPhone — disabled, see header note

  // Strip common LLC/INC/CORP suffixes — Apollo's name match works better
  // against the bare brand than against the legal entity form.
  const searchName = businessName
    .replace(/[,.]/g, '')
    .replace(/\s+(LLC|INC\.?|CORP\.?|CORPORATION|L\.L\.C\.?|L\.P\.?|LP|LLP|CO\.?)$/i, '')
    .trim();

  const t0 = Date.now();
  console.log(`[apollo] search businessName="${businessName}" searchName="${searchName}" revealEmail=${revealEmail} revealPhone=${revealPhone}`);

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
        // Search endpoint ignores reveal_* flags — those are documented only
        // on /people/match. Don't waste them here.
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
  let owner = sorted[0];
  const org = owner.organization || {};

  // Apollo's search endpoint silently ignores reveal_personal_emails and
  // reveal_phone_number — those flags are only honored on /people/match.
  // So if reveal is requested, fire a second call against the matched
  // person's id. Costs ~1 extra credit per unlock; requires API access
  // tier on the Apollo account.
  let matchData = null;
  if ((revealEmail || revealPhone) && owner.id) {
    try {
      const mres = await fetch(APOLLO_PEOPLE_MATCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          id: owner.id,
          reveal_personal_emails: revealEmail,
          reveal_phone_number: revealPhone,
        }),
      });
      const mraw = await mres.text();
      try { matchData = JSON.parse(mraw); } catch { matchData = null; }
      if (!mres.ok) {
        console.error(`[apollo] /people/match HTTP ${mres.status} for id=${owner.id}: ${mraw.slice(0, 200)}`);
      } else if (matchData?.person) {
        // Merge unlocked fields onto the search result. Keep the search
        // record's title/org for context.
        owner = { ...owner, ...matchData.person };
        console.log(`[apollo] unlocked id=${owner.id}: hasEmail=${!!pickEmail(owner)}, hasPhone=${!!(owner.phone_numbers?.length || owner.mobile_phone)}`);
      }
    } catch (err) {
      console.error(`[apollo] /people/match threw for id=${owner.id}: ${err.message}`);
    }
  }

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
      // When reveal_personal_emails=true, Apollo returns unlocked addresses
      // in `personal_emails`. The plain `email` field is often a locked
      // placeholder like `email_not_unlocked@domain.com` — filter that out.
      email: pickEmail(owner),
      personal_emails: Array.isArray(owner.personal_emails) ? owner.personal_emails : [],
      // Phone fields only populate when reveal_phone_number=true.
      phone:
        owner.phone_numbers?.[0]?.sanitized_number ||
        owner.phone_numbers?.[0]?.raw_number ||
        owner.phone || '',
      mobile_phone: owner.mobile_phone || '',
      linkedin_url: owner.linkedin_url || '',
      city: owner.city || '',
      state: owner.state || '',
    },
    revealed: { email: revealEmail, phone: revealPhone },
    matchCount: people.length,
    searchedName: searchName,
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Pick the best email from an Apollo person record. `personal_emails` (when
// reveal_personal_emails=true) is most reliable; `email` is often a locked
// placeholder `email_not_unlocked@domain.com` we want to skip.
function pickEmail(p) {
  const personal = Array.isArray(p.personal_emails) ? p.personal_emails.filter(Boolean) : [];
  if (personal.length) return personal[0];
  const e = p.email || '';
  if (!e || /email_not_unlocked|domain\.com$|locked/i.test(e)) return '';
  return e;
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
