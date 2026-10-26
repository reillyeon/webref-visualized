# Webref Visualized

An interactive force-directed graph of how web platform specifications
reference one another, built live in the browser from the
[webref](https://github.com/w3c/webref) crawl data.

## How it works

Everything is fetched on demand from the published crawl at
`https://w3c.github.io/webref/ed/` — there is no build step.

1. On load, `data.js` fetches `index.json` (the index of every crawled spec)
   and then each spec's `refs/<shortname>.json` (its normative and informative
   references), 16 at a time, with a progress bar. Each reference URL is
   resolved back to a spec in the index by matching against the spec's
   canonical, nightly, release, alternate and versioned URLs (with a prefix
   fallback for fragment/subpage links). References to documents outside
   webref (most RFCs, Unicode reports, …) are dropped.
2. When you dive into a spec, only its `dfns/<shortname>.json` is fetched,
   plus the `links/<shortname>.json` of **the specs the graph already knows
   reference it** (its incoming edges). Each referrer's link anchors are
   matched against the definition ids to work out who links to what.
3. `index.html` + `app.js` render the graph on a `<canvas>` using D3's force
   simulation, and a radial "definitions" view for a single spec.

Fetched files are cached in memory for the session, so revisiting a spec's
definitions is instant.

## Usage

```sh
python3 -m http.server 8765   # then open http://localhost:8765/
```

Add `?base=<url>` to point at a different crawl:

- `?base=https://w3c.github.io/webref/tr/` — the published /TR/ crawl
- `?base=webref/ed/` — a local checkout of the webref repo in `./webref`

## In the UI

- **Node size** = number of specs that reference it (in-degree);
  **colour** = publishing organization.
- **Solid edges** are normative references, **dashed** are informative.
- Click a node to focus it: outgoing references are drawn in orange,
  incoming ("referenced by") in blue, and the sidebar lists both.
- Search with `/`, deep-link with `#<shortname>` (e.g. `#fetch`),
  double-click a node to open the spec.
- Filter by edge kind, organization (click to toggle, double-click to solo),
  or a minimum in-degree threshold to surface the most-depended-upon specs.
- **Collapse spec series into one node** merges every spec sharing a
  `series.shortname` (e.g. `css-color-3/4/5/6`, the three CTAP versions,
  `webauthn-3/4`) into a single node. References between members are dropped,
  duplicate references from several members are merged (normative wins), and
  when diving in, the members' definitions are de-duplicated by id and by
  (type, text, for) with the current specification's version preferred.
  Series nodes have ids like `series:css-color`.

### Diving into a spec's definitions

Select a spec and press **Explore definitions →** (or open `#<shortname>/dfns`,
e.g. `#fetch/dfns`). The view switches to a radial layout:

- The spec sits in the centre; its definitions form a ring, grouped by the
  section of the spec they're defined in (section arcs are labelled when
  zoomed in). Definition colour = kind (concept, Web IDL, CSS, markup, CDDL);
  size = how many specs link to it. Hollow dots are definitions nobody links to
  (hidden by default for large specs — toggle them in the sidebar).
- Specs that link to those definitions form an outer ring, placed near the
  definitions they use. Lines run from each spec to each definition it links to.
- Hover or click a definition to see which specs use it; click a spec to see
  which definitions it uses, and jump straight into *its* definitions.
- Search definitions by name, type or `for` context; `Esc` clears the
  selection, then returns to the full graph.
