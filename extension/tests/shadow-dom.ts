import type { CDPSession, Page } from '@playwright/test';

/** The Scanner UI (content-script) intentionally uses a *closed* shadow
 * root, so Playwright's normal locators (page.locator, etc.) can't see
 * inside it — that's a deliberate product choice (see content-script's own
 * comments on createScannerRoot), not something to work around by changing
 * product code. Driving it in tests means talking to the raw CDP DOM
 * domain instead, which can pierce closed shadow roots. */

export type CdpNode = {
  nodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
};

export async function pierceQuery(cdp: CDPSession, predicate: (node: CdpNode) => boolean): Promise<CdpNode[]> {
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
  const matches: CdpNode[] = [];
  function walk(node: CdpNode): void {
    if (predicate(node)) matches.push(node);
    for (const child of node.children ?? []) walk(child);
    for (const shadowRoot of node.shadowRoots ?? []) walk(shadowRoot);
    if (node.contentDocument) walk(node.contentDocument);
  }
  walk(root);
  return matches;
}

export function hasAttr(node: CdpNode, name: string, value?: string): boolean {
  if (!node.attributes) return false;
  const idx = node.attributes.indexOf(name);
  if (idx === -1) return false;
  return value === undefined || node.attributes[idx + 1] === value;
}

export function getAttr(node: CdpNode, name: string): string | undefined {
  if (!node.attributes) return undefined;
  const idx = node.attributes.indexOf(name);
  return idx === -1 ? undefined : node.attributes[idx + 1];
}

export function hasClass(node: CdpNode, cls: string): boolean {
  if (!node.attributes) return false;
  const idx = node.attributes.indexOf('class');
  if (idx === -1) return false;
  return (node.attributes[idx + 1] ?? '').split(/\s+/).includes(cls);
}

export async function boxCenter(cdp: CDPSession, nodeId: number): Promise<{ x: number; y: number }> {
  const { model } = (await cdp.send('DOM.getBoxModel', { nodeId })) as { model: { content: number[] } };
  const [x1, y1, , , x2, y2] = model.content;
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

/** Clicks the first element in the (piercing) DOM tree carrying
 * `data-action="<action>"` — the Scanner's own toolbar buttons all use
 * this attribute as their identity, see content-script's buildScannerHTML. */
export async function clickScannerAction(page: Page, cdp: CDPSession, action: string): Promise<void> {
  const matches = await pierceQuery(cdp, (n) => hasAttr(n, 'data-action', action));
  if (!matches[0]) throw new Error(`No scanner element with data-action="${action}" found`);
  const { x, y } = await boxCenter(cdp, matches[0].nodeId);
  await page.mouse.click(x, y);
}
