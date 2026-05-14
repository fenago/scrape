// Poll a Firecrawl /v1/batch/scrape job. Returns per-query status so the UI
// can show exactly which queries succeeded, failed, or are still running.

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

  // Build a per-query report: { query, status, leadCount, totalMatched, error }
  const rows = Array.isArray(data.data) ? data.data : [];
  const perQuery = [];
  const allLeads = [];
  let filingsCompletedThrough = null;
  const seen = new Set();

  for (const row of rows) {
    const j = row.json || row.extract || {};
    if (j.filings_completed_through && !filingsCompletedThrough) {
      filingsCompletedThrough = j.filings_completed_through;
    }
    const sourceUrl = row.metadata?.sourceURL || '';
    const query = extractTextParam(sourceUrl);
    const leadsForRow = Array.isArray(j.leads) ? j.leads : [];
    perQuery.push({
      query,
      sourceUrl,
      status: row.metadata?.statusCode === 200 ? 'ok' : `http_${row.metadata?.statusCode || 'unknown'}`,
      leadCount: leadsForRow.length,
      totalMatched: j.total_records_matched || '',
    });
    for (const lead of leadsForRow) {
      const key = `${lead.ucc_number || ''}|${lead.debtor_name || ''}|${lead.address || ''}`;
      if (key === '||' || seen.has(key)) continue;
      seen.add(key);
      allLeads.push({
        debtor_name: lead.debtor_name || '',
        ucc_number: lead.ucc_number || '',
        filing_year: (lead.ucc_number || '').slice(0, 4) || '',
        address: lead.address || '',
        city: lead.city || '',
        state: lead.state || '',
        zip: lead.zip || '',
        status: lead.status || '',
        source_query: query,
      });
    }
  }

  return json(200, {
    status: data.status,                // 'scraping' | 'completed' | 'failed'
    total: data.total,                  // total queries in batch
    completed: data.completed,          // queries done so far
    creditsUsed: data.creditsUsed ?? null,
    perQuery,                           // [{query, status, leadCount, ...}]
    leads: allLeads,                    // deduped across all queries
    filingsCompletedThrough,
    polledAt: new Date().toISOString(),
  });
}

function extractTextParam(u) {
  if (!u) return '';
  try { return new URL(u).searchParams.get('text') || ''; } catch { return ''; }
}
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
