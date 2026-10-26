#!/usr/bin/env python3
"""Build a spec-reference graph from the webref crawl data.

Reads the webref crawl's index.json, then every per-spec "refs" file, and
resolves each referenced URL back to a spec in the index. The result is
written to data/graph.json for consumption by index.html.

By default it reads from a local checkout of https://github.com/w3c/webref
in ./webref/ed. Pass --base with an https:// URL (e.g.
https://w3c.github.io/webref/ed/) to fetch over the network instead.

Usage:
    ./build_graph.py [--out data/graph.json] [--base webref/ed]
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE = os.path.join(HERE, "webref", "ed")


def fetch_json(location):
    """Load JSON from a local path or an http(s) URL."""
    if location.startswith(("http://", "https://")):
        req = urllib.request.Request(location, headers={"User-Agent": "webref-visualized/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    with open(location, encoding="utf-8") as f:
        return json.load(f)


def normalize_url(url):
    """Normalize a URL so that trivially different spellings compare equal."""
    if not url:
        return None
    p = urllib.parse.urlsplit(url.strip())
    scheme = "https"  # treat http and https as equivalent
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = p.path or "/"
    # Drop common index filenames and trailing slashes.
    for suffix in ("/index.html", "/index.htm", "/Overview.html"):
        if path.endswith(suffix):
            path = path[: -len(suffix)] + "/"
    path = path.rstrip("/") or "/"
    return f"{scheme}://{host}{path}"


def candidate_urls(spec):
    """All URLs under which a spec in the index may be referenced."""
    urls = set()
    for key in ("url", "crawled"):
        urls.add(spec.get(key))
    for key in ("nightly", "release"):
        sub = spec.get(key) or {}
        urls.add(sub.get("url"))
        urls.update(sub.get("alternateUrls") or [])
    series = spec.get("series") or {}
    urls.add(series.get("nightlyUrl"))
    urls.add(series.get("releaseUrl"))
    urls.update(spec.get("versions") or [])
    return {u for u in (normalize_url(u) for u in urls) if u}


def url_prefixes(url):
    """Yield progressively shorter ancestors of a URL path for fuzzy matching.

    e.g. https://drafts.csswg.org/css-grid-2/#foo ->
         https://drafts.csswg.org/css-grid-2, https://drafts.csswg.org
    """
    p = urllib.parse.urlsplit(url)
    parts = [x for x in p.path.split("/") if x]
    while parts:
        yield f"{p.scheme}://{p.netloc}/" + "/".join(parts)
        parts.pop()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=DEFAULT_BASE,
                    help="webref crawl directory (local path or https:// URL)")
    ap.add_argument("--out", default=os.path.join(HERE, "data", "graph.json"))
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    base = args.base if args.base.endswith("/") else args.base + "/"
    print(f"Reading {base}index.json ...", file=sys.stderr)
    index = fetch_json(base + "index.json")
    specs = index["results"]
    print(f"  {len(specs)} specs", file=sys.stderr)

    # ---- Build URL -> shortname lookup -------------------------------------
    url_to_short = {}
    for spec in specs:
        for u in candidate_urls(spec):
            # Prefer "full" specs over delta/fork specs when URLs collide.
            existing = url_to_short.get(u)
            if existing is None or spec.get("seriesComposition") == "full":
                url_to_short[u] = spec["shortname"]
    # Also allow lookup by series shortname (e.g. "css-grid" -> "css-grid-2").
    series_to_short = {}
    for spec in specs:
        series = spec.get("series") or {}
        if series.get("currentSpecification") == spec["shortname"]:
            series_to_short[series.get("shortname", "").lower()] = spec["shortname"]
    short_set = {s["shortname"] for s in specs}

    def resolve(ref):
        """Map a {name, url} ref entry to a spec shortname, or None."""
        url = normalize_url(ref.get("url"))
        if url:
            if url in url_to_short:
                return url_to_short[url]
            for prefix in url_prefixes(url):
                if prefix in url_to_short:
                    return url_to_short[prefix]
        name = (ref.get("name") or "").lower()
        if name in short_set:
            return name
        if name in series_to_short:
            return series_to_short[name]
        return None

    # ---- Fetch all refs files ---------------------------------------------
    with_refs = [s for s in specs if s.get("refs")]
    print(f"Loading {len(with_refs)} refs files ...", file=sys.stderr)

    def load_refs(spec):
        try:
            return spec["shortname"], fetch_json(base + spec["refs"])
        except Exception as e:  # noqa: BLE001
            print(f"  ! failed {spec['refs']}: {e}", file=sys.stderr)
            return spec["shortname"], None

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        refs_by_spec = dict(pool.map(load_refs, with_refs))

    # ---- Build edges ------------------------------------------------------
    edges = {}  # (source, target) -> kind
    unresolved = {}  # name -> count
    for source, data in refs_by_spec.items():
        if not data:
            continue
        refs = data.get("refs") or {}
        for kind in ("normative", "informative"):
            for ref in refs.get(kind) or []:
                target = resolve(ref)
                if target is None:
                    unresolved[ref.get("name")] = unresolved.get(ref.get("name"), 0) + 1
                    continue
                if target == source:
                    continue
                key = (source, target)
                # Normative wins if a spec lists a ref in both sections.
                if key not in edges or kind == "normative":
                    edges[key] = kind

    in_degree, out_degree = {}, {}
    for (s, t), _ in edges.items():
        out_degree[s] = out_degree.get(s, 0) + 1
        in_degree[t] = in_degree.get(t, 0) + 1

    # ---- Definitions and the links that point at them ---------------------
    # For each spec with a "dfns" file, record which other specs link to each
    # of its definitions (using the anchors recorded in the linking spec's
    # "links" file).
    with_dfns = [s for s in specs if s.get("dfns")]
    print(f"Loading {len(with_dfns)} dfns files ...", file=sys.stderr)

    def load_dfns(spec):
        try:
            return spec["shortname"], fetch_json(base + spec["dfns"])["dfns"]
        except Exception as e:  # noqa: BLE001
            print(f"  ! failed {spec['dfns']}: {e}", file=sys.stderr)
            return spec["shortname"], []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        dfns_by_spec = dict(pool.map(load_dfns, with_dfns))

    with_links = [s for s in specs if s.get("links")]
    print(f"Loading {len(with_links)} links files ...", file=sys.stderr)

    def load_links(spec):
        try:
            return spec["shortname"], fetch_json(base + spec["links"])["links"]
        except Exception as e:  # noqa: BLE001
            print(f"  ! failed {spec['links']}: {e}", file=sys.stderr)
            return spec["shortname"], {}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        links_by_spec = dict(pool.map(load_links, with_links))

    # (target spec, dfn id) -> set of referencing specs
    dfn_ids = {short: {d["id"] for d in dfns} for short, dfns in dfns_by_spec.items()}
    dfn_refs = {}
    for source, link_data in links_by_spec.items():
        for category in ("rawlinks", "autolinks"):
            for url, info in (link_data.get(category) or {}).items():
                target = info.get("specShortname") or resolve({"url": url})
                if not target or target == source or target not in dfn_ids:
                    continue
                for anchor in info.get("anchors") or []:
                    if anchor in dfn_ids[target]:
                        dfn_refs.setdefault((target, anchor), set()).add(source)

    specs_dir = os.path.join(os.path.dirname(os.path.abspath(args.out)), "specs")
    os.makedirs(specs_dir, exist_ok=True)
    dfn_stats = {}
    for short, dfns in dfns_by_spec.items():
        out_dfns = []
        for d in dfns:
            refs = sorted(dfn_refs.get((short, d["id"]), ()))
            heading = d.get("heading") or {}
            out_dfns.append({
                "id": d["id"],
                "href": d.get("href"),
                "text": (d.get("linkingText") or [d["id"]])[0],
                "type": d.get("type"),
                "for": d.get("for") or [],
                "access": d.get("access"),
                "informative": bool(d.get("informative")),
                "heading": {"id": heading.get("id"), "title": heading.get("title"), "number": heading.get("number")},
                "refs": refs,
            })
        referenced = sum(1 for d in out_dfns if d["refs"])
        dfn_stats[short] = {"dfnCount": len(out_dfns), "dfnRefCount": referenced}
        with open(os.path.join(specs_dir, f"{short}.js"), "w") as f:
            f.write(f"(window.WEBREF_SPECS = window.WEBREF_SPECS || {{}})[{json.dumps(short)}] = ")
            json.dump({"id": short, "dfns": out_dfns}, f, separators=(",", ":"))
            f.write(";\n")
    print(f"Wrote {len(dfn_stats)} per-spec definition files to {specs_dir} "
          f"({len(dfn_refs)} definitions are linked to from other specs)", file=sys.stderr)

    # ---- Series: specs sharing a series.shortname (e.g. css-color-3/4/5/6) --
    # For every multi-member series, emit a merged, de-duplicated definition
    # file and a summary record so the UI can collapse the members into one.
    members_by_series = {}
    for spec in specs:
        members_by_series.setdefault((spec.get("series") or {}).get("shortname") or spec["shortname"], []).append(spec)
    spec_by_short = {s["shortname"]: s for s in specs}
    series_dir = os.path.join(os.path.dirname(os.path.abspath(args.out)), "series")
    os.makedirs(series_dir, exist_ok=True)
    series_records = []
    for series_name, members in members_by_series.items():
        if len(members) < 2:
            continue
        series = members[0].get("series") or {}
        current = spec_by_short.get(series.get("currentSpecification")) or members[-1]
        member_shorts = {m["shortname"] for m in members}
        # Current spec first so its version of a duplicated definition wins.
        ordered = [current] + [m for m in members if m is not current]

        merged, by_id, by_key = [], {}, {}
        for m in ordered:
            for d in dfns_by_spec.get(m["shortname"], []):
                heading = d.get("heading") or {}
                text = (d.get("linkingText") or [d["id"]])[0]
                key = (d.get("type"), text.lower(), tuple(d.get("for") or []))
                refs = {r for r in dfn_refs.get((m["shortname"], d["id"]), ()) if r not in member_shorts}
                existing = by_id.get(d["id"]) or by_key.get(key)
                if existing:
                    existing["refs"].update(refs)
                    existing["definedIn"].append(m["shortname"])
                    continue
                entry = {
                    "id": d["id"],
                    "href": d.get("href"),
                    "text": text,
                    "type": d.get("type"),
                    "for": d.get("for") or [],
                    "access": d.get("access"),
                    "informative": bool(d.get("informative")),
                    "heading": {"id": heading.get("id"), "title": heading.get("title"), "number": heading.get("number")},
                    "refs": set(refs),
                    "definedIn": [m["shortname"]],
                }
                by_id[d["id"]] = entry
                by_key[key] = entry
                merged.append(entry)
        for e in merged:
            e["refs"] = sorted(e["refs"])

        series_id = f"series:{series_name}"
        with open(os.path.join(series_dir, f"{series_name}.js"), "w") as f:
            f.write(f"(window.WEBREF_SPECS = window.WEBREF_SPECS || {{}})[{json.dumps(series_id)}] = ")
            json.dump({"id": series_id, "dfns": merged}, f, separators=(",", ":"))
            f.write(";\n")

        nightly = current.get("nightly") or {}
        release = current.get("release") or {}
        series_records.append({
            "id": series_id,
            "series": series_name,
            "title": series.get("title") or current.get("title"),
            "shortTitle": series.get("shortTitle") or current.get("shortTitle") or series_name,
            "members": [m["shortname"] for m in members],
            "current": current["shortname"],
            "url": series.get("nightlyUrl") or nightly.get("url") or current.get("url"),
            "organization": current.get("organization") or "Unknown",
            "groups": sorted({g.get("name") for m in members for g in m.get("groups") or [] if g.get("name")}),
            "status": release.get("status") or nightly.get("status") or "",
            "categories": current.get("categories") or [],
            "dfnCount": len(merged),
            "dfnRefCount": sum(1 for e in merged if e["refs"]),
            "rawDfnCount": sum(len(dfns_by_spec.get(m["shortname"], [])) for m in members),
        })
    print(f"Wrote {len(series_records)} merged series definition files to {series_dir}", file=sys.stderr)

    nodes = []
    for spec in specs:
        short = spec["shortname"]
        series = spec.get("series") or {}
        nightly = spec.get("nightly") or {}
        release = spec.get("release") or {}
        nodes.append({
            "id": short,
            "title": spec.get("title"),
            "shortTitle": spec.get("shortTitle") or series.get("shortTitle") or short,
            "url": nightly.get("url") or spec.get("url"),
            "organization": spec.get("organization") or "Unknown",
            "groups": [g.get("name") for g in spec.get("groups") or []],
            "status": release.get("status") or nightly.get("status") or "",
            "standing": spec.get("standing"),
            "composition": spec.get("seriesComposition"),
            "categories": spec.get("categories") or [],
            "series": series.get("shortname"),
            "inDegree": in_degree.get(short, 0),
            "outDegree": out_degree.get(short, 0),
            "hasRefs": bool(refs_by_spec.get(short)),
            "dfnCount": dfn_stats.get(short, {}).get("dfnCount", 0),
            "dfnRefCount": dfn_stats.get(short, {}).get("dfnRefCount", 0),
        })

    graph = {
        "meta": {
            "source": base,
            "crawlDate": index.get("date"),
            "specCount": len(nodes),
            "edgeCount": len(edges),
            "normativeCount": sum(1 for k in edges.values() if k == "normative"),
            "informativeCount": sum(1 for k in edges.values() if k == "informative"),
        },
        "nodes": nodes,
        "series": series_records,
        "links": [{"source": s, "target": t, "kind": k} for (s, t), k in sorted(edges.items())],
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(graph, f, indent=1)
    # Also emit a JS module wrapper so index.html works over file:// (where
    # fetch() of a sibling JSON file is blocked by browsers).
    js_out = os.path.splitext(args.out)[0] + ".js"
    with open(js_out, "w") as f:
        f.write("window.WEBREF_GRAPH = ")
        json.dump(graph, f, separators=(",", ":"))
        f.write(";\n")

    print(f"Wrote {args.out}: {len(nodes)} nodes, {len(edges)} edges "
          f"({graph['meta']['normativeCount']} normative, {graph['meta']['informativeCount']} informative)",
          file=sys.stderr)
    top_unresolved = sorted(unresolved.items(), key=lambda kv: -kv[1])[:15]
    print(f"Unresolved refs (not in webref index): {sum(unresolved.values())} across "
          f"{len(unresolved)} names. Most common: {top_unresolved}", file=sys.stderr)


if __name__ == "__main__":
    main()
