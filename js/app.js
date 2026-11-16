(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const preview = $('preview');
  const previewScroll = $('preview-scroll');
  const titleEl = $('wiki-title');
  const filenameEl = $('filename');
  const statusEl = $('status');
  const dropzone = $('dropzone');
  const editorPane = $('editor-pane');
  const fileInput = $('file-input');
  const STORE_KEY = 'wikitext-editor:v1';

  let dirty = false;

  // ---------- Storage (best effort) ----------
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };

  // ---------- Rendering ----------
  function titleFromName(name) {
    return name.replace(/\.(wiki|wikitext|mediawiki|txt)$/i, '')
      .replace(/^\d+_/, '')            // drop ordering prefixes like "0042_"
      .replace(/[_]+/g, ' ').trim() || 'Untitled';
  }

  function render() {
    const src = editor.value;
    titleEl.textContent = titleFromName(filenameEl.value);
    if (!src.trim()) {
      preview.innerHTML = '<p class="empty-preview">Nothing to preview yet. Start typing on the left.</p>';
    } else {
      try {
        preview.innerHTML = WikiParser.parse(src).html;
      } catch (err) {
        console.error(err);
        preview.innerHTML = '<p class="empty-preview">Preview error: ' + String(err.message || err) + '</p>';
      }
    }
    const words = (src.match(/[A-Za-z0-9À-￿']+/g) || []).length;
    $('counts').textContent = words.toLocaleString() + ' words · ' + src.split('\n').length.toLocaleString() + ' lines';
    dropzone.classList.toggle('show', !src && !dropzone.dataset.dismissed);
  }

  let renderTimer = null, saveTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 120);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 400);
  }

  function setDirty(v) {
    dirty = v;
    statusEl.textContent = v ? '● Unsaved changes' : '';
  }

  editor.addEventListener('input', () => { setDirty(true); scheduleRender(); });
  filenameEl.addEventListener('input', scheduleRender);
  filenameEl.addEventListener('blur', () => {
    let n = filenameEl.value.trim() || 'untitled.wiki';
    if (!/\.[a-z0-9]+$/i.test(n)) n += '.wiki';
    filenameEl.value = n;
    scheduleRender();
  });

  // ---------- Loading files ----------
  // Text as it was when the file was opened; null for a new document with no source file.
  let sourceText = null;

  function saveState() {
    store.set({ name: filenameEl.value, text: editor.value, source: sourceText });
  }

  function loadText(text, name, hasSource) {
    editor.value = text.replace(/\r\n?/g, '\n');
    filenameEl.value = name || 'untitled.wiki';
    sourceText = hasSource === false ? null : editor.value;
    setDirty(false);
    dropzone.dataset.dismissed = '1';
    render();
    saveState();
    previewScroll.scrollTop = 0;
    editor.scrollTop = 0;
    editor.focus();
    editor.setSelectionRange(0, 0);
  }

  function confirmDiscard() {
    return !dirty || !editor.value.trim() || confirm('Discard unsaved changes to "' + filenameEl.value + '"?');
  }

  function openFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { alert('That file is larger than 20 MB.'); return; }
    if (!confirmDiscard()) return;
    const reader = new FileReader();
    reader.onload = () => {
      loadText(String(reader.result), file.name);
      statusEl.textContent = 'Opened ' + file.name;
      setTimeout(() => { if (!dirty) statusEl.textContent = ''; }, 2500);
    };
    reader.onerror = () => alert('Could not read the file.');
    reader.readAsText(file);
  }

  $('btn-open').onclick = () => fileInput.click();
  $('dz-browse').onclick = () => fileInput.click();
  fileInput.onchange = () => { openFile(fileInput.files[0]); fileInput.value = ''; };
  $('dz-type').onclick = () => { dropzone.dataset.dismissed = '1'; dropzone.classList.remove('show'); editor.focus(); };
  $('dz-sample').onclick = () => loadText(SAMPLE, 'Sample_article.wiki');
  $('btn-sample').onclick = () => { if (confirmDiscard()) loadText(SAMPLE, 'Sample_article.wiki'); };
  $('btn-new').onclick = () => {
    if (!confirmDiscard()) return;
    loadText('', 'untitled.wiki', false);
    delete dropzone.dataset.dismissed;
    render();
  };

  // Drag & drop: the editor pane is the main target, but dropping anywhere works
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    editorPane.classList.add('over');
    dropzone.classList.add('show');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      editorPane.classList.remove('over');
      dropzone.classList.toggle('show', !editor.value && !dropzone.dataset.dismissed);
    }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    editorPane.classList.remove('over');
    openFile(e.dataTransfer.files[0]);
    dropzone.classList.toggle('show', !editor.value && !dropzone.dataset.dismissed);
  });

  // ---------- Export ----------
  const EDITED_RE = /_edited_\d{8}-\d{6}$/i;

  function timestamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // "name.wiki" -> "name_edited_YYYYMMDD-HHMMSS.wiki" when the text differs from the opened file.
  // An existing "_edited_<timestamp>" suffix is replaced, not stacked.
  function exportName() {
    let name = filenameEl.value.trim() || 'untitled.wiki';
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.wiki';
    const changed = sourceText !== null && editor.value !== sourceText;
    if (!changed) return name;
    const dot = name.lastIndexOf('.');
    const base = name.slice(0, dot).replace(EDITED_RE, '');
    return base + '_edited_' + timestamp(new Date()) + name.slice(dot);
  }

  function exportFile() {
    const name = exportName();
    const blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDirty(false);
    statusEl.textContent = 'Exported ' + name;
    setTimeout(() => { if (!dirty) statusEl.textContent = ''; }, 2500);
  }
  $('btn-export').onclick = exportFile;

  // ---------- Editing helpers ----------
  function replaceSelection(text, selStart, selEnd) {
    const start = editor.selectionStart;
    editor.focus();
    // execCommand keeps the native undo stack; fall back if unsupported
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input'));
    }
    if (selStart !== undefined) editor.setSelectionRange(start + selStart, start + (selEnd !== undefined ? selEnd : selStart));
  }

  function wrap(before, after, placeholder) {
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    const inner = sel || placeholder;
    replaceSelection(before + inner + after, before.length, before.length + inner.length);
  }

  // Ensure the inserted block starts on its own line
  function insertBlock(text, selStart, selEnd) {
    const pos = editor.selectionStart;
    const before = editor.value.slice(0, pos);
    const after = editor.value.slice(editor.selectionEnd);
    let prefix = '';
    if (before && !before.endsWith('\n')) prefix = '\n';
    if (before && !/\n\n$/.test(before + prefix) && /^(=|\{\||----)/.test(text)) prefix += '\n';
    const suffix = after && !after.startsWith('\n') ? '\n' : '';
    replaceSelection(prefix + text + suffix,
      selStart !== undefined ? prefix.length + selStart : undefined,
      selEnd !== undefined ? prefix.length + selEnd : undefined);
  }

  // Prefix every selected line (lists / indents)
  function prefixLines(mark, placeholder) {
    const v = editor.value;
    let s = editor.selectionStart, e = editor.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    if (lineEnd < 0) lineEnd = v.length;
    const block = v.slice(lineStart, lineEnd);
    editor.setSelectionRange(lineStart, lineEnd);
    if (!block.trim()) {
      replaceSelection(mark + ' ' + placeholder, mark.length + 1, mark.length + 1 + placeholder.length);
      return;
    }
    const out = block.split('\n').map((l) => (/^[*#:;]/.test(l) ? mark[0] + l : mark + ' ' + l)).join('\n');
    replaceSelection(out, 0, out.length);
  }

  const commands = {
    bold: () => wrap("'''", "'''", 'bold text'),
    italic: () => wrap("''", "''", 'italic text'),
    link: () => {
      const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      if (sel) replaceSelection('[[' + sel + ']]', 2, 2 + sel.length);
      else replaceSelection('[[Page name|link text]]', 2, 11);
    },
    extlink: () => {
      const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd) || 'link text';
      replaceSelection('[https://example.com ' + sel + ']', 1, 20);
    },
    ul: () => prefixLines('*', 'List item'),
    ol: () => prefixLines('#', 'List item'),
    indent: () => prefixLines(':', 'Indented text'),
    image: () => {
      const t = '[[File:Example.jpg|thumb|right|250px|Caption text]]';
      insertBlock(t, 7, 18);
    },
    table: () => {
      const t = '{| class="wikitable"\n|+ Table caption\n! Header 1 !! Header 2 !! Header 3\n|-\n| Cell 1 || Cell 2 || Cell 3\n|-\n| Cell 4 || Cell 5 || Cell 6\n|}';
      insertBlock(t, 24, 37);
    },
    ref: () => wrap('<ref>', '</ref>', 'Source, title, date'),
    template: () => wrap('{{', '}}', 'Template name'),
    hr: () => insertBlock('----'),
    nowiki: () => wrap('<nowiki>', '</nowiki>', "''not formatted''"),
    heading: (level) => {
      const eq = '='.repeat(level);
      const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim() || 'Heading';
      insertBlock(eq + ' ' + sel + ' ' + eq, level + 1, level + 1 + sel.length);
    }
  };

  document.querySelectorAll('.toolbar [data-cmd]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep textarea selection
    b.addEventListener('click', () => commands[b.dataset.cmd]());
  });
  $('tb-heading').addEventListener('change', (e) => {
    const lvl = +e.target.value;
    e.target.value = '';
    if (lvl) commands.heading(lvl);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F1') { e.preventDefault(); openHelp(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportFile(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); fileInput.click(); return; }
    if (document.activeElement !== editor || !mod) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); commands.bold(); }
    else if (k === 'i') { e.preventDefault(); commands.italic(); }
    else if (k === 'k') { e.preventDefault(); commands.link(); }
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      replaceSelection('\t');
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty && editor.value.trim()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Scroll sync (editor -> preview, proportional) ----------
  editor.addEventListener('scroll', () => {
    const max = editor.scrollHeight - editor.clientHeight;
    if (max <= 0) return;
    const ratio = editor.scrollTop / max;
    previewScroll.scrollTop = ratio * (previewScroll.scrollHeight - previewScroll.clientHeight);
  });

  // Internal links in preview: jump to headings, otherwise do nothing
  preview.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      e.preventDefault();
      const target = href.length > 1 && document.getElementById(decodeURIComponent(href.slice(1)));
      if (target && previewScroll.contains(target)) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // ---------- Resizable divider ----------
  const divider = $('divider');
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    const panes = divider.parentElement.getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(80, Math.max(20, ((ev.clientX - panes.left) / panes.width) * 100));
      editorPane.style.flexBasis = pct + '%';
    };
    const up = () => {
      divider.classList.remove('dragging');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });

  // ---------- Text size (editor and preview independently) ----------
  const ZOOM_KEY = 'wikitext-editor:zoom';
  const ZOOM_STEPS = [70, 80, 90, 100, 110, 125, 150, 175, 200];
  const zoomTargets = {
    editor: { el: editor, base: 13.5 },
    preview: { el: document.querySelector('.wiki'), base: 14.5 }
  };
  let zoom = { editor: 100, preview: 100 };
  try { Object.assign(zoom, JSON.parse(localStorage.getItem(ZOOM_KEY)) || {}); } catch (e) { /* ignore */ }

  function applyZoom(name) {
    const t = zoomTargets[name];
    if (!ZOOM_STEPS.includes(zoom[name])) zoom[name] = 100;
    t.el.style.fontSize = (t.base * zoom[name] / 100) + 'px';
    const group = document.querySelector('.zoom[data-zoom-target="' + name + '"]');
    group.querySelector('.zoom-val').textContent = zoom[name] + '%';
    group.querySelector('[data-zoom="-1"]').disabled = zoom[name] === ZOOM_STEPS[0];
    group.querySelector('[data-zoom="1"]').disabled = zoom[name] === ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }

  document.querySelectorAll('.zoom').forEach((group) => {
    const name = group.dataset.zoomTarget;
    group.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-zoom]');
      if (!btn) return;
      const dir = +btn.dataset.zoom;
      const i = ZOOM_STEPS.indexOf(zoom[name]);
      zoom[name] = dir === 0 ? 100 : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
      applyZoom(name);
      try { localStorage.setItem(ZOOM_KEY, JSON.stringify(zoom)); } catch (err) { /* ignore */ }
    });
    applyZoom(name);
  });

  // ---------- Help ----------
  const HELP = [
    ['Text', [
      ['Bold', "'''bold text'''"],
      ['Italic', "''italic text''"],
      ['Bold + italic', "'''''bold and italic'''''"],
      ['Strikethrough / underline', '<s>struck</s> and <u>underlined</u>'],
      ['Superscript / subscript', 'x<sup>2</sup> and H<sub>2</sub>O'],
      ['Small text', '<small>small print</small>'],
      ['Line break', 'First line<br />second line'],
      ['Escape markup', "<nowiki>''not italic''</nowiki>"],
      ['Hidden comment', 'Visible <!-- hidden note --> text']
    ]],
    ['Headings', [
      ['Section', '== Section =='],
      ['Subsection', '=== Subsection ==='],
      ['Sub-subsection', '==== Sub-subsection ===='],
      ['Hide contents box', '__NOTOC__']
    ]],
    ['Links', [
      ['Internal link', '[[Albert Einstein]]'],
      ['Piped link', '[[Albert Einstein|Einstein]]'],
      ['Link to section', '[[Physics#History|history of physics]]'],
      ['Word endings', '[[scientist]]s'],
      ['External link', '[https://www.wikipedia.org Wikipedia]'],
      ['Bare URL', 'https://example.com'],
      ['Category', '[[Category:Physicists]]']
    ]],
    ['Lists', [
      ['Bulleted list', '* Item one\n* Item two\n** Nested item'],
      ['Numbered list', '# First\n# Second\n## Sub-step'],
      ['Definition list', '; Term\n: Definition'],
      ['Indent', ': Indented once\n:: Indented twice'],
      ['Mixed', '# Step\n#* Note under step']
    ]],
    ['Images', [
      ['Thumbnail', '[[File:Example.jpg|thumb|Caption text]]'],
      ['Size and position', '[[File:Example.jpg|thumb|left|150px|Caption]]'],
      ['Inline image', '[[File:Icon.png|40px]]']
    ]],
    ['Tables', [
      ['Basic table', '{| class="wikitable"\n! Name !! Year\n|-\n| Alpha || 2001\n|-\n| Beta || 2005\n|}'],
      ['Caption + cell style', '{| class="wikitable"\n|+ Results\n|-\n! Team\n! Score\n|-\n| Reds\n| style="background:#dfd" | 3\n|}']
    ]],
    ['References', [
      ['Footnote', "A claim.<ref>Author, ''Book'', 2020.</ref>\n\n== References ==\n<references />"],
      ['Named / reused', 'One.<ref name="src">Source A</ref> Two.<ref name="src" />\n<references />'],
      ['Cite template', 'Fact.<ref>{{cite web |title=Page title |url=https://example.com |website=Example |date=2024}}</ref>\n<references />'],
      ['Citation needed', 'Unsourced claim.{{citation needed}}']
    ]],
    ['Templates & other', [
      ['Template', '{{Template name|param=value}}'],
      ['Infobox', '{{Infobox person\n| name = Ada Lovelace\n| born = 10 December 1815\n| occupation = Mathematician\n}}'],
      ['Main article', '{{Main|History of computing}}'],
      ['Block quote', '<blockquote>Quoted text.</blockquote>'],
      ['Preformatted', ' Lines starting with a space\n are shown as-is'],
      ['Code', '<code>inline code</code>'],
      ['Horizontal rule', '----']
    ]]
  ];

  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function buildHelp() {
    const body = $('help-body');
    body.innerHTML = HELP.map(([section, rows]) =>
      '<div class="help-section"><h3>' + section + '</h3><table class="help-table">' +
      rows.map(([label, src]) =>
        '<tr data-search="' + escHtml((section + ' ' + label + ' ' + src).toLowerCase()).replace(/"/g, '&quot;') + '">' +
        '<td>' + label + '</td>' +
        '<td class="src"><pre title="Click to insert" data-src="' + encodeURIComponent(src) + '">' + escHtml(src) + '</pre></td>' +
        '<td class="out"><div class="wiki-body">' + WikiParser.parse(src).html + '</div></td></tr>'
      ).join('') + '</table></div>'
    ).join('');
    body.addEventListener('click', (e) => {
      const pre = e.target.closest('pre[data-src]');
      if (pre) {
        const src = decodeURIComponent(pre.dataset.src);
        $('help').close();
        dropzone.dataset.dismissed = '1';
        dropzone.classList.remove('show');
        editor.focus();
        if (src.includes('\n') || /^(==|\{\||----|\[\[File)/.test(src)) insertBlock(src);
        else replaceSelection(src);
        return;
      }
      if (e.target.closest('a')) e.preventDefault();
    });
  }

  function openHelp() {
    const dlg = $('help');
    if (!$('help-body').children.length) buildHelp();
    if (!dlg.open) dlg.showModal();
    $('help-search').focus();
  }
  $('btn-help').onclick = openHelp;
  $('help-close').onclick = () => $('help').close();
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); });
  $('help-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#help-body tr').forEach((tr) => { tr.hidden = q && !tr.dataset.search.includes(q); });
    document.querySelectorAll('#help-body .help-section').forEach((s) => {
      s.hidden = !s.querySelector('tr:not([hidden])');
    });
  });

  // ---------- Sample ----------
  const SAMPLE = `{{Infobox software
| name = Wikitext Editor
| developer = You
| released = 2026
| programming language = [[JavaScript]]
| platform = Web browser
| license = [[MIT License|MIT]]
}}
The '''Wikitext Editor''' is a browser-based tool for editing [[MediaWiki]] markup with a ''live preview''.<ref name="about">Project README, 2026.</ref> It runs entirely on the client, so files never leave your computer.

== Features ==
* Drag and drop or open any <code>.wiki</code> file
* Live, Wikipedia-style preview
** Tables, lists, references and infoboxes
** Image placeholders for <nowiki>[[File:...]]</nowiki> links
* Export the edited file with one click<ref>See the ''Export .wiki'' button.</ref>

[[File:Editor screenshot.png|thumb|right|240px|The editor with the preview on the right]]

== Usage ==
# Open a file, or start typing.
# Use the toolbar to insert headings, lists, images and tables.
# Press '''Export .wiki''' to download the result.

; Tip : Press F1 at any time to open the syntax reference.

=== Supported markup ===
{| class="wikitable"
|+ Markup overview
! Element !! Syntax !! Rendered
|-
| Bold || <nowiki>'''text'''</nowiki> || '''text'''
|-
| Italic || <nowiki>''text''</nowiki> || ''text''
|-
| Link || <nowiki>[[Page]]</nowiki> || [[Page]]
|}

== History ==
The project began as a simple way to clean up wiki exports.{{citation needed}} See also [https://www.mediawiki.org/wiki/Help:Formatting MediaWiki formatting help].

== References ==
<references />

[[Category:Text editors]]
[[Category:Web applications]]
`;

  // ---------- Init ----------
  const saved = store.get();
  if (saved && typeof saved.text === 'string') {
    editor.value = saved.text;
    filenameEl.value = saved.name || 'untitled.wiki';
    sourceText = typeof saved.source === 'string' ? saved.source : null;
    if (saved.text) dropzone.dataset.dismissed = '1';
  }
  render();
})();
