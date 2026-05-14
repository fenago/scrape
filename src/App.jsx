import { useState } from 'react';

export default function App() {
  const [debtorName, setDebtorName] = useState('');
  const [searchType, setSearchType] = useState('Organization');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [leads, setLeads] = useState([]);
  const [meta, setMeta] = useState(null);

  async function handleSearch(e) {
    e.preventDefault();
    if (!debtorName.trim()) return;
    setLoading(true);
    setError(null);
    setLeads([]);
    setMeta(null);
    try {
      const res = await fetch('/api/search-ucc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtorName: debtorName.trim(), searchType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setLeads(data.leads || []);
      setMeta({ count: data.leads?.length || 0, source: data.source });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function downloadCsv() {
    if (!leads.length) return;
    const headers = ['debtor_name', 'file_number', 'filing_date', 'secured_party', 'address'];
    const rows = leads.map(l =>
      headers.map(h => `"${(l[h] ?? '').toString().replace(/"/g, '""')}"`).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fl-ucc-leads-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="container">
      <header>
        <h1>Florida UCC Leads</h1>
        <p className="sub">Search the Florida Secured Transaction Registry via Firecrawl.</p>
      </header>

      <form onSubmit={handleSearch} className="search-form">
        <div className="row">
          <label>
            Search type
            <select value={searchType} onChange={e => setSearchType(e.target.value)}>
              <option value="Organization">Organization (debtor)</option>
              <option value="Individual">Individual (debtor)</option>
            </select>
          </label>
          <label className="grow">
            Debtor name
            <input
              type="text"
              value={debtorName}
              onChange={e => setDebtorName(e.target.value)}
              placeholder={searchType === 'Individual' ? 'Last name, First name' : 'Business name'}
              required
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {error && <div className="error">⚠ {error}</div>}

      {meta && (
        <div className="meta">
          Found <strong>{meta.count}</strong> result{meta.count === 1 ? '' : 's'}.
          {leads.length > 0 && (
            <button className="link" onClick={downloadCsv}>Export CSV</button>
          )}
        </div>
      )}

      {leads.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Debtor</th>
              <th>File #</th>
              <th>Filed</th>
              <th>Secured Party</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l, i) => (
              <tr key={i}>
                <td>{l.debtor_name}</td>
                <td>{l.file_number}</td>
                <td>{l.filing_date}</td>
                <td>{l.secured_party}</td>
                <td>{l.address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer>
        <p>Data source: floridaucc.com · Public records · Powered by Firecrawl</p>
      </footer>
    </div>
  );
}
