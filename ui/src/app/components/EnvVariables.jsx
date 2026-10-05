'use client';
import { ChevronDownIcon, ChevronUpIcon, CopyIcon, SearchIcon, ShieldIcon } from '@primer/octicons-react';
import { useEffect, useMemo, useState } from 'react';
import { useHydrated } from '../hooks/useHydrated';
import { withBasePath } from '../utils/basePath';

const SENSITIVE_REGEX = /(secret|token|key|password|private)/i;

export default function EnvVariables() {
  const hydrated = useHydrated();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [includeInfra, setIncludeInfra] = useState(false);
  const [revealAll, setRevealAll] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: null, direction: null });

  const fetchData = () => {
    if (!hydrated) return;
    setLoading(true); setError(null);
    fetch(withBasePath(`/api/safe-settings/app/env${includeInfra ? '?includeInfra=true' : ''}`))
      .then(r => {
        if (!r.ok) {
          throw new Error(`Unable to retrieve environment variables (HTTP ${r.status}). Please try again later.`);
        }
        return r.json();
      })
      .then(json => {
        setRows(json.variables || []);
        setLastFetchedAt(new Date(json.updatedAt || Date.now()));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [hydrated, includeInfra]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => 
      r.key.toLowerCase().includes(q) || 
      (r.value + '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const sorted = useMemo(() => {
    if (!sortConfig.key || !sortConfig.direction) return filtered;
    const list = [...filtered];
    list.sort((a, b) => {
      let av = a[sortConfig.key];
      let bv = b[sortConfig.key];
      if (av == null) av = '';
      if (bv == null) bv = '';
      av = (av + '').toLowerCase();
      bv = (bv + '').toLowerCase();
      if (av < bv) return sortConfig.direction === 'asc' ? -1 : 1;
      if (av > bv) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [filtered, sortConfig]);

  const cycleSort = (key) => {
    setSortConfig(prev => {
      if (prev.key === key) {
        if (prev.direction === 'asc') return { key, direction: 'desc' };
        if (prev.direction === 'desc') return { key: null, direction: null };
      }
      return { key, direction: 'asc' };
    });
  };

  const renderSortIcon = (key) => {
    if (sortConfig.key !== key) return <span className="text-muted ms-1" style={{ opacity: 0.3 }}>↕</span>;
    if (sortConfig.direction === 'asc') return <ChevronUpIcon size={14} className="ms-1" />;
    if (sortConfig.direction === 'desc') return <ChevronDownIcon size={14} className="ms-1" />;
    return <span className="text-muted ms-1" style={{ opacity: 0.3 }}>↕</span>;
  };

  const maskedValue = (k, v) => {
    if (revealAll) return v;
    if (!SENSITIVE_REGEX.test(k)) return v;
    if (!v) return v;
    if (v.length <= 4) return '*'.repeat(v.length);
    return v.slice(0, 2) + '***' + v.slice(-2);
  };

  const copyToClipboard = (text) => {
    try { navigator.clipboard.writeText(text); } catch(_) {}
  }

  return (
    <div className="ui-table">
      <div className="row g-3 align-items-end mb-3">
        <div className="col-md-4">
          <label className="form-label small theme-text-secondary">Search</label>
            <div className="input-group">
              <span className="input-group-text theme-bg-secondary theme-border border"><SearchIcon size={14} /></span>
              <input className="form-control theme-bg-primary theme-text-primary theme-border border" placeholder="Filter by key, value, or description" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
        </div>
  {/* Removed options and buttons section for a cleaner environment page UI */}
      </div>

      {loading && <div className="py-4 text-center theme-text-secondary">Loading…</div>}
      {error && !loading && <div className="alert alert-danger py-2">Error: {error}</div>}
      {!loading && !error && filtered.length === 0 && <div className="py-4 text-center theme-text-secondary">No variables</div>}

      {!loading && !error && filtered.length > 0 && (
        <div className="table-responsive" style={{ background: 'var(--bg-primary)' }}>
          <table className="table table-sm table-hover align-middle mb-0 theme-bg-primary" style={{ background: 'var(--bg-primary)' }}>
            <thead className="small">
              <tr className="theme-bg-secondary">
                <th role="button" onClick={() => cycleSort('key')} className="theme-text-primary user-select-none" style={{ width: '20%', cursor: 'pointer' }}>Key {renderSortIcon('key')}</th>
                <th role="button" onClick={() => cycleSort('value')} className="theme-text-primary user-select-none" style={{ width: '30%', cursor: 'pointer' }}>Value {renderSortIcon('value')}</th>
                <th role="button" onClick={() => cycleSort('description')} className="theme-text-primary user-select-none" style={{ cursor: 'pointer' }}>Description {renderSortIcon('description')}</th>
                <th className="theme-text-primary text-center" style={{ width: '50px' }}></th>
                <th className="theme-text-primary" style={{ width: '50px' }}></th>
              </tr>
            </thead>
            <tbody className="small">
              {sorted.map(r => {
                const sensitive = SENSITIVE_REGEX.test(r.key);
                return (
                  <tr key={r.key} className="theme-border-top" style={{ background: 'var(--bg-primary)' }}>
                    <td className="fw-semibold text-break"><code>{r.key}</code></td>
                    <td className="text-break" style={{ maxWidth: 350 }}>
                      <code>{maskedValue(r.key, r.value)}</code>
                    </td>
                    <td className="text-break theme-text-secondary">{r.description || 'NA'}</td>
                    <td className="text-center">{sensitive && <ShieldIcon size={14} className="text-warning" />}</td>
                    <td className="text-center">
                      <button className="btn btn-sm btn-link p-0" title="Copy value" onClick={() => copyToClipboard(r.value)}><CopyIcon size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 d-flex justify-content-between small theme-text-secondary">
        <span>{sorted.length} shown / {rows.length} total</span>
      </div>
    </div>
  );
}
