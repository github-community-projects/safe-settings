"use client";

import {
    ChevronDownIcon,
    ChevronUpIcon,
    InfoIcon,
    SearchIcon,
} from "@primer/octicons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHydrated } from "../hooks/useHydrated";
import { withBasePath } from "../utils/basePath";

// Mock organizations used when /api/safe-settings/installation returns 404
const MOCK_ORGS = [
  {
    id: 1,
    name: "mock-org-one",
    lastSyncDate: new Date(Date.now() - 3600 * 1000).toISOString(),
    lastSyncMessage: "Initial mock sync",
    lastSyncSha: "abcdef1",
    ageSeconds: 3600,
  },
  {
    id: 2,
    name: "example-inc",
    lastSyncDate: new Date(Date.now() - 7200 * 1000).toISOString(),
    lastSyncMessage: "Second mock sync",
    lastSyncSha: "abcdef2",
    ageSeconds: 7200,
  },
  {
    id: 3,
    name: "demo-labs",
    lastSyncDate: null,
    lastSyncMessage: null,
    lastSyncSha: null,
    ageSeconds: null,
    na: true,
  },
];

const OrganizationsTable = ({ organizations: propOrganizations = [] }) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortConfig, setSortConfig] = useState({ key: null, direction: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = useState([]);
  const hydrated = useHydrated();
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const headerCheckboxRef = useRef(null);
  const [retrievingFiles, setRetrievingFiles] = useState(false);
  const [retrieveMessage, setRetrieveMessage] = useState(null);
  const [retrieveError, setRetrieveError] = useState(null);
  const [retrieveResults, setRetrieveResults] = useState(null);

  // Fetch real organizations from backend API on client hydration
  useEffect(() => {
    if (!hydrated) return; // avoid SSR mismatch
    let cancelled = false;
    setLoading(true);

    fetch(withBasePath("/api/safe-settings/installation"))
      .then((r) => {
        if (!r.ok) {
          throw new Error(
            `Unable to retrieve organizations (HTTP ${r.status}). Please try again later.`
          );
        }
        return r.json();
      })
      .then((json) => {
        if (!json || cancelled) return;
        const mapped = (json.installations || []).map((i) => ({
          id: i.id,
          name: i.account,
          lastSyncDate: i.committed_at || null,
          lastSyncSha: i.sha || null,
          lastSyncMessage: i.message || null,
          ageSeconds: typeof i.age_seconds === "number" ? i.age_seconds : null,
          hasConfigRepo:
            typeof i.hasConfigRepo === "boolean" ? i.hasConfigRepo : false,
          isInSync: typeof i.isInSync === "boolean" ? i.isInSync : false,
        }));
        setFetched(mapped);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  const data =
    fetched.length > 0
      ? fetched
      : propOrganizations.length > 0
      ? propOrganizations
      : [];

  // Format date for display with hydration-safe approach
  const formatLastSync = (org) => {
    if (!org.lastSyncDate) return <span className="text-muted">—</span>;
    const dateObj = new Date(org.lastSyncDate);
    let ageSec = org.ageSeconds;
    if (hydrated && ageSec == null) {
      ageSec = Math.floor((Date.now() - dateObj.getTime()) / 1000);
    }
    const rel = (() => {
      if (ageSec == null) return "";
      if (ageSec < 60) return "0m";
      const mTotal = Math.floor(ageSec / 60);
      if (mTotal < 60) return `${mTotal}m`;
      const hTotal = Math.floor(mTotal / 60);
      if (hTotal < 24) {
        const remM = mTotal % 60;
        return remM ? `${hTotal}h ${remM}m` : `${hTotal}h`;
      }
      const dTotal = Math.floor(hTotal / 24);
      const remH = hTotal % 24;
      return remH ? `${dTotal}d ${remH}h` : `${dTotal}d`;
    })();
    const fullStamp = `${dateObj.getFullYear()}-${String(
      dateObj.getMonth() + 1
    ).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")} ${String(
      dateObj.getHours()
    ).padStart(2, "0")}:${String(dateObj.getMinutes()).padStart(
      2,
      "0"
    )}:${String(dateObj.getSeconds()).padStart(2, "0")}`;
    const tooltip = [
      fullStamp,
      org.lastSyncMessage,
      org.lastSyncSha ? `SHA: ${org.lastSyncSha.slice(0, 7)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    return (
      <span title={tooltip} className="text-nowrap">
        {rel}
      </span>
    );
  };
  const lastSyncColStyle = {
    width: "170px",
    fontVariantNumeric: "tabular-nums",
  };

  // Filter organizations based on search term
  const filteredData = useMemo(() => {
    return data.filter((org) =>
      org.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [data, searchTerm]);

  // Sort organizations
  const sortedData = useMemo(() => {
    if (!sortConfig.key) return filteredData;

    return [...filteredData].sort((a, b) => {
      let aValue = a[sortConfig.key];
      let bValue = b[sortConfig.key];

      // Convert dates to timestamps for comparison
      if (sortConfig.key === "lastSyncDate") {
        aValue = new Date(aValue).getTime();
        bValue = new Date(bValue).getTime();
      }

      if (aValue < bValue) {
        return sortConfig.direction === "asc" ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === "asc" ? 1 : -1;
      }
      return 0;
    });
  }, [filteredData, sortConfig]);

  // Handle column sorting
  const handleSort = (key) => {
    setSortConfig((prevConfig) => {
      if (prevConfig.key === key) {
        if (prevConfig.direction === "asc") {
          return { key, direction: "desc" };
        } else if (prevConfig.direction === "desc") {
          return { key: null, direction: null };
        }
      }
      return { key, direction: "asc" };
    });
  };

  // Render sort icon
  const renderSortIcon = (columnKey) => {
    if (sortConfig.key !== columnKey) {
      return (
        <span className="text-muted ms-1" style={{ opacity: 0.3 }}>
          ↕
        </span>
      );
    }
    if (sortConfig.direction === "asc") {
      return <ChevronUpIcon className="ms-1" size={16} />;
    }
    if (sortConfig.direction === "desc") {
      return <ChevronDownIcon className="ms-1" size={16} />;
    }
    return (
      <span className="text-muted ms-1" style={{ opacity: 0.3 }}>
        ↕
      </span>
    );
  };

  // Keep header checkbox indeterminate when some but not all rows are selected
  useEffect(() => {
    if (!headerCheckboxRef || !headerCheckboxRef.current) return;
    const selectableCount = sortedData.filter((o) => !o.synced).length;
    headerCheckboxRef.current.indeterminate =
      selectedIds.size > 0 && selectedIds.size < selectableCount;
  }, [selectedIds, sortedData]);

  // Prune selection when the displayed dataset changes (remove ids that no longer exist)
  useEffect(() => {
    setSelectedIds((prev) => {
      const allowed = new Set(
        sortedData.filter((o) => !o.synced).map((o) => o.id)
      );
      const next = new Set([...prev].filter((id) => allowed.has(id)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [sortedData]);

  // Retrieve files for selected organizations
  const retrieveFilesForSelected = async () => {
    if (selectedIds.size === 0) return;
    // map selected ids back to organization names using the current sorted/filtered dataset
    const orgNames = sortedData
      .filter((o) => selectedIds.has(o.id))
      .map((o) => o.name);
    if (orgNames.length === 0) return;
    setRetrieveResults(null);
    setRetrieveMessage(null);
    setRetrieveError(null);
    setRetrievingFiles(true);
    try {
  const res = await fetch(withBasePath("/api/safe-settings/hub/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgs: orgNames }),
      });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const json = await res.json().catch(() => ({}));
      if (Array.isArray(json.results)) {
        setRetrieveResults(json.results);
        const created = json.results.filter((r) => r.pr).length;
        const skipped = json.results.filter((r) => r.skipped).map((r) => r.org);
        const errors = json.results.filter((r) => r.error).length;
        const parts = [];
        if (created)
          parts.push(`${created} PR${created > 1 ? "s" : ""} created`);
        if (skipped.length) parts.push(`Skipped: ${skipped.join(", ")}`);
        if (errors) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
        setRetrieveMessage(parts.join(" • ") || "Retrieval completed");
      } else {
        setRetrieveMessage(json.message || "Retrieval requested");
      }
    } catch (e) {
      setRetrieveError(e.message || String(e));
    } finally {
      setRetrievingFiles(false);
    }
  };

  return (
    <div className="ui-table">
      {/* Search Bar */}
      <div className="mb-4">
        <div className="row">
          <div className="col-md-6">
            <div className="input-group">
              <span className="input-group-text theme-bg-secondary theme-border">
                <SearchIcon size={14} className="theme-text-secondary" />
              </span>
              <input
                type="text"
                className="form-control theme-bg-primary theme-text-primary theme-border"
                placeholder="Search organizations..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="col-md-6 text-end">
            <div className="d-inline-flex align-items-center">
              <span
                title={
                  "Retrieve Settings will read each selected organization's admin repo at the configured CONFIG_PATH and create a single PR in the hub repo containing those files. Already-imported organizations will be skipped. Use this for initial imports only."
                }
                className="me-2 text-muted"
                style={{ cursor: "help" }}
              >
                <InfoIcon size={16} />
              </span>
              <button
                className={
                  selectedIds.size === 0 || retrievingFiles
                    ? "btn btn-sm btn-outline-secondary"
                    : "btn btn-sm btn-primary"
                }
                onClick={retrieveFilesForSelected}
                disabled={selectedIds.size === 0 || retrievingFiles}
                aria-disabled={selectedIds.size === 0 || retrievingFiles}
                style={
                  selectedIds.size === 0 || retrievingFiles
                    ? { opacity: 0.45, cursor: "not-allowed" }
                    : {}
                }
                title={
                  selectedIds.size === 0
                    ? "Select organizations to enable"
                    : retrievingFiles
                    ? "Retrieving files…"
                    : "Retrieve files for selected organizations"
                }
              >
                {retrievingFiles && (
                  <span
                    className="spinner-border spinner-border-sm me-2"
                    role="status"
                    aria-hidden="true"
                  ></span>
                )}
                Import Settings
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Reserved message area: keeps layout stable when messages appear */}
      <div
        style={{ minHeight: "1.4rem" }}
        className="mb-2 d-flex align-items-center flex-column"
      >
        {retrieveResults ? (
          retrieveResults.map((r) => (
            <div key={r.org} className="w-100 small mb-1">
              {r.pr ? (
                <div className="text-success">
                  Imported {r.org}:{" "}
                  <a href={r.pr} target="_blank" rel="noreferrer">
                    {r.pr}
                  </a>
                </div>
              ) : r.skipped ? (
                <div className="theme-text-secondary">
                  Skipping {r.org}: already present in hub
                </div>
              ) : r.error ? (
                <div className="text-danger">
                  {r.org}: {r.error}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <>
            {retrieveMessage && (
              <div className="small text-success me-3">{retrieveMessage}</div>
            )}
            {retrieveError && (
              <div className="small text-danger">{retrieveError}</div>
            )}
          </>
        )}
      </div>

      {/* Table */}
      <div className="table-responsive">
        <table className="table table-hover theme-bg-primary">
          <thead className="theme-bg-secondary">
            <tr>
              <th style={{ width: "40px", textAlign: "center" }}>
                {/* compute selectable rows so header/select-all ignores already-imported orgs */}
                <input
                  type="checkbox"
                  ref={headerCheckboxRef}
                  checked={useMemo(() => {
                    const selectableCount = sortedData.filter(
                      (o) => !o.synced
                    ).length;
                    return (
                      selectableCount > 0 &&
                      selectedIds.size === selectableCount
                    );
                  }, [sortedData, selectedIds])}
                  onChange={() => {
                    // toggle all selectable (non-synced) rows
                    setSelectedIds((prev) => {
                      const selectable = sortedData
                        .filter((o) => !o.synced)
                        .map((o) => o.id);
                      if (prev.size === selectable.length) return new Set();
                      return new Set(selectable);
                    });
                  }}
                  aria-label="Select all organizations"
                />
              </th>
              <th
                className="theme-text-primary sortable-header"
                style={{ cursor: "pointer" }}
                onClick={() => handleSort("name")}
              >
                <div className="d-flex align-items-center">
                  <div>Organization Name</div>
                  <div className="ms-2">{renderSortIcon("name")}</div>
                  <small className="text-muted ms-3">
                    Showing {sortedData.length} of {data.length} organizations
                  </small>
                </div>
              </th>
              <th
                className="theme-text-primary"
                style={{ width: "120px", textAlign: "center" }}
                title="Does this organization have the admin (safe-settings-config) repository?"
              >
                Config Repo
              </th>
              <th
                className="theme-text-primary"
                style={{ width: "90px", textAlign: "center" }}
                title="Are config files in sync with the hub?"
              >
                In Sync
              </th>
              <th
                className="theme-text-primary sortable-header"
                style={{ cursor: "pointer", ...lastSyncColStyle }}
                onClick={() => handleSort("lastSyncDate")}
              >
                Last Sync
                {renderSortIcon("lastSyncDate")}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={5}
                  className="text-center theme-text-secondary py-4"
                >
                  Loading organizations…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={5} className="py-4">
                  <div className="alert alert-danger" role="alert">
                    {error}
                  </div>
                </td>
              </tr>
            )}
            {!loading && !error && sortedData.length > 0
              ? sortedData.map((org) => {
                  return (
                    <tr key={org.id} className="theme-hover">
                      <td style={{ width: "40px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(org.id)}
                          onChange={() =>
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(org.id)) next.delete(org.id);
                              else next.add(org.id);
                              return next;
                            })
                          }
                          aria-label={`Select ${org.name}`}
                          disabled={org.synced === true}
                          style={
                            org.synced
                              ? { opacity: 0.45, cursor: "not-allowed" }
                              : {}
                          }
                        />
                      </td>
                      <td className="theme-text-primary fw-semibold">
                        {org.name}
                        {org.synced && (
                          <small className="text-muted ms-2">Imported</small>
                        )}
                      </td>
                      <td
                        className="theme-text-primary"
                        style={{ textAlign: "center" }}
                      >
                        {org.hasConfigRepo ? (
                          <span
                            className="text-success"
                            title="Admin repo present"
                          >
                            ✓
                          </span>
                        ) : (
                          <span
                            className="text-muted"
                            title="Admin repo not present"
                          >
                            NA
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        {org.isInSync ? (
                          <span className="text-success" title="In sync">
                            ✓
                          </span>
                        ) : (
                          <span className="text-danger" title="Not in sync">
                            ✗
                          </span>
                        )}
                      </td>
                      <td
                        className="theme-text-secondary"
                        style={lastSyncColStyle}
                      >
                        {formatLastSync(org)}
                      </td>
                    </tr>
                  );
                })
              : !loading &&
                !error && (
                  <tr>
                    <td
                      colSpan={5}
                      className="text-center theme-text-secondary py-4"
                    >
                      {searchTerm
                        ? `No organizations found matching "${searchTerm}"`
                        : "No organizations available"}
                    </td>
                  </tr>
                )}
          </tbody>
        </table>
      </div>

      {/* Table Footer Info */}
      {sortedData.length > 0 && (
        <div className="d-flex justify-content-between align-items-center mt-3">
          <small className="theme-text-secondary">
            {searchTerm && `Filtered by: "${searchTerm}"`}
            {sortConfig.key && (
              <span className="ms-2">
                • Sorted by:{" "}
                {sortConfig.key === "name"
                  ? "Organization Name"
                  : "Last Safe-settings Sync"}
                ({sortConfig.direction === "asc" ? "A-Z" : "Z-A"})
              </span>
            )}
          </small>
        </div>
      )}
    </div>
  );
};

export default OrganizationsTable;
