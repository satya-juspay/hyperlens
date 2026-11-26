import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import { Download, ExternalLink, ListFilter, Search, SearchX, X } from 'lucide-react';
import type { CatalogEntry, Environment, Platform, SearchMode, SearchResponse, SearchResult, SortField, Status } from '../shared/model.js';
import {
  CopyButton, count, environmentNames, FilterSelect, Pagination, platformNames, Popover, SortHeader, Source
} from './components.js';
import { useDebounced, useResource } from './api.js';

const modes: Record<SearchMode, string> = { 'exact-key': 'Exact key', 'exact-path': 'Exact path', partial: 'Partial match' };
const modeHint: Record<SearchMode, string> = {
  'exact-key': 'Match a property name at any depth.',
  'exact-path': 'Match a specific nested path.',
  partial: 'Find paths containing the search text.'
};
const size = 20;
export interface Selection { query: string; mode: SearchMode }

export function SearchView({ status, initial, inputRef, active, selectResult, remember }: {
  status: Status | undefined; initial: Selection; inputRef: RefObject<HTMLInputElement | null>;
  active: boolean; selectResult: (result: SearchResult) => void; remember: (choice: Selection) => void;
}) {
  const [draft, setDraft] = useState(initial.query);
  const [mode, setMode] = useState<SearchMode>(initial.mode);
  const [explicitMode, setExplicitMode] = useState(Boolean(initial.query));
  const [selection, setSelection] = useState(initial);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [clientDraft, setClientDraft] = useState('');
  const [clients, setClients] = useState<string[]>([]);
  const [valueDraft, setValueDraft] = useState('');
  const [value, setValue] = useState('');
  const [valueError, setValueError] = useState('');
  const [showValues, setShowValues] = useState(true);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortField>('clientId');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const typed = useDebounced(draft.trim());
  const version = status?.indexVersion;
  const suggestionURL = active && open ? '/api/configurations/suggestions?limit=8&q=' + encodeURIComponent(typed) : null;
  const suggestions = useResource<{ entries: CatalogEntry[] }>(suggestionURL, version);
  const suggestionsList = typed === draft.trim() ? suggestions.data?.entries ?? [] : [];
  const suggested = useResource<{ entries: CatalogEntry[] }>(active && !selection.query ? '/api/configurations?limit=5' : null, version);
  const clientOptions = useResource<{ clients: string[] }>(active ? '/api/clients' : null, version);

  const query = new URLSearchParams({
    q: selection.query, mode: selection.mode, includeValues: String(showValues), page: String(page),
    pageSize: String(size), sort, direction
  });
  for (const platform of platforms) query.append('platform', platform);
  for (const environment of environments) query.append('environment', environment);
  for (const client of clients) query.append('clientId', client);
  if (value) query.set('value', value);
  const search = useResource<SearchResponse>(active && selection.query ? '/api/search?' + query : null, version);
  const data = search.data;
  const counts = data?.counts;
  const filterCount = platforms.length + environments.length + clients.length + Number(!!value);
  const listOpen = open && suggestionsList.length > 0;

  function run(text: string, nextMode: SearchMode) {
    const next = { query: text.trim(), mode: nextMode };
    setSelection(next);
    remember(next);
    setPage(1);
    setOpen(false);
    setHighlight(-1);
  }

  function pick(entry: CatalogEntry) {
    setDraft(entry.path);
    setMode('exact-path');
    setExplicitMode(false);
    run(entry.path, 'exact-path');
  }

  function clear() {
    setDraft('');
    setMode('exact-key');
    setExplicitMode(false);
    run('', 'exact-key');
    inputRef.current?.focus();
  }

  function keyboard(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      setHighlight(-1);
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (!suggestionsList.length) return;
      setHighlight(current => event.key === 'ArrowDown' ? (current + 1) % suggestionsList.length
        : current <= 0 ? suggestionsList.length - 1 : current - 1);
    }
    if (event.key === 'Enter' && listOpen && highlight >= 0 && suggestionsList[highlight]) {
      event.preventDefault();
      pick(suggestionsList[highlight]);
    }
  }

  function applyValue(event: FormEvent) {
    event.preventDefault();
    const json = valueDraft.trim();
    try {
      if (json) JSON.parse(json);
      setValueError('');
      setValue(json);
      setPage(1);
    } catch { setValueError('Enter a valid JSON value.'); }
  }

  function addClient(event: FormEvent) {
    event.preventDefault();
    const id = clientDraft.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{1,120}$/.test(id) || clients.length >= 50) return;
    if (!clients.includes(id)) setClients([...clients, id]);
    setClientDraft('');
    setPage(1);
  }

  function changeSort(field: SortField) {
    setDirection(field === sort && direction === 'asc' ? 'desc' : 'asc');
    setSort(field);
    setPage(1);
  }

  useEffect(() => {
    if (highlight >= 0) document.getElementById(`suggestion-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  return <div className="search-content">
    <section className="panel search-panel" aria-labelledby="search-heading">
      <div className="search-label">
        <label id="search-heading" htmlFor="configuration-search">Search configurations</label>
        <span className="search-shortcut"><kbd>/</kbd> to focus search</span>
      </div>
      <form className="search-form" onSubmit={event => { event.preventDefault(); run(draft, mode); }}>
        <div className="combobox">
          <div className="search-input">
            <Search size={20} strokeWidth={1.8} />
            <input ref={inputRef} id="configuration-search" value={draft} maxLength={1024}
              role="combobox" aria-autocomplete="list" aria-expanded={listOpen}
              aria-controls={listOpen ? 'configuration-suggestions' : undefined}
              aria-activedescendant={listOpen && highlight >= 0 ? `suggestion-${highlight}` : undefined}
              autoComplete="off" placeholder="Search a configuration or nested config path…"
              onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setHighlight(-1); }}
              onKeyDown={keyboard} onChange={event => {
                const text = event.currentTarget.value;
                setDraft(text);
                if (!explicitMode) setMode(/[.\[]/.test(text) ? 'exact-path' : 'exact-key');
                setOpen(true);
                setHighlight(-1);
              }} />
            {draft && <button type="button" className="icon-button" aria-label="Clear search" onClick={clear}><X size={17} /></button>}
          </div>
          {listOpen && <ul id="configuration-suggestions" role="listbox" aria-label="Configuration suggestions" className="suggestions">
            {suggestionsList.map((entry, index) =>
              <li key={entry.path} id={`suggestion-${index}`} role="option" aria-selected={highlight === index}
                onMouseDown={event => event.preventDefault()} onClick={() => pick(entry)}>
                <div><code>{entry.path}</code><div className="muted small">{entry.category} · {entry.types.join(', ') || 'unknown type'}</div></div>
                <Source value={entry.source} />
              </li>)}
          </ul>}
        </div>
        <button type="submit" className="button primary search-submit"><Search size={17} />Search</button>
      </form>
      <div className="mode-line">
        <div className="mode-group" role="group" aria-label="Search mode">
          {(Object.keys(modes) as SearchMode[]).map(searchMode =>
            <button type="button" key={searchMode} aria-pressed={mode === searchMode}
              onClick={() => {
                setMode(searchMode);
                setExplicitMode(true);
                if (draft.trim() === selection.query && selection.query) run(draft, searchMode);
              }}>{modes[searchMode]}</button>)}
        </div>
        <span className="mode-help">{modeHint[mode]}</span>
      </div>
      <div className="filter-row" role="group" aria-label="Filters">
        <span className="filter-label"><ListFilter size={17} />Filters</span>
        <FilterSelect label="Platform" names={platformNames} values={platforms} onChange={items => { setPlatforms(items); setPage(1); }} />
        <FilterSelect label="Environment" names={environmentNames} values={environments} onChange={items => { setEnvironments(items); setPage(1); }} />
        <Popover label={clients.length ? `Client ID · ${clients.length}` : 'Client ID'} active={!!clients.length}>
          <form className="filter-form" onSubmit={addClient}>
            <label htmlFor="client-filter">Client IDs</label>
            <div className="filter-form-input"><input id="client-filter" list="available-clients" value={clientDraft}
              autoComplete="off" placeholder="Type a client ID" onChange={event => setClientDraft(event.currentTarget.value)} />
            <button type="submit" className="button" disabled={!clientDraft.trim()}>Add</button></div>
            <datalist id="available-clients">{clientOptions.data?.clients.map(client => <option key={client} value={client} />)}</datalist>
          </form>
          {!!clients.length && <div className="selected-clients">{clients.map(client => <button type="button" key={client}
            className="pill client-chip" aria-label={`Remove ${client}`}
            onClick={() => { setClients(clients.filter(id => id !== client)); setPage(1); }}>{client}<X size={12} /></button>)}</div>}
        </Popover>
        <Popover label="Config value" active={!!value}>
          <form className="filter-form" onSubmit={applyValue}>
            <label htmlFor="value-filter">Exact JSON value</label>
            <div className="filter-form-input"><input id="value-filter" value={valueDraft} placeholder={'true, 3, null, "UPI"'}
              maxLength={2000} onChange={event => { setValueDraft(event.currentTarget.value); setValueError(''); }} />
            <button type="submit" className="button">Apply</button></div>
            {valueError && <span className="validation-error" role="alert">{valueError}</span>}
          </form>
          {value && <button className="text-button filter-clear" type="button" onClick={() => { setValue(''); setValueDraft(''); setPage(1); }}>Clear value</button>}
        </Popover>
        {!!filterCount && <button className="text-button filter-clear" type="button" onClick={() => {
          setPlatforms([]); setEnvironments([]); setClients([]); setClientDraft(''); setValue(''); setValueDraft(''); setValueError(''); setPage(1);
        }}>Reset filters</button>}
      </div>
    </section>
    {!selection.query && !!suggested.data?.entries.length && <div className="quick-search">
      <span>Try a configuration</span>
      <div>{suggested.data.entries.map(entry => <button key={entry.path} className="suggested-chip" type="button" onClick={() => pick(entry)}>
        {entry.path}
      </button>)}</div>
    </div>}
    <section className="results-section" aria-labelledby="result-heading">
      <div className="results-header">
        <div><div className="result-title"><h2 id="result-heading">Search results</h2>{counts && <span className="result-total">{count(counts.occurrences)}</span>}</div>
        <div className="muted small">{selection.query ? <><code className="submitted-query">{selection.query}</code> <span>· {modes[selection.mode]}</span></>
          : 'Matching clients, platforms, and environments appear here.'}</div></div>
        <div className="result-actions">
          <label className="button value-toggle"><input type="checkbox" checked={showValues}
            onChange={event => setShowValues(event.currentTarget.checked)} />Show values</label>
          {counts && counts.occurrences > 0 ? <a className="button" href={'/api/search.csv?' + query}><Download size={16} />Export CSV</a>
            : <button className="button" disabled><Download size={16} />Export CSV</button>}
        </div>
      </div>
      {data && data.coverage.current < data.coverage.targets && <div role="status" className="notice warning">
        {count(data.coverage.stale)} stale, {count(data.coverage.partial)} partial and {count(data.coverage.unavailable)} unavailable client environments.
        Search uses the data currently indexed.
      </div>}
      <div className="panel results-panel" aria-busy={search.loading}>
        {!selection.query && <div className="empty-state">
          <div className="empty-icon"><Search size={24} strokeWidth={1.65} /></div>
          <h3>Start with a configuration</h3>
          <p>Enter a key or a nested path to find where it’s explicitly set.</p>
        </div>}
        {search.loading && <div className="empty-state"><div className="loading-ring" /><p role="status">Searching the index…</p></div>}
        {search.error && <div className="empty-state"><p className="validation-error" role="alert">{search.error}</p></div>}
        {data && !data.results.length && <div className="empty-state">
          <div className="empty-icon"><SearchX size={23} strokeWidth={1.65} /></div>
          <h3>{data.indexVersion ? 'No matching configurations' : 'The index is being prepared'}</h3>
          <p>{data.indexVersion ? 'Check the key, path, or filters for this search.' : 'Run or wait for a refresh to search live data.'}</p>
        </div>}
        {data && !!data.results.length && <div>
          <dl className="result-counts">
            <div><dt>Matching clients</dt><dd>{count(data.counts.clients)}</dd></div>
            <div><dt>Client-platform pairs</dt><dd>{count(data.counts.clientPlatforms)}</dd></div>
            <div><dt>Client environments</dt><dd>{count(data.counts.targets)}</dd></div>
            <div><dt>Occurrences</dt><dd>{count(data.counts.occurrences)}</dd></div>
          </dl>
          <div className="table-scroll">
            <table aria-label="Configuration search results" className="results-table">
              <thead><tr>
                <SortHeader field="clientId" current={sort} direction={direction} change={changeSort}>Client ID</SortHeader>
                <SortHeader field="platform" current={sort} direction={direction} change={changeSort}>Platform</SortHeader>
                <SortHeader field="environment" current={sort} direction={direction} change={changeSort}>Environment</SortHeader>
                <SortHeader field="path" current={sort} direction={direction} change={changeSort}>Config path</SortHeader>
                {showValues && <th scope="col">Config value</th>}
                <SortHeader field="hyperpayConfigUrl" current={sort} direction={direction} change={changeSort}>Hyperpay-config URL</SortHeader>
              </tr></thead>
              <tbody>{data.results.map(row => <tr key={row.id}>
                <td><button type="button" className="client-button" onClick={() => selectResult(row)}>{row.clientId}</button>
                  {row.stale && <span className="pill stale-pill">Stale</span>}</td>
                <td><span className={`pill platform-${row.platform}`}>{platformNames[row.platform]}</span></td>
                <td><span className={`pill environment-${row.environment}`}>{environmentNames[row.environment]}</span></td>
                <td><button type="button" title={row.path} className="path-button" onClick={() => selectResult(row)}><code>{row.path}</code></button></td>
                {showValues && <td><button type="button" title="Inspect and copy full value" onClick={() => selectResult(row)}
                  className={`value-button type-${row.valueType}`}>{row.preview}</button></td>}
                <td><div className="table-url"><a href={row.hyperpayConfigUrl} title={row.hyperpayConfigUrl} target="_blank" rel="noreferrer">
                  <span>{row.owner}/{row.version}/configuration.js</span><ExternalLink size={13} /></a><CopyButton value={row.hyperpayConfigUrl} label="Copy hyperpay-config URL" /></div></td>
              </tr>)}</tbody>
            </table>
          </div>
          <Pagination page={data.page} total={data.counts.occurrences} size={data.pageSize} change={setPage} />
        </div>}
      </div>
    </section>
  </div>;
}
