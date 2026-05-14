import { useEffect, useRef, useState } from 'react';

const MCA_LENDERS = [
  'KABBAGE', 'ONDECK', 'BLUEVINE', 'SQUARE CAPITAL', 'FUNDING CIRCLE',
  'PAYPAL WORKING CAPITAL', 'AMERICAN EXPRESS MERCHANT FINANCING',
  'SHOPIFY CAPITAL', 'FUNDBOX', 'LENDIO', 'CAN CAPITAL', 'RAPID FINANCE',
  'CREDIBLY', 'CELTIC BANK', 'WEBBANK', 'WORLD BUSINESS LENDERS',
];

const YEAR_OPTIONS = [
  { id: 'all',  label: 'All years' },
  { id: '2026', label: '2026 only' },
  { id: '2025', label: '2025 only' },
  { id: '2024', label: '2024 only' },
  { id: '2023', label: '2023 only' },
];

export default function App() {
  const [mode, setMode] = useState('lender');               // 'debtor' | 'lender'
  const [yearFilter, setYearFilter] = useState('all');
  const [maxQueries, setMaxQueries] = useState(16);
  const [leadCap, setLeadCap] = useState(500);
  const [selectedLenders, setSelectedLenders] = useState([...MCA_LENDERS]);
  const [customNames, setCustomNames] = useState('');
  const [csvPreview, setCsvPreview] = useState('raw'); // 'raw' | 'ghl'

  const [job, setJob] = useState(null);                     // {jobId, totalQueries, queries:[{query,url}]}
  const [status, setStatus] = useState(null);               // full poll response
  const [pollLog, setPollLog] = useState([]);               // [{time, msg}]
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const pollTimer = useRef(null);
  const pollCount = useRef(0);

  useEffect(() => () => clearTimeout(pollTimer.current), []);

  function logEvent(msg) {
    setPollLog(curr => [{ time: new Date().toLocaleTimeString(), msg }, ...curr].slice(0, 50));
  }

  function toggleLender(l) {
    setSelectedLenders(curr => curr.includes(l) ? curr.filter(x => x !== l) : [...curr, l]);
  }

  async function runSweep() {
    setError(null); setStatus(null); setJob(null); setPollLog([]);
    pollCount.current = 0;
    setRunning(true);
    clearTimeout(pollTimer.current);

    const customs = customNames.split(',').map(s => s.trim()).filter(Boolean);
    const submitBody = {
      searchType: mode,
      matchMode: 'BeginsWith',
      maxQueries: parseInt(maxQueries, 10) || 16,
      customNames: customs,
    };
    if (mode === 'lender') submitBody.prefixes = selectedLenders;
    if (mode === 'debtor' && customs.length === 0) {
      setError("Debtor mode needs at least one custom name (e.g. 'ACME', 'PUBLIX'). The FL UCC search doesn't support single-letter prefix browsing — see the note below.");
      setRunning(false);
      return;
    }

    logEvent(`Submitting batch: ${(submitBody.prefixes || []).length + customs.length} queries…`);
    try {
      const res = await fetch('/api/scrape-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitBody),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`);
      setJob(data);
      logEvent(`Batch submitted. Firecrawl job ${data.jobId.slice(0, 8)}…`);
      logEvent(`Will scrape ${data.totalQueries} URLs. Polling every 4s.`);
      pollStatus(data.jobId);
    } catch (err) {
      setError(err.message);
      logEvent(`✗ Submit failed: ${err.message}`);
      setRunning(false);
    }
  }

  async function pollStatus(jobId) {
    pollCount.current += 1;
    try {
      const res = await fetch(`/api/scrape-status?id=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Status failed (${res.status})`);
      setStatus(data);

      logEvent(
        `Poll #${pollCount.current}: ${data.status} · ${data.completed || 0}/${data.total || '?'} queries · ` +
        `${data.leads?.length || 0} leads · ${data.creditsUsed ?? '?'} credits`
      );

      const filtered = applyFilters(data.leads).length;
      const done = data.status === 'completed' || data.status === 'failed';
      const capHit = filtered >= (parseInt(leadCap, 10) || Infinity);

      if (done) {
        logEvent(`✓ Batch ${data.status}. Final: ${data.leads?.length || 0} leads, ${data.creditsUsed} credits.`);
        setRunning(false);
      } else if (capHit) {
        logEvent(`⏸ Lead cap (${leadCap}) hit. Stopping poll early — batch continues server-side.`);
        setRunning(false);
      } else {
        pollTimer.current = setTimeout(() => pollStatus(jobId), 4000);
      }
    } catch (err) {
      setError(err.message);
      logEvent(`✗ Poll error: ${err.message}`);
      setRunning(false);
    }
  }

  function cancelPolling() {
    clearTimeout(pollTimer.current);
    logEvent('⏸ Polling stopped by user.');
    setRunning(false);
  }

  function applyFilters(leads) {
    if (!leads) return [];
    if (yearFilter === 'all') return leads;
    return leads.filter(l => l.filing_year === yearFilter);
  }

  function rawCsv(rows) {
    const headers = ['debtor_name', 'ucc_number', 'filing_year', 'address', 'city', 'state', 'zip', 'status', 'source_query'];
    const body = rows.map(l => headers.map(h => csvCell(l[h])).join(','));
    return [headers.join(','), ...body].join('\n');
  }

  function ghlCsv(rows) {
    // Go High Level contact import format. For UCC business leads we have no
    // person name/email/phone — map debtor business to Company Name and stuff
    // the UCC/status into Notes + Tags for filtering inside GHL.
    const headers = [
      'First Name', 'Last Name', 'Email', 'Phone', 'Company Name',
      'Address', 'City', 'State', 'Postal Code', 'Country',
      'Source', 'Tags', 'Notes',
    ];
    const body = rows.map(l => {
      const tags = [
        'fl-ucc-lead',
        l.filing_year && `year-${l.filing_year}`,
        l.source_query && `${mode === 'lender' ? 'lender' : 'debtor'}-${l.source_query.toLowerCase().replace(/\s+/g, '-')}`,
      ].filter(Boolean).join('; ');
      const notes = [
        `UCC #${l.ucc_number}`,
        l.status && `Status: ${l.status}`,
        l.source_query && `Source query: ${l.source_query}`,
      ].filter(Boolean).join(' | ');
      return [
        '', '', '', '',                                    // person fields blank
        l.debtor_name,
        l.address, l.city, l.state, l.zip, 'US',
        mode === 'lender' ? `FL UCC - ${l.source_query}` : 'FL UCC',
        tags, notes,
      ].map(csvCell).join(',');
    });
    return [headers.join(','), ...body].join('\n');
  }

  function downloadFile(text, filename) {
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function downloadRawCsv() {
    const rows = applyFilters(status?.leads || []).slice(0, parseInt(leadCap, 10) || Infinity);
    if (!rows.length) return;
    downloadFile(rawCsv(rows), `fl-ucc-raw-${mode}-${yearFilter}-${Date.now()}.csv`);
  }

  function downloadGhlCsv() {
    const rows = applyFilters(status?.leads || []).slice(0, parseInt(leadCap, 10) || Infinity);
    if (!rows.length) return;
    downloadFile(ghlCsv(rows), `fl-ucc-ghl-${mode}-${yearFilter}-${Date.now()}.csv`);
  }

  function csvCell(v) { return `"${(v ?? '').toString().replace(/"/g, '""')}"`; }

  const filteredLeads = applyFilters(status?.leads || []).slice(0, parseInt(leadCap, 10) || Infinity);
  const previewText = csvPreview === 'raw' ? rawCsv(filteredLeads) : csvPreview === 'ghl' ? ghlCsv(filteredLeads) : '';

  return (
    <div className="container">
      <header>
        <h1>Florida UCC Lead Pull</h1>
        <p className="sub">
          Async batch-scrape the Florida Secured Transaction Registry. Pick a mode, enter lenders or custom debtor names, and watch the queries run live.
        </p>
      </header>

      <form className="panel" onSubmit={e => { e.preventDefault(); runSweep(); }}>
        <fieldset>
          <legend>Mode</legend>
          <label className="radio">
            <input type="radio" name="mode" checked={mode === 'lender'} onChange={() => setMode('lender')} />
            <span><strong>Lender (Secured Party)</strong> — pull every merchant funded by selected MCA funders.</span>
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={mode === 'debtor'} onChange={() => setMode('debtor')} />
            <span><strong>Debtor name</strong> — pull UCC filings against specific business names you supply.</span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Filing year (filter applied to results)</legend>
          <div className="chips">
            {YEAR_OPTIONS.map(t => (
              <button key={t.id} type="button"
                className={`chip ${yearFilter === t.id ? 'on' : ''}`}
                onClick={() => setYearFilter(t.id)}>{t.label}</button>
            ))}
          </div>
          <p className="hint">Derived from the first 4 digits of the UCC Number (the list view doesn't expose filing dates directly).</p>
        </fieldset>

        <div className="grid">
          <fieldset>
            <legend>Max queries (cost cap)</legend>
            <input type="number" min="1" max="50" value={maxQueries}
              onChange={e => setMaxQueries(e.target.value)} />
            <p className="hint">~5 Firecrawl credits per query. 16 lenders = ~80 credits.</p>
          </fieldset>
          <fieldset>
            <legend>Max leads (stop polling at)</legend>
            <input type="number" min="1" value={leadCap}
              onChange={e => setLeadCap(e.target.value)} />
            <p className="hint">After this many filtered leads, polling stops.</p>
          </fieldset>
        </div>

        {mode === 'lender' && (
          <fieldset>
            <legend>MCA lenders (click to toggle — currently {selectedLenders.length} selected)</legend>
            <div className="chips">
              {MCA_LENDERS.map(l => (
                <button key={l} type="button"
                  className={`chip ${selectedLenders.includes(l) ? 'on' : ''}`}
                  onClick={() => toggleLender(l)}>{l}</button>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="link" onClick={() => setSelectedLenders([...MCA_LENDERS])}>Select all</button>
              <button type="button" className="link" onClick={() => setSelectedLenders([])}>Clear</button>
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend>{mode === 'debtor' ? 'Debtor names (comma-separated)' : 'Extra lender names (optional, comma-separated)'}</legend>
          <input type="text" value={customNames}
            onChange={e => setCustomNames(e.target.value)}
            placeholder={mode === 'lender' ? 'e.g. STRIPE CAPITAL, BREX' : 'e.g. PUBLIX, AMAZON, ACE HARDWARE'} />
          <p className="hint">FL UCC uses "Compact Name" matching — these need to be real business name fragments, not single letters.</p>
        </fieldset>

        <div className="submit-row">
          {!running ? (
            <button type="submit">Run sweep</button>
          ) : (
            <button type="button" onClick={cancelPolling}>Stop polling</button>
          )}
          {filteredLeads.length > 0 && (
            <>
              <button type="button" className="primary" onClick={downloadRawCsv}>
                Download raw CSV ({filteredLeads.length})
              </button>
              <button type="button" className="primary" onClick={downloadGhlCsv}>
                Download GHL CSV ({filteredLeads.length})
              </button>
            </>
          )}
        </div>
      </form>

      {error && <div className="errors"><strong>Error:</strong> {error}</div>}

      {job && (
        <div className="panel live-status">
          <div className="live-row">
            <div>
              <div className="big-num">{status?.completed || 0}<span className="small">/{status?.total || job.totalQueries}</span></div>
              <div className="big-label">Queries</div>
            </div>
            <div>
              <div className="big-num">{filteredLeads.length}<span className="small">/{status?.leads?.length || 0}</span></div>
              <div className="big-label">Leads (filtered/total)</div>
            </div>
            <div>
              <div className="big-num">{status?.creditsUsed ?? '–'}</div>
              <div className="big-label">Credits used</div>
            </div>
            <div>
              <div className="big-num"><code>{status?.status || 'submitting'}</code></div>
              <div className="big-label">Status</div>
            </div>
          </div>
          {status?.total > 0 && (
            <div className="progress-bar">
              <div style={{ width: `${(status.completed / status.total) * 100}%` }} />
            </div>
          )}
          <div className="muted small-text">
            Firecrawl job <code>{job.jobId}</code> · submitted {new Date(job.submittedAt).toLocaleTimeString()}
            {status?.polledAt && <> · last polled {new Date(status.polledAt).toLocaleTimeString()}</>}
          </div>
        </div>
      )}

      {status?.filingsCompletedThrough && (
        <div className="meta">Registry current through: <strong>{status.filingsCompletedThrough}</strong></div>
      )}

      {job?.queries && (
        <details className="panel" open>
          <summary><strong>Per-query results ({job.queries.length})</strong></summary>
          <table className="compact">
            <thead>
              <tr><th>#</th><th>Query</th><th>HTTP</th><th>Rows</th><th>Total matched</th></tr>
            </thead>
            <tbody>
              {job.queries.map((q, i) => {
                const r = status?.perQuery?.find(x => x.query === q.query);
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><code>{q.query}</code></td>
                    <td>{r?.status || (running ? '…' : '–')}</td>
                    <td>{r?.leadCount ?? '–'}</td>
                    <td className="muted">{r?.totalMatched || '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}

      {pollLog.length > 0 && (
        <details className="panel">
          <summary><strong>Activity log ({pollLog.length})</strong></summary>
          <ul className="log">
            {pollLog.map((e, i) => <li key={i}><span className="muted">{e.time}</span> {e.msg}</li>)}
          </ul>
        </details>
      )}

      {filteredLeads.length > 0 && (
        <div className="panel">
          <div className="csv-tabs">
            <strong>CSV preview</strong>
            <div className="chips">
              <button type="button" className={`chip ${csvPreview === 'raw' ? 'on' : ''}`} onClick={() => setCsvPreview('raw')}>Raw</button>
              <button type="button" className={`chip ${csvPreview === 'ghl' ? 'on' : ''}`} onClick={() => setCsvPreview('ghl')}>Go High Level</button>
            </div>
            <span className="muted small-text">
              {csvPreview === 'raw'
                ? 'Plain dump of every column the scraper extracted.'
                : 'Mapped to GHL Contact import: Company Name = debtor, Address/City/State/Postal Code populated, UCC# + status in Notes, tags pre-built.'}
            </span>
          </div>
          <pre className="csv-preview">{previewText.split('\n').slice(0, 30).join('\n')}{previewText.split('\n').length > 30 ? '\n…' : ''}</pre>
        </div>
      )}

      {filteredLeads.length > 0 && (
        <>
          <h3>Leads ({filteredLeads.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Debtor</th>
                <th>UCC #</th>
                <th>Year</th>
                <th>Address</th>
                <th>City</th>
                <th>State</th>
                <th>Zip</th>
                <th>Status</th>
                <th>Source query</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.slice(0, 500).map((l, i) => (
                <tr key={i}>
                  <td>{l.debtor_name}</td>
                  <td><code>{l.ucc_number}</code></td>
                  <td>{l.filing_year}</td>
                  <td>{l.address}</td>
                  <td>{l.city}</td>
                  <td>{l.state}</td>
                  <td>{l.zip}</td>
                  <td>{l.status}</td>
                  <td className="muted">{l.source_query}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredLeads.length > 500 && (
            <div className="meta muted">Showing first 500. Export CSV for the full list.</div>
          )}
        </>
      )}

      <footer>
        <p>
          Data: floridaucc.com · Note: the result list doesn't expose filing date or secured-party fields directly; UCC number's first 4 digits are the year. For production volume use Florida's
          {' '}<a href="https://floridaucc.com/" target="_blank" rel="noreferrer">UCC Secured Transactions Download</a>.
        </p>
      </footer>
    </div>
  );
}
