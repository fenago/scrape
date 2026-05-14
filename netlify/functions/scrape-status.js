// Poll a Firecrawl batch/scrape job and return aggregated leads.
// The client polls this endpoint every few seconds until status === 'completed'.

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return json(500, { error: 'FIRECRAWL_API_KEY env var is not set.' });

  const jobId = event.queryStringParameters?.id;
  if (!jobId) return json(400, { error: 'id query param is required' });

  const url = `https://api.firecrawl.dev/v1/batch/scrape/${encodeURIComponent(jobId)}`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
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
      firecrawl_details: data,
    });
  }

  // Firecrawl batch response shape: { status, total, completed, data: [{ json, metadata: { sourceURL } }, ...] }
  const rows = Array.isArray(data.data) ? data.data : [];
  const leads = [];
  let filingsCompletedThrough = null;
  const seen = new Set();

  for (const row of rows) {
    const j = row.json || row.extract || {};
    if (j.filings_completed_through && !filingsCompletedThrough) {
      filingsCompletedThrough = j.filings_completed_through;
    }
    const sourceQuery = extractTextParam(row.metadata?.sourceURL);
    for (const lead of j.leads || []) {
      const key = `${lead.file_number || ''}|${lead.debtor_name || ''}`;
      if (key === '|' || seen.has(key)) continue;
      seen.add(key);
      leads.push({
        debtor_name: lead.debtor_name || '',
        file_number: lead.file_number || '',
        filing_date: lead.filing_date || '',
        filing_type: lead.filing_type || '',
        secured_party: lead.secured_party || '',
        address: lead.address || '',
        source_query: sourceQuery,
      });
    }
  }

  return json(200, {
    status: data.status,
    total: data.total,
    completed: data.completed,
    creditsUsed: data.creditsUsed ?? null,
    leads,
    filingsCompletedThrough,
  });
}

function extractTextParam(u) {
  if (!u) return '';
  try { return new URL(u).searchParams.get('text') || ''; } catch { return ''; }
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
