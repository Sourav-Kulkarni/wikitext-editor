# Wikitext Editor

A browser-based editor for MediaWiki `.wiki` files with a live, Wikipedia-style preview. It's a static site with no build step and no dependencies, and it runs on GitHub Pages as-is.

## Features

- **Open files** by dragging and dropping onto the left pane, or with the file picker. Accepts `.wiki`, `.wikitext`, `.mediawiki` and `.txt`.
- **Live preview** of headings, contents box, bold/italic, links, lists, tables, infoboxes, references, categories and `<nowiki>`/`<pre>`.
- **Toolbar** to insert headings, lists, image placeholders, tables, references and templates.
- **Export** the edited file as `.wiki` (Ctrl+S).
- **Quick help** (F1): a searchable syntax reference. Click any example to insert it.
- **Autosave** to the browser's local storage. Files never leave your machine.

Images are shown as labelled placeholders, and unknown templates appear as highlighted `{{chips}}`.

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python -m http.server 8000   # then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, then choose `main` and `/ (root)`.
3. The site will be published at `https://<user>.github.io/<repo>/`.

## Project structure

```
index.html      Page layout, toolbar, help dialog
css/style.css   Editor UI and Wikipedia-like preview styles
js/parser.js    Wikitext → HTML renderer (WikiParser.parse)
js/app.js       File I/O, toolbar actions, live preview, help
```

## Limitations

The renderer is a lightweight approximation of MediaWiki, not a full implementation. It doesn't expand templates, parser functions or Lua modules.
