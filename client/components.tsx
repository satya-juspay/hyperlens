import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, X } from 'lucide-react';
import type { CatalogEntry, ResultDetail, SearchResult, SortField } from '../shared/model.js';
import { useResource } from './api.js';

export const count = (value: number) => new Intl.NumberFormat().format(value);
export const timestamp = (value: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  : '—';
export const platformNames = { android: 'Android', ios: 'iOS', web: 'Web' };
export const environmentNames = { release: 'Release', cug: 'CUG' };

export function Source({ value }: { value: CatalogEntry['source'] }) {
  return <span className={`pill source-${value}`}>{
    value === 'both' ? 'Repository + observed' : value === 'repository' ? 'Repository' : 'Observed'
  }</span>;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 1600);
    return () => clearTimeout(timer);
  }, [feedback]);
  return <button className="icon-button copy" type="button" title={feedback || label} aria-label={feedback || label}
    onClick={async () => {
      try { await navigator.clipboard.writeText(value); setFeedback('Copied'); }
      catch { setFeedback('Clipboard unavailable'); }
    }}>
    {feedback === 'Copied' ? <Check /> : <Copy />}
    <span className="sr-only" aria-live="polite">{feedback}</span>
  </button>;
}

export function FilterSelect<T extends string>({ label, names, values, onChange }: {
  label: string; names: Record<T, string>; values: T[]; onChange: (values: T[]) => void
}) {
  return <Popover label={label + (values.length ? ` · ${values.length}` : '')} active={!!values.length}>
    {(Object.keys(names) as T[]).map(value => <label className="check-option" key={value}>
      <input type="checkbox" checked={values.includes(value)}
        onChange={event => onChange(event.currentTarget.checked ? [...values, value] : values.filter(existing => existing !== value))} />
      {names[value]}
    </label>)}
  </Popover>;
}

export function Popover({ label, active, children }: { label: string; active: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="popover" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      root.current?.querySelector('button')?.focus();
    }
  }}>
    <button className={`button filter-button ${active ? 'filter-active' : ''}`} type="button"
      aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {label}<ChevronDown size={14} />
    </button>
    {open && <div className="popover-panel">{children}</div>}
  </div>;
}

export function Pagination({ page, total, size, change }: { page: number; total: number; size: number; change: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <div className="pagination">
    <span>{total ? `${count((page - 1) * size + 1)}–${count(Math.min(total, page * size))} of ${count(total)}` : '0 results'}</span>
    <div className="pagination-controls">
      <button type="button" className="button page-button" aria-label="Previous page" disabled={page <= 1}
        onClick={() => change(page - 1)}><ChevronLeft size={16} /></button>
      <span>Page {count(page)} of {count(pages)}</span>
      <button type="button" className="button page-button" aria-label="Next page" disabled={page >= pages}
        onClick={() => change(page + 1)}><ChevronRight size={16} /></button>
    </div>
  </div>;
}

export function SortHeader({ field, current, direction, change, children }: {
  field: SortField; current: SortField; direction: 'asc' | 'desc'; change: (field: SortField) => void; children: ReactNode
}) {
  return <th scope="col" aria-sort={current === field ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button type="button" className="sort-button" onClick={() => change(field)}>
      {children}{current === field && (direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
    </button>
  </th>;
}

export function DetailPanel({ result, close, version }: { result: SearchResult; close: () => void; version: string | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const detail = useResource<ResultDetail>('/api/results/' + result.id, version);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const current = detail.data ?? result;
  return <dialog ref={ref} className="detail-dialog" aria-labelledby="detail-heading"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="detail-inner">
      <div className="detail-header">
        <div><div className="muted small">Configuration occurrence</div><h2 id="detail-heading">{current.clientId}</h2></div>
        <button type="button" className="icon-button" aria-label="Close details" autoFocus onClick={close}><X size={20} /></button>
      </div>
      {current.stale && <p className="notice warning">This occurrence uses a cached configuration from an earlier fetch.</p>}
      <dl className="detail-meta">
        <div><dt>Platform</dt><dd>{platformNames[current.platform]}</dd></div>
        <div><dt>Environment</dt><dd>{environmentNames[current.environment]}</dd></div>
        <div><dt>Configuration owner</dt><dd>{current.owner}</dd></div>
        <div><dt>Version</dt><dd>{current.version}</dd></div>
        {detail.data && <div><dt>Last fetched</dt><dd>{timestamp(detail.data.fetchedAt)}</dd></div>}
        {detail.data && <div><dt>Last checked</dt><dd>{timestamp(detail.data.checkedAt)}</dd></div>}
      </dl>
      <section className="detail-section">
        <h3>Matched path</h3>
        <div className="code-field"><code>{current.path}</code><CopyButton value={current.path} label="Copy configuration path" /></div>
      </section>
      <section className="detail-section">
        <div className="section-heading"><h3>Configured value</h3><span className={`pill type-${current.valueType}`}>{current.valueType}</span></div>
        {detail.error && <p role="alert" className="notice error">{detail.error}</p>}
        {detail.loading && <p className="muted" role="status">Loading configured value…</p>}
        {detail.data && <>
          {current.valueType === 'unresolved' && <p className="muted small">The runtime expression is shown as declared.</p>}
          <div className="code-field value-field"><pre>{detail.data.value}</pre><CopyButton value={detail.data.value} label="Copy configuration value" /></div>
        </>}
      </section>
      <section className="detail-section">
        <h3>Source URLs</h3>
        <UrlField label="Normalized hyperpay-config URL" url={current.hyperpayConfigUrl} />
        {detail.data && <>
          <UrlField label="MJOS URL" url={detail.data.mjosUrl} />
          {detail.data.originalUrls.map(url => <UrlField key={url} label="Original hyperpay-config URL" url={url} />)}
        </>}
      </section>
    </div>
  </dialog>;
}

function UrlField({ label, url }: { label: string; url: string }) {
  return <div className="url-field"><div className="muted small">{label}</div><div className="code-field">
    <a href={url} target="_blank" rel="noreferrer">{url}<ExternalLink size={13} /></a>
    <CopyButton value={url} label={`Copy ${label}`} />
  </div></div>;
}
