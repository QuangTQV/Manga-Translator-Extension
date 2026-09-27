// The "Text style" part of the manual text area editor: per-region font, size,
// colours, alignment, rotation, ... (see backend schemas.RegionStyle). Kept out
// of region-tool.ts so that file stays about selecting/rendering regions; this
// one only knows how to show a RegionStyle in form controls, read it back, and
// turn it into the request's snake_case shape.
import type { RegionStyle } from '../shared/types.js';

const STYLE_PRESETS_KEY = 'mtRegionStylePresets';
interface RegionStylePreset { name: string; style: RegionStyle }

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
  .style-presets{grid-column:1/-1;display:grid;gap:5px;padding:6px 0;border-bottom:1px solid rgba(122,162,255,.2)}
  .style-presets .pair{display:flex;gap:5px;min-width:0}
  .style-presets select,.style-presets input{min-width:0;flex:1;box-sizing:border-box;background:#080c18;color:#dde6f5;border:1px solid rgba(122,162,255,.35);border-radius:6px;padding:4px 6px;font:12px system-ui,sans-serif}
  .style-presets button{padding:4px 7px}
  .style-presets-status{min-height:13px;color:#86efac;font-size:10px}
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
        <div class="style-presets">
          <div class="pair">
            <select id="st-presets" aria-label="${tr('regionStylePreset')}"><option value="">${tr('regionStylePresetChoose')}</option></select>
            <button id="st-preset-delete" type="button" title="${tr('regionStylePresetDelete')}" aria-label="${tr('regionStylePresetDelete')}" disabled>×</button>
          </div>
          <div class="pair">
            <input id="st-preset-name" type="text" maxlength="40" placeholder="${tr('regionStylePresetName')}" />
            <button id="st-preset-save" type="button" disabled>${tr('regionStylePresetSave')}</button>
          </div>
          <span class="style-presets-status" id="st-preset-status" aria-live="polite"></span>
        </div>
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
  private readonly tr: (key: string) => string;
  private presets: RegionStylePreset[] = [];
  private readonly presetsReady: Promise<void>;

  constructor(shadow: ShadowRoot, tr: (key: string) => string) {
    this.$ = <T extends HTMLElement>(id: string): T => shadow.getElementById(id) as T;
    this.tr = tr;
    this.presetsReady = this.loadPresets();
    for (const id of ['st-color', 'st-outline-color', 'st-bg']) {
      this.$<HTMLSelectElement>(`${id}-mode`).addEventListener('change', () => this.syncColorVisibility());
    }
    for (const id of ['st-rot', 'st-offx', 'st-offy', 'st-area']) {
      this.$<HTMLInputElement>(id).addEventListener('input', () => this.syncOutputs());
    }
    this.$<HTMLButtonElement>('st-reset').addEventListener('click', () => this.set(undefined));
    this.$<HTMLSelectElement>('st-presets').addEventListener('change', (event) => {
      const preset = this.presets.find((item) => item.name === (event.currentTarget as HTMLSelectElement).value);
      if (preset) this.set(preset.style);
      this.$<HTMLSpanElement>('st-preset-status').textContent = '';
      this.syncPresetButtons();
    });
    this.$<HTMLInputElement>('st-preset-name').addEventListener('input', () => this.syncPresetButtons());
    this.$<HTMLElement>('style-box').addEventListener('input', () => this.syncPresetButtons());
    this.$<HTMLElement>('style-box').addEventListener('change', () => this.syncPresetButtons());
    this.$<HTMLButtonElement>('st-preset-save').addEventListener('click', () => { void this.savePreset(); });
    this.$<HTMLButtonElement>('st-preset-delete').addEventListener('click', () => { void this.deletePreset(); });
    this.syncColorVisibility();
    this.syncOutputs();
  }

  private async loadPresets(): Promise<void> {
    try {
      const stored = (await chrome.storage.local.get(STYLE_PRESETS_KEY))[STYLE_PRESETS_KEY];
      this.presets = Array.isArray(stored)
        ? stored.filter((item): item is RegionStylePreset => Boolean(item && typeof item.name === 'string' && item.name.trim() && item.style && typeof item.style === 'object'))
        : [];
    } catch {
      this.presets = [];
    }
    this.renderPresets();
  }

  private renderPresets(): void {
    const select = this.$<HTMLSelectElement>('st-presets');
    const current = select.value;
    const first = select.options[0];
    select.replaceChildren(first, ...this.presets.map((preset) => new Option(preset.name, preset.name)));
    select.value = this.presets.some((preset) => preset.name === current) ? current : '';
    this.syncPresetButtons();
  }

  private syncPresetButtons(): void {
    const name = this.$<HTMLInputElement>('st-preset-name').value.trim();
    this.$<HTMLButtonElement>('st-preset-save').disabled = !name || !this.get();
    this.$<HTMLButtonElement>('st-preset-delete').disabled = !this.$<HTMLSelectElement>('st-presets').value;
  }

  private async savePreset(): Promise<void> {
    await this.presetsReady;
    const name = this.$<HTMLInputElement>('st-preset-name').value.trim();
    const style = this.get();
    if (!name || !style) return;
    this.presets = this.presets.filter((preset) => preset.name.toLocaleLowerCase() !== name.toLocaleLowerCase());
    this.presets.push({ name, style });
    if (this.presets.length > 20) this.presets.shift();
    try {
      await chrome.storage.local.set({ [STYLE_PRESETS_KEY]: this.presets });
      this.renderPresets();
      this.$<HTMLSelectElement>('st-presets').value = name;
      this.$<HTMLInputElement>('st-preset-name').value = '';
      this.$<HTMLSpanElement>('st-preset-status').textContent = this.tr('regionStylePresetSaved');
      this.syncPresetButtons();
    } catch {
      this.$<HTMLSpanElement>('st-preset-status').textContent = this.tr('regionStylePresetError');
    }
  }

  private async deletePreset(): Promise<void> {
    await this.presetsReady;
    const select = this.$<HTMLSelectElement>('st-presets');
    const name = select.value;
    if (!name) return;
    this.presets = this.presets.filter((preset) => preset.name !== name);
    try {
      await chrome.storage.local.set({ [STYLE_PRESETS_KEY]: this.presets });
      this.renderPresets();
      this.$<HTMLSpanElement>('st-preset-status').textContent = '';
    } catch {
      this.$<HTMLSpanElement>('st-preset-status').textContent = this.tr('regionStylePresetError');
    }
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
    this.syncPresetButtons();
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
