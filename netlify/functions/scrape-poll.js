// Poll a Firecrawl /v1/batch/scrape job. Fast (<1s).
//
// Parses the Firecrawl markdown response with regex (no external deps).
// GSCCCA renders both the filings page and the variants page as markdown
// tables; pure-regex parsing handles every row deterministically without
// hitting AI context limits.

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

  const row = Array.isArray(data.data) && data.data.length ? data.data[0] : null;
  const markdown = row?.markdown || '';
  const aiJson = row?.json || row?.extract || {};

  // Multi-tier extraction (each step wrapped in try/catch — never crashes the poll):
  //   1. Markdown table parse (best, deterministic, gets every row)
  //   2. AI json (fallback)
  let parsed = { page_kind: null, filings: [], variants: [], total_matched: '' };
  let parseError = null;
  if (markdown) {
    try { parsed = parseMarkdown(markdown); }
    catch (err) { parseError = `markdown parse failed: ${err.message}`; }
  }

  const filings = parsed.filings.length ? parsed.filings :
                  Array.isArray(aiJson.filings) ? aiJson.filings : [];
  const variants = parsed.variants.length ? parsed.variants :
                   Array.isArray(aiJson.variants) ? aiJson.variants : [];
  const page_kind = parsed.page_kind || aiJson.page_kind || null;
  const total_matched = parsed.total_matched || aiJson.total_matched || '';
  const extractedBy =
    parsed.filings.length ? 'markdown-table' :
    (Array.isArray(aiJson.filings) && aiJson.filings.length) ? 'ai-fallback' : 'none';

  // Useful snippet of markdown (cropped to interesting section).
  const interesting = (() => {
    if (!markdown) return '';
    const markers = ['SECURED PARTY SEARCH', 'Search Results', 'Records Found', 'Variations of the Name', 'no items matching'];
    for (const m of markers) {
      const idx = markdown.toLowerCase().indexOf(m.toLowerCase());
      if (idx >= 0) return markdown.slice(idx, idx + 3000);
    }
    return markdown.slice(0, 3000);
  })();

  let firecrawlError = null;
  if (data.status === 'failed') {
    firecrawlError = data.error || data.message || row?.error || row?.metadata?.error || 'Firecrawl reported failed status.';
  }

  return json(200, {
    status: data.status,
    completed: data.completed,
    total: data.total,
    creditsUsed: data.creditsUsed ?? null,
    expiresAt: data.expiresAt || null,
    page_kind,
    total_matched,
    variants,
    filings,
    extractedBy,
    parseError,
    finalUrl: row?.metadata?.sourceURL || row?.metadata?.url || null,
    markdownSnippet: interesting,
    markdownLength: markdown.length,
    pageTitle: row?.metadata?.title || null,
    error: firecrawlError,
    polledAt: new Date().toISOString(),
  });
}

// --- Markdown table parser (no external deps) ---
// GA renders results as markdown tables of the form:
//   | header1 | header2 | header3 |
//   | --- | --- | --- |
//   | val1   | val2   | val3   |
// We find every table, classify it by its header, and extract every row.
function parseMarkdown(md) {
  const out = { page_kind: null, filings: [], variants: [], total_matched: '' };

  // Detect "no items matching" and login-bounce up front.
  const flat = md.replace(/\s+/g, ' ');
  if (/no\s+items?\s+matching\s+your\s+search/i.test(flat) ||
      /no\s+(?:records?|results?)\s+(?:were\s+)?found/i.test(flat)) {
    out.page_kind = 'none';
    out.total_matched = '0';
    return out;
  }
  if (/please.{0,40}login\s+name\s+and\s+password/i.test(flat) || /login.asp/i.test(md)) {
    // Only a strong signal if the whole page is the login form, not just a link.
    if (!/Records Found|Variations of the Name|SECURED PARTY SEARCH/i.test(md)) {
      out.page_kind = 'login';
    }
  }

  const fileNumRe = /^\d{3}-\d{4}-\d{6}$/;
  const lines = md.split('\n');

  // Walk lines, find table header rows (lines with | and including key columns),
  // then collect subsequent table rows until the table ends.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) continue;

    const headers = splitMdRow(line).map(c => c.trim().toLowerCase().replace(/\*/g, ''));
    if (headers.length < 3) continue;
    const headerJoined = headers.join(' | ');

    // Skip the divider row that follows.
    const isFilings = /file number/.test(headerJoined) && /debtor/.test(headerJoined);
    const isVariants = /secured party name/.test(headerJoined) && /instrument/.test(headerJoined);
    if (!isFilings && !isVariants) continue;

    // Locate column indices we care about.
    const idx = isFilings ? {
      file_number:          headers.findIndex(h => /file number/.test(h)),
      document_type:        headers.findIndex(h => /document type|^type$/.test(h)),
      debtor_name:          headers.findIndex(h => /debtor/.test(h)),
      date_filed:           headers.findIndex(h => /date filed|^filed$/.test(h)),
      original_file_number: headers.findIndex(h => /original/.test(h)),
    } : {
      instruments:        headers.findIndex(h => /instrument/.test(h)),
      secured_party_name: headers.findIndex(h => /secured party name/.test(h)),
    };

    // Iterate subsequent lines as table rows until we hit a non-table line.
    for (let j = i + 1; j < lines.length; j++) {
      const rowLine = lines[j];
      if (!rowLine.includes('|')) break;
      const cells = splitMdRow(rowLine).map(c => c.trim());
      // Skip divider rows like | --- | --- |
      if (cells.every(c => /^[-:\s]*$/.test(c))) continue;
      if (cells.length < headers.length - 1) continue; // tolerate ragged rows

      if (isFilings) {
        const fn = cells[idx.file_number] || '';
        if (!fileNumRe.test(fn)) continue;
        out.filings.push({
          file_number:          fn,
          document_type:        cells[idx.document_type] || '',
          debtor_name:          cells[idx.debtor_name] || '',
          date_filed:           cells[idx.date_filed] || '',
          original_file_number: cells[idx.original_file_number] || '',
        });
        out.page_kind = 'filings';
      } else if (isVariants) {
        const count = parseInt((cells[idx.instruments] || '').replace(/,/g, ''), 10);
        const name = cells[idx.secured_party_name] || '';
        if (!isNaN(count) && name && !/^secured party name$/i.test(name)) {
          out.variants.push({ secured_party_name: name, instrument_count: count });
          out.page_kind = 'variants';
        }
      }
    }
    // Once we've found a real results table, stop scanning.
    if (out.filings.length || out.variants.length) break;
  }

  // Extract "N Records Found" / "N Variations" total for display.
  const m =
    flat.match(/(\d+(?:,\d{3})*)\s+records?\s+found/i) ||
    flat.match(/(\d+(?:,\d{3})*)\s+variations?\s+of\s+the\s+name\s+found/i) ||
    flat.match(/(\d+(?:,\d{3})*)\s+items?\s+matched/i);
  if (m) out.total_matched = m[1];

  if (!out.page_kind) out.page_kind = 'other';
  return out;
}

function splitMdRow(line) {
  // Splits a markdown table row into cells. Handles leading/trailing pipes
  // and escaped pipes (\|) in cell content.
  const trimmed = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  const parts = [];
  let buf = '';
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '\\' && trimmed[i + 1] === '|') { buf += '|'; i++; continue; }
    if (c === '|') { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
