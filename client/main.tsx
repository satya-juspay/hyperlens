import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, BookOpen, CircleAlert, Moon, RefreshCw, Search, Sun } from 'lucide-react';
import type { CatalogEntry, SearchResult, Status } from '../shared/model.js';
import { request } from './api.js';
import { count, DetailPanel, timestamp } from './components.js';
import { SearchView } from './search.js';
import type { Selection } from './search.js';
import { CatalogView, DatasetMetrics, HealthView } from './views.js';
import './styles.css';

const nav = [
  { key: 'search', title: 'Configuration explorer', label: 'Search', icon: Search,
    summary: 'Find where Hyperpay configurations are explicitly set across clients, platforms, and environments.' },
  { key: 'catalog', title: 'Configuration catalog', label: 'Configuration catalog', icon: BookOpen,
    summary: 'Browse repository definitions and paths observed in client configurations.' },
  { key: 'health', title: 'Index health', label: 'Index health', icon: Activity,
    summary: 'Inspect refresh coverage, cached results, and ingestion issues.' }
] as const;
type View = typeof nav[number]['key'];

const statusLabels: Record<Status['state'], string> = {
  idle: 'Awaiting refresh', refreshing: 'Refreshing index', ready: 'Index ready', partial: 'Partial coverage', failed: 'Refresh failed'
};
const phases = { mjos: 'Fetching MJOS', 'hyperpay-config': 'Fetching and parsing hyperpay-config', indexing: 'Saving the index' };

function getTheme(): boolean {
  try {
    const saved = localStorage.getItem('hyperlens-theme');
    return saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  } catch { return false; }
}

function App() {
  const [view, setView] = useState<View>('search');
  const [status, setStatus] = useState<Status>();
  const [statusError, setStatusError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [dark, setDark] = useState(getTheme);
  const [result, setResult] = useState<SearchResult>();
  const [selection, setSelection] = useState<Selection>({ query: '', mode: 'exact-key' });
  const [searchKey, setSearchKey] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const toFocus = useRef(false);
  const requestSequence = useRef(0);
  const current = nav.find(item => item.key === view)!;
  const loading = refreshing || status?.state === 'refreshing';

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('hyperlens-theme', dark ? 'dark' : 'light'); } catch {}
  }, [dark]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      let delay = 5000;
      const ticket = ++requestSequence.current;
      try {
        const updated = await request<Status>('/api/status', controller.signal);
        if (controller.signal.aborted) return;
        if (ticket === requestSequence.current) {
          setStatus(updated);
          setStatusError('');
        }
        delay = updated.state === 'refreshing' ? 750 : 5000;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (ticket === requestSequence.current) setStatusError((error as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loading]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || result
        || target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      event.preventDefault();
      if (view === 'search') input.current?.focus();
      else { toFocus.current = true; setView('search'); }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [view, result]);

  useEffect(() => {
    if (view === 'search' && toFocus.current) {
      input.current?.focus();
      toFocus.current = false;
    }
  }, [view]);

  async function refresh() {
    setRefreshing(true);
    setStatusError('');
    try {
      const response = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json();
      if (!response.ok && response.status !== 409) throw new Error(data.error ?? 'Refresh could not start.');
      requestSequence.current++;
      setStatus(data.status);
    } catch (error) { setStatusError((error as Error).message); }
    finally { setRefreshing(false); }
  }

  function selectCatalog(entry: CatalogEntry) {
    setSelection({ query: entry.path, mode: 'exact-path' });
    setSearchKey(value => value + 1);
    setView('search');
  }

  const coverage = status?.coverage;
  const covered = (coverage?.current ?? 0) + (coverage?.stale ?? 0) + (coverage?.partial ?? 0);
  return <>
    <a href="#main" className="skip-link">Skip to main content</a>
    <header className="app-header">
      <button type="button" className="brand" onClick={() => setView('search')} aria-label="HyperLens home">
        <img className="brand-wordmark" src={dark ? '/branding/hyperlens-wordmark-dark.png' : '/branding/hyperlens-wordmark-light.png'}
          width={156} height={34} alt="" />
        <span className="brand-description">Hyperpay Configuration Explorer</span>
      </button>
      <div className="header-actions">
        <div className="header-status">
          <span className={`status-label status-${status?.state ?? 'idle'}`}><i />
            {status ? statusLabels[status.state] : 'Loading index status'}</span>
          <span className="refresh-time">Last complete refresh {timestamp(status?.lastSuccessfulRefresh ?? null)}</span>
        </div>
        <button type="button" className="button refresh-button" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} /><span>{loading ? 'Refreshing' : 'Refresh'}</span>
        </button>
        <button type="button" className="button theme-button" onClick={() => setDark(value => !value)}
          aria-label={dark ? 'Use light theme' : 'Use dark theme'} title={dark ? 'Use light theme' : 'Use dark theme'}>
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
    <div className="app-body">
      <aside className="sidebar">
        <nav aria-label="Workspace">
          {nav.map(item => <button type="button" key={item.key} className={view === item.key ? 'nav-item selected' : 'nav-item'}
            aria-current={view === item.key ? 'page' : undefined} aria-label={item.label} onClick={() => setView(item.key)}>
            <item.icon size={18} strokeWidth={1.8} />
            {item.key === 'catalog' ? <><span className="nav-label-wide">{item.label}</span><span className="nav-label-mobile">Catalog</span></>
              : <span>{item.label}</span>}
          </button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="coverage-panel">
            <div className="coverage-heading"><Activity size={16} /> Dataset coverage</div>
            <progress aria-label="Client environments searchable" max={coverage?.targets || 1} value={covered} />
            <div className="coverage-text">{count(covered)} of {count(coverage?.targets ?? 0)} client environments searchable</div>
            {coverage && coverage.current < covered && <div className="coverage-text">{count(covered - coverage.current)} stale or partial</div>}
          </div>
        </div>
      </aside>
      <main id="main" className="workspace">
        <div className="workspace-content">
          <div className="page-heading"><h1>{current.title}</h1><p>{current.summary}</p></div>
          {(statusError || status?.error) && <div className="notice error" role="alert"><CircleAlert size={17} />{statusError || status?.error}</div>}
          {status?.progress && <div className="notice refresh-progress" role="status">
            <RefreshCw size={17} className="spin" /><span>{phases[status.progress.phase]}</span>
            {status.progress.total > 1 && <><progress aria-label="Current refresh phase" value={status.progress.completed} max={status.progress.total} />
              <span>{count(status.progress.completed)} / {count(status.progress.total)}</span></>}
          </div>}
          <div hidden={view !== 'search'}>
            {view === 'search' && <DatasetMetrics status={status} />}
            <SearchView key={searchKey} status={status} initial={selection} inputRef={input} active={view === 'search'}
              selectResult={setResult} remember={setSelection} />
          </div>
          {view === 'catalog' && <CatalogView status={status} choose={selectCatalog} />}
          {view === 'health' && <HealthView status={status} />}
        </div>
      </main>
    </div>
    {result && <DetailPanel result={result} close={() => setResult(undefined)} version={status?.indexVersion ?? null} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
