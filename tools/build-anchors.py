#!/usr/bin/env python3
"""
Derive stable anchor ids for every addressable part of the review documents.

Rather than hand-tagging rows (and re-tagging them every time a document
changes), this reads the documents themselves, injects a data-anchor on each
table row and section, and writes assets/doc-index.json — the index the notes
layer uses for labels, grouping and the dashboard.

Presentation stays in the HTML. Nothing is recomputed: no figure is read,
rewritten or derived. Re-runnable; ids are derived from heading and row text,
so they survive edits that don't rename things.

    python3 tools/build-anchors.py            # write
    python3 tools/build-anchors.py --check    # verify in sync, exit 1 if not
"""
import html as _html
import json, re, sys, unicodedata, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = {"proforma": "proforma.html", "placement": "placement.html"}


def slug(text, maxlen=48):
    text = re.sub(r"<[^>]+>", "", text)
    text = (text.replace("&amp;", "and").replace("&nbsp;", " ")
                .replace("&mdash;", "-").replace("&ndash;", "-")
                .replace("&times;", "x").replace("&hellip;", ""))
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:maxlen].strip("-") or "item"


def plain(html):
    """Readable label: tags out, entities in, margin notes dropped."""
    html = re.sub(r'<span class="note".*?</span>', "", html, flags=re.S)
    html = re.sub(r'<span class="tbd".*?</span>', "", html, flags=re.S)
    txt = _html.unescape(re.sub(r"<[^>]+>", "", html)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", txt).strip()


def uniq(base, seen):
    if base not in seen:
        seen.add(base)
        return base
    n = 2
    while f"{base}-{n}" in seen:
        n += 1
    seen.add(f"{base}-{n}")
    return f"{base}-{n}"


def strip(src):
    """Remove previously injected anchors so re-runs are idempotent."""
    src = re.sub(r'\s*data-anchor="[^"]*"', "", src)
    src = re.sub(r"<section id=\"[^\"]*\">", "<section>", src)
    return src


def process(page, path):
    src = strip((ROOT / path).read_text())
    out, index, seen = [], [], set()
    section_slug, section_label = "document", "Document"
    pos = 0

    # every <section> ... anchor it, then walk its rows
    for sec in re.finditer(r"<section>(.*?)</section>", src, re.S):
        out.append(src[pos:sec.start()])
        body = sec.group(1)
        eye = re.search(r'<div class="eyebrow">(.*?)</div>', body, re.S)
        h2 = re.search(r"<h2>(.*?)</h2>", body, re.S)
        section_label = plain(eye.group(1)) if eye else (plain(h2.group(1)) if h2 else "Section")
        section_slug = uniq(slug(section_label), seen)
        rows = []

        def tag_row(m):
            attrs, inner = m.group(1), m.group(2)
            if "<th" in inner:                      # header row, not addressable
                return m.group(0)
            first = re.search(r"<td[^>]*>(.*?)</td>", inner, re.S)
            if not first:
                return m.group(0)
            label = plain(first.group(1))
            if not label:
                return m.group(0)
            aid = uniq(f"{section_slug}--{slug(label)}", seen)
            rows.append({"id": aid, "label": label})
            return f'<tr{attrs} data-anchor="{aid}">{inner}</tr>'

        body = re.sub(r"<tr([^>]*)>(.*?)</tr>", tag_row, body, flags=re.S)

        # stat boxes and caveat cards are addressable too
        def tag_block(cls, label_re):
            def go(m):
                inner = m.group(1)
                lm = re.search(label_re, inner, re.S)
                label = plain(lm.group(1)) if lm else cls
                aid = uniq(f"{section_slug}--{slug(label)}", seen)
                rows.append({"id": aid, "label": label})
                return f'<div class="{cls}" data-anchor="{aid}">{inner}</div>'
            return go

        body = re.sub(r'<div class="stat">(.*?)</div>\s*(?=<div class="stat"|</div>)',
                      tag_block("stat", r'<div class="v[^"]*">(.*?)</div>'), body, flags=re.S)
        body = re.sub(r'<div class="caveat">(.*?)</div>',
                      tag_block("caveat", r"<b>(.*?)</b>"), body, flags=re.S)

        # each zone node on the traffic x intent grid is addressable
        def tag_zone(m):
            inner = m.group(1)
            label = " ".join(plain(t) for t in re.findall(r"<text[^>]*>(.*?)</text>", inner, re.S))
            label = re.sub(r"\s+", " ", label).strip()
            if not label:
                return m.group(0)
            aid = uniq(f"{section_slug}--{slug(label)}", seen)
            rows.append({"id": aid, "label": label, "kind": "zone"})
            return f'<g data-anchor="{aid}">{inner}</g>'

        body = re.sub(r"<g>(\s*<circle.*?)</g>", tag_zone, body, flags=re.S)

        index.append({"id": section_slug, "label": section_label,
                      "heading": plain(h2.group(1)) if h2 else section_label,
                      "rows": rows})
        out.append(f'<section id="{section_slug}" data-anchor="{section_slug}">{body}</section>')
        pos = sec.end()

    out.append(src[pos:])
    return "".join(out), index


def main():
    check = "--check" in sys.argv
    doc_index, changed = {}, []
    for page, path in PAGES.items():
        html, index = process(page, path)
        doc_index[page] = index
        target = ROOT / path
        if target.read_text() != html:
            changed.append(path)
            if not check:
                target.write_text(html)

    idx_path = ROOT / "assets" / "doc-index.json"
    payload = json.dumps(doc_index, indent=2, ensure_ascii=False) + "\n"
    if not idx_path.exists() or idx_path.read_text() != payload:
        changed.append("assets/doc-index.json")
        if not check:
            idx_path.write_text(payload)

    total = sum(len(s["rows"]) for p in doc_index.values() for s in p)
    secs = sum(len(p) for p in doc_index.values())
    print(f"{secs} sections, {total} addressable rows")
    for page, secs_ in doc_index.items():
        print(f"  {page}: {len(secs_)} sections, {sum(len(s['rows']) for s in secs_)} rows")
    if check and changed:
        print("OUT OF SYNC:", ", ".join(changed))
        return 1
    if changed and not check:
        print("updated:", ", ".join(changed))
    return 0


sys.exit(main())
