'use client';
import { ChevronDownIcon, ChevronRightIcon, FileDirectoryIcon, FileIcon, SearchIcon } from '@primer/octicons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHydrated } from '../hooks/useHydrated';
import { withBasePath } from '../utils/basePath';

// Match the left index width and reuse for the search input
const LEFT_COL_WIDTH = 320;


export default function SafeSettingsHubContent3b() {
  const hydrated = useHydrated();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rootTree, setRootTree] = useState(null);
  const [search, setSearch] = useState('');
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [selectedPath, setSelectedPath] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  const fetchData = () => {
    if (!hydrated) return;
    setLoading(true); setError(null);
    fetch(withBasePath('/api/safe-settings/hub/content?fetchContent=true'))
      .then(r => {
        if (!r.ok) throw new Error(`Unable to retrieve safe-settings hub content (HTTP ${r.status})`);
        return r.json();
      })
      .then(json => { setRootTree(json); setLastFetchedAt(new Date()); })
      .catch((error) => { setError("Unable to load content. Please try again later."); setRootTree(null); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, [hydrated]);

  const filterTree = useCallback((node) => {
    if (!node) return null;
    const term = search.toLowerCase();
    const matches = (n) => !term || (n.name && n.name.toLowerCase().includes(term)) || (n.path && n.path.toLowerCase().includes(term));
    if (node.type === 'file') {
      return matches(node) ? node : null;
    }
    if (node.type === 'dir') {
      const filteredEntries = (node.entries || [])
        .map(child => filterTree(child))
        .filter(Boolean);
      if (matches(node) || filteredEntries.length > 0) {
        return { ...node, entries: filteredEntries };
      }
      return null;
    }
    return null;
  }, [search]);

  const filteredTree = useMemo(() => filterTree(rootTree), [rootTree, filterTree]);

  const displayTree = useMemo(() => {
    if (!filteredTree) return null;
    if (filteredTree.type === 'dir') {
      const nameMatch = (n) => n && n.type === 'dir' && n.name && n.name.toLowerCase().includes('safe-settings');
      const immediate = (filteredTree.entries || []).find(nameMatch);
      if (immediate) return immediate;
      const findDescendant = (node, depth = 0, maxDepth = 3) => {
        if (!node || node.type !== 'dir' || depth >= maxDepth) return null;
        for (const child of node.entries || []) if (nameMatch(child)) return child;
        for (const child of node.entries || []) if (child.type === 'dir') {
          const found = findDescendant(child, depth + 1, maxDepth);
          if (found) return found;
        }
        return null;
      };
      const found = findDescendant(filteredTree, 0, 3);
      if (found) return found;
    }
    return filteredTree;
  }, [filteredTree]);

  useEffect(() => { if (!displayTree) return; setSelectedPath(prev => prev || displayTree.path); }, [displayTree]);

  const findNodeByPath = useCallback((node, path) => {
    if (!node) return null;
    if (node.path === path) return node;
    if (node.type === 'dir') {
      for (const child of node.entries || []) {
        const found = findNodeByPath(child, path);
        if (found) return found;
      }
    }
    return null;
  }, []);

  const selectedNode = useMemo(() => {
    if (!displayTree || !selectedPath) return null;
    return findNodeByPath(displayTree, selectedPath);
  }, [displayTree, selectedPath, findNodeByPath]);

  const toggleDir = (path) => { setExpandedPaths(prev => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; }); };

  const formatTimeAgo = (iso) => {
    if (!iso) return '—';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    const diffSec = Math.floor((Date.now() - dt.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH} hour${diffH === 1 ? '' : 's'} ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 30) return `${diffD} day${diffD === 1 ? '' : 's'} ago`;
    const diffM = Math.floor(diffD / 30);
    if (diffM < 12) return diffM === 1 ? '1 month ago' : `${diffM} months ago`;
    const diffY = Math.floor(diffD / 365);
    if (diffY === 1) return 'last year';
    return `${diffY} years ago`;
  };

  const repoCount = useMemo(() => {
    if (!rootTree) return '—';
    const rp = rootTree.reposProcessed || rootTree.repos || null;
    if (!rp) return '—';
    if (Array.isArray(rp)) return rp.length;
    if (typeof rp === 'object') return Object.keys(rp).length;
    return '—';
  }, [rootTree]);

  const renderTree = (node, depth = 0) => {
    if (!node) return null;
    if (node.type === 'file') {
      const selected = selectedPath === node.path;
      return (
        <div key={node.path} className={`d-flex align-items-center py-1 ${selected ? 'theme-bg-secondary' : ''}`} style={{ paddingLeft: depth * 12, cursor: 'pointer' }} onClick={() => setSelectedPath(node.path)}>
          <FileIcon size={12} className="me-2" />
          <span className="small text-truncate">{node.name}</span>
        </div>
      );
    }
    const expanded = expandedPaths.has(node.path);
    const selected = selectedPath === node.path;
    return (
      <div key={node.path}>
        <div className={`d-flex align-items-center py-1 ${selected ? 'theme-bg-secondary' : ''}`} style={{ paddingLeft: depth * 12, cursor: 'pointer' }}>
          <div onClick={() => { toggleDir(node.path); setSelectedPath(node.path); }} className="d-inline-flex align-items-center">
            {expanded ? <ChevronDownIcon size={12} className="me-2" /> : <ChevronRightIcon size={12} className="me-2" />}
            <FileDirectoryIcon size={12} className="me-2 text-primary" />
            <span className="small">{node.name}</span>
          </div>
        </div>
        {expanded && (node.entries || []).map(child => renderTree(child, depth + 1))}
      </div>
    );
  };

  const childrenForSelected = useMemo(() => { if (!selectedNode) return []; if (selectedNode.type === 'dir') return selectedNode.entries || []; return []; }, [selectedNode]);

  const fileContent = useMemo(() => { if (!selectedNode || selectedNode.type !== 'file') return null; return selectedNode.content || selectedNode.body || selectedNode.text || selectedNode.preview || null; }, [selectedNode]);

  const fileLines = useMemo(() => fileContent ? fileContent.split('\n') : [], [fileContent]);
  const lineCount = fileLines.length;
  const locCount = fileLines.filter(l => l.trim()).length;
  const byteCount = useMemo(() => {
    if (!fileContent) return 0;
    try { return new TextEncoder().encode(fileContent).length; } catch (e) { return fileContent.length; }
  }, [fileContent]);

  return (
    <div className="ui-table">
      <div className="row g-3 align-items-start mb-3">
        <div className="col-md-6">
          <div className="d-flex align-items-start" style={{ gap: '0.75rem' }}>
            <div className="input-group" style={{ width: LEFT_COL_WIDTH, flex: '0 0 auto' }}>
              <span className="input-group-text theme-bg-secondary theme-border"><SearchIcon size={14} /></span>
              <input className="form-control theme-bg-primary theme-text-primary theme-border" placeholder="Filter by name or path" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {selectedNode && <div className="small text-muted text-start" style={{ marginLeft: 10, marginTop: 4, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong>{selectedNode.path}</strong></div>}
          </div>
        </div>
        <div className="col-md-6 text-end">
          <div className="btn-group btn-group-sm">
            {/* edit button intentionally removed */}
          </div>
        </div>
      </div>

      {loading && <div className="py-4 text-center theme-text-secondary">Loading…</div>}
      {error && <div className="alert alert-danger">{error}</div>}
      {!loading && !displayTree && <div className="py-4 text-center theme-text-secondary">No entries</div>}

      {!loading && displayTree && (
        <div className="d-flex" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
          <div style={{ width: LEFT_COL_WIDTH, minHeight: 320, border: '1px solid var(--color-border, #d0d7de)', borderRadius: 6, padding: '0.5rem', overflow: 'auto' }}>
            {/* left tree */}
            {displayTree.type === 'dir' && displayTree.name && displayTree.name.toLowerCase().includes('safe-settings')
              ? (displayTree.entries || []).map(child => renderTree(child, 0))
              : renderTree(displayTree)
            }
          </div>

          <div style={{ flex: 1, minHeight: 320, minWidth: 0, border: 'none', padding: '0 0.5rem 0.5rem 0.5rem', display: 'flex', flexDirection: 'column' }}>
            {/* right content (dir/file view) */}
            {selectedNode && selectedNode.type === 'dir' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {/* path rendered next to the filter at the top; removed empty toolbar to avoid extra top gap */}
                <div className="table-responsive" style={{ flex: 1, overflow: 'auto' }}>
                  <table className="table table-sm table-hover align-middle mb-0">
                    <thead className="small">
                      <tr className="theme-bg-secondary">
                        <th style={{ width: '45%' }}>Name</th>
                        <th>Commit-Message</th>
                        <th style={{ width: '160px' }}>Last commit date</th>
                      </tr>
                    </thead>
                    <tbody className="small">
                      {(childrenForSelected.length === 0) && (
                        <tr><td colSpan={3} className="text-center text-muted">No entries</td></tr>
                      )}
                      {childrenForSelected.map(child => (
                        <tr key={child.path} className={child.type === 'dir' ? 'cursor-pointer' : ''} onClick={() => setSelectedPath(child.path)}>
                          <td className="fw-semibold text-break">
                            <span className="d-inline-flex align-items-center">
                              {child.type === 'dir' ? <FileDirectoryIcon size={14} className="me-2 text-primary" /> : <FileIcon size={14} className="me-2" />}
                              {child.name}
                            </span>
                          </td>
                          <td className="text-break">{child.lastCommitMessage || '—'}</td>
                          <td className="text-muted text-nowrap" title={child.lastCommitAt ? new Date(child.lastCommitAt).toLocaleString() : ''}>{child.lastCommitAt ? formatTimeAgo(child.lastCommitAt) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selectedNode && selectedNode.type === 'file' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {/* path rendered next to the filter at the top; removed empty toolbar to avoid extra top gap */}
                <div style={{ flex: 1, overflow: 'auto' }}>
                  {/* file header with border and rounded top, followed by a bordered code area with rounded bottom */}
                  <div style={{ borderRadius: 6, overflow: 'visible' }}>
                    <div className="d-flex align-items-center justify-content-between" style={{ background: '#f6f8fa', padding: '0.5rem 0.75rem', border: '1px solid var(--color-border, #d0d7de)', borderRadius: '6px 6px 0 0' }}>
                      <div />
                      <div className="d-flex align-items-center">
                        <button className="btn btn-sm btn-outline-secondary me-2" disabled>Edit</button>
                        <button className="btn btn-sm btn-outline-secondary" disabled>Save</button>
                      </div>
                    </div>

                    <div style={{ border: '1px solid var(--color-border, #d0d7de)', borderTop: 'none', borderRadius: '0 0 6px 6px', overflow: 'hidden', minWidth: 0 }}>
                       <div style={{ display: 'flex', gap: '0.5rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Roboto Mono", "Courier New", monospace', fontSize: 13, minWidth: 0 }}>
                        <div style={{ padding: '0 0.5rem', background: 'transparent', borderRight: '1px solid var(--color-border, #d0d7de)', color: 'var(--color-text-secondary)', textAlign: 'right', flex: '0 0 3.25rem' }}>
                          {fileLines.map((_, i) => <div key={i} style={{ margin: 0, lineHeight: '1.4', fontSize: 13, color: 'var(--color-text-secondary)' }}>{i + 1}</div>)}
                        </div>
                        <div style={{ padding: 0, whiteSpace: 'pre', overflowX: 'auto', flex: 1, minWidth: 0 }}>
                          {fileLines.length === 0 ? (
                            <div className="text-muted" style={{ margin: 0, lineHeight: '1.4' }}>No content available</div>
                          ) : (
                            fileLines.map((ln, i) => <div key={i} style={{ whiteSpace: 'pre', margin: 0, lineHeight: '1.4' }}>{ln || ' '}</div>)
                          )}
                        </div>
                       </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!selectedNode && (
              <div className="text-muted">Select a folder or file from the left to view contents.</div>
            )}

          </div>
        </div>
      )}

      {/* footer (items shown) removed */}
    </div>
  );
}
