import { useState } from 'react';
import { Activity, Check, Database, FileSearch, Layers3, Search } from 'lucide-react';
import type { CatalogEntry, Failure, Status } from '../shared/model.js';
import { count, Pagination, Source, timestamp } from './components.js';
import { useDebounced, useResource } from './api.js';

export function DatasetMetrics({ status }: { status: Status | undefined }) {
  const metrics = [
    { label: 'Client-platform pairs', value: status?.coverage.clientPlatforms, detail: 'Master client dataset', icon: Layers3, tone: 'accent' },
    { label: 'Client environments', value: status?.coverage.targets, detail: 'Across Release and CUG', icon: Activity, tone: 'sky' },
    { label: 'Hyperpay-configs indexed', value: status?.coverage.parsed, detail: 'Unique normalized URLs', icon: Database, tone: 'green' }
  ];
  return <div className="metric-grid">{metrics.map(({ label, value, detail, icon: Icon, tone }) =>
    <section className="panel metric" key={label}>
      <div className={`metric-icon tone-${tone}`}><Icon size={20} strokeWidth={1.8} /></div>
      <div><div className="metric-label">{label}</div><div className="metric-value">{value === undefined ? '—' : count(value)}</div>
        <div className="metric-detail">{detail}</div></div>
    </section>
  )}</div>;
}

export function CatalogView({ status, choose }: { status?: Status; choose: (entry: CatalogEntry) => void }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const deferred = useDebounced(filter);
  const size = 30;
  const query = new URLSearchParams({ q: deferred, limit: String(size), offset: String((page - 1) * size) });
  const items = useResource<{ entries: CatalogEntry[]; total: number }>('/api/configurations?' + query, status?.indexVersion);
  return <section className="panel" aria-label="Configuration catalog">
    <div className="section-toolbar">
      <div><h2>Catalog entries</h2><p className="muted small">{items.data ? `${count(items.data.total)} matching paths` : 'Search by name, path, or component alias.'}</p></div>
      <label className="mini-search"><Search size={17} />
        <input aria-label="Filter the configuration catalog" placeholder="Filter the catalog…" value={filter} maxLength={1024}
          onChange={event => { setFilter(event.currentTarget.value); setPage(1); }} />
      </label>
    </div>
    {items.loading && <div className="empty-state" role="status">Loading catalog…</div>}
    {items.error && <p className="notice error" role="alert">{items.error}</p>}
    {items.data && !items.data.total && <div className="empty-state">
      <div className="empty-icon"><FileSearch size={22} /></div><h3>No catalog entries found</h3><p>Try a different name or enter the path in Search.</p>
    </div>}
    {items.data && items.data.total > 0 && <>
      <div className="table-scroll"><table aria-label="Configuration paths" className="catalog-table">
        <thead><tr><th scope="col">Configuration path</th><th scope="col">Category</th><th scope="col">Value types</th><th scope="col">Source</th></tr></thead>
        <tbody>{items.data.entries.map(entry => <tr key={entry.path}>
          <td><button type="button" className="path-button" onClick={() => choose(entry)}><code>{entry.path}</code></button>
            {entry.deprecated && <span className="pill stale-pill">Deprecated</span>}
            {(entry.description || entry.defaultValue !== undefined || !!entry.aliases?.length) && <details className="catalog-details">
              <summary>Definition details</summary>
              {entry.description && <p>{entry.description}</p>}
              {entry.defaultValue !== undefined && <p>Repository default <code>{JSON.stringify(entry.defaultValue)}</code></p>}
              {!!entry.aliases?.length && <p>Component aliases <code>{entry.aliases.join(', ')}</code></p>}
            </details>}
          </td>
          <td>{entry.category}</td><td className="muted">{entry.types.join(', ') || '—'}</td><td><Source value={entry.source} /></td>
        </tr>)}</tbody>
      </table></div>
      <Pagination page={page} total={items.data.total} size={size} change={setPage} />
    </>}
  </section>;
}

export function HealthView({ status }: { status?: Status }) {
  const [page, setPage] = useState(1);
  const health = useResource<{ failures: Failure[]; total: number; catalogNotes: string[] }>(
    `/api/health?offset=${(page - 1) * 100}`, status?.indexVersion
  );
  const coverage = status?.coverage;
  const labels = {
    csv: 'Master CSV', mjos: 'MJOS', url: 'Hyperpay-config URL', fetch: 'Fetch',
    parse: 'Parse', index: 'Index'
  };
  return <div className="view-stack">
    <DatasetMetrics status={status} />
    <section className="panel health-overview">
      <div className="section-toolbar"><div><h2>Index coverage</h2>
        <p className="muted small">Last complete refresh {timestamp(status?.lastSuccessfulRefresh ?? null)}</p></div></div>
      <dl className="result-counts">
        <div><dt>Current</dt><dd>{count(coverage?.current ?? 0)}</dd></div>
        <div><dt>Stale</dt><dd>{count(coverage?.stale ?? 0)}</dd></div>
        <div><dt>Partial</dt><dd>{count(coverage?.partial ?? 0)}</dd></div>
        <div><dt>Unavailable</dt><dd>{count(coverage?.unavailable ?? 0)}</dd></div>
      </dl>
      <p className="health-notes muted small">{count(coverage?.unresolved ?? 0)} properties have unresolved runtime values. Their declared paths remain searchable.</p>
    </section>
    <section className="panel" aria-label="Refresh issues">
      <div className="section-toolbar"><div><h2>Refresh issues</h2><p className="muted small">Fetch, validation, and parsing issues from the last indexed attempt.</p></div></div>
      {health.error && <p className="notice error" role="alert">{health.error}</p>}
      {health.data && health.data.catalogNotes.length > 0 && <ul className="health-notes muted small">
        {health.data.catalogNotes.map(note => <li key={note}>{note}</li>)}
      </ul>}
      {health.data && !health.data.total && <div className="empty-state">
        <div className="empty-icon"><Check size={24} /></div>
        <h3>{status?.indexVersion ? 'No indexing issues recorded' : 'No refresh has been indexed yet'}</h3>
      </div>}
      {health.data && health.data.total > 0 && <><div className="table-scroll"><table className="health-table">
        <thead><tr><th scope="col">Stage</th><th scope="col">Affected record</th><th scope="col">Issue</th></tr></thead>
        <tbody>{health.data.failures.map((failure, index) => <tr key={index}>
          <td>{labels[failure.stage]}</td><td><code>{failure.targetId ? JSON.parse(failure.targetId).join(' / ') : failure.url ?? 'Dataset'}</code></td>
          <td>{failure.message}</td>
        </tr>)}</tbody>
      </table></div><Pagination page={page} total={health.data.total} size={100} change={setPage} /></>}
    </section>
  </div>;
}
