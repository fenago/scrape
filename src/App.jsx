import { useState } from 'react';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

const MCA_LENDERS = [
  'KABBAGE',
  'ONDECK',
  'BLUEVINE',
  'SQUARE CAPITAL',
  'FUNDING CIRCLE',
  'PAYPAL WORKING CAPITAL',
  'AMERICAN EXPRESS MERCHANT FINANCING',
  'SHOPIFY CAPITAL',
  'FUNDBOX',
  'LENDIO',
  'CAN CAPITAL',
  'RAPID FINANCE',
  'CREDIBLY',
  'CELTIC BANK',
  'WEBBANK',
  'WORLD BUSINESS LENDERS',
];

export default function App() {
  const [mode, setMode] = useState('debtor'); // 'debtor' | 'lender'
  const [prefixes, setPrefixes] = useState(['A']);
  const [customPrefix, setCustomPrefix] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [leads, setLeads] = useState([]);
  const [errors, setErrors] = useState([]);
  const [filingsThrough, setFilingsThrough] = useState(null);

  function togglePrefix(p) {
    setPrefixes(curr => (curr.includes(p) ? curr.filter(x => x !== p) : [...curr, p]));
  }
  function selectAllLetters() { setPrefixes([...ALPHABET]); }
  function clearPrefixes() { setPrefixes([]); }

  async function runBatch(e) {
    e.preventDefault();
    const queryList = [...prefixes];
    if (customPrefix.trim()) queryList.push(...customPrefix.split(',').map(s => s.trim()).filter(Boolean));
    if (!queryList.length) return;

    setRunning(true);
    setErrors([]);
    setLeads([]);
    setFilingsThrough(null);

    const seen = new Set();
    const collected = [];
    const errs = [];

    for (let i = 0; i < queryList.length; i++) {
      const q = queryList[i];
      setProgress({ current: i + 1, total: queryList.length, query: q });
      try {
        const res = await fetch('/api/search-ucc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prefix: q,
            searchType: mode,
            matchMode: 'BeginsWith',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const detail = data.firecrawl_details
            ? JSON.stringify(data.firecrawl_details).slice(0, 300)
            : '';
          errs.push({
            query: q,
            error: `${data.error || `HTTP ${res.status}`}${detail ? ` — ${detail}` : ''}`,
          });
          continue;
        }
        if (data.filingsCompletedThrough && !filingsThrough) {
          setFilingsThrough(data.filingsCompletedThrough);
        }
        for (const lead of data.leads || []) {
          const key = `${lead.file_number || ''}|${lead.debtor_name || ''}`;
          if (key !== '|' && !seen.has(key)) {
            seen.add(key);
            collected.push({ ...lead, source_query: q });
            setLeads([...collected]);
          }
        }
      } catch (err) {
        errs.push({ query: q, error: err.message });
      }
    }

    setErrors(errs);
    setProgress(null);
    setRunning(false);
  }

  function downloadCsv() {
    if (!leads.length) return;
    const headers = ['debtor_name', 'file_number', 'filing_date', 'filing_type', 'secured_party', 'address', 'source_query'];
    const rows = leads.map(l =>
      headers.map(h => `"${(l[h] ?? '').toString().replace(/"/g, '""')}"`).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fl-ucc-leads-${mode}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="container">
      <header>
        <h1>Florida UCC Lead Pull</h1>
        <p className="sub">
          Bulk-extract UCC filings from the Florida Secured Transaction Registry.
          Pick a mode, choose prefixes, and the app will enumerate the registry and dedupe results into a CSV-ready lead list.
        </p>
      </header>

      <form onSubmit={runBatch} className="panel">
        <fieldset>
          <legend>Mode</legend>
          <label className="radio">
            <input type="radio" name="mode" checked={mode === 'debtor'} onChange={() => setMode('debtor')} />
            <span><strong>Debtor name</strong> — pull all businesses with a UCC filed against them (every business that took financing).</span>
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={mode === 'lender'} onChange={() => setMode('lender')} />
            <span><strong>Secured Party (lender)</strong> — pull every merchant funded by a specific lender. Great for stealing MCA funder lead lists.</span>
          </label>
        </fieldset>

        {mode === 'lender' ? (
          <fieldset>
            <legend>MCA lenders (click to toggle)</legend>
            <div className="chips">
              {MCA_LENDERS.map(l => (
                <button
                  key={l}
                  type="button"
                  className={`chip ${prefixes.includes(l) ? 'on' : ''}`}
                  onClick={() => togglePrefix(l)}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="link" onClick={clearPrefixes}>Clear</button>
            </div>
          </fieldset>
        ) : (
          <fieldset>
            <legend>Debtor name prefixes (A–Z, 0–9)</legend>
            <div className="chips">
              {ALPHABET.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`chip ${prefixes.includes(c) ? 'on' : ''}`}
                  onClick={() => togglePrefix(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="link" onClick={selectAllLetters}>Select A–Z + 0–9</button>
              <button type="button" className="link" onClick={clearPrefixes}>Clear</button>
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend>Custom names (comma-separated, optional)</legend>
          <input
            type="text"
            value={customPrefix}
            onChange={e => setCustomPrefix(e.target.value)}
            placeholder={mode === 'lender' ? 'e.g. SQUARE CAPITAL, STRIPE CAPITAL' : 'e.g. AB, ACE, AMER'}
          />
        </fieldset>

        <div className="submit-row">
          <button type="submit" disabled={running || (!prefixes.length && !customPrefix.trim())}>
            {running ? 'Pulling…' : `Run batch (${prefixes.length + (customPrefix.trim() ? customPrefix.split(',').filter(s => s.trim()).length : 0)} queries)`}
          </button>
          {leads.length > 0 && (
            <button type="button" className="primary" onClick={downloadCsv}>
              Export {leads.length} leads to CSV
            </button>
          )}
        </div>
      </form>

      {progress && (
        <div className="progress">
          Querying <strong>{progress.query}</strong> ({progress.current} / {progress.total})…
          <div className="progress-bar"><div style={{ width: `${(progress.current / progress.total) * 100}%` }} /></div>
        </div>
      )}

      {filingsThrough && (
        <div className="meta">Registry current through: <strong>{filingsThrough}</strong></div>
      )}

      {leads.length > 0 && (
        <>
          <div className="meta">
            Collected <strong>{leads.length}</strong> unique leads across <strong>{prefixes.length + (customPrefix.trim() ? customPrefix.split(',').filter(s => s.trim()).length : 0)}</strong> queries.
          </div>
          <table>
            <thead>
              <tr>
                <th>Debtor</th>
                <th>File #</th>
                <th>Filed</th>
                <th>Type</th>
                <th>Secured Party</th>
                <th>Address</th>
                <th>Source query</th>
              </tr>
            </thead>
            <tbody>
              {leads.slice(0, 500).map((l, i) => (
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
          {leads.length > 500 && (
            <div className="meta muted">Showing first 500 of {leads.length}. Export to CSV for the full list.</div>
          )}
        </>
      )}

      {errors.length > 0 && (
        <div className="errors">
          <h3>Errors ({errors.length})</h3>
          <ul>
            {errors.map((e, i) => <li key={i}><code>{e.query}</code>: {e.error}</li>)}
          </ul>
        </div>
      )}

      <footer>
        <p>
          Data: floridaucc.com · Scraping is rate-limited and best for moderate volume.
          For daily production volume, see Florida's <a href="https://floridaucc.com/" target="_blank" rel="noreferrer">UCC Secured Transactions Download</a> bulk feed.
        </p>
      </footer>
    </div>
  );
}
