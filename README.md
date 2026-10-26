# Webref Visualized

An interactive force-directed graph of how web platform specifications
reference one another, built from the [webref](https://github.com/w3c/webref)
crawl data.

## How it works

1. `build_graph.py` reads `webref/ed/index.json` (the index of every crawled
   spec) and each spec's `refs/<shortname>.json` file (its normative and
   informative references).
2. Each reference URL is resolved back to a spec in the index by matching
   against the spec's canonical, nightly, release, alternate and versioned
   URLs (with a prefix fallback for fragment/subpage links). References to
   documents outside webref (e.g. most RFCs, Unicode reports) are dropped.
3. The result is written to `data/graph.json` and `data/graph.js`
   (nodes = specs, links = references, with `kind` = normative/informative).
4. For every spec with a `dfns/<shortname>.json` file, each definition is
   matched against the `anchors` recorded in every other spec's
   `links/<shortname>.json`, producing a per-definition list of specs that
   link to it. These are written to `data/specs/<shortname>.js`.
5. `index.html` + `app.js` render the graph on a `<canvas>` using D3's force
   simulation, and a radial "definitions" view for a single spec.

## Usage

```sh
# Regenerate the graph from the local webref checkout (webref/ed)
./build_graph.py

# ...or straight from the published crawl
./build_graph.py --base https://w3c.github.io/webref/ed/

# View it
python3 -m http.server 8765   # then open http://localhost:8765/
```

Opening `index.html` directly from disk also works, since the data is loaded
via `data/graph.js` rather than `fetch()`.

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
  `webauthn-3/4`) into a single node: 769 specs → 675 nodes, 7,742 → 6,042
  references. References between members are dropped, duplicate references
  from several members are merged (normative wins), and the series'
  definitions are de-duplicated by id / (type, text, for) with the current
  specification's version preferred. Merged data lives in
  `data/series/<series>.js`; series nodes have ids like `series:css-color`.

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
