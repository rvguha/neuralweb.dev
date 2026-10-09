#!/usr/bin/env python3
"""Build the design-document pages (neuralweb.dev/design/) from the markdown documents that live in each project's repo.

    python tools/build_design.py NEURALKG2_MD ARD_MD QDRSS_MD NLWEB_MD

Each argument is the path of that project's docs/life-of-a-query.md. Needs the `markdown` package. Writes design/index.html and
design/<name>/index.html. References between the documents become links; mermaid diagrams are drawn in the browser.
"""
import html
import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
DOCS = [  # slug, short name, who it is for, markdown repo path as written inside the documents
    ("neural-db", "Neural DB", "NeuralKG2: a question in plain words becomes an answer whose every number comes from a published source.",
     "NeuralKG2/docs/life-of-a-query.md"),
    ("ard", "ARD finder", "Which published tables describe a quantity: the index, the search and the model rerank.",
     "ard-finder/docs/life-of-a-query.md"),
    ("qdrss", "Query-defined RSS", "A standing interest becomes an RSS feed of matching episodes and transcript passages.",
     "rssnlweb/docs/life-of-a-query.md"),
    ("nlweb", "NLWeb samples", "Natural-language search over recipes, movies, reviews, trails and homes.",
     "nlweb-samples/docs/life-of-a-query.md"),
]
LINKS = {path: f"/design/{slug}/" for slug, _, _, path in DOCS}
STYLE = """
:root { color-scheme: light dark; --bg:#f6f7fb; --surface:#fff; --ink:#1d2433; --muted:#52607d; --accent:#2f54c4; --line:#d9dee7; --code:#eef1f7;
  --display:"Newsreader","Iowan Old Style",Georgia,serif; --body:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#10141b; --surface:#171c26; --ink:#e6eaf2; --muted:#98a2b6; --accent:#8fa9ff; --line:#2a3242; --code:#222a39; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 var(--body); }
.wrap { max-width:860px; margin:0 auto; padding-inline:16px; padding-block:28px 72px; }
nav.top { font:13px var(--mono); display:flex; gap:6px 16px; flex-wrap:wrap; margin-bottom:22px; color:var(--muted); }
nav.top a { color:var(--accent); text-decoration:none; } nav.top a:hover { text-decoration:underline; } nav.top .here { color:var(--ink); font-weight:600; }
h1 { font:600 clamp(1.8rem,4vw,2.4rem)/1.15 var(--display); letter-spacing:-.01em; margin:0 0 .6em; text-wrap:balance; }
h2 { font:600 1.55rem/1.25 var(--display); margin:2.2em 0 .5em; padding-top:.4em; border-top:1px solid var(--line); }
h3 { font:600 1.15rem/1.3 var(--display); margin:1.8em 0 .4em; }
p, li { max-width:72ch; } a { color:var(--accent); }
code { font:.88em var(--mono); background:var(--code); padding:.12em .36em; border-radius:4px; overflow-wrap:anywhere; }
pre { background:var(--code); padding:14px 16px; border-radius:8px; overflow-x:auto; line-height:1.45; } pre code { background:none; padding:0; overflow-wrap:normal; }
pre.mermaid { background:var(--surface); border:1px solid var(--line); text-align:center; }
.tablewrap { overflow-x:auto; margin:1em 0; border:1px solid var(--line); border-radius:8px; background:var(--surface); }
table { border-collapse:collapse; width:100%; font-size:.92rem; min-width:520px; }
th { text-align:left; font:600 12px var(--mono); text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:8px 12px; border-top:1px solid var(--line); vertical-align:top; } tr:first-child td { border-top:0; }
em { color:var(--muted); } li { margin:.25em 0; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-top:24px; }
.card { display:block; padding:16px 18px; background:var(--surface); border:1px solid var(--line); border-radius:10px; text-decoration:none; color:inherit; }
.card:hover { border-color:var(--accent); } .card b { color:var(--accent); font:600 1.1rem var(--display); display:block; margin-bottom:4px; }
.card span { color:var(--muted); font-size:.92rem; }
"""
HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&family=Newsreader:wght@500;600&display=swap">
<style>{style}</style>
</head>
<body>
<div class="wrap">
"""
MERMAID = """<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default', securityLevel: 'strict' });
</script>
"""


def nav(current):
    parts = ['<a href="/design/">Design documents</a>'] + [
        f'<span class="here">{name}</span>' if slug == current else f'<a href="/design/{slug}/">{name}</a>' for slug, name, _, _ in DOCS]
    return '<nav class="top">' + " ".join(parts) + "</nav>\n"


NAMES = {"NeuralKG2/docs/life-of-a-query.md": "NeuralKG2", "ard-finder/docs/life-of-a-query.md": "ARD",
         "rssnlweb/docs/life-of-a-query.md": "QDRSS", "nlweb-samples/docs/life-of-a-query.md": "NLWeb samples"}


def convert(text):
    for path, url in LINKS.items():
        # "the ARD design document, `ard-finder/docs/...`" is one reference, not two.
        text = re.sub(rf"the (\w+) design document, `{re.escape(path)}`", rf"[the \1 design document]({url})", text)
        text = text.replace(f"`{path}`", f"[{NAMES[path]}]({url})")
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    body = re.sub(r'<pre><code class="language-mermaid">(.*?)</code></pre>', lambda m: f'<pre class="mermaid">{m.group(1)}</pre>', body, flags=re.S)
    body = re.sub(r"(<table>.*?</table>)", r'<div class="tablewrap">\1</div>', body, flags=re.S)
    return body


def main():
    sources = sys.argv[1:]
    if len(sources) != len(DOCS):
        sys.exit(__doc__)
    out = ROOT / "design"
    for (slug, name, blurb, _), source in zip(DOCS, sources):
        text = Path(source).read_text()
        title = re.match(r"# (.+)", text).group(1)
        page = HEAD.format(title=html.escape(title), style=STYLE) + nav(slug) + convert(text) + "\n</div>\n" + MERMAID + "</body>\n</html>\n"
        (out / slug).mkdir(parents=True, exist_ok=True)
        (out / slug / "index.html").write_text(page)
    cards = "".join(f'<a class="card" href="/design/{slug}/"><b>{name}</b><span>{blurb}</span></a>\n' for slug, name, blurb, _ in DOCS)
    index = (HEAD.format(title="NeuralWeb design documents", style=STYLE) + '<nav class="top"><span class="here">Design documents</span> <a href="/status/">Status</a></nav>\n'
             "<h1>How a query moves through NeuralWeb</h1>\n"
             "<p>One document for each system: what it is, how a query travels through it step by step, what it costs, how it fails, what must always hold and what is still open. Every claim points at a file and line in the code.</p>\n"
             f'<div class="cards">\n{cards}</div>\n</div>\n</body>\n</html>\n')
    (out / "index.html").write_text(index)
    print("wrote", out)


if __name__ == "__main__":
    main()
