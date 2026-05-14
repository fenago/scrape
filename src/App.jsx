import { useEffect, useRef, useState } from 'react';

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

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 90000;

function mmddyyyy(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [timeWindow, setTimeWindow] = useState('365d');
  const [stemSearch, setStemSearch] = useState(true);
  const [maxrows, setMaxrows] = useState(100);
  const [selectedLenders, setSelectedLenders] = useState([...DEFAULT_LENDERS]);
  const [customNames, setCustomNames] = useState('');
  const [preview, setPreview] = useState('raw'); // 'raw' | 'ghl' | 'json'

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('idle');    // 'idle' | 'submitting' | 'polling' | 'parsing' | 'done'
  const [currentIdx, setCurrentIdx] = useState(0);
  const [currentLender, setCurrentLender] = useState(null);
  const [currentJobId, setCurrentJobId] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const [lenderElapsed, setLenderElapsed] = useState(0);
  const [log, setLog] = useState([]);             // [{time, msg}]
  const [perLender, setPerLender] = useState([]); // accumulated results
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);
  const lenderStartRef = useRef(0);

  // Tick the elapsed counter every 500ms while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setLenderElapsed(Math.floor((Date.now() - lenderStartRef.current) / 1000));
    }, 500);
    return () => clearInterval(t);
  }, [running]);

  function pushLog(msg) {
    setLog(curr => [{ time: new Date().toLocaleTimeString(), msg }, ...curr].slice(0, 100));
  }

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
    setLog([]);
    setPhase('idle');
    cancelRef.current = false;

    const customs = customNames.split(',').map(s => s.trim()).filter(Boolean);
    const lenders = [...new Set([...selectedLenders, ...customs])];
    if (!lenders.length) { setError('Pick at least one lender.'); return; }

    const { fromDate, toDate } = dateRange();
    setRunning(true);
    pushLog(`Starting sweep: ${lenders.length} lender(s), ${fromDate} → ${toDate}`);

    const results = [];

    for (let i = 0; i < lenders.length; i++) {
      if (cancelRef.current) { pushLog('⏸ Stopped by user'); break; }
      const lender = lenders[i];
      lenderStartRef.current = Date.now();
      setCurrentIdx(i + 1);
      setCurrentLender(lender);
      setCurrentJobId(null);
      setPollCount(0);
      setLenderElapsed(0);
      setPhase('submitting');
      pushLog(`▶ Lender ${i + 1}/${lenders.length}: ${lender} — submitting to Firecrawl…`);

      let jobId;
      try {
        const res = await fetch('/api/scrape-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lender, fromDate, toDate, maxrows: parseInt(maxrows, 10) || 100, stemSearch }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        jobId = data.jobId;
        setCurrentJobId(jobId);
        pushLog(`  → Job ${jobId.slice(0, 8)}… submitted. Polling every ${POLL_INTERVAL_MS / 1000}s…`);
      } catch (err) {
        const failure = { lender, status: 'error', error: `Submit: ${err.message}`, variants: [], filings: [], elapsedMs: Date.now() - lenderStartRef.current };
        results.push(failure);
        setPerLender([...results]);
        pushLog(`  ✗ Submit failed: ${err.message}`);
        continue;
      }

      // Poll until done.
      setPhase('polling');
      const pollStart = Date.now();
      let final = null;
      let polls = 0;
      while (!cancelRef.current) {
        if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
          pushLog(`  ✗ Poll timeout after ${POLL_TIMEOUT_MS / 1000}s`);
          break;
        }
        await sleep(POLL_INTERVAL_MS);
        polls += 1;
        setPollCount(polls);
        try {
          const res = await fetch(`/api/scrape-poll?id=${encodeURIComponent(jobId)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          pushLog(`  poll #${polls}: status=${data.status}${data.creditsUsed ? ` · ${data.creditsUsed} credits` : ''}`);
          if (data.status === 'completed' || data.status === 'failed') { final = data; break; }
        } catch (err) {
          pushLog(`  ✗ Poll error: ${err.message}`);
        }
      }

      const elapsedMs = Date.now() - lenderStartRef.current;
      if (final) {
        const r = {
          lender,
          status: final.status === 'completed' ? 'ok' : 'error',
          page_kind: final.page_kind,
          total_matched: final.total_matched,
          variants: final.variants || [],
          filings: final.filings || [],
          creditsUsed: final.creditsUsed,
          elapsedMs,
        };
        results.push(r);
        setPerLender([...results]);
        pushLog(`  ✓ ${r.page_kind || final.status}: ${r.variants.length} variants, ${r.filings.length} filings (${(elapsedMs / 1000).toFixed(1)}s)`);
      } else {
        results.push({ lender, status: 'error', error: 'timeout or cancelled', variants: [], filings: [], elapsedMs });
        setPerLender([...results]);
      }
    }

    setPhase('done');
    setRunning(false);
    pushLog(`✓ Sweep complete. ${results.reduce((s, r) => s + (r.filings?.length || 0), 0)} total filings.`);
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
  function jsonExport(rows) { return JSON.stringify(rows, null, 2); }
  function csvCell(v) { return `"${(v ?? '').toString().replace(/"/g, '""')}"`; }
  function downloadFile(text, filename, mime = 'text/csv') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  const previewText =
    preview === 'raw' ? rawCsv(leads) :
    preview === 'ghl' ? ghlCsv(leads) :
    jsonExport(leads);
  const totalFilings = perLender.reduce((s, q) => s + (q.filings?.length || 0), 0);
  const totalVariants = perLender.reduce((s, q) => s + (q.variants?.length || 0), 0);
  const totalCredits = perLender.reduce((s, q) => s + (q.creditsUsed || 0), 0);

  return (
    <div className="container">
      <header>
        <h1>Georgia UCC Lead Pull</h1>
        <p className="sub">
          Pull MCA leads from the Georgia GSCCCA UCC index. Async Firecrawl jobs (live polling every 2.5s) — survives Netlify's 10s sync timeout.
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
            <button type="button" className={`chip ${stemSearch ? 'on' : ''}`} onClick={() => setStemSearch(true)}>Stem (fuzzy)</button>
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
            <p className="hint">~12 Firecrawl credits per lender. ~25–40s each.</p>
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
                ⬇ Raw CSV ({leads.length})
              </button>
              <button type="button" className="primary" onClick={() => downloadFile(ghlCsv(leads), `ga-ucc-ghl-${Date.now()}.csv`)}>
                ⬇ GHL CSV
              </button>
              <button type="button" className="primary" onClick={() => downloadFile(jsonExport(leads), `ga-ucc-${Date.now()}.json`, 'application/json')}>
                ⬇ JSON
              </button>
            </>
          )}
        </div>
      </form>

      {error && <div className="errors"><strong>Error:</strong> {error}</div>}

      {/* LIVE STATUS — always visible while running */}
      {running && (
        <div className="panel live-status">
          <div className="live-row">
            <div>
              <div className="big-num">{currentIdx}<span className="small">/{selectedLenders.length + customNames.split(',').filter(s => s.trim()).length}</span></div>
              <div className="big-label">Lender</div>
            </div>
            <div>
              <div className="big-num" style={{ fontSize: '1rem' }}><code>{currentLender || '–'}</code></div>
              <div className="big-label">Now scraping</div>
            </div>
            <div>
              <div className="big-num">{lenderElapsed}s</div>
              <div className="big-label">Elapsed</div>
            </div>
            <div>
              <div className="big-num">{pollCount}</div>
              <div className="big-label">Polls</div>
            </div>
            <div>
              <div className="big-num">{leads.length}</div>
              <div className="big-label">Leads so far</div>
            </div>
          </div>
          <div className="progress-bar">
            <div style={{ width: `${(currentIdx - 1) / Math.max(1, selectedLenders.length + customNames.split(',').filter(s => s.trim()).length) * 100}%` }} />
          </div>
          <div className="muted small-text">
            Phase: <code>{phase}</code>
            {currentJobId && <> · Job <code>{currentJobId.slice(0, 12)}…</code></>}
            <br/>
            Steps: Firecrawl logs in → submits search → drills into biggest variant → AI-extracts the filings.
            Each lender ≈ 25–40 seconds. Live log below ⬇
          </div>
        </div>
      )}

      {log.length > 0 && (
        <details className="panel" open={running}>
          <summary><strong>Live log ({log.length})</strong></summary>
          <ul className="log">
            {log.map((e, i) => <li key={i}><span className="muted">{e.time}</span> {e.msg}</li>)}
          </ul>
        </details>
      )}

      {perLender.length > 0 && (
        <div className="panel live-status">
          <div className="live-row">
            <div>
              <div className="big-num">{perLender.length}</div>
              <div className="big-label">Lenders done</div>
            </div>
            <div>
              <div className="big-num">{leads.length}</div>
              <div className="big-label">Unique leads</div>
            </div>
            <div>
              <div className="big-num">{totalFilings}</div>
              <div className="big-label">Total filings</div>
            </div>
            <div>
              <div className="big-num">{totalVariants}</div>
              <div className="big-label">Variants seen</div>
            </div>
            <div>
              <div className="big-num">{totalCredits}</div>
              <div className="big-label">Credits used</div>
            </div>
          </div>
        </div>
      )}

      {perLender.length > 0 && (
        <details className="panel" open>
          <summary><strong>Per-lender results ({perLender.length})</strong></summary>
          <table className="compact">
            <thead><tr><th>#</th><th>Lender</th><th>Page kind</th><th>Total matched</th><th>Variants</th><th>Filings</th><th>Credits</th><th>Elapsed</th><th>Error</th></tr></thead>
            <tbody>
              {perLender.map((q, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><code>{q.lender}</code></td>
                  <td><code>{q.page_kind || q.status || '–'}</code></td>
                  <td className="muted">{q.total_matched || '–'}</td>
                  <td>{q.variants?.length || 0}</td>
                  <td>{q.filings?.length || 0}</td>
                  <td className="muted">{q.creditsUsed || '–'}</td>
                  <td className="muted">{((q.elapsedMs || 0) / 1000).toFixed(1)}s</td>
                  <td className="muted">{q.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {perLender.some(q => q.variants?.length > 0) && (
        <details className="panel">
          <summary><strong>Lender name variants seen</strong></summary>
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
            <strong>Export preview</strong>
            <div className="chips">
              <button type="button" className={`chip ${preview === 'raw' ? 'on' : ''}`} onClick={() => setPreview('raw')}>Raw CSV</button>
              <button type="button" className={`chip ${preview === 'ghl' ? 'on' : ''}`} onClick={() => setPreview('ghl')}>GHL CSV</button>
              <button type="button" className={`chip ${preview === 'json' ? 'on' : ''}`} onClick={() => setPreview('json')}>JSON</button>
            </div>
          </div>
          <pre className="csv-preview">{previewText.split('\n').slice(0, 40).join('\n')}{previewText.split('\n').length > 40 ? '\n…' : ''}</pre>
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
        <p>Source: GSCCCA GA UCC Index. Async Firecrawl jobs · live polling · sequential per lender. Uses your free GSCCCA limited-use account.</p>
      </footer>
    </div>
  );
}
