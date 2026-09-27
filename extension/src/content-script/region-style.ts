// The "Text style" part of the manual text area editor: per-region font, size,
// colours, alignment, rotation, ... (see backend schemas.RegionStyle). Kept out
// of region-tool.ts so that file stays about selecting/rendering regions; this
// one only knows how to show a RegionStyle in form controls, read it back, and
// turn it into the request's snake_case shape.
import type { RegionStyle } from '../shared/types.js';

/** Only the fields that differ from "follow the global settings". */
export function normalizeStyle(style: RegionStyle | undefined): RegionStyle | undefined {
  if (!style) return undefined;
  const out: RegionStyle = {};
  if (style.font) out.font = style.font;
  if (style.fontSize && style.fontSize > 0) out.fontSize = style.fontSize;
  if (style.lineSpacing && style.lineSpacing > 0) out.lineSpacing = style.lineSpacing;
  if (style.align) out.align = style.align;
  if (style.textColor) out.textColor = style.textColor;
  if (style.outlineWidth !== undefined && style.outlineWidth >= 0) out.outlineWidth = style.outlineWidth;
  if (style.outlineColor) out.outlineColor = style.outlineColor;
  if (style.backgroundColor) out.backgroundColor = style.backgroundColor;
  if (style.uppercase !== undefined) out.uppercase = style.uppercase;
  if (style.rotation) out.rotation = style.rotation;
  if (style.vertical) out.vertical = true;
  if (style.offsetX) out.offsetX = style.offsetX;
  if (style.offsetY) out.offsetY = style.offsetY;
  if (style.textArea !== undefined && style.textArea < 100) out.textArea = style.textArea;
  return Object.keys(out).length ? out : undefined;
}

/** The /region/render request's `style` for a region (snake_case), or undefined. */
export function styleToApi(style: RegionStyle | undefined): Record<string, unknown> | undefined {
  const s = normalizeStyle(style);
  if (!s) return undefined;
  const api: Record<string, unknown> = {};
  const map: [keyof RegionStyle, string][] = [
    ['font', 'font'], ['fontSize', 'font_size'], ['lineSpacing', 'line_spacing'], ['align', 'align'],
    ['textColor', 'text_color'], ['outlineWidth', 'outline_width'], ['outlineColor', 'outline_color'],
    ['backgroundColor', 'background_color'], ['uppercase', 'uppercase'], ['rotation', 'rotation'],
    ['vertical', 'vertical'], ['offsetX', 'offset_x'], ['offsetY', 'offset_y'], ['textArea', 'text_area'],
  ];
  for (const [from, to] of map) if (s[from] !== undefined) api[to] = s[from];
  return api;
}

export const STYLE_CSS = `
  details.style{border:1px solid rgba(122,162,255,.25);border-radius:8px;padding:6px 8px}
  details.style summary{cursor:pointer;font-size:12px;font-weight:600;color:#9fb0cf;outline:none}
  details.style[open] summary{margin-bottom:8px}
  .style-grid{display:grid;grid-template-columns:96px 1fr;gap:6px 8px;align-items:center}
  .style-grid label{margin:0}
  .style-grid input[type=number],.style-grid select{width:100%;box-sizing:border-box;background:#080c18;color:#dde6f5;border:1px solid rgba(122,162,255,.35);border-radius:6px;padding:4px 6px;font:12px system-ui,sans-serif}
  .style-grid input[type=color]{width:34px;height:26px;padding:0;border:1px solid rgba(122,162,255,.35);border-radius:6px;background:none;cursor:pointer;flex:none}
  .style-grid input[type=range]{width:100%;accent-color:#7aa2ff}
  .style-grid .pair{display:flex;gap:6px;align-items:center;min-width:0}
  .style-grid .pair select{flex:1;min-width:0}
  .style-grid output{font-size:11px;color:#9fb0cf;min-width:38px;text-align:right}
  .style-grid .check{display:flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-size:12px;color:#dde6f5}
  .style-hint{font-size:11px;color:#8092b8;margin:8px 0 6px}
`;

export function styleHtml(tr: (key: string) => string): string {
  const auto = tr('regionStyleAuto');
  const custom = tr('regionStyleCustom');
  const colorPair = (id: string, noneLabel: string, initial: string): string =>
    `<div class="pair"><select id="${id}-mode"><option value="">${noneLabel}</option><option value="custom">${custom}</option></select><input id="${id}" type="color" value="${initial}" hidden></div>`;
  const range = (id: string, min: number, max: number, value: number): string =>
    `<div class="pair"><input id="${id}" type="range" min="${min}" max="${max}" step="1" value="${value}"><output id="${id}-out"></output></div>`;
  return `
    <details class="style" id="style-box">
      <summary>${tr('regionStyleTitle')}</summary>
      <div class="style-grid">
        <label>${tr('regionStyleFont')}</label>
        <select id="st-font"><option value="">${tr('regionStyleDefault')}</option></select>
        <label>${tr('regionStyleSize')}</label>
        <input id="st-size" type="number" min="4" max="400" step="1" placeholder="${auto}">
        <label>${tr('regionStyleLineSpacing')}</label>
        <input id="st-spacing" type="number" min="0.5" max="3" step="0.05" placeholder="${auto}">
        <label>${tr('regionStyleAlign')}</label>
        <select id="st-align"><option value="">${auto}</option><option value="left">${tr('regionStyleAlignLeft')}</option><option value="center">${tr('regionStyleAlignCenter')}</option><option value="right">${tr('regionStyleAlignRight')}</option></select>
        <label>${tr('regionStyleCase')}</label>
        <select id="st-upper"><option value="">${auto}</option><option value="1">${tr('regionStyleCaseUpper')}</option><option value="0">${tr('regionStyleCaseAsTyped')}</option></select>
        <label>${tr('regionStyleColor')}</label>
        ${colorPair('st-color', auto, '#000000')}
        <label>${tr('regionStyleOutline')}</label>
        <input id="st-outline" type="number" min="0" max="20" step="0.5" placeholder="${auto}">
        <label>${tr('regionStyleOutlineColor')}</label>
        ${colorPair('st-outline-color', auto, '#ffffff')}
        <label>${tr('regionStyleBackground')}</label>
        ${colorPair('st-bg', tr('regionStyleNone'), '#fff27a')}
        <label>${tr('regionStyleRotation')}</label>
        ${range('st-rot', -180, 180, 0)}
        <label>${tr('regionStyleOffsetX')}</label>
        ${range('st-offx', -50, 50, 0)}
        <label>${tr('regionStyleOffsetY')}</label>
        ${range('st-offy', -50, 50, 0)}
        <label>${tr('regionStyleArea')}</label>
        ${range('st-area', 20, 100, 100)}
        <label>${tr('regionStyleVertical')}</label>
        <label class="check"><input id="st-vertical" type="checkbox"> ${tr('regionStyleVerticalHint')}</label>
      </div>
      <div class="style-hint">${tr('regionStyleHint')}</div>
      <button id="st-reset" type="button">${tr('regionStyleReset')}</button>
    </details>`;
}

/** Reads and writes a RegionStyle from/to the controls styleHtml() produced. */
export class StyleControls {
  private readonly $: <T extends HTMLElement>(id: string) => T;

  constructor(shadow: ShadowRoot) {
    this.$ = <T extends HTMLElement>(id: string): T => shadow.getElementById(id) as T;
    for (const id of ['st-color', 'st-outline-color', 'st-bg']) {
      this.$<HTMLSelectElement>(`${id}-mode`).addEventListener('change', () => this.syncColorVisibility());
    }
    for (const id of ['st-rot', 'st-offx', 'st-offy', 'st-area']) {
      this.$<HTMLInputElement>(id).addEventListener('input', () => this.syncOutputs());
    }
    this.$<HTMLButtonElement>('st-reset').addEventListener('click', () => this.set(undefined));
    this.syncColorVisibility();
    this.syncOutputs();
  }

  /** Fills the font picker; a font the list doesn't have (backend offline, or
   * a pack from another machine) is kept as an extra option, not dropped. */
  setFonts(fonts: string[], current: string | undefined): void {
    const select = this.$<HTMLSelectElement>('st-font');
    const first = select.options[0];
    const names = current && !fonts.includes(current) ? [...fonts, current] : fonts;
    select.replaceChildren(first, ...names.map((name) => new Option(name, name)));
    select.value = current ?? '';
  }

  /** Is the box currently showing any non-default value? */
  isCustomised(): boolean {
    return this.get() !== undefined;
  }

  open(): void {
    this.$<HTMLDetailsElement>('style-box').open = true;
  }

  set(style: RegionStyle | undefined): void {
    const s = normalizeStyle(style) ?? {};
    this.$<HTMLSelectElement>('st-font').value = s.font ?? '';
    this.$<HTMLInputElement>('st-size').value = s.fontSize !== undefined ? String(s.fontSize) : '';
    this.$<HTMLInputElement>('st-spacing').value = s.lineSpacing !== undefined ? String(s.lineSpacing) : '';
    this.$<HTMLSelectElement>('st-align').value = s.align ?? '';
    this.$<HTMLSelectElement>('st-upper').value = s.uppercase === undefined ? '' : s.uppercase ? '1' : '0';
    this.setColor('st-color', s.textColor);
    this.$<HTMLInputElement>('st-outline').value = s.outlineWidth !== undefined ? String(s.outlineWidth) : '';
    this.setColor('st-outline-color', s.outlineColor);
    this.setColor('st-bg', s.backgroundColor);
    this.$<HTMLInputElement>('st-rot').value = String(s.rotation ?? 0);
    this.$<HTMLInputElement>('st-offx').value = String(s.offsetX ?? 0);
    this.$<HTMLInputElement>('st-offy').value = String(s.offsetY ?? 0);
    this.$<HTMLInputElement>('st-area').value = String(s.textArea ?? 100);
    this.$<HTMLInputElement>('st-vertical').checked = s.vertical === true;
    this.syncColorVisibility();
    this.syncOutputs();
  }

  get(): RegionStyle | undefined {
    const number = (id: string): number | undefined => {
      const raw = this.$<HTMLInputElement>(id).value.trim();
      const value = raw === '' ? NaN : Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const color = (id: string): string | undefined =>
      this.$<HTMLSelectElement>(`${id}-mode`).value === 'custom' ? this.$<HTMLInputElement>(id).value : undefined;
    const upper = this.$<HTMLSelectElement>('st-upper').value;
    const align = this.$<HTMLSelectElement>('st-align').value;
    return normalizeStyle({
      font: this.$<HTMLSelectElement>('st-font').value || undefined,
      fontSize: number('st-size'),
      lineSpacing: number('st-spacing'),
      align: (align || undefined) as RegionStyle['align'],
      textColor: color('st-color'),
      outlineWidth: number('st-outline'),
      outlineColor: color('st-outline-color'),
      backgroundColor: color('st-bg'),
      uppercase: upper === '' ? undefined : upper === '1',
      rotation: number('st-rot'),
      vertical: this.$<HTMLInputElement>('st-vertical').checked,
      offsetX: number('st-offx'),
      offsetY: number('st-offy'),
      textArea: number('st-area'),
    });
  }

  private setColor(id: string, value: string | undefined): void {
    this.$<HTMLSelectElement>(`${id}-mode`).value = value ? 'custom' : '';
    if (value) this.$<HTMLInputElement>(id).value = value;
  }

  private syncColorVisibility(): void {
    for (const id of ['st-color', 'st-outline-color', 'st-bg']) {
      this.$<HTMLInputElement>(id).hidden = this.$<HTMLSelectElement>(`${id}-mode`).value !== 'custom';
    }
  }

  private syncOutputs(): void {
    const out = (id: string, unit: string): void => {
      this.$<HTMLOutputElement>(`${id}-out`).textContent = `${this.$<HTMLInputElement>(id).value}${unit}`;
    };
    out('st-rot', '°');
    out('st-offx', '%');
    out('st-offy', '%');
    out('st-area', '%');
  }
}
