import { useEffect, useRef, useState } from 'react';

const MCA_LENDERS = [
  'KABBAGE', 'ONDECK', 'BLUEVINE', 'SQUARE CAPITAL', 'FUNDING CIRCLE',
  'PAYPAL WORKING CAPITAL', 'AMERICAN EXPRESS MERCHANT FINANCING',
  'SHOPIFY CAPITAL', 'FUNDBOX', 'LENDIO', 'CAN CAPITAL', 'RAPID FINANCE',
  'CREDIBLY', 'CELTIC BANK', 'WEBBANK', 'WORLD BUSINESS LENDERS',
];

const TIME_WINDOWS = [
  { id: 'all',    label: 'All time',     days: null },
  { id: '24h',    label: 'Last 24 hours', days: 1 },
  { id: '7d',     label: 'Last 7 days',  days: 7 },
  { id: '30d',    label: 'Last 30 days', days: 30 },
  { id: '90d',    label: 'Last 90 days', days: 90 },
];

export default function App() {
  const [mode, setMode] = useState('debtor');           // 'debtor' | 'lender'
  const [timeWindow, setTimeWindow] = useState('30d');
  const [maxQueries, setMaxQueries] = useState(36);
  const [leadCap, setLeadCap] = useState(500);
  const [selectedLenders, setSelectedLenders] = useState([...MCA_LENDERS]);
  const [customNames, setCustomNames] = useState('');

  const [job, setJob] = useState(null);                  // {jobId, totalQueries}
  const [status, setStatus] = useState(null);            // poll response
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const pollTimer = useRef(null);

  useEffect(() => () => clearTimeout(pollTimer.current), []);

  function toggleLender(l) {
    setSelectedLenders(curr => curr.includes(l) ? curr.filter(x => x !== l) : [...curr, l]);
  }

  async function runSweep() {
    setError(null);
    setStatus(null);
    setJob(null);
    setRunning(true);
    clearTimeout(pollTimer.current);

    const customs = customNames.split(',').map(s => s.trim()).filter(Boolean);
    const submitBody = {
      searchType: mode,
      matchMode: 'BeginsWith',
      maxQueries: parseInt(maxQueries, 10) || 36,
      customNames: customs,
    };
    if (mode === 'debtor') submitBody.sweep = true;
    else submitBody.prefixes = selectedLenders;

    try {
      const res = await fetch('/api/scrape-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitBody),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`);
      setJob({ jobId: data.jobId, totalQueries: data.totalQueries });
      pollStatus(data.jobId);
    } catch (err) {
      setError(err.message);
      setRunning(false);
    }
  }

  async function pollStatus(jobId) {
    try {
      const res = await fetch(`/api/scrape-status?id=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Status failed (${res.status})`);
      setStatus(data);

      const filteredCount = applyFilters(data.leads).length;
      const done = data.status === 'completed' || data.status === 'failed';
      const capHit = filteredCount >= (parseInt(leadCap, 10) || Infinity);

      if (done || capHit) {
        setRunning(false);
      } else {
        pollTimer.current = setTimeout(() => pollStatus(jobId), 4000);
      }
    } catch (err) {
      setError(err.message);
      setRunning(false);
    }
  }

  function cancelPolling() {
    clearTimeout(pollTimer.current);
    setRunning(false);
  }

  function applyFilters(leads) {
    if (!leads) return [];
    const days = TIME_WINDOWS.find(t => t.id === timeWindow)?.days;
    if (!days) return leads;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return leads.filter(l => {
      const d = parseDate(l.filing_date);
      return d && d >= cutoff;
    });
  }

  function parseDate(s) {
    if (!s) return null;
    const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    return new Date(+m[3], +m[1] - 1, +m[2]);
  }

  function downloadCsv() {
    const rows = applyFilters(status?.leads || []).slice(0, parseInt(leadCap, 10) || Infinity);
    if (!rows.length) return;
    const headers = ['debtor_name', 'file_number', 'filing_date', 'filing_type', 'secured_party', 'address', 'source_query'];
    const body = rows.map(l => headers.map(h => `"${(l[h] ?? '').toString().replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...body].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fl-ucc-${mode}-${timeWindow}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredLeads = applyFilters(status?.leads || []).slice(0, parseInt(leadCap, 10) || Infinity);
  const completion = status ? `${status.completed || 0} / ${status.total || job?.totalQueries || 0}` : '';

  return (
    <div className="container">
      <header>
        <h1>Florida UCC Lead Pull</h1>
        <p className="sub">
          Async batch-scrape the Florida Secured Transaction Registry.
          Pick a mode, set a time window, cap the spend, and pull a CSV-ready lead list.
        </p>
      </header>

      <form className="panel" onSubmit={e => { e.preventDefault(); runSweep(); }}>
        <fieldset>
          <legend>Mode</legend>
          <label className="radio">
            <input type="radio" name="mode" checked={mode === 'debtor'} onChange={() => setMode('debtor')} />
            <span><strong>Debtor sweep</strong> — auto-walk A–Z + 0–9 to pull every business with a recent UCC filing.</span>
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={mode === 'lender'} onChange={() => setMode('lender')} />
            <span><strong>Lender (Secured Party)</strong> — pull every merchant funded by selected MCA funders.</span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Time window (filter)</legend>
          <div className="chips">
            {TIME_WINDOWS.map(t => (
              <button
                key={t.id}
                type="button"
                className={`chip ${timeWindow === t.id ? 'on' : ''}`}
                onClick={() => setTimeWindow(t.id)}
              >{t.label}</button>
            ))}
          </div>
        </fieldset>

        <div className="grid">
          <fieldset>
            <legend>Max queries (cost cap)</legend>
            <input type="number" min="1" max="50" value={maxQueries}
              onChange={e => setMaxQueries(e.target.value)} />
            <p className="hint">~5 Firecrawl credits per query. 36 = full A–Z sweep.</p>
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
            <legend>MCA lenders (click to toggle)</legend>
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
          <legend>Custom names (optional, comma-separated)</legend>
          <input type="text" value={customNames}
            onChange={e => setCustomNames(e.target.value)}
            placeholder={mode === 'lender' ? 'e.g. STRIPE CAPITAL, BREX' : 'e.g. AB, ACE'} />
        </fieldset>

        <div className="submit-row">
          {!running ? (
            <button type="submit">Run sweep</button>
          ) : (
            <button type="button" onClick={cancelPolling}>Stop polling</button>
          )}
          {filteredLeads.length > 0 && (
            <button type="button" className="primary" onClick={downloadCsv}>
              Export {filteredLeads.length} leads to CSV
            </button>
          )}
        </div>
      </form>

      {error && <div className="errors"><strong>Error:</strong> {error}</div>}

      {job && (
        <div className="progress">
          <div>
            <strong>Job {job.jobId.slice(0, 8)}…</strong> · Status: <code>{status?.status || 'submitting'}</code>
            · Queries: <strong>{completion}</strong>
            · Filtered leads: <strong>{filteredLeads.length}</strong>
            {status?.creditsUsed != null && <> · Credits: <strong>{status.creditsUsed}</strong></>}
          </div>
          {status?.total > 0 && (
            <div className="progress-bar">
              <div style={{ width: `${(status.completed / status.total) * 100}%` }} />
            </div>
          )}
        </div>
      )}

      {status?.filingsCompletedThrough && (
        <div className="meta">Registry current through: <strong>{status.filingsCompletedThrough}</strong></div>
      )}

      {filteredLeads.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Debtor</th>
              <th>File #</th>
              <th>Filed</th>
              <th>Type</th>
              <th>Secured Party</th>
              <th>Address</th>
              <th>Query</th>
            </tr>
          </thead>
          <tbody>
            {filteredLeads.slice(0, 500).map((l, i) => (
              <tr key={i}>
                <td>{l.debtor_name}</td>
                <td>{l.file_number}</td>
                <td>{l.filing_date}</td>
                <td>{l.filing_type}</td>
                <td>{l.secured_party}</td>
                <td>{l.address}</td>
                <td className="muted">{l.source_query}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {filteredLeads.length > 500 && (
        <div className="meta muted">Showing first 500 of {filteredLeads.length}. Export CSV for the full list.</div>
      )}

      <footer>
        <p>
          Data: floridaucc.com · For production-volume MCA lead lists, use Florida's
          {' '}<a href="https://floridaucc.com/" target="_blank" rel="noreferrer">UCC Secured Transactions Download</a> bulk feed.
        </p>
      </footer>
    </div>
  );
}
