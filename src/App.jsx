import { useEffect, useRef, useState } from 'react';

const MCA_LENDERS = [
  // High-volume bank originators for fintech MCAs:
  'CELTIC BANK', 'WEBBANK', 'CROSS RIVER BANK', 'AMERICAN EXPRESS NATIONAL BANK',
  // Direct MCA / fintech lenders — known active UCC filers:
  'KABBAGE', 'ON DECK CAPITAL', 'BLUEVINE', 'FUNDING CIRCLE',
  'SQUARE FINANCIAL SERVICES', 'FUNDBOX', 'SHOPIFY CAPITAL', 'CAN CAPITAL',
  'RAPID FINANCIAL', 'CREDIBLY', 'WORLD BUSINESS LENDERS', 'PEARL CAPITAL',
  'EVEREST BUSINESS FUNDING', 'EBF', 'MULLIGAN FUNDING', 'QUICKBRIDGE',
  'STRATEGIC FUNDING', 'IOU FINANCIAL', 'GREEN CAPITAL FUNDING', 'BIZFUND',
  'FOX CAPITAL', 'LENDISTRY', 'LENDR', 'KAPITUS',
  // Added round 2 — well-known MCA shops also active in UCC filings:
  'LIBERTAS FUNDING', 'FORA FINANCIAL', 'KNIGHTSBRIDGE FUNDING',
  'CFG MERCHANT SOLUTIONS', 'RELIANT FUNDING', 'VOX FUNDING',
  'UNITED CAPITAL SOURCE', 'CHANNEL PARTNERS CAPITAL', 'NEWCO CAPITAL',
  'HENRY BUSINESS CAPITAL', 'SBG FUNDING', 'HEADWAY CAPITAL', 'TORRO',
  'THE LCF GROUP', 'FUNDKITE', 'PREMIUM MERCHANT FUNDING', 'PIRS CAPITAL',
  'SNAP ADVANCES', 'UPWISE CAPITAL', 'NEWTEK BUSINESS LENDING',
  'NATIONAL BUSINESS CAPITAL', 'BREAKOUT CAPITAL', 'YELLOWSTONE CAPITAL',
  'FUNDRY', 'CAPITAL ONE BUSINESS',
];

const DOC_TYPES = [
  { id: 'Original',     label: 'Original',     desc: 'Fresh UCC-1 — best MCA leads' },
  { id: 'Amendment',    label: 'Amendment',    desc: 'Modified existing loan' },
  { id: 'Continuation', label: 'Continuation', desc: 'Extended 5-year filing' },
  { id: 'Assignment',   label: 'Assignment',   desc: 'Lender sold the debt' },
  { id: 'Termination',  label: 'Termination',  desc: 'Loan paid off — not useful for MCA' },
];

const DEFAULT_DOC_TYPES = ['Original', 'Amendment', 'Continuation'];

const DEFAULT_LENDERS = ['CELTIC BANK'];

const TIME_WINDOWS = [
  { id: '7d',   label: 'Last 7 days',   days: 7 },
  { id: '30d',  label: 'Last 30 days',  days: 30 },
  { id: '90d',  label: 'Last 90 days',  days: 90 },
  { id: '180d', label: 'Last 180 days', days: 180 },
  { id: '365d', label: 'Last 12 months (max for free account)', days: 365 },
];

const POLL_INTERVAL_MS = 3000;
// No hard client timeout. We poll as long as Firecrawl says the job is alive
// (status=scraping). Real expiration comes from Firecrawl's own expiresAt field.
// We warn the user if the job appears stuck (no field changes for STUCK_WARN_MS)
// but never auto-kill — they cancel manually.
const STUCK_WARN_MS = 90000;

function mmddyyyy(d) { return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [timeWindow, setTimeWindow] = useState('365d');
  const [stemSearch, setStemSearch] = useState(true);
  const [maxrows, setMaxrows] = useState(100);
  const [selectedLenders, setSelectedLenders] = useState([...DEFAULT_LENDERS]);
  const [customNames, setCustomNames] = useState('');
  const [preview, setPreview] = useState('raw'); // 'raw' | 'ghl' | 'json'
  const [docTypeFilter, setDocTypeFilter] = useState([...DEFAULT_DOC_TYPES]);
  const [customTags, setCustomTags] = useState('');
  const [notesPrefix, setNotesPrefix] = useState('');

  // Enrichment state: file_number → { apollo: {...}, batch: {...}, status }
  const [enrichment, setEnrichment] = useState({});
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState(null);
  // BatchData disabled by default per user preference (too expensive).
  // The /api/enrich-batch function still exists; flip batch:true here to re-enable.
  const [enrichSources, setEnrichSources] = useState({ apollo: true, batch: false });
  const enrichCancelRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('idle');    // 'idle' | 'submitting' | 'polling' | 'parsing' | 'done'
  const [currentIdx, setCurrentIdx] = useState(0);
  const [currentLender, setCurrentLender] = useState(null);
  const [currentJobId, setCurrentJobId] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const [lenderElapsed, setLenderElapsed] = useState(0);
  const [lastPoll, setLastPoll] = useState(null); // full last poll response
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

      // Poll until Firecrawl says it's done (or user cancels). No hard timeout —
      // we trust Firecrawl's expiresAt field as the real expiry.
      setPhase('polling');
      let final = null;
      let polls = 0;
      let lastStatus = null;
      let scrapingRunStart = 0;
      let lastChangeAt = Date.now();
      let stuckWarned = false;

      while (!cancelRef.current) {
        await sleep(POLL_INTERVAL_MS);
        polls += 1;
        setPollCount(polls);
        try {
          const res = await fetch(`/api/scrape-poll?id=${encodeURIComponent(jobId)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setLastPoll(data);  // expose full poll response to UI

          // Detect status change → log meaningful event.
          if (data.status !== lastStatus) {
            lastChangeAt = Date.now();
            stuckWarned = false;
            if (lastStatus === 'scraping' && data.status !== 'scraping') {
              const dur = ((Date.now() - scrapingRunStart) / 1000).toFixed(1);
              pushLog(`  · scraping took ${dur}s · ${data.creditsUsed || 0} credits`);
            }
            if (data.status === 'scraping') {
              scrapingRunStart = Date.now();
              pushLog(`  · Firecrawl: scraping started${data.expiresAt ? ` · expires ${new Date(data.expiresAt).toLocaleTimeString()}` : ''}`);
            } else if (data.status === 'completed') {
              pushLog(`  · Firecrawl: completed · ${data.creditsUsed || 0} credits · page_kind=${data.page_kind || '?'} · ${data.filings?.length || 0} filings / ${data.variants?.length || 0} variants${data.total_matched ? ` · "${data.total_matched}"` : ''}`);
            } else if (data.status === 'failed') {
              pushLog(`  ✗ Firecrawl: failed${data.error ? ` — ${data.error}` : ''}`);
            } else {
              pushLog(`  · status: ${data.status}`);
            }
            lastStatus = data.status;
          } else if (data.status === 'scraping' && !stuckWarned && Date.now() - lastChangeAt > STUCK_WARN_MS) {
            pushLog(`  ⚠ ${Math.floor(STUCK_WARN_MS / 1000)}s with no change — job may be slow or stuck. Click "Stop after current lender" to skip.`);
            stuckWarned = true;
          }

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
          finalUrl: final.finalUrl,
          markdownSnippet: final.markdownSnippet,
          markdownLength: final.markdownLength,
          pageTitle: final.pageTitle,
          firecrawlError: final.error,
          elapsedMs,
        };
        results.push(r);
        setPerLender([...results]);
        pushLog(`  ✓ ${r.page_kind || final.status}: ${r.variants.length} variants, ${r.filings.length} filings (${(elapsedMs / 1000).toFixed(1)}s)`);
      } else {
        results.push({ lender, status: 'error', error: 'cancelled', variants: [], filings: [], elapsedMs });
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

  // Run enrichment for all currently-filtered leads. Chains Apollo → Batch:
  // Apollo identifies the owner from the business name; Batch then skip-traces
  // that owner's personal cell + email. Either step is optional via toggles.
  async function enrichAll() {
    setError(null);
    setEnriching(true);
    enrichCancelRef.current = false;
    const targets = leads;
    const acc = { ...enrichment };
    for (let i = 0; i < targets.length; i++) {
      if (enrichCancelRef.current) break;
      const l = targets[i];
      const key = l.file_number + '|' + l.debtor_name;
      setEnrichProgress({ current: i + 1, total: targets.length, lender: l.debtor_name });
      if (acc[key]?.status === 'ok') continue; // already enriched

      const entry = acc[key] || {};
      // Apollo step
      if (enrichSources.apollo) {
        try {
          const res = await fetch('/api/enrich-apollo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ businessName: l.debtor_name, state: 'GA' }),
          });
          const data = await res.json();
          entry.apollo = data;
        } catch (err) {
          entry.apollo = { status: 'error', error: err.message };
        }
      }
      // Batch step — needs owner name from Apollo (or skip if not available)
      if (enrichSources.batch) {
        const owner = entry.apollo?.owner;
        if (owner?.first_name || owner?.last_name) {
          try {
            const res = await fetch('/api/enrich-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                firstName: owner.first_name,
                lastName: owner.last_name,
                state: 'GA',
                city: owner.city || entry.apollo?.business?.city,
              }),
            });
            const data = await res.json();
            entry.batch = data;
          } catch (err) {
            entry.batch = { status: 'error', error: err.message };
          }
        } else {
          entry.batch = { status: 'skipped', reason: 'No owner identified by Apollo — Batch needs a first/last name' };
        }
      }
      entry.status = 'ok';
      acc[key] = entry;
      setEnrichment({ ...acc });
    }
    setEnrichProgress(null);
    setEnriching(false);
  }

  function cancelEnrich() { enrichCancelRef.current = true; }

  function leadKey(l) { return l.file_number + '|' + l.debtor_name; }
  function getEnriched(l) {
    const e = enrichment[leadKey(l)];
    if (!e) return null;
    return {
      business_phone: e.apollo?.business?.phone || '',
      business_website: e.apollo?.business?.website || '',
      industry: e.apollo?.business?.industry || '',
      owner_name: e.apollo?.owner?.full_name || '',
      owner_title: e.apollo?.owner?.title || '',
      owner_email: e.apollo?.owner?.email || '',
      owner_phone_business: e.apollo?.owner?.phone || '',
      owner_mobile: e.batch?.person?.mobile || '',
      owner_landline: e.batch?.person?.landline || '',
      owner_personal_email: e.batch?.person?.email || '',
      owner_address: e.batch?.person?.current_address || '',
      apollo_status: e.apollo?.status || '',
      batch_status: e.batch?.status || '',
    };
  }

  // Aggregate + dedupe (on file_number + debtor_name) + filter by doc type.
  const allLeads = (() => {
    const seen = new Set();
    const out = [];
    for (const q of perLender) {
      for (const f of (q.filings || [])) {
        const key = `${f.file_number || ''}|${f.debtor_name || ''}`;
        if (key === '|' || seen.has(key)) continue;
        seen.add(key);
        out.push({ ...f, source_lender: q.lender });
      }
    }
    return out;
  })();
  const leads = allLeads.filter(l => {
    if (!docTypeFilter.length) return true;
    return docTypeFilter.includes(l.document_type);
  });

  function rawCsv(rows) {
    const headers = [
      'file_number', 'document_type', 'debtor_name', 'date_filed', 'original_file_number', 'source_lender',
      'business_phone', 'business_website', 'industry',
      'owner_name', 'owner_title', 'owner_email', 'owner_phone',
    ];
    return [headers.join(','), ...rows.map(l => {
      const e = getEnriched(l) || {};
      const merged = { ...e, owner_phone: e.owner_phone_business || e.owner_mobile || e.owner_landline || '' };
      return headers.map(h => csvCell(l[h] !== undefined ? l[h] : merged[h])).join(',');
    })].join('\n');
  }
  function ghlCsv(rows) {
    const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Company Name', 'Address', 'City', 'State', 'Postal Code', 'Country', 'Source', 'Tags', 'Notes'];
    const userTags = customTags.split(',').map(t => t.trim()).filter(Boolean);
    return [headers.join(','), ...rows.map(l => {
      const e = getEnriched(l) || {};
      const [firstName, ...rest] = (e.owner_name || '').split(' ');
      const lastName = rest.join(' ');
      const email = e.owner_email || e.owner_personal_email || '';
      const phone = e.owner_mobile || e.owner_phone_business || e.business_phone || e.owner_landline || '';
      const autoTags = [
        'ucc-ga-lead',
        l.source_lender && `lender-${l.source_lender.toLowerCase().replace(/\s+/g, '-')}`,
        l.document_type && `doc-${l.document_type.toLowerCase()}`,
        e.industry && `industry-${e.industry.toLowerCase().replace(/\s+/g, '-')}`,
        e.owner_mobile && 'has-cell',
        email && 'has-email',
      ].filter(Boolean);
      const tags = [...autoTags, ...userTags].join('; ');
      const noteParts = [
        notesPrefix && notesPrefix.trim(),
        `UCC #${l.file_number}`,
        l.date_filed && `Filed: ${l.date_filed}`,
        l.document_type && `Type: ${l.document_type}`,
        l.original_file_number && l.original_file_number !== 'N/A' && `Original: ${l.original_file_number}`,
        e.business_website && `Site: ${e.business_website}`,
        e.owner_title && `Owner title: ${e.owner_title}`,
        e.owner_landline && `Landline: ${e.owner_landline}`,
      ].filter(Boolean);
      const notes = noteParts.join(' | ');
      return [firstName || '', lastName, email, phone, l.debtor_name, e.owner_address || '', '', 'GA', '', 'US', `GA UCC - ${l.source_lender}`, tags, notes].map(csvCell).join(',');
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

        <fieldset>
          <legend>Filter by document type ({docTypeFilter.length} selected — applied to results)</legend>
          <div className="chips">
            {DOC_TYPES.map(t => (
              <button key={t.id} type="button" className={`chip ${docTypeFilter.includes(t.id) ? 'on' : ''}`} title={t.desc} onClick={() => setDocTypeFilter(curr => curr.includes(t.id) ? curr.filter(x => x !== t.id) : [...curr, t.id])}>
                {t.label}
              </button>
            ))}
          </div>
          <details className="doc-cheat">
            <summary><strong>📖 Document type cheat sheet — MCA lead quality guide</strong></summary>
            <table className="compact">
              <thead><tr><th>Type</th><th>What it means</th><th>MCA value</th></tr></thead>
              <tbody>
                <tr>
                  <td><strong>Original</strong></td>
                  <td>Fresh UCC-1 financing statement. Brand-new loan just filed.</td>
                  <td>🟢 <strong>Best leads</strong> — they just took on debt, may want to stack/refi</td>
                </tr>
                <tr>
                  <td><strong>Amendment</strong></td>
                  <td>UCC-3 modifies an existing filing (collateral change, add debtor, etc.)</td>
                  <td>🟡 Active borrower, still owes</td>
                </tr>
                <tr>
                  <td><strong>Continuation</strong></td>
                  <td>Extends life of existing filing past the 5-year mark</td>
                  <td>🟡 Active borrower, long-term — loan still going</td>
                </tr>
                <tr>
                  <td><strong>Termination</strong></td>
                  <td>Releases the security interest. Loan was paid off / settled.</td>
                  <td>🔴 <strong>Worthless for MCA</strong> — they have no more debt</td>
                </tr>
                <tr>
                  <td><strong>Assignment</strong></td>
                  <td>Lender sold/transferred the debt to another party</td>
                  <td>⚪ Neutral — borrower still owes, but to someone else</td>
                </tr>
              </tbody>
            </table>
            <p className="hint">
              Filter is applied client-side after scraping — change anytime without re-running. Default: Original + Amendment + Continuation. Termination off by default (no MCA value).
            </p>
          </details>
        </fieldset>

        <fieldset>
          <legend>GHL custom tags (appended to auto-tags, comma-separated)</legend>
          <input type="text" value={customTags} onChange={e => setCustomTags(e.target.value)} placeholder="e.g. mca-campaign-jan, hot-list, cold-call-batch-1" />
          <p className="hint">Auto-tags always added: <code>ucc-ga-lead</code>, <code>lender-celtic-bank</code>, <code>doc-original</code>, etc.</p>
        </fieldset>

        <fieldset>
          <legend>GHL Notes prefix (optional, prepended to every contact's Notes)</legend>
          <input type="text" value={notesPrefix} onChange={e => setNotesPrefix(e.target.value)} placeholder="e.g. Imported 2026-01-15 batch · MCA refi opportunity" />
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
            {currentJobId && <> · Firecrawl job <code>{currentJobId}</code></>}
            {lastPoll?.expiresAt && <> · Firecrawl expires {new Date(lastPoll.expiresAt).toLocaleTimeString()}</>}
            <br/>
            <strong>No client-side timeout.</strong> We poll for as long as Firecrawl says the job is alive. Cancel manually if you want to stop.
            {lastPoll?.status === 'scraping' && lenderElapsed > 90 && (
              <span style={{ color: '#d29922' }}>
                {' '}· This run is taking longer than usual (Firecrawl's typical: 30–60s).
              </span>
            )}
            <br/>
            Firecrawl runs login → search → drill in a real browser on their side. The job status stays "scraping" until <em>everything</em> completes — they don't expose intermediate steps over their API.
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
              <div className="big-num">{leads.length}<span className="small">/{allLeads.length}</span></div>
              <div className="big-label">Leads (filtered/total)</div>
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
            <thead><tr><th>#</th><th>Lender</th><th>Page kind</th><th>Total matched</th><th>Variants</th><th>Filings</th><th>Credits</th><th>Elapsed</th><th>Final URL</th><th>Error</th></tr></thead>
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
                  <td className="muted small-text" style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.finalUrl ? new URL(q.finalUrl).pathname : '–'}</td>
                  <td className="muted">{q.error || q.firecrawlError || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {perLender.some(q => q.markdownSnippet) && (
        <details className="panel">
          <summary><strong>What Firecrawl actually saw</strong> — page content per lender (debug)</summary>
          {perLender.filter(q => q.markdownSnippet).map((q, i) => (
            <div key={i} style={{ marginBottom: '1.25rem' }}>
              <div className="muted small-text">
                <strong>{q.lender}</strong>
                {q.pageTitle && <> · title: <em>{q.pageTitle}</em></>}
                {q.finalUrl && <> · final URL: <code>{q.finalUrl}</code></>}
                {q.markdownLength != null && <> · full markdown: {q.markdownLength.toLocaleString()} chars</>}
              </div>
              <pre className="csv-preview" style={{ maxHeight: '300px' }}>{q.markdownSnippet}</pre>
            </div>
          ))}
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
          <div className="csv-tabs" style={{ marginBottom: '0.5rem' }}>
            <strong>🔎 Enrichment (Apollo.io)</strong>
            <span className="muted small-text">Finds owner name, business email, business phone, industry</span>
          </div>
          <p className="hint" style={{ marginBottom: '0.75rem' }}>
            For each lead, Apollo runs 2 calls (org enrich + people search at that org) to find the owner/founder/CEO. ~2 credits per lead ≈ $0.20.
            Coverage typically 40–70% — better for established businesses, weaker for one-person LLCs.
            Requires <code>APOLLO_API_KEY</code> env var set in Netlify.
          </p>
          <div className="submit-row" style={{ paddingTop: 0, borderTop: 'none' }}>
            {!enriching ? (
              <button type="button" onClick={enrichAll}>
                Enrich {leads.filter(l => enrichment[leadKey(l)]?.status !== 'ok').length} lead{leads.length === 1 ? '' : 's'} with Apollo
              </button>
            ) : (
              <button type="button" onClick={cancelEnrich}>Stop enrichment</button>
            )}
            <button type="button" className="link" onClick={() => setEnrichment({})}>Clear enrichment cache</button>
          </div>
          {enrichProgress && (
            <div className="muted small-text" style={{ marginTop: '0.5rem' }}>
              Enriching <strong>{enrichProgress.current}</strong> of <strong>{enrichProgress.total}</strong> — current: <code>{enrichProgress.lender}</code>
            </div>
          )}
        </div>
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
              <tr>
                <th>Debtor (Lead)</th>
                <th>Doc Type</th>
                <th>Date Filed</th>
                <th>Owner</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Funded By</th>
              </tr>
            </thead>
            <tbody>
              {leads.slice(0, 500).map((l, i) => {
                const e = getEnriched(l) || {};
                const phone = e.owner_mobile || e.owner_phone_business || e.business_phone || e.owner_landline || '';
                const email = e.owner_email || e.owner_personal_email || '';
                return (
                  <tr key={i}>
                    <td>
                      <strong>{l.debtor_name}</strong>
                      <div className="muted small-text"><code>{l.file_number}</code></div>
                    </td>
                    <td>{l.document_type}</td>
                    <td>{l.date_filed}</td>
                    <td>
                      {e.owner_name ? <><strong>{e.owner_name}</strong><div className="muted small-text">{e.owner_title}</div></> : <span className="muted">—</span>}
                    </td>
                    <td>{phone || <span className="muted">—</span>}{e.owner_mobile && <div className="muted small-text">📱 mobile</div>}</td>
                    <td>{email || <span className="muted">—</span>}</td>
                    <td className="muted">{l.source_lender}</td>
                  </tr>
                );
              })}
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
