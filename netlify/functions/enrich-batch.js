// BatchSkipTracing (BatchData) enrichment: owner name + state → personal cell, email, address.
//
// BatchData API: https://api.batchdata.com
// Auth: Bearer token. Required Netlify env var: BATCHDATA_API_KEY
//
// Note: BatchData is residential/consumer-focused. To get useful results we
// need at minimum a first + last name (the BUSINESS OWNER, not the LLC).
// Typical chain: Apollo identifies the owner → BatchData skip-traces them.

const BATCH_SKIPTRACE = 'https://api.batchdata.com/api/v1/property/skip-trace';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.BATCHDATA_API_KEY;
  if (!apiKey) return json(500, { error: 'BATCHDATA_API_KEY env var is not set on Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  const state = (body.state || '').trim();
  const businessName = (body.businessName || '').trim();
  const city = (body.city || '').trim();
  const street = (body.street || '').trim();

  if (!firstName && !lastName && !businessName) {
    return json(400, { error: 'Provide at least firstName + lastName, or businessName' });
  }

  // BatchData skip-trace request payload. Their API accepts either property
  // address or person-name input. We send both when available — better match
  // rate. Schema is best-effort based on their public docs.
  const requests = [{
    propertyAddress: street && city ? { street, city, state, zip: '' } : undefined,
    name: {
      first: firstName || undefined,
      last: lastName || undefined,
      full: !firstName && !lastName ? businessName : undefined,
    },
  }];

  let res;
  try {
    res = await fetch(BATCH_SKIPTRACE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ requests }),
    });
  } catch (err) {
    return json(502, { status: 'error', error: `BatchData request failed: ${err.message}` });
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    return json(502, { status: 'error', error: 'BatchData returned non-JSON', body: raw.slice(0, 300) });
  }
  if (!res.ok) {
    return json(200, {
      status: 'failed',
      httpStatus: res.status,
      error: data.error || data.message || `BatchData HTTP ${res.status}`,
      details: data,
    });
  }

  // Their response shape: { results: { persons: [{ ... }] } } or similar.
  // We normalize defensively.
  const person =
    data?.results?.persons?.[0] ||
    data?.results?.[0]?.persons?.[0] ||
    data?.persons?.[0] ||
    data?.result?.[0] ||
    null;

  if (!person) {
    return json(200, { status: 'no_match', raw: data });
  }

  // Pick best phones (mobile first, then landline). Phones may be array of
  // objects with type ("Wireless"/"Landline") and number, or plain strings.
  const phones = (person.phoneNumbers || person.phones || person.phone || []).map(p =>
    typeof p === 'string' ? { number: p, type: '' } : { number: p.number || p.phoneNumber || '', type: p.type || p.phoneType || '' }
  );
  const mobile = phones.find(p => /wireless|mobile|cell/i.test(p.type))?.number || '';
  const landline = phones.find(p => /landline|home|work/i.test(p.type))?.number || '';
  const fallbackPhone = phones[0]?.number || '';

  const emails = (person.emails || person.email || []).map(e => typeof e === 'string' ? e : e.email || e.address || '');
  const addresses = (person.addresses || person.address || []).map(a =>
    typeof a === 'string' ? a : `${a.street || ''}, ${a.city || ''}, ${a.state || ''} ${a.zip || ''}`.trim()
  );

  return json(200, {
    status: 'ok',
    person: {
      first_name: person.firstName || person.first_name || firstName,
      last_name: person.lastName || person.last_name || lastName,
      mobile,
      landline,
      phone: mobile || landline || fallbackPhone,
      email: emails[0] || '',
      all_phones: phones,
      all_emails: emails,
      current_address: addresses[0] || '',
      all_addresses: addresses,
      age: person.age || null,
    },
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
