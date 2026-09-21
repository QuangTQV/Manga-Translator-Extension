// Interactive relationship map for the Story DB tab. It is a *view* over the
// character/relationship form rows (the rows stay the single source of truth
// and what gets saved) — so it needs no state of its own beyond node
// positions and the current selection, and can never drift from the form.

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 360;
const H = 260;
const NODE_R = 17;

const GENDER_COLORS: Record<string, string> = {
  male: '#60a5fa',
  female: '#f472b6',
  other: '#a78bfa',
  unknown: '#94a3b8',
};

interface GraphNode { id: string; name: string; gender: string; role: string; avatar: string; row: HTMLDivElement; }
interface GraphEdge { row: HTMLDivElement; a: string; b: string; label: string; notes: string; }

export interface RelationshipGraphOptions {
  svg: SVGSVGElement;
  info: HTMLElement;
  connectBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  charactersList: HTMLElement;
  relationshipsList: HTMLElement;
  t: (key: string) => string;
  // Adds a relationship row between two characters and returns it.
  addRelationship: (aId: string, bId: string) => HTMLDivElement;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function initRelationshipGraph(opts: RelationshipGraphOptions): { refresh: () => void } {
  const { svg, info, connectBtn, resetBtn, charactersList, relationshipsList, t } = opts;
  const positions = new Map<string, { x: number; y: number }>();
  let selectedId: string | null = null;
  let connectMode = false;
  let connectFrom: string | null = null;
  let dragId: string | null = null;
  let dragMoved = false;
  let scheduled = false;

  function readNodes(): GraphNode[] {
    const nodes: GraphNode[] = [];
    for (const row of Array.from(charactersList.querySelectorAll<HTMLDivElement>('.story-char-row'))) {
      const name = row.querySelector<HTMLInputElement>('.sc-name')?.value.trim() ?? '';
      if (!name) continue;
      nodes.push({
        id: row.dataset.charId ?? '',
        name,
        gender: row.querySelector<HTMLSelectElement>('.sc-gender')?.value || 'unknown',
        role: row.querySelector<HTMLInputElement>('.sc-role')?.value.trim() ?? '',
        avatar: row.dataset.avatar ?? '',
        row,
      });
    }
    return nodes;
  }

  function readEdges(ids: Set<string>): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const row of Array.from(relationshipsList.querySelectorAll<HTMLDivElement>('.story-rel-row'))) {
      const a = row.querySelector<HTMLSelectElement>('.sr-char-a')?.value ?? '';
      const b = row.querySelector<HTMLSelectElement>('.sr-char-b')?.value ?? '';
      if (!a || !b || a === b || !ids.has(a) || !ids.has(b)) continue;
      edges.push({
        row, a, b,
        label: row.querySelector<HTMLInputElement>('.sr-relation')?.value.trim() ?? '',
        notes: row.querySelector<HTMLInputElement>('.sr-notes')?.value.trim() ?? '',
      });
    }
    return edges;
  }

  function defaultPosition(index: number, total: number): { x: number; y: number } {
    if (total === 1) return { x: W / 2, y: H / 2 };
    const rx = W / 2 - NODE_R - 26;
    const ry = H / 2 - NODE_R - 22;
    const angle = (2 * Math.PI * index) / total - Math.PI / 2;
    return { x: W / 2 + rx * Math.cos(angle), y: H / 2 + ry * Math.sin(angle) };
  }

  function render(): void {
    scheduled = false;
    const nodes = readNodes();
    const ids = new Set(nodes.map((n) => n.id));
    const edges = readEdges(ids);
    if (selectedId && !ids.has(selectedId)) selectedId = null;
    if (connectFrom && !ids.has(connectFrom)) connectFrom = null;
    for (const id of Array.from(positions.keys())) if (!ids.has(id)) positions.delete(id);
    // A saved position (row dataset, round-tripped through the backend) wins
    // over the default circle layout.
    nodes.forEach((n, i) => {
      if (positions.has(n.id)) return;
      const sx = n.row.dataset.x;
      const sy = n.row.dataset.y;
      positions.set(n.id, sx !== undefined && sy !== undefined ? { x: Number(sx), y: Number(sy) } : defaultPosition(i, nodes.length));
    });

    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    if (nodes.length === 0) {
      const msg = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#6b7a99', 'font-size': 12 });
      msg.textContent = t('graphEmpty');
      svg.appendChild(msg);
      info.textContent = '';
      return;
    }

    const neighbours = new Set<string>();
    if (selectedId) {
      neighbours.add(selectedId);
      for (const e of edges) {
        if (e.a === selectedId) neighbours.add(e.b);
        if (e.b === selectedId) neighbours.add(e.a);
      }
    }
    const edgeActive = (e: GraphEdge): boolean => !selectedId || e.a === selectedId || e.b === selectedId;

    // Parallel edges between the same pair fan out as curves so they don't overlap.
    const pairCount = new Map<string, number>();
    const pairSeen = new Map<string, number>();
    const pairKey = (e: GraphEdge): string => [e.a, e.b].sort().join('|');
    for (const e of edges) pairCount.set(pairKey(e), (pairCount.get(pairKey(e)) ?? 0) + 1);

    const edgeLayer = svgEl('g');
    const labelLayer = svgEl('g');
    const nodeLayer = svgEl('g');
    svg.append(edgeLayer, labelLayer, nodeLayer);

    for (const e of edges) {
      const pa = positions.get(e.a)!;
      const pb = positions.get(e.b)!;
      const key = pairKey(e);
      const total = pairCount.get(key) ?? 1;
      const idx = pairSeen.get(key) ?? 0;
      pairSeen.set(key, idx + 1);
      // Normalise direction so offsets for A->B and B->A fan the same way.
      const flip = e.a > e.b ? -1 : 1;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const offset = (idx - (total - 1) / 2) * 44 * flip;
      const cx = (pa.x + pb.x) / 2 + (-dy / len) * offset;
      const cy = (pa.y + pb.y) / 2 + (dx / len) * offset;
      const active = edgeActive(e);
      const path = svgEl('path', {
        d: `M ${pa.x} ${pa.y} Q ${cx} ${cy} ${pb.x} ${pb.y}`,
        fill: 'none',
        stroke: active ? '#7aa2ff' : '#3a4664',
        'stroke-width': active && selectedId ? 2.4 : 1.6,
        'stroke-dasharray': e.label ? '' : '4 3',
        opacity: active ? 1 : 0.35,
      });
      edgeLayer.appendChild(path);

      if (e.label) {
        const mx = 0.25 * pa.x + 0.5 * cx + 0.25 * pb.x;
        const my = 0.25 * pa.y + 0.5 * cy + 0.25 * pb.y;
        const text = svgEl('text', {
          x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': 10, fill: '#dde6f5', stroke: '#080c18', 'stroke-width': 3.5,
          'paint-order': 'stroke', opacity: active ? 1 : 0.35, style: 'cursor:pointer',
        });
        text.textContent = truncate(e.label, 22);
        const title = svgEl('title');
        title.textContent = e.notes ? `${e.label} — ${e.notes}` : e.label;
        text.appendChild(title);
        text.addEventListener('click', (ev) => {
          ev.stopPropagation();
          e.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          e.row.querySelector<HTMLInputElement>('.sr-relation')?.focus();
        });
        labelLayer.appendChild(text);
      }
    }

    const defs = svgEl('defs');
    svg.prepend(defs);
    nodes.forEach((n, i) => {
      const p = positions.get(n.id)!;
      const dim = !!selectedId && !neighbours.has(n.id);
      const g = svgEl('g', { transform: `translate(${p.x} ${p.y})`, 'data-id': n.id, style: `cursor:${connectMode ? 'crosshair' : 'grab'}`, opacity: dim ? 0.35 : 1 });
      const isSel = n.id === selectedId || n.id === connectFrom;
      g.appendChild(svgEl('circle', {
        r: NODE_R, fill: GENDER_COLORS[n.gender] ?? GENDER_COLORS.unknown,
        stroke: isSel ? '#ffffff' : '#080c18', 'stroke-width': isSel ? 3 : 2,
      }));
      if (n.avatar) {
        const clip = svgEl('clipPath', { id: `mt-avatar-clip-${i}` });
        clip.appendChild(svgEl('circle', { r: NODE_R - 1 }));
        defs.appendChild(clip);
        const image = svgEl('image', { x: -NODE_R, y: -NODE_R, width: NODE_R * 2, height: NODE_R * 2, 'clip-path': `url(#mt-avatar-clip-${i})`, preserveAspectRatio: 'xMidYMid slice', 'pointer-events': 'none' });
        image.setAttribute('href', n.avatar);
        g.appendChild(image);
      }
      const initial = svgEl('text', { y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#080c18', 'pointer-events': 'none' });
      initial.textContent = n.avatar ? '' : (Array.from(n.name)[0]?.toUpperCase() ?? '?');
      const label = svgEl('text', {
        y: NODE_R + 11, 'text-anchor': 'middle', 'font-size': 11, fill: '#dde6f5',
        stroke: '#080c18', 'stroke-width': 3.5, 'paint-order': 'stroke', 'pointer-events': 'none',
      });
      label.textContent = truncate(n.name, 14);
      g.append(initial, label);
      nodeLayer.appendChild(g);
    });

    renderInfo(nodes, edges);
  }

  function renderInfo(nodes: GraphNode[], edges: GraphEdge[]): void {
    if (connectMode) {
      const from = nodes.find((n) => n.id === connectFrom);
      info.textContent = from ? `${t('graphConnectPickSecond')} (${from.name} → ?)` : t('graphConnectPickFirst');
      return;
    }
    const sel = nodes.find((n) => n.id === selectedId);
    if (!sel) { info.textContent = t('graphHint'); return; }
    const byId = new Map(nodes.map((n) => [n.id, n.name]));
    const lines = edges
      .filter((e) => e.a === sel.id || e.b === sel.id)
      .map((e) => `${byId.get(e.a)} ↔ ${byId.get(e.b)}: ${e.label || '—'}`);
    const head = sel.role ? `${sel.name} (${sel.role})` : sel.name;
    info.textContent = lines.length ? `${head}\n${lines.join('\n')}` : head;
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  function toSvgPoint(ev: PointerEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    return { x: ((ev.clientX - rect.left) / rect.width) * W, y: ((ev.clientY - rect.top) / rect.height) * H };
  }

  svg.addEventListener('pointerdown', (ev) => {
    const g = (ev.target as Element).closest('g[data-id]');
    if (!g || connectMode) return;
    dragId = g.getAttribute('data-id');
    dragMoved = false;
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!dragId) return;
    // Capture only once a real drag starts — capturing on pointerdown would
    // retarget the following click to the <svg> and break node selection.
    if (!dragMoved) svg.setPointerCapture(ev.pointerId);
    const pt = toSvgPoint(ev);
    const pad = NODE_R + 4;
    const pos = { x: Math.min(W - pad, Math.max(pad, pt.x)), y: Math.min(H - pad, Math.max(pad, pt.y)) };
    positions.set(dragId, pos);
    const dragRow = charactersList.querySelector<HTMLDivElement>(`.story-char-row[data-char-id="${dragId}"]`);
    if (dragRow) { dragRow.dataset.x = pos.x.toFixed(1); dragRow.dataset.y = pos.y.toFixed(1); }
    dragMoved = true;
    render();
  });

  svg.addEventListener('pointerup', (ev) => {
    if (dragId && svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
    dragId = null;
  });

  svg.addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('g[data-id]');
    const id = g?.getAttribute('data-id') ?? null;
    if (connectMode) {
      if (!id) return;
      if (!connectFrom) { connectFrom = id; render(); return; }
      if (id === connectFrom) { connectFrom = null; render(); return; }
      const row = opts.addRelationship(connectFrom, id);
      connectFrom = null;
      connectMode = false;
      connectBtn.classList.remove('active');
      render();
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.querySelector<HTMLInputElement>('.sr-relation')?.focus();
      return;
    }
    if (dragMoved) { dragMoved = false; return; }
    selectedId = id && id !== selectedId ? id : null;
    render();
  });

  connectBtn.addEventListener('click', () => {
    connectMode = !connectMode;
    connectFrom = null;
    connectBtn.classList.toggle('active', connectMode);
    render();
  });

  resetBtn.addEventListener('click', () => {
    positions.clear();
    for (const row of Array.from(charactersList.querySelectorAll<HTMLDivElement>('.story-char-row'))) {
      delete row.dataset.x;
      delete row.dataset.y;
    }
    render();
  });

  // The rows are the source of truth: re-draw whenever they change.
  for (const list of [charactersList, relationshipsList]) {
    list.addEventListener('input', schedule);
    list.addEventListener('change', schedule);
    new MutationObserver(schedule).observe(list, { childList: true });
  }

  render();
  return { refresh: schedule };
}
