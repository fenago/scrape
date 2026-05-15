// Hunter.io enrichment — turns {first_name, last_name, domain} into a
// business email address. Optionally verifies deliverability.
//
// Endpoints used:
//   - Email Finder:    GET /v2/email-finder?domain=&first_name=&last_name=&api_key=
//   - Email Verifier:  GET /v2/email-verifier?email=&api_key=    (only if verify=true)
//   - Domain Search:   GET /v2/domain-search?domain=&api_key=    (fallback when finder misses)
//
// Docs: https://hunter.io/api-documentation/v2
// Auth: api_key query param.
// Required Netlify env var: HUNTER_API_KEY
//
// Cost on Hunter's plan:
//   - Email Finder: 1 request (counts against monthly quota)
//   - Email Verifier: 1 request (separate quota or same depending on plan)

const HUNTER_BASE = 'https://api.hunter.io/v2';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return json(500, { error: 'HUNTER_API_KEY env var is not set on Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  const rawDomain = (body.domain || '').trim();
  const verify = body.verify === true;

  if (!rawDomain) {
    return json(200, { status: 'skipped', reason: 'No company domain available — Hunter needs a domain to find emails' });
  }
  if (!firstName && !lastName) {
    return json(200, { status: 'skipped', reason: 'No first/last name available — Hunter needs at least one to target an email' });
  }

  // Normalize domain: strip protocol, www., trailing slash, query string.
  const domain = rawDomain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[\/?#]/)[0]
    .toLowerCase()
    .trim();
  if (!domain || !domain.includes('.')) {
    return json(200, { status: 'skipped', reason: `Domain "${rawDomain}" did not parse to a valid host` });
  }

  const t0 = Date.now();
  console.log(`[hunter] finder domain=${domain} name="${firstName} ${lastName}" verify=${verify}`);

  // Step 1: email-finder
  const finderUrl = new URL(`${HUNTER_BASE}/email-finder`);
  finderUrl.searchParams.set('domain', domain);
  if (firstName) finderUrl.searchParams.set('first_name', firstName);
  if (lastName) finderUrl.searchParams.set('last_name', lastName);
  finderUrl.searchParams.set('api_key', apiKey);

  let finderData;
  try {
    const res = await fetch(finderUrl.toString());
    finderData = await res.json();
    if (!res.ok) {
      const msg = finderData?.errors?.[0]?.details || `Hunter HTTP ${res.status}`;
      console.error(`[hunter] finder HTTP ${res.status} for ${domain}: ${msg}`);
      return json(200, { status: 'error', error: msg, httpStatus: res.status });
    }
  } catch (err) {
    console.error(`[hunter] finder threw: ${err.message}`);
    return json(502, { status: 'error', error: err.message });
  }

  const email = finderData?.data?.email || '';
  const score = finderData?.data?.score ?? null;
  const position = finderData?.data?.position || '';
  const company = finderData?.data?.company || '';

  // If email-finder returned nothing usable, try domain-search as a fallback —
  // gives the user the company's email pattern + a list of other contacts there.
  if (!email) {
    console.log(`[hunter] finder returned no email for ${domain}, trying domain-search fallback`);
    const searchUrl = new URL(`${HUNTER_BASE}/domain-search`);
    searchUrl.searchParams.set('domain', domain);
    searchUrl.searchParams.set('limit', '5');
    searchUrl.searchParams.set('api_key', apiKey);
    try {
      const sres = await fetch(searchUrl.toString());
      const sdata = await sres.json();
      if (sres.ok) {
        return json(200, {
          status: 'no_match',
          message: `Hunter could not match "${firstName} ${lastName}" at ${domain}, but the domain has ${sdata?.data?.emails?.length || 0} known contacts`,
          domain,
          pattern: sdata?.data?.pattern || '',
          organization: sdata?.data?.organization || '',
          sampleEmails: (sdata?.data?.emails || []).slice(0, 3).map(e => ({
            email: e.value, first_name: e.first_name, last_name: e.last_name, position: e.position, confidence: e.confidence,
          })),
        });
      }
    } catch (err) {
      console.error(`[hunter] domain-search fallback threw: ${err.message}`);
    }
    return json(200, { status: 'no_match', message: `Hunter could not match "${firstName} ${lastName}" at ${domain}`, domain });
  }

  // Step 2 (optional): verify the email is actually deliverable.
  let verification = null;
  if (verify && email) {
    const vUrl = new URL(`${HUNTER_BASE}/email-verifier`);
    vUrl.searchParams.set('email', email);
    vUrl.searchParams.set('api_key', apiKey);
    try {
      const vres = await fetch(vUrl.toString());
      const vdata = await vres.json();
      if (vres.ok) {
        verification = {
          status: vdata?.data?.status || '',           // 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown'
          result: vdata?.data?.result || '',           // 'deliverable' | 'undeliverable' | 'risky' | 'unknown'
          score: vdata?.data?.score ?? null,
          regexp: vdata?.data?.regexp,
          gibberish: vdata?.data?.gibberish,
          disposable: vdata?.data?.disposable,
          mx_records: vdata?.data?.mx_records,
          smtp_check: vdata?.data?.smtp_check,
        };
        console.log(`[hunter] verified ${email}: ${verification.result} (${verification.score})`);
      }
    } catch (err) {
      console.error(`[hunter] verifier threw: ${err.message}`);
    }
  }

  console.log(`[hunter] found ${email} score=${score} (${Date.now() - t0}ms)`);
  return json(200, {
    status: 'ok',
    email,
    score,                                              // 0–100 confidence
    position,
    company,
    domain,
    verification,                                       // null if verify was off
    sources: finderData?.data?.sources?.slice(0, 3) || [],
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
