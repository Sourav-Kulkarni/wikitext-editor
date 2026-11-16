/*
 * Minimal MediaWiki wikitext -> HTML renderer.
 * Covers the common article syntax: headings, bold/italic, links, lists,
 * tables, images (as placeholders), references, templates (as chips /
 * infobox), <nowiki>, <pre>, comments and a small whitelist of HTML tags.
 */
(function (global) {
  'use strict';

  const ALLOWED_TAGS = [
    'b', 'i', 'u', 's', 'del', 'ins', 'small', 'big', 'sup', 'sub', 'code',
    'span', 'div', 'br', 'blockquote', 'center', 'tt', 'strike', 'kbd',
    'var', 'mark', 'abbr', 'cite', 'q', 'p', 'hr', 'syntaxhighlight', 'poem'
  ];

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

  function slug(text) {
    return text.replace(/<[^>]+>/g, '').trim().replace(/\s+/g, '_').replace(/[^\w\-.]/g, '');
  }

  // Split on '|' that are not inside [[...]] or {{...}}
  function splitPipes(s) {
    const out = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const two = s.substr(i, 2);
      if (two === '[[' || two === '{{') { depth++; cur += two; i++; continue; }
      if ((two === ']]' || two === '}}') && depth > 0) { depth--; cur += two; i++; continue; }
      if (s[i] === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += s[i];
    }
    out.push(cur);
    return out;
  }

  // Strip dangerous attributes from whitelisted HTML tags
  function cleanAttrs(attrs) {
    if (!attrs) return '';
    return attrs
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript:/gi, '');
  }

  function parse(src, opts) {
    opts = opts || {};
    const store = [];           // placeholder storage
    const put = (html, block) => {
      store.push(html);
      return (block ? '\u0001B' : '\u0001I') + (store.length - 1) + '\u0001';
    };
    const refs = [];            // {name, html}
    const refNames = {};
    const headings = [];
    const categories = [];
    let extCount = 0;
    let refListPlaced = false;

    let text = (src || '').replace(/\r\n?/g, '\n');

    // 1. Comments, nowiki, pre
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    text = text.replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, (_, c) => put(esc(c)));
    text = text.replace(/<nowiki\s*\/>/gi, '');
    text = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, c) => put('<pre>' + esc(c) + '</pre>', true));
    text = text.replace(/<syntaxhighlight[^>]*>([\s\S]*?)<\/syntaxhighlight>/gi,
      (_, c) => put('<pre class="code">' + esc(c) + '</pre>', true));
    text = text.replace(/<math>([\s\S]*?)<\/math>/gi, (_, c) => put('<span class="math">' + esc(c) + '</span>'));

    // 2. References (content parsed later)
    const pendingRefs = [];
    function addRef(name, content) {
      if (name && refNames[name] !== undefined) {
        const r = refs[refNames[name]];
        if (content && !r.raw) r.raw = content;
        r.uses++;
        return refNames[name];
      }
      refs.push({ name, raw: content || '', uses: 1 });
      if (name) refNames[name] = refs.length - 1;
      return refs.length - 1;
    }
    const nameOf = (attrs) => {
      const m = /name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/i.exec(attrs || '');
      return m ? (m[1] || m[2] || m[3]) : null;
    };
    text = text.replace(/<ref(\s[^>]*?)?\/>/gi, (_, a) => {
      const idx = addRef(nameOf(a), '');
      pendingRefs.push(idx);
      return '\u0002R' + idx + '\u0002';
    });
    text = text.replace(/<ref(\s[^>]*?)?>([\s\S]*?)<\/ref>/gi, (_, a, c) => {
      const idx = addRef(nameOf(a), c.trim());
      return '\u0002R' + idx + '\u0002';
    });
    text = text.replace(/<references\s*\/>|<references>[\s\S]*?<\/references>|\{\{\s*(reflist|references)[^{}]*\}\}/gi,
      () => '\u0002L\u0002');

    // 3. Escape HTML, then restore whitelisted tags
    text = esc(text);
    const tagRe = new RegExp('&lt;(/?)(' + ALLOWED_TAGS.join('|') + ')(\\s[^&]*?)?(/?)&gt;', 'gi');
    text = text.replace(tagRe, (_, close, tag, attrs, self) => {
      tag = tag.toLowerCase();
      if (tag === 'center') return close ? '</div>' : '<div style="text-align:center">';
      if (tag === 'poem') return close ? '</div>' : '<div class="poem">';
      if (tag === 'syntaxhighlight') return close ? '</pre>' : '<pre class="code">';
      return '<' + close + tag + cleanAttrs(attrs) + self + '>';
    });

    // 4. Magic words
    const noToc = /__NOTOC__/.test(text);
    const forceToc = /__TOC__/.test(text);
    text = text.replace(/__TOC__/, '\u0002T\u0002');
    text = text.replace(/__[A-Z]+__/g, '');

    // 5. Templates (innermost first)
    let guard = 0;
    const tplRe = /\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/;
    while (tplRe.test(text) && guard++ < 500) {
      text = text.replace(tplRe, (_, body) => renderTemplate(body));
    }

    function renderTemplate(body) {
      const parts = splitPipes(body);
      const name = parts.shift().trim();
      const lname = name.toLowerCase();
      if (/^infobox/.test(lname)) {
        let rows = '';
        let title = name.replace(/^infobox\s*/i, '');
        let image = '';
        parts.forEach((p) => {
          const eq = p.indexOf('=');
          if (eq < 0) return;
          const k = p.slice(0, eq).trim();
          const v = p.slice(eq + 1).trim();
          if (!v) return;
          if (/^(name|title)$/i.test(k)) { title = v; return; }
          if (/^image$/i.test(k)) { image = v; return; }
          rows += '<tr><th>' + inline(k.replace(/_/g, ' ')) + '</th><td>' + inline(v) + '</td></tr>';
        });
        let imgHtml = '';
        if (image) {
          const file = image.replace(/^\[\[|\]\]$/g, '').replace(/^(file|image):/i, '').split('|')[0];
          imgHtml = '<tr><td colspan="2" class="ib-image"><div class="img-ph small"><span class="img-icon">🖼</span><span class="img-name">' +
            file + '</span></div></td></tr>';
        }
        return put('<table class="infobox"><caption>' + inline(title) + '</caption>' + imgHtml + rows + '</table>', true);
      }
      if (lname === 'main' || lname === 'see also' || lname === 'further') {
        const label = lname === 'main' ? 'Main article' : lname === 'see also' ? 'See also' : 'Further information';
        const links = parts.map((p) => wikiLink(p.trim(), p.trim())).join(', ');
        return put('<div class="hatnote">' + label + ': ' + links + '</div>', true);
      }
      if (lname === 'quote' || lname === 'blockquote') {
        return put('<blockquote>' + inline(parts[0] || '') + '</blockquote>', true);
      }
      if (lname === 'citation needed' || lname === 'cn' || lname === 'fact') {
        return put('<sup class="noprint">[<i>citation needed</i>]</sup>');
      }
      if (/^cite /.test(lname)) {
        const p = {};
        parts.forEach((x) => { const i = x.indexOf('='); if (i > 0) p[x.slice(0, i).trim()] = x.slice(i + 1).trim(); });
        const author = p.last ? (p.last + (p.first ? ', ' + p.first : '')) : (p.author || '');
        const t = p.title ? (p.url ? '<a class="ext" href="' + escAttr(p.url) + '" target="_blank" rel="noopener">"' + p.title + '"</a>' : '"' + p.title + '"') : '';
        const bits = [author, t, p.work || p.website || p.journal || p.publisher ? '<i>' + (p.work || p.website || p.journal || p.publisher) + '</i>' : '', p.date || p.year || '', p['access-date'] ? 'Retrieved ' + p['access-date'] : ''];
        return put('<cite>' + bits.filter(Boolean).join('. ') + '.</cite>');
      }
      const params = parts.length ? '<span class="tpl-params">|' + parts.map((x) => x.trim()).join('|') + '</span>' : '';
      return put('<span class="template" title="Template: ' + escAttr(name) + '">{{' + name + params + '}}</span>');
    }

    // ---------- Inline ----------
    function wikiLink(target, label) {
      const href = '#' + slug(target);
      return '<a class="wikilink" href="' + escAttr(href) + '" title="' + escAttr(target) + '">' + label + '</a>';
    }

    function imagePlaceholder(inner) {
      const parts = splitPipes(inner);
      const file = parts.shift().replace(/^\s*(file|image)\s*:\s*/i, '').trim();
      let align = '', size = '', caption = '', thumb = false, alt = '';
      parts.forEach((p) => {
        const t = p.trim();
        if (/^(thumb|thumbnail|frame|framed|frameless)$/i.test(t)) thumb = !/frameless/i.test(t) || thumb;
        else if (/^(left|right|center|none)$/i.test(t)) align = t.toLowerCase();
        else if (/^\d*x?\d+px$/i.test(t)) size = t;
        else if (/^upright/i.test(t) || /^border$/i.test(t)) { /* ignore */ }
        else if (/^alt=/i.test(t)) alt = t.slice(4);
        else if (/^(link|page|class|lang)=/i.test(t)) { /* ignore */ }
        else caption = t;
      });
      const w = size ? parseInt(size.split('x')[0] || size, 10) : (thumb ? 220 : 180);
      const cls = ['img-ph', thumb ? 'thumb' : 'plain', 'align-' + (align || (thumb ? 'right' : 'none'))].join(' ');
      return put('<figure class="' + cls + '" style="width:' + (w || 220) + 'px">' +
        '<div class="img-box"><span class="img-icon">🖼</span><span class="img-name">' + file + '</span>' +
        (size ? '<span class="img-size">' + size + '</span>' : '') + '</div>' +
        (thumb && caption ? '<figcaption>' + caption + '</figcaption>' : '') +
        '</figure>', thumb || align === 'center');
    }

    function inline(s) {
      // internal links without nested brackets (category / file handled below)
      let g = 0;
      let prev;
      do {
        prev = s;
        s = s.replace(/\[\[([^\[\]|]+?)(?:\|([^\[\]]*?))?\]\]([a-z]*)/g, (m, target, label, trail) => {
          const t = target.trim();
          if (/^\s*(file|image)\s*:/i.test(t)) return m.replace(/^\[\[/, '\u0003').replace(/\]\]([a-z]*)$/, '\u0004$1');
          if (/^category\s*:/i.test(t)) { categories.push(t.replace(/^category\s*:\s*/i, '')); return ''; }
          if (/^:/.test(t)) return wikiLink(t.slice(1), (label || t.slice(1)) + trail);
          const disp = label === '' ? t.replace(/\s*\(.*\)$/, '').replace(/^[^:]*:/, '') : (label || t);
          return wikiLink(t, disp + trail);
        });
        // file links whose caption may now contain rendered links
        s = s.replace(/\u0003([^\u0003\u0004]*)\u0004/g, (_, inner) => imagePlaceholder(inner));
        s = s.replace(/\[\[\s*((?:file|image)\s*:[^\[\]]*?(?:\[\[[^\]]*\]\][^\[\]]*?)*)\]\]/gi, (_, inner) => imagePlaceholder(inner));
      } while (s !== prev && g++ < 10);

      // external links
      s = s.replace(/\[((?:https?|ftp):\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g, (_, url, label) => {
        if (label) return '<a class="ext" href="' + escAttr(url) + '" target="_blank" rel="noopener">' + label + '</a>';
        extCount++;
        return '<a class="ext" href="' + escAttr(url) + '" target="_blank" rel="noopener">[' + extCount + ']</a>';
      });
      s = s.replace(/(^|[\s(])((?:https?):\/\/[^\s<\[\]"']+)/g, (_, pre, url) =>
        pre + '<a class="ext" href="' + escAttr(url) + '" target="_blank" rel="noopener">' + url + '</a>');

      // bold / italic
      s = s.replace(/'''''(.+?)'''''/g, '<b><i>$1</i></b>');
      s = s.replace(/'''(.+?)'''/g, '<b>$1</b>');
      s = s.replace(/''(.+?)''/g, '<i>$1</i>');
      return s;
    }

    // ---------- Blocks ----------
    const lines = text.split('\n');
    const out = [];
    let para = [];
    let listStack = '';
    let preBuf = [];

    const flushPara = () => {
      if (!para.length) return;
      const joined = para.join(' ').trim();
      if (joined) {
        // Paragraph made of a single block placeholder -> emit raw
        if (/^(\u0001B\d+\u0001\s*)+$/.test(joined)) out.push(joined);
        else out.push('<p>' + inline(joined) + '</p>');
      }
      para = [];
    };
    const flushPre = () => {
      if (!preBuf.length) return;
      out.push('<pre>' + preBuf.map(inline).join('\n') + '</pre>');
      preBuf = [];
    };
    const listTag = (c) => (c === '*' ? 'ul' : c === '#' ? 'ol' : 'dl');
    const itemTag = (c) => (c === '*' || c === '#' ? 'li' : c === ';' ? 'dt' : 'dd');
    const closeLists = (to) => {
      while (listStack.length > to) {
        const c = listStack[listStack.length - 1];
        out.push('</' + itemTag(c) + '></' + listTag(c) + '>');
        listStack = listStack.slice(0, -1);
      }
    };
    const sameList = (a, b) => a === b || ((a === ';' || a === ':') && (b === ';' || b === ':'));

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Table block
      if (/^\s*\{\|/.test(line)) {
        flushPara(); flushPre(); closeLists(0);
        const tbl = [];
        let depth = 0;
        for (; i < lines.length; i++) {
          const l = lines[i];
          if (/^\s*\{\|/.test(l)) depth++;
          tbl.push(l);
          if (/^\s*\|\}/.test(l)) { depth--; if (depth === 0) break; }
        }
        out.push(renderTable(tbl));
        continue;
      }

      // Heading
      const h = /^(={1,6})\s*(.+?)\s*\1\s*$/.exec(line);
      if (h) {
        flushPara(); flushPre(); closeLists(0);
        const level = h[1].length;
        const html = inline(h[2]);
        let id = slug(html) || 'section';
        let n = 2; const base = id;
        while (headings.some((x) => x.id === id)) id = base + '_' + n++;
        headings.push({ level, html, id });
        out.push('\u0002H' + (headings.length - 1) + '\u0002<h' + level + ' id="' + escAttr(id) + '">' + html + '</h' + level + '>');
        continue;
      }

      // Horizontal rule
      if (/^-{4,}\s*$/.test(line)) { flushPara(); flushPre(); closeLists(0); out.push('<hr>'); continue; }

      // Lists
      const lm = /^([*#:;]+)\s*(.*)$/.exec(line);
      if (lm) {
        flushPara(); flushPre();
        let prefix = lm[1];
        let content = lm[2];
        // ";term : definition" on one line
        let defAfter = null;
        if (prefix[prefix.length - 1] === ';') {
          const ci = content.indexOf(' : ');
          const ci2 = ci < 0 ? content.indexOf(':') : ci;
          if (ci2 > 0 && !/https?:$/.test(content.slice(0, ci2 + 1))) {
            defAfter = content.slice(ci2 + (ci >= 0 ? 3 : 1)).trim();
            content = content.slice(0, ci2).trim();
          }
        }
        let common = 0;
        while (common < prefix.length && common < listStack.length &&
               sameList(prefix[common], listStack[common])) common++;
        closeLists(common);
        if (common === prefix.length) {
          // sibling item at the current depth
          const c = listStack[common - 1];
          const n = prefix[common - 1];
          out.push('</' + itemTag(c) + '><' + itemTag(n) + '>');
          listStack = listStack.slice(0, -1) + n;
        } else {
          for (let k = common; k < prefix.length; k++) {
            const c = prefix[k];
            out.push('<' + listTag(c) + '><' + itemTag(c) + '>');
            listStack += c;
          }
        }
        out.push(inline(content));
        if (defAfter !== null) {
          out.push('</dt><dd>' + inline(defAfter));
          listStack = listStack.slice(0, -1) + ':';
        }
        continue;
      }
      closeLists(0);

      // Preformatted (leading space)
      if (/^ \S/.test(line) || (/^ +$/.test(line) && preBuf.length)) {
        flushPara();
        preBuf.push(line.slice(1));
        continue;
      }
      flushPre();

      if (/^\s*$/.test(line)) { flushPara(); continue; }

      // Standalone block placeholder line
      if (/^\s*(\u0001B\d+\u0001\s*)+$/.test(line) || /^\s*<\/?(div|blockquote|table|hr)/i.test(line)) {
        flushPara();
        out.push(inline(line));
        continue;
      }
      para.push(line);
    }
    flushPara(); flushPre(); closeLists(0);

    function renderTable(rows) {
      let html = '';
      let open = { row: false, cell: null };
      const closeCell = () => { if (open.cell) { html += '</' + open.cell + '>'; open.cell = null; } };
      const closeRow = () => { closeCell(); if (open.row) { html += '</tr>'; open.row = false; } };
      const ensureRow = () => { if (!open.row) { html += '<tr>'; open.row = true; } };
      const cell = (tag, raw) => {
        // "attrs | content" (but not "[[a|b]]")
        const parts = splitPipes(raw);
        let attrs = '', content = raw;
        if (parts.length > 1 && /=/.test(parts[0]) && !/\[\[/.test(parts[0])) {
          attrs = ' ' + cleanAttrs(parts[0].trim().replace(/&quot;/g, '"'));
          content = parts.slice(1).join('|');
        }
        closeCell(); ensureRow();
        html += '<' + tag + attrs + '>' + inline(content.trim());
        open.cell = tag;
      };
      for (let r = 0; r < rows.length; r++) {
        const line = rows[r].trim();
        if (/^\{\|/.test(line)) {
          if (r === 0) {
            const attrs = cleanAttrs(line.slice(2).trim());
            const isWiki = /wikitable/.test(attrs);
            html += '<div class="table-wrap"><table ' + (isWiki ? '' : 'class="plain" ') + attrs + '>';
          } else {
            // nested table: collect and render recursively
            const nested = [];
            let d = 0;
            for (; r < rows.length; r++) {
              const l = rows[r];
              if (/^\s*\{\|/.test(l)) d++;
              nested.push(l);
              if (/^\s*\|\}/.test(l)) { d--; if (d === 0) break; }
            }
            html += renderTable(nested);
          }
          continue;
        }
        if (/^\|\}/.test(line)) { closeRow(); html += '</table></div>'; continue; }
        if (/^\|\+/.test(line)) { html += '<caption>' + inline(line.slice(2).trim()) + '</caption>'; continue; }
        if (/^\|-/.test(line)) {
          closeRow();
          const attrs = cleanAttrs(line.slice(2).trim());
          html += '<tr' + (attrs ? ' ' + attrs : '') + '>'; open.row = true;
          continue;
        }
        if (/^!/.test(line)) { line.slice(1).split(/!!|\|\|/).forEach((c) => cell('th', c)); continue; }
        if (/^\|/.test(line)) { line.slice(1).split('||').forEach((c) => cell('td', c)); continue; }
        // continuation of previous cell
        if (open.cell) html += line === '' ? '<br>' : ' ' + inline(line);
      }
      if (!/<\/table><\/div>$/.test(html)) { closeRow(); html += '</table></div>'; }
      return html;
    }

    let html = out.join('\n');

    // TOC
    let tocHtml = '';
    if (!noToc && (forceToc || headings.length >= 4)) {
      tocHtml = '<div class="toc"><div class="toc-title">Contents</div><ul>';
      const counters = [0, 0, 0, 0, 0, 0, 0];
      const minLevel = Math.min.apply(null, headings.map((x) => x.level));
      headings.forEach((hd) => {
        const lvl = hd.level - minLevel + 1;
        counters[lvl]++;
        for (let k = lvl + 1; k < counters.length; k++) counters[k] = 0;
        const num = counters.slice(1, lvl + 1).join('.');
        tocHtml += '<li class="toc-l' + lvl + '"><a href="#' + escAttr(hd.id) + '"><span class="toc-num">' + num +
          '</span> ' + hd.html.replace(/<a [^>]*>|<\/a>/g, '') + '</a></li>';
      });
      tocHtml += '</ul></div>';
    }
    if (tocHtml && /\u0002T\u0002/.test(html)) html = html.replace('\u0002T\u0002', tocHtml);
    else if (tocHtml) html = html.replace('\u0002H0\u0002', tocHtml);
    html = html.replace(/\u0002[HT]\d*\u0002/g, '');

    // Hoist block placeholders (thumbs, infoboxes) out of paragraphs
    html = html.replace(/<p>((?:\u0001B\d+\u0001\s*)+)/g, '$1<p>').replace(/<p>\s*<\/p>/g, '');

    // Restore placeholders (may be nested)
    for (let k = 0; k < 5 && /\u0001[BI]\d+\u0001/.test(html); k++) {
      html = html.replace(/\u0001[BI](\d+)\u0001/g, (_, n) => store[+n]);
    }

    // References
    const refHtml = refs.map((r) => inline(esc(r.raw)));
    html = html.replace(/\u0002R(\d+)\u0002/g, (_, n) =>
      '<sup class="reference"><a href="#cite-note-' + (+n + 1) + '" id="cite-ref-' + (+n + 1) + '">[' + (+n + 1) + ']</a></sup>');
    const refList = refs.length
      ? '<ol class="references">' + refs.map((r, n) =>
          '<li id="cite-note-' + (n + 1) + '"><a href="#cite-ref-' + (n + 1) + '">^</a> ' + (refHtml[n] || '<i>(empty reference)</i>') + '</li>'
        ).join('') + '</ol>'
      : '';
    if (/\u0002L\u0002/.test(html)) {
      html = html.replace(/<p>\s*\u0002L\u0002\s*<\/p>/, '\u0002L\u0002');
      html = html.replace('\u0002L\u0002', refList || '');
      html = html.replace(/\u0002L\u0002/g, '');
      refListPlaced = true;
    } else if (refList) {
      html += '<h2 id="References">References</h2>' + refList;
    }
    for (let k = 0; k < 5 && /\u0001[BI]\d+\u0001/.test(html); k++) {
      html = html.replace(/\u0001[BI](\d+)\u0001/g, (_, n) => store[+n]);
    }

    if (categories.length) {
      html += '<div class="catlinks"><b>Categories:</b> ' +
        categories.map((c) => '<a class="wikilink" href="#">' + c + '</a>').join(' | ') + '</div>';
    }

    return { html, headings, refs: refs.length, categories, refListPlaced };
  }

  global.WikiParser = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
