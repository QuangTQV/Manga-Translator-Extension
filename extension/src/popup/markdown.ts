// Minimal Markdown -> DOM for the Help chat's assistant replies. Builds
// elements and assigns textContent only (never innerHTML), so a model reply
// can't inject markup into the extension page. Covers what chat replies
// actually use: paragraphs, headings, nested bullet/numbered lists, fenced
// code, **bold**, *italic*, `code`, and http(s) links.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function appendText(parent: Node, text: string): void {
  text.split('\n').forEach((part, i) => {
    if (i > 0) parent.appendChild(document.createElement('br'));
    if (part) parent.appendChild(document.createTextNode(part));
  });
}

function appendInline(parent: Node, text: string): void {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      appendText(parent, rest);
      return;
    }
    appendText(parent, rest.slice(0, m.index));
    const token = m[0];
    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (m[2]) {
      const strong = document.createElement('strong');
      appendInline(strong, token.slice(2, -2));
      parent.appendChild(strong);
    } else if (m[3]) {
      const em = document.createElement('em');
      appendInline(em, token.slice(1, -1));
      parent.appendChild(em);
    } else {
      const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      appendInline(a, label);
      parent.appendChild(a);
    }
    rest = rest.slice(m.index + token.length);
  }
}

interface OpenList {
  el: HTMLUListElement | HTMLOListElement;
  indent: number;
  ordered: boolean;
}

export function renderMarkdown(source: string): DocumentFragment {
  const root = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let lists: OpenList[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, paragraph.join('\n'));
    root.appendChild(p);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushParagraph();
      lists = [];
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code.join('\n');
      pre.appendChild(codeEl);
      root.appendChild(pre);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      lists = [];
      continue;
    }

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      lists = [];
      const h = document.createElement('h4');
      appendInline(h, heading[1]);
      root.appendChild(h);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph();
      lists = [];
      root.appendChild(document.createElement('hr'));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1].replace(/\t/g, '  ').length;
      const ordered = /\d/.test(item[2]);
      while (lists.length && indent < lists[lists.length - 1].indent) lists.pop();
      let top = lists[lists.length - 1];
      if (top && indent === top.indent && top.ordered !== ordered) {
        lists.pop();
        top = lists[lists.length - 1];
      }
      if (!top || indent > top.indent) {
        const el = document.createElement(ordered ? 'ol' : 'ul');
        const parentItem = top?.el.lastElementChild;
        (parentItem ?? root).appendChild(el);
        lists.push({ el, indent, ordered });
        top = lists[lists.length - 1];
      }
      const li = document.createElement('li');
      appendInline(li, item[3]);
      top.el.appendChild(li);
      continue;
    }

    // A plain line right after a list item continues that item's text
    // rather than starting a new paragraph (a common wrapped-bullet shape).
    const openItem = lists[lists.length - 1]?.el.lastElementChild;
    if (openItem && /^\s+/.test(line)) {
      appendText(openItem, '\n');
      appendInline(openItem, line.trim());
      continue;
    }

    lists = [];
    paragraph.push(line.trim());
  }
  flushParagraph();
  return root;
}
