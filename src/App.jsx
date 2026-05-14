import { useState } from 'react';

// Real MCA UCC filing entities. GA's Stem Search catches variants automatically.
const MCA_LENDERS = [
  // High-volume bank originators for fintech MCAs:
  'CELTIC BANK',
  'WEBBANK',
  'CROSS RIVER BANK',
  'AMERICAN EXPRESS NATIONAL BANK',
  // Direct MCA lenders:
  'KABBAGE',
  'ON DECK CAPITAL',
  'BLUEVINE',
  'FUNDING CIRCLE',
  'SQUARE FINANCIAL SERVICES',
  'FUNDBOX',
  'SHOPIFY CAPITAL',
  'CAN CAPITAL',
  'RAPID FINANCIAL',
  'CREDIBLY',
  'WORLD BUSINESS LENDERS',
  'PEARL CAPITAL',
  'EVEREST BUSINESS FUNDING',
  'EBF',
  'MULLIGAN FUNDING',
  'QUICKBRIDGE',
  'STRATEGIC FUNDING',
  'IOU FINANCIAL',
  'GREEN CAPITAL FUNDING',
  'BIZFUND',
  'FOX CAPITAL',
  'LENDISTRY',
  'LENDR',
  'KAPITUS',
];

const DEFAULT_LENDERS = ['CELTIC BANK', 'WEBBANK', 'KABBAGE'];

// GSCCCA free accounts silently clamp FromDate to 1 year ago, so the UI
// limits to options inside that window.
const TIME_WINDOWS = [
  { id: '7d',  label: 'Last 7 days',  days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: '180d', label: 'Last 180 days', days: 180 },
  { id: '365d', label: 'Last 12 months (max for free account)', days: 365 },
];

function mmddyyyy(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

export default function App() {
  const [timeWindow, setTimeWindow] = useState('365d');
  const [stemSearch, setStemSearch] = useState(true);
  const [maxrows, setMaxrows] = useState(100);
  const [selectedLenders, setSelectedLenders] = useState([...DEFAULT_LENDERS]);
  const [customNames, setCustomNames] = useState('');
  const [csvPreview, setCsvPreview] = useState('raw');

  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);

  function toggleLender(l) {
    setSelectedLenders(curr => curr.includes(l) ? curr.filter(x => x !== l) : [...curr, l]);
  }

  function dateRange() {
    const tw = TIME_WINDOWS.find(t => t.id === timeWindow) || TIME_WINDOWS[TIME_WINDOWS.length - 1];
    const today = new Date();
    const from = new Date(today.getTime() - tw.days * 24 * 60 * 60 * 1000);
    return { fromDate: mmddyyyy(from), toDate: mmddyyyy(today) };
  }

  async function runSweep(e) {
    e?.preventDefault?.();
    setError(null);
    setResponse(null);
    setRunning(true);

    const customs = customNames.split(',').map(s => s.trim()).filter(Boolean);
    const lenders = [...new Set([...selectedLenders, ...customs])];
    const { fromDate, toDate } = dateRange();

    try {
      const res = await fetch('/api/scrape-ga', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lenders, fromDate, toDate, maxrows: parseInt(maxrows, 10) || 100, stemSearch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResponse(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  function rawCsv(rows) {
    const headers = ['debtor_name', 'file_number', 'filing_date', 'filing_type', 'secured_party', 'county', 'status', 'source_lender'];
    const body = rows.map(l => headers.map(h => csvCell(l[h])).join(','));
    return [headers.join(','), ...body].join('\n');
  }
  function ghlCsv(rows) {
    const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Company Name', 'Address', 'City', 'State', 'Postal Code', 'Country', 'Source', 'Tags', 'Notes'];
    const body = rows.map(l => {
      const tags = ['ucc-ga-lead', l.source_lender && `lender-${l.source_lender.toLowerCase().replace(/\s+/g, '-')}`, l.county && `county-${l.county.toLowerCase().replace(/\s+/g, '-')}`].filter(Boolean).join('; ');
      const notes = [`UCC #${l.file_number}`, l.filing_date && `Filed: ${l.filing_date}`, l.filing_type && `Type: ${l.filing_type}`, l.secured_party && `Secured Party: ${l.secured_party}`, l.status && `Status: ${l.status}`].filter(Boolean).join(' | ');
      return ['', '', '', '', l.debtor_name, '', '', 'GA', '', 'US', `GA UCC - ${l.source_lender}`, tags, notes].map(csvCell).join(',');
    });
    return [headers.join(','), ...body].join('\n');
  }
  function csvCell(v) { return `"${(v ?? '').toString().replace(/"/g, '""')}"`; }
  function downloadFile(text, filename) {
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  const leads = response?.leads || [];
  const previewText = csvPreview === 'raw' ? rawCsv(leads) : ghlCsv(leads);
  const totalVariants = (response?.perQuery || []).reduce((s, q) => s + (q.variants?.length || 0), 0);
  const totalFilings = (response?.perQuery || []).reduce((s, q) => s + (q.filings?.length || 0), 0);

  return (
    <div className="container">
      <header>
        <h1>Georgia UCC Lead Pull</h1>
        <p className="sub">
          Pull MCA leads from the Georgia GSCCCA UCC index. Real browser sessions via Firecrawl, so the site can't reject the requests. ~10 credits per lender.
        </p>
      </header>

      <form className="panel" onSubmit={runSweep}>
        <fieldset>
          <legend>Time window</legend>
          <div className="chips">
            {TIME_WINDOWS.map(t => (
              <button key={t.id} type="button" className={`chip ${timeWindow === t.id ? 'on' : ''}`} onClick={() => setTimeWindow(t.id)}>{t.label}</button>
            ))}
          </div>
          <p className="hint">
            Filings dated <strong>{dateRange().fromDate}</strong> through <strong>{dateRange().toDate}</strong>.
            GSCCCA free accounts cap the lookback at 12 months — older dates get silently clamped server-side.
          </p>
        </fieldset>

        <fieldset>
          <legend>Name matching</legend>
          <div className="chips">
            <button type="button" className={`chip ${stemSearch ? 'on' : ''}`} onClick={() => setStemSearch(true)}>Stem (fuzzy — recommended)</button>
            <button type="button" className={`chip ${!stemSearch ? 'on' : ''}`} onClick={() => setStemSearch(false)}>Exact</button>
          </div>
        </fieldset>

        <div className="grid">
          <fieldset>
            <legend>Results per lender (10–100)</legend>
            <input type="number" min="10" max="100" value={maxrows} onChange={e => setMaxrows(e.target.value)} />
          </fieldset>
          <fieldset>
            <legend>Lenders selected</legend>
            <div className="big-num" style={{ paddingTop: '0.4rem' }}>{selectedLenders.length + customNames.split(',').filter(s => s.trim()).length}<span className="small"> / 10 max</span></div>
            <p className="hint">~10 Firecrawl credits per lender. 5 lenders ≈ 50 credits per run.</p>
          </fieldset>
        </div>

        <fieldset>
          <legend>MCA lenders (click to toggle)</legend>
          <div className="chips">
            {MCA_LENDERS.map(l => (
              <button key={l} type="button" className={`chip ${selectedLenders.includes(l) ? 'on' : ''}`} onClick={() => toggleLender(l)}>{l}</button>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="link" onClick={() => setSelectedLenders([...DEFAULT_LENDERS])}>Reset to defaults</button>
            <button type="button" className="link" onClick={() => setSelectedLenders([])}>Clear</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Extra lender names (optional, comma-separated)</legend>
          <input type="text" value={customNames} onChange={e => setCustomNames(e.target.value)} placeholder="e.g. STRIPE CAPITAL, BREX" />
        </fieldset>

        <div className="submit-row">
          <button type="submit" disabled={running}>{running ? 'Running (~15s per lender)…' : 'Run sweep'}</button>
          {leads.length > 0 && (
            <>
              <button type="button" className="primary" onClick={() => downloadFile(rawCsv(leads), `ga-ucc-raw-${Date.now()}.csv`)}>
                Download raw CSV ({leads.length})
              </button>
              <button type="button" className="primary" onClick={() => downloadFile(ghlCsv(leads), `ga-ucc-ghl-${Date.now()}.csv`)}>
                Download GHL CSV ({leads.length})
              </button>
            </>
          )}
        </div>
      </form>

      {error && <div className="errors"><strong>Error:</strong> {error}</div>}

      {response?.params?.dateClamped && (
        <div className="errors" style={{ borderColor: '#d29922', background: 'rgba(210,153,34,0.1)', color: '#d29922' }}>
          <strong>Date clamped:</strong> requested FromDate <code>{response.params.requestedFromDate}</code> was clamped by GSCCCA to <code>{response.params.fromDate}</code> (free account limit).
        </div>
      )}

      {response && (
        <div className="panel live-status">
          <div className="live-row">
            <div>
              <div className="big-num">{response.perQuery?.length || 0}</div>
              <div className="big-label">Lenders queried</div>
            </div>
            <div>
              <div className="big-num">{leads.length}</div>
              <div className="big-label">Unique leads</div>
            </div>
            <div>
              <div className="big-num">{totalFilings}</div>
              <div className="big-label">Total filings found</div>
            </div>
            <div>
              <div className="big-num">{totalVariants}</div>
              <div className="big-label">Lender variants seen</div>
            </div>
          </div>
        </div>
      )}

      {response?.perQuery && (
        <details className="panel" open>
          <summary><strong>Per-lender results ({response.perQuery.length})</strong></summary>
          <table className="compact">
            <thead><tr><th>#</th><th>Lender</th><th>Page kind</th><th>Total matched</th><th>Variants</th><th>Filings</th><th>Elapsed</th><th>Error</th></tr></thead>
            <tbody>
              {response.perQuery.map((q, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><code>{q.lender}</code></td>
                  <td><code>{q.page_kind || '–'}</code></td>
                  <td className="muted">{q.total_matched || '–'}</td>
                  <td>{q.variants?.length || 0}</td>
                  <td>{q.filings?.length || 0}</td>
                  <td className="muted">{q.elapsedMs}ms</td>
                  <td className="muted">{q.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {response?.perQuery?.some(q => q.variants?.length > 0) && (
        <details className="panel">
          <summary><strong>Lender variants seen</strong> (GSCCCA grouped filings under these names)</summary>
          <table className="compact">
            <thead><tr><th>Source lender</th><th>Variant name</th><th>Instruments</th></tr></thead>
            <tbody>
              {response.perQuery.flatMap(q =>
                (q.variants || []).map((v, i) => (
                  <tr key={`${q.lender}-${i}`}>
                    <td><code>{q.lender}</code></td>
                    <td>{v.secured_party_name}</td>
                    <td>{v.instrument_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </details>
      )}

      {leads.length > 0 && (
        <div className="panel">
          <div className="csv-tabs">
            <strong>CSV preview</strong>
            <div className="chips">
              <button type="button" className={`chip ${csvPreview === 'raw' ? 'on' : ''}`} onClick={() => setCsvPreview('raw')}>Raw</button>
              <button type="button" className={`chip ${csvPreview === 'ghl' ? 'on' : ''}`} onClick={() => setCsvPreview('ghl')}>Go High Level</button>
            </div>
          </div>
          <pre className="csv-preview">{previewText.split('\n').slice(0, 30).join('\n')}{previewText.split('\n').length > 30 ? '\n…' : ''}</pre>
        </div>
      )}

      {leads.length > 0 && (
        <>
          <h3>Leads ({leads.length})</h3>
          <table>
            <thead>
              <tr><th>Debtor</th><th>File #</th><th>Filed</th><th>Type</th><th>Secured Party</th><th>County</th><th>Status</th><th>Source</th></tr>
            </thead>
            <tbody>
              {leads.slice(0, 500).map((l, i) => (
                <tr key={i}>
                  <td>{l.debtor_name}</td>
                  <td><code>{l.file_number}</code></td>
                  <td>{l.filing_date}</td>
                  <td>{l.filing_type}</td>
                  <td>{l.secured_party}</td>
                  <td>{l.county}</td>
                  <td>{l.status}</td>
                  <td className="muted">{l.source_lender}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <footer>
        <p>Source: GSCCCA Georgia UCC Index. Uses Firecrawl (real browser session) + your free GSCCCA limited-use account.</p>
      </footer>
    </div>
  );
}
