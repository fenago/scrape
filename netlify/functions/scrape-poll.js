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
  //   { status, total, completed, creditsUsed, expiresAt, data: [{ markdown, json, metadata }] }
  const row = Array.isArray(data.data) && data.data.length ? data.data[0] : null;
  const j = row?.json || row?.extract || {};
  const markdown = row?.markdown || '';
  // Strip the GSCCCA header/menu garbage from the markdown preview so the
  // user sees the actual results section, not the image-preload JS.
  const interesting = (() => {
    if (!markdown) return '';
    // Look for the first meaningful marker we know about.
    const markers = ['SECURED PARTY SEARCH', 'Search Results', 'Variations of the Name', 'records matched', 'no items matching'];
    for (const m of markers) {
      const idx = markdown.toLowerCase().indexOf(m.toLowerCase());
      if (idx >= 0) return markdown.slice(idx, idx + 3000);
    }
    return markdown.slice(0, 3000);
  })();

  // Surface Firecrawl's failure reason from the per-URL data array when status=failed.
  let firecrawlError = null;
  if (data.status === 'failed') {
    firecrawlError =
      data.error || data.message ||
      row?.error || row?.metadata?.error ||
      'Firecrawl reported failed status (no error message).';
  }

  return json(200, {
    status: data.status,                  // 'scraping' | 'completed' | 'failed'
    completed: data.completed,
    total: data.total,
    creditsUsed: data.creditsUsed ?? null,
    expiresAt: data.expiresAt || null,    // Firecrawl's own expiry — real timeout
    page_kind: j.page_kind || null,
    total_matched: j.total_matched || '',
    variants: Array.isArray(j.variants) ? j.variants : [],
    filings: Array.isArray(j.filings) ? j.filings : [],
    finalUrl: row?.metadata?.sourceURL || row?.metadata?.url || null,
    markdownSnippet: interesting,
    markdownLength: markdown.length,
    pageTitle: row?.metadata?.title || null,
    error: firecrawlError,
    polledAt: new Date().toISOString(),
  });
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
