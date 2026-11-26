# HyperLens

HyperLens finds every client, platform, and environment whose Hyperpay configuration explicitly declares a property. It returns the source path, typed configured value, and normalized hyperpay-config URL for each occurrence.

## Run locally

Use Node.js 20.19 or newer. Place the authorized master file at `mjos_client_list_cleaned.csv` in the project root or point `HYPERLENS_CSV` at an existing copy. The CSV needs the columns `client_id,platform`. The supplied file is already in the local workspace and is excluded from Git.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4173**. On first launch HyperLens builds an index from the master CSV. Later launches open the saved snapshot. Click **Refresh** to read the current CSV, revalidate Juspay assets, and update the index. **Index health** shows ingest progress and errors, and explains which client environments have current, stale, partial, or unavailable data.

The default server is loopback-only. For internal shared hosting, set `HYPERLENS_AUTH` through the environment and require TLS and the organization's access controls at the reverse proxy. Keep the CSV and cache private to the service account. The application uses the network only for read-only GETs to the approved Juspay asset paths. Website assets and API responses are served by the same local process.

| Environment variable | Default |
| --- | --- |
| `HYPERLENS_CSV` | `mjos_client_list_cleaned.csv` |
| `HYPERLENS_CACHE` | `.hyperlens` |
| `HYPERLENS_WIDGET_ROOT` | `../hyper-widget` |
| `HYPERLENS_READER_ROOT` | `../config-reader` |
| `HYPERLENS_HOST` / `HYPERLENS_PORT` | `127.0.0.1` / `4173` |
| `HYPERLENS_AUTH` | Optional `username:password`; required for non-loopback binding |
| `HYPERLENS_CONCURRENCY` | `15` concurrent requests, configurable from 1 to 30 |
| `HYPERLENS_AUTO_REFRESH` | `1` to refresh on first launch, `0` for manual refresh only |

## Search behavior

- **Exact key** matches a case-sensitive property name at any depth. **Exact path** matches the full path. **Partial match** searches paths case-insensitively. Type a key directly or use the catalog and autocomplete.
- Use dots for normal property names, `[0]` for an array index, and `["a.b"]` for a literal dotted key. For example, `flowConfig.getInstrumentConfig.shouldCallEligibility` searches the same field as `mainConfig.flowConfig.getInstrumentConfig.shouldCallEligibility`. Results show the exact declared path, including `mainConfig` when present.
- False, zero, empty strings, null, empty arrays, and empty objects count as present. The optional **Config value** filter accepts JSON and distinguishes `true` from `"true"`. The catalog includes repository defaults as metadata. Results come from indexed merchant declarations.
- Filter by platform, environment, client ID, and typed value. Use **Show values** to control previews and the value column in CSV exports. Select a client, path, or value to inspect and copy the full value and source URLs.
- Each row is identified by the original client ID, platform, environment, normalized URL, and exact path. Multiple clients can reference one configuration. The configuration owner and original extracted URLs appear in the detail view.

## Architecture

| Area | Location | Behavior |
| --- | --- | --- |
| CSV and URL discovery | [server/urls.ts](server/urls.ts) | Preserves client IDs as strings, expands Release and CUG, discovers nested MJOS URL references, and validates host and path. |
| Refresh and HTTP transport | [server/refresh.ts](server/refresh.ts), [server/transport.ts](server/transport.ts) | Bounded concurrency, request timeouts, transient retry and rate-limit handling, global normalized URL deduplication, conditional HTTP revalidation, and content hashes. |
| Static parsing and paths | [server/parser.ts](server/parser.ts), [server/paths.ts](server/paths.ts) | Uses Acorn to read the declaration behind the live `window.getMerchantConfig` wrapper, along with common literal, assignment, and export forms. Handles arrays, local literal bindings, and static spreads. No downloaded code is executed. |
| Catalog and reverse index | [server/catalog.ts](server/catalog.ts), [server/index.ts](server/index.ts) | Joins repository definitions with observed paths. Shared configurations are indexed once; search expands matches through their MJOS references. |
| Persistence | [server/cache.ts](server/cache.ts) | Stores a compressed snapshot of MJOS, parsed data, relationships, and coverage. Raw JavaScript is cached separately by content hash. Atomic replacement keeps the prior snapshot readable until publishing the new one succeeds. |
| API and interface | [server/http.ts](server/http.ts), [client/main.tsx](client/main.tsx) | Provides status, search, CSV export, catalog, details, and refresh endpoints. The React interface includes keyboard autocomplete, sortable and paginated results, a detail panel, and light and dark themes. |

Refreshes re-read the source CSV and fetch each MJOS once per client, platform, and environment. URLs are extracted recursively and normalized to `configuration.js` with owner and version intact. Repeated archive and JavaScript references share one fetch and parse. On a failed fetch or parse HyperLens retains the previous usable record when available and labels the affected result stale. A partially available record still contributes its searchable configurations. Coverage distinguishes these cases, and the last successful refresh time advances only on a complete refresh.

### Repository findings

- HyperWidget defines `flowConfig`, `screenConfig`, and other sections in `config/config.js`. HyperLens reads the local JavaScript import graph statically and draws descriptions, declared types, and defaults from `constants/rules.js` where available. It also reads inline deprecation markers and component aliases.
- Config-reader uses a `mainConfig` envelope, `componentMapping` aliases, dotted property names, and operations such as `#ref`, `#js-expr`, and `#override`. Its runtime evaluates merchant expressions. HyperLens instead preserves runtime operations as unresolved declarations. It indexes expressly provided override fields and accepts shorthand paths while showing the declared paths in results.
- Both repositories are optional at runtime. When a checkout is missing, the observed catalog still works and Index health reports unavailable repository metadata. HyperLens reads the checkouts without modifying them.

## Verification and limits

`npm test` builds the project and runs 15 synthetic fixture tests, including wrapped merchant scripts, nested searches, shared references, typed values, failed refresh recovery, and cache revalidation. The local live run on 26 November 2026 (IST) loaded 544 CSV pairs, indexed 1,088 client environments and 715 distinct configurations, and reported zero fetch or parse failures. Headless Chrome verified desktop and mobile search, keyboard autocomplete, filters, details, CSV export, and a complete refresh launched from the dashboard.

Only statically declared properties can be indexed. Runtime functions, unknown computed keys, and unresolved spreads can hide data. Runtime expressions are visible as unresolved and their effective values cannot be filtered. The repository catalog imports statically readable JavaScript and structured rule metadata. It is not a complete compiler for PureScript definitions. The MVP uses a single Node process with a local cache and an in-memory index. The first full ingest used roughly 1 GiB of process memory before completion, so allow headroom for in-progress refreshes.

Before team rollout, wire the service into the organization's sign-in and access controls. If the dataset substantially grows or several replicas need to serve it, move the snapshot and postings to a shared persistent store.
