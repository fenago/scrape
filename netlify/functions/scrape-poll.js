// Poll a Firecrawl /v1/batch/scrape job. Fast (<1s), runs entirely within
// Netlify's 10s sync window. Client calls this every 2-3 seconds until
// status === 'completed'.

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!fcKey) return json(500, { error: 'FIRECRAWL_API_KEY env var not set' });

  const jobId = event.queryStringParameters?.id;
  if (!jobId) return json(400, { error: 'id query param is required' });

  const url = `https://api.firecrawl.dev/v1/batch/scrape/${encodeURIComponent(jobId)}`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${fcKey}` } });
  } catch (err) {
    return json(502, { error: `Firecrawl poll failed: ${err.message}` });
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    return json(502, { error: 'Firecrawl returned non-JSON', body: raw.slice(0, 300) });
  }
  if (!res.ok || data.success === false) {
    return json(res.status || 502, { error: data.error || data.message || 'Firecrawl error', firecrawl: data });
  }

  // Firecrawl batch response shape:
  //   { status, total, completed, creditsUsed, data: [{ json, metadata }] }
  const row = Array.isArray(data.data) && data.data.length ? data.data[0] : null;
  const j = row?.json || row?.extract || {};

  return json(200, {
    status: data.status,                  // 'scraping' | 'completed' | 'failed'
    completed: data.completed,
    total: data.total,
    creditsUsed: data.creditsUsed ?? null,
    page_kind: j.page_kind || null,
    total_matched: j.total_matched || '',
    variants: Array.isArray(j.variants) ? j.variants : [],
    filings: Array.isArray(j.filings) ? j.filings : [],
    polledAt: new Date().toISOString(),
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
