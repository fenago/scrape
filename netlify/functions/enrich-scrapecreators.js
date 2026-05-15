// ScrapeCreators enrichment — uses their Google Search endpoint to find:
//   1. The company's actual website domain (so Hunter has something to query).
//   2. The person's LinkedIn URL (so the user has outreach surface area).
// Optionally fetches the full LinkedIn profile.
//
// Endpoints used:
//   - Google Search:    GET /v1/google/search?query=
//   - LinkedIn Profile: GET /v1/linkedin/profile?url=        (only if fetchProfile=true)
//
// Docs: https://docs.scrapecreators.com/
// Auth: x-api-key header.
// Required Netlify env var: SCRAPECREATORS_API_KEY
//
// Cost: 1 credit per Google search request, plus 1 per LinkedIn profile fetch.

const SC_BASE = 'https://api.scrapecreators.com';

// Domains that show up in Google results but are NOT the company's own site.
// Filter these out when deriving the company domain from a search.
const DOMAIN_BLACKLIST = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'yelp.com', 'bbb.org', 'mapquest.com', 'yellowpages.com', 'manta.com',
  'bizapedia.com', 'opencorporates.com', 'buzzfile.com', 'dnb.com', 'zoominfo.com',
  'apollo.io', 'crunchbase.com', 'glassdoor.com', 'indeed.com', 'ziprecruiter.com',
  'google.com', 'bing.com', 'wikipedia.org', 'amazon.com', 'ebay.com',
]);

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) return json(500, { error: 'SCRAPECREATORS_API_KEY env var is not set on Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const companyName = (body.companyName || '').trim();
  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  const knownDomain = (body.knownDomain || '').trim();
  const findDomain = body.findDomain !== false;     // default on
  const findLinkedIn = body.findLinkedIn !== false; // default on
  const fetchProfile = body.fetchProfile === true;  // default off (extra credit)

  if (!companyName) return json(400, { error: 'companyName is required' });

  const result = {
    status: 'ok',
    domain: knownDomain || '',
    domainSource: knownDomain ? 'provided' : '',
    linkedin_url: '',
    linkedin_title: '',
    linkedin_snippet: '',
    profile: null,
    credits_used: 0,
    skips: [],
  };

  // Strip entity suffixes for cleaner Google queries.
  const bareName = companyName
    .replace(/[,.]/g, '')
    .replace(/\s+(LLC|INC\.?|CORP\.?|CORPORATION|L\.L\.C\.?|L\.P\.?|LP|LLP|CO\.?|PC|P\.C\.?)$/i, '')
    .trim();

  // -------- 1. Find company domain (if not already known) --------
  if (findDomain && !knownDomain) {
    try {
      const query = `"${bareName}" official site`;
      const data = await scGet('/v1/google/search', { query }, apiKey);
      result.credits_used += 1;
      const results = data?.results || [];
      // Find the first result whose host is NOT a blacklisted aggregator.
      for (const r of results) {
        const host = hostOf(r.url);
        if (!host) continue;
        const rootDomain = rootOf(host);
        if (DOMAIN_BLACKLIST.has(rootDomain)) continue;
        result.domain = rootDomain;
        result.domainSource = 'google-search';
        console.log(`[sc] domain for "${bareName}" → ${rootDomain}`);
        break;
      }
      if (!result.domain) result.skips.push('domain-search: no non-aggregator result');
    } catch (err) {
      console.error(`[sc] domain search threw: ${err.message}`);
      result.skips.push(`domain-search: ${err.message}`);
    }
  }

  // -------- 2. Find LinkedIn URL --------
  if (findLinkedIn && (firstName || lastName)) {
    try {
      // Quoted name + quoted company increases precision dramatically.
      const fullName = [firstName, lastName].filter(Boolean).join(' ');
      const query = `site:linkedin.com/in "${fullName}" "${bareName}"`;
      const data = await scGet('/v1/google/search', { query }, apiKey);
      result.credits_used += 1;
      const results = data?.results || [];
      const liHit = results.find(r => /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(r.url || ''));
      if (liHit) {
        result.linkedin_url = canonicalLi(liHit.url);
        result.linkedin_title = liHit.title || '';
        result.linkedin_snippet = liHit.description || '';
        console.log(`[sc] linkedin for "${fullName}" @ "${bareName}" → ${result.linkedin_url}`);
      } else {
        result.skips.push('linkedin-search: no linkedin.com/in/ result');
      }
    } catch (err) {
      console.error(`[sc] linkedin search threw: ${err.message}`);
      result.skips.push(`linkedin-search: ${err.message}`);
    }
  } else if (findLinkedIn) {
    result.skips.push('linkedin-search: no first/last name');
  }

  // -------- 3. Fetch full LinkedIn profile (optional, extra credit) --------
  if (fetchProfile && result.linkedin_url) {
    try {
      const data = await scGet('/v1/linkedin/profile', { url: result.linkedin_url }, apiKey);
      result.credits_used += 1;
      // ScrapeCreators returns the raw LinkedIn profile JSON shape; we pluck
      // the most useful bits and keep the rest in raw for the user to mine.
      result.profile = {
        headline: data?.headline || data?.profile?.headline || '',
        location: data?.location || data?.profile?.location || '',
        current_company: data?.current_company || data?.profile?.current_company || '',
        current_title: data?.current_title || data?.profile?.current_title || '',
        raw: data,
      };
      console.log(`[sc] profile fetched for ${result.linkedin_url}`);
    } catch (err) {
      console.error(`[sc] profile fetch threw: ${err.message}`);
      result.skips.push(`profile: ${err.message}`);
    }
  }

  return json(200, result);
}

// ----- helpers -----

async function scGet(path, params, apiKey) {
  const url = new URL(SC_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { 'x-api-key': apiKey } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`ScrapeCreators ${path} HTTP ${res.status}: ${(data?.error || data?._raw || '').toString().slice(0, 200)}`);
  return data;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// "ww1.foo.bar.example.com" → "example.com". Naive but adequate for our uses.
function rootOf(host) {
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  // Handle common 2-part TLDs (co.uk, com.au, etc.) — punt and assume the
  // last 3 labels if the second-to-last is short. Good enough for US LLCs.
  const last = parts.slice(-2).join('.');
  return last;
}

// Strip query/anchor, force https, lowercase the path. /in/john-doe/ → /in/john-doe
function canonicalLi(url) {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
