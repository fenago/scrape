import { useRef, useState } from 'react';

const MCA_LENDERS = [
  'CELTIC BANK', 'WEBBANK', 'CROSS RIVER BANK', 'AMERICAN EXPRESS NATIONAL BANK',
  'KABBAGE', 'ON DECK CAPITAL', 'BLUEVINE', 'FUNDING CIRCLE',
  'SQUARE FINANCIAL SERVICES', 'FUNDBOX', 'SHOPIFY CAPITAL', 'CAN CAPITAL',
  'RAPID FINANCIAL', 'CREDIBLY', 'WORLD BUSINESS LENDERS', 'PEARL CAPITAL',
  'EVEREST BUSINESS FUNDING', 'EBF', 'MULLIGAN FUNDING', 'QUICKBRIDGE',
  'STRATEGIC FUNDING', 'IOU FINANCIAL', 'GREEN CAPITAL FUNDING', 'BIZFUND',
  'FOX CAPITAL', 'LENDISTRY', 'LENDR', 'KAPITUS',
];

const DEFAULT_LENDERS = ['CELTIC BANK'];

const TIME_WINDOWS = [
  { id: '7d',   label: 'Last 7 days',   days: 7 },
  { id: '30d',  label: 'Last 30 days',  days: 30 },
  { id: '90d',  label: 'Last 90 days',  days: 90 },
  { id: '180d', label: 'Last 180 days', days: 180 },
  { id: '365d', label: 'Last 12 months (max for free account)', days: 365 },
];

function mmddyyyy(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }

export default function App() {
  const [timeWindow, setTimeWindow] = useState('365d');
  const [stemSearch, setStemSearch] = useState(true);
  const [maxrows, setMaxrows] = useState(100);
  const [selectedLenders, setSelectedLenders] = useState([...DEFAULT_LENDERS]);
  const [customNames, setCustomNames] = useState('');
  const [csvPreview, setCsvPreview] = useState('raw');

  // Runtime state.
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);     // {current,total,lender,startedAt}
  const [perLender, setPerLender] = useState([]);     // [{lender, status, page_kind, variants, filings, elapsedMs, error}]
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);

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
    setPerLender([]);
    setProgress(null);
    cancelRef.current = false;

    const customs = customNames.split(',').map(s => s.trim()).filter(Boolean);
    const lenders = [...new Set([...selectedLenders, ...customs])];
    if (!lenders.length) { setError('Pick at least one lender.'); return; }

    const { fromDate, toDate } = dateRange();
    setRunning(true);
    const results = [];

    for (let i = 0; i < lenders.length; i++) {
      if (cancelRef.current) break;
      const lender = lenders[i];
      setProgress({ current: i + 1, total: lenders.length, lender, startedAt: Date.now() });
      try {
        const res = await fetch('/api/scrape-ga-one', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lender, fromDate, toDate, maxrows: parseInt(maxrows, 10) || 100, stemSearch }),
        });
        const data = await res.json();
        results.push(data);
        setPerLender([...results]);
      } catch (err) {
        results.push({ lender, status: 'error', error: err.message, variants: [], filings: [] });
        setPerLender([...results]);
      }
    }

    setProgress(null);
    setRunning(false);
  }

  function cancel() {
    cancelRef.current = true;
  }

  // Aggregate + dedupe.
  const leads = (() => {
    const seen = new Set();
    const out = [];
    for (const q of perLender) {
      for (const f of (q.filings || [])) {
        const key = `${f.file_number || ''}|${f.debtor_name || ''}|${f.county || ''}`;
        if (key === '||' || seen.has(key)) continue;
        seen.add(key);
        out.push({ ...f, source_lender: q.lender });
      }
    }
    return out;
  })();

  function rawCsv(rows) {
    const headers = ['debtor_name', 'file_number', 'filing_date', 'filing_type', 'secured_party', 'county', 'status', 'source_lender'];
    return [headers.join(','), ...rows.map(l => headers.map(h => csvCell(l[h])).join(','))].join('\n');
  }
  function ghlCsv(rows) {
    const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Company Name', 'Address', 'City', 'State', 'Postal Code', 'Country', 'Source', 'Tags', 'Notes'];
    return [headers.join(','), ...rows.map(l => {
      const tags = ['ucc-ga-lead', l.source_lender && `lender-${l.source_lender.toLowerCase().replace(/\s+/g, '-')}`, l.county && `county-${l.county.toLowerCase().replace(/\s+/g, '-')}`].filter(Boolean).join('; ');
      const notes = [`UCC #${l.file_number}`, l.filing_date && `Filed: ${l.filing_date}`, l.filing_type && `Type: ${l.filing_type}`, l.secured_party && `Secured Party: ${l.secured_party}`, l.status && `Status: ${l.status}`].filter(Boolean).join(' | ');
      return ['', '', '', '', l.debtor_name, '', '', 'GA', '', 'US', `GA UCC - ${l.source_lender}`, tags, notes].map(csvCell).join(',');
    })].join('\n');
  }
  function csvCell(v) { return `"${(v ?? '').toString().replace(/"/g, '""')}"`; }
  function downloadFile(text, filename) {
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  const previewText = csvPreview === 'raw' ? rawCsv(leads) : ghlCsv(leads);
  const elapsed = progress ? Math.floor((Date.now() - progress.startedAt) / 1000) : 0;
  // Re-render every second while running, so the elapsed timer updates.
  // (Cheap polyfill — useState in a ref+timer would be cleaner, but this works.)
  if (running) setTimeout(() => setPerLender(p => [...p]), 1000);

  return (
    <div className="container">
      <header>
        <h1>Georgia UCC Lead Pull</h1>
        <p className="sub">
          Pull MCA leads from the Georgia GSCCCA UCC index. Each lender runs sequentially (~15–25s) in a real browser session via Firecrawl. Drills past variant names into actual debtor filings.
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
          <p className="hint">Filings dated <strong>{dateRange().fromDate}</strong> through <strong>{dateRange().toDate}</strong>.</p>
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
            <div className="big-num" style={{ paddingTop: '0.4rem' }}>{selectedLenders.length + customNames.split(',').filter(s => s.trim()).length}</div>
            <p className="hint">~12 Firecrawl credits per lender. 3 lenders ≈ 40 credits, ~60–90 seconds total.</p>
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
          {!running ? (
            <button type="submit">Run sweep</button>
          ) : (
            <button type="button" onClick={cancel}>Stop after current lender</button>
          )}
          {leads.length > 0 && !running && (
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

      {progress && (
        <div className="panel live-status">
          <div className="live-row">
            <div>
              <div className="big-num">{progress.current}<span className="small">/{progress.total}</span></div>
              <div className="big-label">Lenders</div>
            </div>
            <div>
              <div className="big-num"><code style={{ fontSize: '0.9rem' }}>{progress.lender}</code></div>
              <div className="big-label">Now scraping</div>
            </div>
            <div>
              <div className="big-num">{elapsed}s</div>
              <div className="big-label">Elapsed this lender</div>
            </div>
            <div>
              <div className="big-num">{leads.length}</div>
              <div className="big-label">Leads so far</div>
            </div>
          </div>
          <div className="progress-bar">
            <div style={{ width: `${(progress.current - 1) / progress.total * 100}%` }} />
          </div>
          <div className="muted small-text">
            Logging in → submitting search → drilling into biggest variant → extracting filings. ~15–25s per lender.
          </div>
        </div>
      )}

      {perLender.length > 0 && (
        <details className="panel" open>
          <summary><strong>Per-lender results ({perLender.length})</strong></summary>
          <table className="compact">
            <thead><tr><th>#</th><th>Lender</th><th>Page kind</th><th>Total matched</th><th>Variants</th><th>Filings</th><th>Elapsed</th><th>Error</th></tr></thead>
            <tbody>
              {perLender.map((q, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><code>{q.lender}</code></td>
                  <td><code>{q.page_kind || q.status || '–'}</code></td>
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

      {perLender.some(q => q.variants?.length > 0) && (
        <details className="panel">
          <summary><strong>Lender variants seen</strong> (GSCCCA groups filings under these names — we drilled into the biggest one)</summary>
          <table className="compact">
            <thead><tr><th>Source lender</th><th>Variant name</th><th>Instruments</th></tr></thead>
            <tbody>
              {perLender.flatMap(q =>
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
        <p>Source: GSCCCA GA UCC Index. Real browser session via Firecrawl + your free GSCCCA limited-use account.</p>
      </footer>
    </div>
  );
}
