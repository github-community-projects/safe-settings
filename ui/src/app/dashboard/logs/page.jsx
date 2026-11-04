"use client"
import { useEffect, useState } from 'react'
import TitleBar from '../../components/TitleBar'
import { withBasePath } from '../../utils/basePath'

export default function LogsPage () {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const logLevels = ['INFO', 'WARN', 'DEBUG', 'ERROR']
  const [selectedLevels, setSelectedLevels] = useState(new Set(logLevels))
  const [search, setSearch] = useState('')
  const [syncOnly, setSyncOnly] = useState(false)

  useEffect(() => {
    async function fetchLogs() {
      try {
        setLoading(true)
        const response = await fetch(withBasePath('/api/safe-settings/hub/log?lines=100'))
        if (!response.ok) throw new Error('Failed to fetch logs')
        const data = await response.json()
        setEntries(data.entries || [])
        setError(null)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    fetchLogs()
  }, [])

  const toggleLevel = (lvl) => {
    const next = new Set(selectedLevels)
    if (next.has(lvl)) next.delete(lvl)
    else next.add(lvl)
    setSelectedLevels(next)
  }

  const filtered = entries.filter(e => {
    // Filter by log level
    if (!selectedLevels.has(e.level.toUpperCase())) return false
    
    // Filter by search term
    if (search.trim() !== '' && !e.message.toLowerCase().includes(search.trim().toLowerCase())) return false
    
    // Filter by sync-only if enabled
    if (syncOnly && !e.message.toLowerCase().includes('sync')) return false
    
    return true
  })

  return (
    <>
      <TitleBar />
      <div className="container py-4">
        <div className="col-12 mb-4">
          <div className="card shadow-sm">
            <div className="card-body">
              <h4 className="card-title mb-2">Safe Settings Hub-Sync Log</h4>
              <p className="card-text text-muted">Last 100 entries from <code>hubSyncHandler.log</code></p>
              {loading && <div className="text-muted">Loading logs...</div>}
              {error && <div className="alert alert-danger">Error: {error}</div>}
            </div>
          </div>
        </div>
        <div className="col-12 mb-4">
          <div className="card shadow-sm">
            <div className="card-body">
              <h5 className="card-title mb-3">Filter Options</h5>
              <div className="mb-2">
                <strong>Log Levels:</strong>
                <div className="d-flex gap-3 mt-2">
                  {logLevels.map(lvl => (
                    <label key={lvl} className="form-check form-check-inline">
                      <input className="form-check-input" type="checkbox" checked={selectedLevels.has(lvl)} onChange={() => toggleLevel(lvl)} />
                      <span className="form-check-label">{lvl}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="mb-3">
                <label className="form-check">
                  <input 
                    className="form-check-input" 
                    type="checkbox" 
                    checked={syncOnly} 
                    onChange={(e) => setSyncOnly(e.target.checked)} 
                  />
                  <span className="form-check-label">
                    <strong>🔄 Show Sync Logs Only</strong>
                  </span>
                </label>
              </div>
              <div className="mt-3">
                <strong>Search Message:</strong>
                <input
                  type="text"
                  className="form-control mt-1"
                  placeholder="Search for SYNC, error, etc."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ maxWidth: 300 }}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="col-12">
          <div className="card shadow-sm">
            <div className="card-body">
              <h5 className="card-title mb-3">Log Entries</h5>
              <div className="table-responsive" style={{ maxHeight: '60vh', overflow: 'auto' }}>
                <table className="table table-sm table-striped align-middle">
                  <thead>
                    <tr>
                      <th style={{width: '200px'}}>Timestamp</th>
                      <th style={{width: '90px'}}>Level</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row, i) => {
                      let levelClass = ''
                      if (row.level === 'ERROR') levelClass = 'log-error'
                      else if (row.level === 'WARN') levelClass = 'log-warn'
                      return (
                        <tr key={`${row.timestamp || 'na'}-${i}`}>
                          <td style={{fontSize: '0.85rem', whiteSpace: 'nowrap'}}>{row.timestamp || '-'}</td>
                          <td className={levelClass} style={{fontWeight: 600}}>{row.level || 'UNKNOWN'}</td>
                          <td className={levelClass} style={{fontFamily: 'monospace', fontSize: '0.9rem', whiteSpace: 'pre-wrap'}}>{row.message}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {filtered.length === 0 && <div className="text-muted py-3">No log entries match your filters.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
