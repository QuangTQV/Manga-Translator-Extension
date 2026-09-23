// Eraser tool: paint freehand over raw text/SFX that a rectangular manual
// region can't isolate cleanly (curved SFX, text hugging a character's
// outline, ...) and have it inpainted away. Strokes are recorded in screen
// space while painting, then rasterised into a black/white mask at the
// target image's natural resolution on Apply and handed to
// region-tool.ts:applyEraseStroke, which folds it into the page's persisted
// cumulative eraser mask (reusing all of that module's storage/reapply
// plumbing — an eraser stroke is just another kind of manual edit).

import { applyEraseStroke, findTargetImageForRect } from './region-tool.js';

export interface EraserToolDeps {
  resolveUrl(img: HTMLImageElement): string | null;
  tr(key: string): string;
  toast(message: string, isError?: boolean): void;
}

interface Point { x: number; y: number; }

const Z = '2147483647';
const BRUSH_SIZES = { small: 10, medium: 20, large: 36 } as const;
type BrushSize = keyof typeof BRUSH_SIZES;

let deps: EraserToolDeps;
let active = false;

export function initEraserTool(d: EraserToolDeps): void {
  deps = d;
}

export function startEraserSelect(): void {
  if (active) return;
  active = true;

  const strokes: Point[][] = [];
  let currentStroke: Point[] | null = null;
  let brush: BrushSize = 'medium';

  const layer = document.createElement('div');
  layer.id = 'mt-eraser-layer';
  layer.style.cssText = `position:fixed;inset:0;z-index:${Z};cursor:none;`;

  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:auto;';
  const ctx = canvas.getContext('2d')!;

  const cursor = document.createElement('div');
  cursor.style.cssText = 'position:fixed;border:2px solid #f87171;background:rgba(248,113,113,0.25);border-radius:50%;pointer-events:none;transform:translate(-50%,-50%);display:none;';

  const hint = document.createElement('div');
  hint.textContent = deps.tr('eraserHint');
  hint.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:#0b1120;color:#dde6f5;font:13px system-ui,sans-serif;border:1px solid #f87171;pointer-events:none;';

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:6px;align-items:center;padding:8px;border-radius:10px;background:#0b1120;border:1px solid rgba(248,113,113,0.5);box-shadow:0 8px 24px rgba(0,0,0,.4);font:12px system-ui,sans-serif;';

  const makeBtn = (label: string, primary = false): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = `border:1px solid ${primary ? '#f87171' : 'rgba(255,255,255,.3)'};background:${primary ? '#f87171' : 'transparent'};color:${primary ? '#080c18' : '#dde6f5'};font-weight:${primary ? '700' : '400'};border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;`;
    return btn;
  };

  const sizeBtns: Record<BrushSize, HTMLButtonElement> = {
    small: makeBtn(deps.tr('eraserBrushSmall')),
    medium: makeBtn(deps.tr('eraserBrushMedium')),
    large: makeBtn(deps.tr('eraserBrushLarge')),
  };
  const undoBtn = makeBtn(deps.tr('eraserUndo'));
  const clearBtn = makeBtn(deps.tr('eraserClear'));
  const cancelBtn = makeBtn(deps.tr('eraserCancel'));
  const applyBtn = makeBtn(deps.tr('eraserApply'), true);
  const status = document.createElement('span');
  status.style.cssText = 'margin-left:4px;color:#f87171;max-width:180px;';

  const setBrush = (b: BrushSize): void => {
    brush = b;
    for (const [key, btn] of Object.entries(sizeBtns) as [BrushSize, HTMLButtonElement][]) {
      btn.style.outline = key === b ? '2px solid #f87171' : 'none';
    }
    cursor.style.width = cursor.style.height = `${BRUSH_SIZES[b] * 2}px`;
  };
  for (const [key, btn] of Object.entries(sizeBtns) as [BrushSize, HTMLButtonElement][]) {
    btn.addEventListener('click', () => setBrush(key));
  }
  setBrush('medium');

  toolbar.append(sizeBtns.small, sizeBtns.medium, sizeBtns.large, undoBtn, clearBtn, cancelBtn, applyBtn, status);
  layer.append(canvas, cursor, hint, toolbar);
  document.body.appendChild(layer);

  const redraw = (): void => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(248,113,113,0.6)';
    ctx.fillStyle = 'rgba(248,113,113,0.6)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = BRUSH_SIZES[brush] * 2;
    for (const stroke of strokes) {
      if (!stroke.length) continue;
      ctx.beginPath();
      ctx.arc(stroke[0].x, stroke[0].y, BRUSH_SIZES[brush], 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  };

  const finish = (): void => {
    active = false;
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
  };
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') finish(); };
  document.addEventListener('keydown', onKey, true);
  cancelBtn.addEventListener('click', finish);

  // Listeners live on the canvas, not the whole layer — the toolbar sits in
  // the same layer, and a click on one of its buttons would otherwise bubble
  // up into a layer-level pointerdown handler and get recorded as a (phantom,
  // single-point) paint stroke.
  canvas.addEventListener('pointermove', (ev) => {
    cursor.style.display = 'block';
    cursor.style.left = `${ev.clientX}px`;
    cursor.style.top = `${ev.clientY}px`;
    if (!currentStroke) return;
    currentStroke.push({ x: ev.clientX, y: ev.clientY });
    redraw();
  });
  canvas.addEventListener('pointerleave', () => { cursor.style.display = 'none'; });
  canvas.addEventListener('pointerdown', (ev) => {
    currentStroke = [{ x: ev.clientX, y: ev.clientY }];
    strokes.push(currentStroke);
    canvas.setPointerCapture(ev.pointerId);
    redraw();
  });
  canvas.addEventListener('pointerup', () => { currentStroke = null; });

  undoBtn.addEventListener('click', () => { strokes.pop(); redraw(); });
  clearBtn.addEventListener('click', () => { strokes.length = 0; redraw(); });

  applyBtn.addEventListener('click', async () => {
    if (!strokes.some((s) => s.length)) {
      deps.toast(deps.tr('eraserNoStrokes'), true);
      return;
    }
    const allPoints = strokes.flat();
    const rect = {
      left: Math.min(...allPoints.map((p) => p.x)) - BRUSH_SIZES[brush],
      top: Math.min(...allPoints.map((p) => p.y)) - BRUSH_SIZES[brush],
      right: Math.max(...allPoints.map((p) => p.x)) + BRUSH_SIZES[brush],
      bottom: Math.max(...allPoints.map((p) => p.y)) + BRUSH_SIZES[brush],
    };
    const img = findTargetImageForRect(rect);
    const rawUrl = img ? deps.resolveUrl(img) : null;
    if (!img || !rawUrl) { deps.toast(deps.tr('regionNoImage'), true); return; }

    const imgRect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / imgRect.width;
    const scaleY = img.naturalHeight / imgRect.height;
    const toImageSpace = (p: Point): Point => ({ x: (p.x - imgRect.left) * scaleX, y: (p.y - imgRect.top) * scaleY });
    const radiusPx = BRUSH_SIZES[brush] * ((scaleX + scaleY) / 2);

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = img.naturalWidth;
    maskCanvas.height = img.naturalHeight;
    const maskCtx = maskCanvas.getContext('2d')!;
    maskCtx.fillStyle = '#000';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.strokeStyle = '#fff';
    maskCtx.fillStyle = '#fff';
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.lineWidth = radiusPx * 2;
    for (const stroke of strokes) {
      if (!stroke.length) continue;
      const mapped = stroke.map(toImageSpace);
      maskCtx.beginPath();
      maskCtx.arc(mapped[0].x, mapped[0].y, radiusPx, 0, Math.PI * 2);
      maskCtx.fill();
      maskCtx.beginPath();
      maskCtx.moveTo(mapped[0].x, mapped[0].y);
      for (const p of mapped.slice(1)) maskCtx.lineTo(p.x, p.y);
      maskCtx.stroke();
    }
    const maskBase64 = maskCanvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

    for (const b of [...Object.values(sizeBtns), undoBtn, clearBtn, cancelBtn, applyBtn]) b.disabled = true;
    status.style.color = '#93c5fd';
    status.textContent = deps.tr('eraserApplying');
    try {
      await applyEraseStroke(img, rawUrl, maskBase64);
      finish();
    } catch (e) {
      status.style.color = '#f87171';
      status.textContent = e instanceof Error ? e.message : String(e);
      for (const b of [...Object.values(sizeBtns), undoBtn, clearBtn, cancelBtn, applyBtn]) b.disabled = false;
    }
  });
}
