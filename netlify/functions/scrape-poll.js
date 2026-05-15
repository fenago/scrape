// Poll a Firecrawl /v1/batch/scrape job. Fast (<1s), runs entirely within
// Netlify's 10s sync window.
//
// IMPORTANT: this version parses the raw HTML table with cheerio rather than
// relying on Firecrawl's AI JSON extraction, because the AI extraction was
// dropping ~25% of rows when the table was long (context-limit issue). With
// cheerio we get every row deterministically.

import * as cheerio from 'cheerio';

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
  const html = row?.html || '';
  const markdown = row?.markdown || '';
  const aiJson = row?.json || row?.extract || {};

  // === Deterministic HTML parsing (the fix) ===
  // GA's filings page has columns: SELECT, FILE NUMBER, DOCUMENT TYPE,
  // DEBTOR NAME, DATE FILED, ORIGINAL FILE NUMBER. The variants page has:
  // SELECT, INSTRUMENTS, SECURED PARTY NAME. We detect which one we're on
  // by looking at the header row.
  const parsed = html ? parseGsccca(html) : { page_kind: null, filings: [], variants: [], total_matched: '' };

  // Fall back to AI JSON only if cheerio couldn't find the table.
  const filings = parsed.filings.length ? parsed.filings :
                  Array.isArray(aiJson.filings) ? aiJson.filings : [];
  const variants = parsed.variants.length ? parsed.variants :
                   Array.isArray(aiJson.variants) ? aiJson.variants : [];
  const page_kind = parsed.page_kind || aiJson.page_kind || null;
  const total_matched = parsed.total_matched || aiJson.total_matched || '';

  // Strip useful markdown snippet (first interesting marker onward).
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
    extractedBy: parsed.filings.length ? 'cheerio' : (Array.isArray(aiJson.filings) && aiJson.filings.length ? 'ai-fallback' : 'none'),
    finalUrl: row?.metadata?.sourceURL || row?.metadata?.url || null,
    markdownSnippet: interesting,
    markdownLength: markdown.length,
    htmlLength: html.length,
    pageTitle: row?.metadata?.title || null,
    error: firecrawlError,
    polledAt: new Date().toISOString(),
  });
}

// Parse the GSCCCA results page deterministically. Walks every <table>, looks
// for header rows that match either the filings layout or the variants layout,
// then extracts every row. Returns ALL rows — no AI context limits.
function parseGsccca(html) {
  const $ = cheerio.load(html);
  const out = { page_kind: null, filings: [], variants: [], total_matched: '' };

  // Detect "no items matching" / "no records found" up front.
  const bodyText = $.root().text().replace(/\s+/g, ' ');
  if (/no\s+items?\s+matching\s+your\s+search/i.test(bodyText) ||
      /no\s+(?:records?|results?)\s+(?:were\s+)?found/i.test(bodyText)) {
    out.page_kind = 'none';
    out.total_matched = '0';
    return out;
  }
  if ($('input[name="txtUserID"]').length || /please.{0,40}login\s+name\s+and\s+password/i.test(bodyText)) {
    out.page_kind = 'login';
    return out;
  }

  // Find the largest table whose header row contains either FILE NUMBER (filings)
  // or SECURED PARTY NAME (variants). Try every table — GA wraps in layout tables.
  const fileNumRe = /^\d{3}-\d{4}-\d{6}$/;

  $('table').each((_, tbl) => {
    const $tbl = $(tbl);
    const rows = $tbl.find('tr');
    if (rows.length < 2) return;

    const headerCells = rows.first().find('th, td').map((i, c) => $(c).text().trim().toLowerCase().replace(/\s+/g, ' ')).get();
    const headerJoined = headerCells.join(' | ');

    // FILINGS layout
    if (/file number/.test(headerJoined) && /debtor/.test(headerJoined)) {
      const idx = {
        file_number:          headerCells.findIndex(h => /file number/.test(h)),
        document_type:        headerCells.findIndex(h => /document type|type/.test(h)),
        debtor_name:          headerCells.findIndex(h => /debtor/.test(h)),
        date_filed:           headerCells.findIndex(h => /date filed|filed/.test(h)),
        original_file_number: headerCells.findIndex(h => /original/.test(h)),
      };
      rows.slice(1).each((_, tr) => {
        const cells = $(tr).find('td').map((i, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
        if (cells.length < 3) return;
        const fn = pickCell(cells, idx.file_number);
        if (!fileNumRe.test(fn)) return;
        out.filings.push({
          file_number:          fn,
          document_type:        pickCell(cells, idx.document_type),
          debtor_name:          pickCell(cells, idx.debtor_name),
          date_filed:           pickCell(cells, idx.date_filed),
          original_file_number: pickCell(cells, idx.original_file_number),
        });
      });
      out.page_kind = 'filings';
    }

    // VARIANTS layout
    if (!out.page_kind && /secured party name/.test(headerJoined) && /instrument/.test(headerJoined)) {
      const idx = {
        instruments:        headerCells.findIndex(h => /instrument/.test(h)),
        secured_party_name: headerCells.findIndex(h => /secured party name/.test(h)),
      };
      rows.slice(1).each((_, tr) => {
        const cells = $(tr).find('td').map((i, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
        if (cells.length < 2) return;
        const count = parseInt(pickCell(cells, idx.instruments).replace(/,/g, ''), 10);
        const name = pickCell(cells, idx.secured_party_name);
        if (!isNaN(count) && name) {
          out.variants.push({ secured_party_name: name, instrument_count: count });
        }
      });
      out.page_kind = 'variants';
    }
  });

  // Extract "N Records Found" / "N Variations of the Name Found" total.
  const m =
    bodyText.match(/(\d+(?:,\d{3})*)\s+records?\s+found/i) ||
    bodyText.match(/(\d+(?:,\d{3})*)\s+variations?\s+of\s+the\s+name\s+found/i) ||
    bodyText.match(/(\d+(?:,\d{3})*)\s+items?\s+matched/i);
  if (m) out.total_matched = m[1];

  if (!out.page_kind) out.page_kind = 'other';
  return out;
}

function pickCell(cells, i) {
  if (i < 0 || i >= cells.length) return '';
  return cells[i] || '';
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
