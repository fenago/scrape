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
  { id: 'Original',     label: 'Original',     desc: 'Fresh UCC-1 — actively in debt, prime stack/refi target' },
  { id: 'Amendment',    label: 'Amendment',    desc: 'Modified existing loan — still active borrower' },
  { id: 'Continuation', label: 'Continuation', desc: '5-year extension — still active long-term borrower' },
  { id: 'Assignment',   label: 'Assignment',   desc: 'Lender sold/transferred the debt' },
  { id: 'Termination',  label: 'Termination',  desc: 'Loan paid off — proven borrower, ready for a new MCA' },
];

const DEFAULT_DOC_TYPES = ['Original', 'Amendment', 'Continuation', 'Termination'];

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

// Empirical: 1 variants scrape + ~N drill scrapes per lender, each scrape ≈ 1
// Firecrawl credit. Most lenders surface 5–15 name variants, so ~12 is a
// reasonable single-number estimate to show before a sweep runs.
const CREDITS_PER_LENDER = 12;

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

  // Enrichment state: file_number → { gasos: {...}, apollo: {...}, batch: {...}, status }
  const [enrichment, setEnrichment] = useState({});
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState(null);
  // GA SoS + Apollo both on by default — they're complementary. SoS catches
  // small LLCs Apollo doesn't index; Apollo catches established businesses
  // with LinkedIn/web footprints. BatchData chains off either to get the
  // owner's personal cell + email.
  const [enrichSources, setEnrichSources] = useState({ gasos: true, apollo: true, batch: true });
  // Apollo reveal flags. Email is cheap (~1 credit), phone is expensive
  // (~8 credits) — phone is opt-in.
  const [apolloReveal, setApolloReveal] = useState({ email: true, phone: false });
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

      // ===== Phase 1: get variants list =====
      setPhase('submitting variants');
      pushLog(`▶ Lender ${i + 1}/${lenders.length}: ${lender} — getting variants list…`);
      let variantsResult;
      try {
        variantsResult = await runScrapeJob({
          mode: 'variants', lender,
          fromDate, toDate, maxrows: parseInt(maxrows, 10) || 100, stemSearch,
        });
      } catch (err) {
        results.push({ lender, status: 'error', error: `Variants scrape: ${err.message}`, variants: [], filings: [], elapsedMs: Date.now() - lenderStartRef.current });
        setPerLender([...results]);
        pushLog(`  ✗ Variants step failed: ${err.message}`);
        continue;
      }
      const variants = (variantsResult.variants || []).filter(v => v.instrument_count > 0);
      pushLog(`  · Found ${variants.length} variant(s) with results: ${variants.map(v => `${v.secured_party_name} (${v.instrument_count})`).join(', ') || '(none)'}`);

      // ===== Phase 2: drill each variant =====
      const allFilings = [];
      let creditsUsed = variantsResult.creditsUsed || 0;
      let perVariantStatus = [];

      // Intentionally NO cancel check inside the variant loop. The button is
      // labeled "Stop after current lender" — meaning we finish ALL variants
      // for the lender currently in flight, then stop before starting the
      // next lender (the cancel check at the top of the outer loop handles
      // that). Breaking mid-variant would discard partial filings and the
      // user would see "nothing returned".
      for (let v = 0; v < variants.length; v++) {
        const variant = variants[v];
        setPhase(`drilling variant ${v + 1}/${variants.length}`);
        pushLog(`  ↪ Drill ${v + 1}/${variants.length}: ${variant.secured_party_name} (${variant.instrument_count} expected)`);
        try {
          const drillResult = await runScrapeJob({
            mode: 'drill', lender,
            variantName: variant.secured_party_name,
            fromDate, toDate, maxrows: parseInt(maxrows, 10) || 100, stemSearch,
          });
          creditsUsed += drillResult.creditsUsed || 0;
          const got = (drillResult.filings || []).length;
          allFilings.push(...(drillResult.filings || []));
          perVariantStatus.push({ variant: variant.secured_party_name, expected: variant.instrument_count, got, status: 'ok' });
          pushLog(`     ✓ Got ${got} filings`);
        } catch (err) {
          perVariantStatus.push({ variant: variant.secured_party_name, expected: variant.instrument_count, got: 0, status: 'error', error: err.message });
          pushLog(`     ✗ Drill failed for "${variant.secured_party_name}": ${err.message}`);
        }
      }

      const elapsedMs = Date.now() - lenderStartRef.current;
      const r = {
        lender,
        status: 'ok',
        page_kind: variants.length ? 'variants→filings' : 'no-variants',
        total_matched: variants.reduce((s, v) => s + v.instrument_count, 0).toString(),
        variants,
        filings: allFilings,
        perVariant: perVariantStatus,
        creditsUsed,
        elapsedMs,
      };
      results.push(r);
      setPerLender([...results]);
      pushLog(`  ✓ Lender done: ${variants.length} variants, ${allFilings.length} filings, ${creditsUsed} credits (${(elapsedMs / 1000).toFixed(1)}s)`);
    }

    setPhase('done');
    setRunning(false);
    pushLog(`✓ Sweep complete. ${results.reduce((s, r) => s + (r.filings?.length || 0), 0)} total filings.`);
  }

  function cancel() {
    cancelRef.current = true;
  }

  // Submit one Firecrawl job (variants OR drill mode), poll until done,
  // return the parsed result. Throws on cancel or final failure.
  async function runScrapeJob({ mode, lender, variantName, fromDate, toDate, maxrows, stemSearch }) {
    const submitRes = await fetch('/api/scrape-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, lender, variantName, fromDate, toDate, maxrows, stemSearch }),
    });
    const submitData = await submitRes.json();
    if (!submitRes.ok) throw new Error(submitData.error || `submit HTTP ${submitRes.status}`);
    const jobId = submitData.jobId;
    setCurrentJobId(jobId);

    let lastStatus = null;
    let lastChangeAt = Date.now();
    let stuckWarned = false;
    // Note: we do NOT abort the poll on cancelRef. "Stop after current lender"
    // means finish the in-flight scrape and let its results land; the outer
    // loop is what actually stops the sweep. Aborting mid-poll would discard
    // partial work and leave the user with empty results.
    while (true) {
      await sleep(POLL_INTERVAL_MS);
      setPollCount(c => c + 1);
      const pollRes = await fetch(`/api/scrape-poll?id=${encodeURIComponent(jobId)}`);
      const data = await pollRes.json();
      if (!pollRes.ok) {
        // Don't bail on transient errors — keep polling unless 4xx.
        if (pollRes.status >= 400 && pollRes.status < 500) throw new Error(data.error || `poll HTTP ${pollRes.status}`);
        continue;
      }
      setLastPoll(data);
      if (data.status !== lastStatus) {
        lastChangeAt = Date.now();
        stuckWarned = false;
        lastStatus = data.status;
      } else if (data.status === 'scraping' && !stuckWarned && Date.now() - lastChangeAt > STUCK_WARN_MS) {
        pushLog(`     ⚠ ${Math.floor(STUCK_WARN_MS / 1000)}s with no change — Firecrawl may be slow.`);
        stuckWarned = true;
      }
      if (data.status === 'completed') return data;
      if (data.status === 'failed') throw new Error(data.error || 'Firecrawl reported failed');
    }
  }

  // Run enrichment for all currently-filtered leads. Chains:
  //   GA SoS (free, ~95% SMB coverage) → Apollo (medium-biz coverage)
  //   → BatchData skip-trace (needs a first/last name from either source)
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
      // GA Secretary of State step — public records, free, best coverage for
      // small/sole-prop LLCs. Returns registered agent (often the owner).
      if (enrichSources.gasos) {
        try {
          const res = await fetch('/api/enrich-gasos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ businessName: l.debtor_name }),
          });
          entry.gasos = await res.json();
        } catch (err) {
          entry.gasos = { status: 'error', error: err.message };
        }
      }
      // Apollo step
      if (enrichSources.apollo) {
        try {
          const res = await fetch('/api/enrich-apollo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              businessName: l.debtor_name,
              state: 'GA',
              revealEmail: apolloReveal.email,
              revealPhone: apolloReveal.phone,
            }),
          });
          entry.apollo = await res.json();
        } catch (err) {
          entry.apollo = { status: 'error', error: err.message };
        }
      }
      // BatchData skip-trace — chains off whichever source produced a usable
      // first/last name. Apollo wins when both have a name (more likely the
      // true owner). SoS registered agent is a fallback unless flagged as
      // a commercial registered-agent service.
      if (enrichSources.batch) {
        const apolloOwner = entry.apollo?.status === 'ok' ? entry.apollo.owner : null;
        const sosAgent =
          entry.gasos?.status === 'ok' && !entry.gasos.registered_agent?.likely_commercial
            ? entry.gasos.registered_agent
            : null;
        const firstName = apolloOwner?.first_name || sosAgent?.first_name || '';
        const lastName = apolloOwner?.last_name || sosAgent?.last_name || '';
        const source = apolloOwner ? 'apollo' : (sosAgent ? 'gasos' : null);
        if (firstName || lastName) {
          try {
            const res = await fetch('/api/enrich-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                firstName,
                lastName,
                state: 'GA',
                city: apolloOwner?.city || entry.apollo?.business?.city || '',
              }),
            });
            const data = await res.json();
            entry.batch = { ...data, nameSource: source };
          } catch (err) {
            entry.batch = { status: 'error', error: err.message };
          }
        } else {
          entry.batch = {
            status: 'skipped',
            reason: entry.gasos?.registered_agent?.likely_commercial
              ? 'GA SoS agent is a commercial registered-agent service; no real person to skip-trace'
              : 'No owner name found by Apollo or GA SoS — Batch needs a first/last name',
          };
        }
      }
      // Final entry status:
      //   'ok'        — at least one source returned usable data
      //   'no_match'  — none of the sources errored, but none found data
      //   'error'     — at least one source actually errored (HTTP/auth/etc.)
      const sources = [entry.gasos, entry.apollo, entry.batch].filter(Boolean);
      const anyOk = sources.some(s => s?.status === 'ok');
      const anyError = sources.some(s => s?.status === 'error' || s?.status === 'apollo_error');
      if (anyOk) entry.status = 'ok';
      else if (anyError) entry.status = 'error';
      else entry.status = 'no_match';
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
    const apolloOwner = e.apollo?.status === 'ok' ? e.apollo.owner : null;
    const sosAgent = e.gasos?.status === 'ok' ? e.gasos.registered_agent : null;
    const sosBusiness = e.gasos?.status === 'ok' ? e.gasos.business : null;
    // Owner name preference: Apollo (most likely the true owner via title
    // match) > SoS registered agent (when not a commercial service).
    const ownerName =
      apolloOwner?.full_name ||
      (sosAgent && !sosAgent.likely_commercial ? sosAgent.full_name : '');
    return {
      business_phone: e.apollo?.business?.phone || '',
      business_website: e.apollo?.business?.website || '',
      industry: e.apollo?.business?.industry || '',
      owner_name: ownerName,
      owner_title: apolloOwner?.title || (sosAgent && !sosAgent.likely_commercial ? 'Registered Agent (GA SoS)' : ''),
      owner_email: apolloOwner?.email || '',
      owner_phone_business: apolloOwner?.phone || '',
      owner_mobile: e.batch?.person?.mobile || '',
      owner_landline: e.batch?.person?.landline || '',
      owner_personal_email: e.batch?.person?.email || '',
      owner_address: e.batch?.person?.current_address || sosBusiness?.principal_address || '',
      // GA SoS data
      sos_business_name: sosBusiness?.name || '',
      sos_control_number: sosBusiness?.controlNumber || '',
      sos_principal_address: sosBusiness?.principal_address || '',
      sos_status: sosBusiness?.status || '',
      sos_agent_name: sosAgent?.full_name || '',
      sos_agent_is_commercial: sosAgent?.likely_commercial ? 'yes' : '',
      // Per-source statuses for debugging in exports
      gasos_status: e.gasos?.status || '',
      gasos_error: e.gasos?.error || '',
      apollo_status: e.apollo?.status || '',
      apollo_error: e.apollo?.error || '',
      batch_status: e.batch?.status || '',
      batch_error: e.batch?.error || '',
      enrich_status: e.status || '',
    };
  }
  // Total lenders in this sweep = picked-from-chips + custom-typed-names.
  // Estimated cost up front so the user knows what they're about to spend.
  const customLenderCount = customNames.split(',').map(s => s.trim()).filter(Boolean).length;
  const lenderCount = selectedLenders.length + customLenderCount;
  const estimatedCredits = lenderCount * CREDITS_PER_LENDER;

  // Per-lead failure detail so the user can actually see what's failing.
  // Each row: { name, fileNumber, kind: 'error'|'no_match', detail, httpStatus? }
  const enrichFailures = Object.entries(enrichment)
    .filter(([, e]) => e.status === 'error' || e.status === 'no_match')
    .map(([key, e]) => {
      const [fileNumber, name] = key.split('|');
      const sosStatus = e.gasos?.status || '';
      const sosMsg = e.gasos?.error || e.gasos?.message || '';
      const apolloStatus = e.apollo?.status || '';
      const apolloMsg = e.apollo?.error || e.apollo?.message || '';
      const batchMsg = e.batch?.error || '';
      const httpStatus = e.apollo?.httpStatus || null;
      const parts = [];
      if (sosStatus === 'no_match') parts.push('SoS: no entity found');
      else if (sosStatus === 'error') parts.push(`SoS error: ${sosMsg}`);
      if (apolloStatus === 'no_match') parts.push('Apollo: no people indexed');
      else if (apolloStatus === 'apollo_error') parts.push(`Apollo ${httpStatus || 'error'}: ${apolloMsg}`);
      else if (apolloStatus === 'error') parts.push(`Apollo: ${apolloMsg}`);
      if (batchMsg) parts.push(`Batch: ${batchMsg}`);
      const detail = parts.length ? parts.join(' · ') : `No data found (sos=${sosStatus || 'off'}, apollo=${apolloStatus || 'off'})`;
      return { name, fileNumber, kind: e.status, detail, httpStatus, apolloStatus, sosStatus };
    });
  const enrichSuccess = Object.values(enrichment).filter(e => e.status === 'ok').length;
  const enrichNoMatch = Object.values(enrichment).filter(e => e.status === 'no_match').length;
  const enrichFailed = Object.values(enrichment).filter(e => e.status === 'error').length;
  // Per-source success counts for the summary breakdown.
  const sosOkCount = Object.values(enrichment).filter(e => e.gasos?.status === 'ok').length;
  const apolloOkCount = Object.values(enrichment).filter(e => e.apollo?.status === 'ok').length;
  const batchOkCount = Object.values(enrichment).filter(e => e.batch?.status === 'ok').length;
  // Only suggest the API-key fix when we see HTTP errors that actually look auth-related.
  const looksLikeAuthIssue = enrichFailures.some(f =>
    f.httpStatus === 401 || f.httpStatus === 403 ||
    /api[_-]?key|unauthorized|authentication/i.test(f.detail || '')
  );

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
      'sos_principal_address', 'sos_agent_name', 'sos_control_number', 'sos_status',
      'owner_mobile', 'owner_personal_email', 'owner_address',
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
            <div className="big-num" style={{ paddingTop: '0.4rem' }}>{lenderCount}</div>
            <p className="hint">
              Estimated cost: <strong>~{estimatedCredits} Firecrawl credits</strong> (~12 credits/lender · ~25–40s each)
            </p>
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
            <button type="button" className="link" onClick={() => setSelectedLenders([...MCA_LENDERS])}>Select all</button>
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
            <p className="hint" style={{ marginTop: '0.4rem' }}>
              UCC document types are uniform across all 50 states (Article 9 of the Uniform Commercial Code), so the same definitions apply to Georgia, Florida, and everywhere else.
            </p>
            <table className="compact">
              <thead><tr><th>Type</th><th>What it means</th><th>MCA value</th></tr></thead>
              <tbody>
                <tr>
                  <td><strong>Original</strong></td>
                  <td>Fresh UCC-1 financing statement. Brand-new loan just filed.</td>
                  <td>🟢 <strong>Prime</strong> — currently in debt, candidate for stack/refi</td>
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
                  <td>🟢 <strong>Proven</strong> — they took on debt and paid it back. Great re-engagement target for a new MCA.</td>
                </tr>
                <tr>
                  <td><strong>Assignment</strong></td>
                  <td>Lender sold/transferred the debt to another party</td>
                  <td>⚪ Neutral — borrower still owes, but to someone else</td>
                </tr>
              </tbody>
            </table>
            <p className="hint">
              Filter is applied client-side after scraping — change anytime without re-running. Default: all types except Assignment.
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
              <div className="big-num">{currentIdx}<span className="small">/{lenderCount}</span></div>
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
            <div style={{ width: `${(currentIdx - 1) / Math.max(1, lenderCount) * 100}%` }} />
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
              <div className="big-num">{totalCredits}</div>
              <div className="big-label">Firecrawl credits</div>
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

      {perLender.some(q => q.perVariant?.length > 0 || q.variants?.length > 0) && (
        <details className="panel" open>
          <summary><strong>Per-variant breakdown</strong> — every variant for every lender, with drill status</summary>
          <table className="compact">
            <thead><tr><th>Source lender</th><th>Variant name</th><th>Expected</th><th>Got</th><th>Status</th></tr></thead>
            <tbody>
              {perLender.flatMap(q => {
                const rows = q.perVariant?.length ? q.perVariant : (q.variants || []).map(v => ({ variant: v.secured_party_name, expected: v.instrument_count, got: 0, status: '–' }));
                return rows.map((r, i) => (
                  <tr key={`${q.lender}-${i}`}>
                    <td><code>{q.lender}</code></td>
                    <td>{r.variant}</td>
                    <td>{r.expected}</td>
                    <td><strong>{r.got}</strong></td>
                    <td>
                      {r.status === 'ok' && r.got === r.expected && <span style={{ color: 'var(--good)' }}>✓ all</span>}
                      {r.status === 'ok' && r.got !== r.expected && <span style={{ color: '#d29922' }} title="Some rows missing">⚠ {r.got}/{r.expected}</span>}
                      {r.status === 'error' && <span style={{ color: 'var(--error)' }} title={r.error}>✗ {r.error}</span>}
                      {r.status === '–' && <span className="muted">—</span>}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </details>
      )}

      {leads.length > 0 && (
        <div className="panel">
          <div className="csv-tabs" style={{ marginBottom: '0.5rem' }}>
            <strong>🔎 Enrichment</strong>
            <span className="muted small-text">GA SoS → Apollo → BatchData skip-trace</span>
          </div>
          <p className="hint" style={{ marginBottom: '0.5rem' }}>
            Chained enrichment for each lead. GA Secretary of State (free, public) catches small LLCs Apollo doesn't index. Apollo (~2 credits ≈ $0.20/lead) covers established businesses. BatchData skip-traces whichever owner name we found to a personal cell + email.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.5rem' }}>
            <label className="small-text">
              <input
                type="checkbox"
                checked={enrichSources.gasos}
                onChange={e => setEnrichSources(s => ({ ...s, gasos: e.target.checked }))}
              />{' '}
              <strong>GA SoS</strong> (free, registered agent + principal address)
            </label>
            <label className="small-text">
              <input
                type="checkbox"
                checked={enrichSources.apollo}
                onChange={e => setEnrichSources(s => ({ ...s, apollo: e.target.checked }))}
              />{' '}
              <strong>Apollo</strong> (~2 credits/lead)
            </label>
            <label className="small-text">
              <input
                type="checkbox"
                checked={enrichSources.batch}
                onChange={e => setEnrichSources(s => ({ ...s, batch: e.target.checked }))}
              />{' '}
              <strong>BatchData</strong> skip-trace
            </label>
          </div>
          {enrichSources.apollo && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.75rem', paddingLeft: '1rem' }}>
              <label className="small-text muted">
                <input
                  type="checkbox"
                  checked={apolloReveal.email}
                  onChange={e => setApolloReveal(r => ({ ...r, email: e.target.checked }))}
                />{' '}
                Apollo: reveal owner email (~1 credit/result)
              </label>
              <label className="small-text muted">
                <input
                  type="checkbox"
                  checked={apolloReveal.phone}
                  onChange={e => setApolloReveal(r => ({ ...r, phone: e.target.checked }))}
                />{' '}
                Apollo: reveal owner phone (~8 credits/result — expensive)
              </label>
            </div>
          )}
          <div className="submit-row" style={{ paddingTop: 0, borderTop: 'none' }}>
            {!enriching ? (
              <button
                type="button"
                onClick={enrichAll}
                disabled={!enrichSources.gasos && !enrichSources.apollo && !enrichSources.batch}
              >
                Enrich {leads.filter(l => enrichment[leadKey(l)]?.status !== 'ok').length} lead{leads.length === 1 ? '' : 's'}
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
          {(enrichSuccess > 0 || enrichNoMatch > 0 || enrichFailed > 0) && (
            <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.8rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px' }}>
              <div className="small-text">
                <strong>Enrichment summary:</strong>{' '}
                <span style={{ color: 'var(--good)' }}>✓ {enrichSuccess} succeeded</span>
                {enrichNoMatch > 0 && <>{' · '}<span className="muted">○ {enrichNoMatch} no data</span></>}
                {enrichFailed > 0 && <>{' · '}<span style={{ color: 'var(--error)' }}>✗ {enrichFailed} failed</span></>}
              </div>
              <div className="small-text muted" style={{ marginTop: '0.2rem' }}>
                By source: GA SoS {sosOkCount} · Apollo {apolloOkCount} · BatchData {batchOkCount}
              </div>
              {enrichFailures.length > 0 && (
                <details style={{ marginTop: '0.4rem' }} open>
                  <summary className="small-text" style={{ color: enrichFailed > 0 ? 'var(--error)' : 'var(--muted)' }}>
                    Details ({enrichFailures.length})
                  </summary>
                  <ul className="log" style={{ marginTop: '0.3rem' }}>
                    {enrichFailures.slice(0, 30).map((f, i) => (
                      <li key={i}>
                        <strong>{f.name || f.fileNumber}</strong>
                        {f.kind === 'no_match' ? ' — ' : <span style={{ color: 'var(--error)' }}> — </span>}
                        {f.detail}
                      </li>
                    ))}
                    {enrichFailures.length > 30 && <li className="muted">…and {enrichFailures.length - 30} more</li>}
                  </ul>
                  {enrichNoMatch > 0 && enrichFailed === 0 && (
                    <p className="hint" style={{ marginTop: '0.4rem' }}>
                      "No data" usually means the business is a recent / out-of-state / very small LLC neither GA SoS nor Apollo has indexed. Try enabling BatchData skip-trace if it's not already on.
                    </p>
                  )}
                  {looksLikeAuthIssue && (
                    <p className="hint" style={{ marginTop: '0.4rem' }}>
                      An HTTP 401/403 above suggests an auth problem: check <code>APOLLO_API_KEY</code> / <code>FIRECRAWL_API_KEY</code> / <code>BATCHDATA_API_KEY</code> in Netlify (Site configuration → Environment variables) and trigger a new deploy.
                    </p>
                  )}
                  <p className="hint" style={{ marginTop: '0.4rem' }}>
                    For more diagnostics see the Netlify Functions log (look for <code>[gasos]</code> and <code>[apollo]</code> prefixes).
                  </p>
                </details>
              )}
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
                <th title="Apollo enrichment status">Enr.</th>
                <th>Funded By</th>
              </tr>
            </thead>
            <tbody>
              {leads.slice(0, 500).map((l, i) => {
                const e = getEnriched(l);
                const phone = e?.owner_mobile || e?.owner_phone_business || e?.business_phone || e?.owner_landline || '';
                const email = e?.owner_email || e?.owner_personal_email || '';
                let enrichBadge = <span className="muted small-text" title="Not enriched yet">–</span>;
                if (e?.enrich_status === 'ok') {
                  enrichBadge = <span style={{ color: 'var(--good)', fontSize: '0.78rem' }} title="Apollo found data">✓</span>;
                } else if (e?.enrich_status === 'error') {
                  enrichBadge = <span style={{ color: 'var(--error)', fontSize: '0.78rem' }} title={e.apollo_error || 'enrichment failed'}>✗</span>;
                } else if (e?.apollo_status === 'no_match') {
                  enrichBadge = <span style={{ color: 'var(--muted)', fontSize: '0.78rem' }} title="Apollo had no match for this business">∅</span>;
                }
                return (
                  <tr key={i}>
                    <td>
                      <strong>{l.debtor_name}</strong>
                      <div className="muted small-text"><code>{l.file_number}</code></div>
                    </td>
                    <td>{l.document_type}</td>
                    <td>{l.date_filed}</td>
                    <td>
                      {e?.owner_name ? <><strong>{e.owner_name}</strong><div className="muted small-text">{e.owner_title}</div></> : <span className="muted">—</span>}
                    </td>
                    <td>{phone || <span className="muted">—</span>}{e?.owner_mobile && <div className="muted small-text">📱 mobile</div>}</td>
                    <td>{email || <span className="muted">—</span>}</td>
                    <td>{enrichBadge}</td>
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
