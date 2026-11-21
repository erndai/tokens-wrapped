// Colors only. No text lives here: every claim and perk string stays in rates.js.
// Each color is { hex, basic }: hex for 24-bit and 256-color terminals, basic as the 16-color SGR code.

export const THEME = {
  border: { hex: '#454a54', basic: 90 },
  muted: { hex: '#8a8f98', basic: 90 },
  back: { hex: '#4cc38a', basic: 32 },
  ernd: { hex: '#9aa5ff', basic: 94 }, // ernd's dusk periwinkle, footer only
};

// One accent per line, so a screenshot reads at a glance.
export const ACCENTS = {
  openai: { hex: '#5dbb9a', basic: 32 },
  anthropic: { hex: '#e0835f', basic: 33 },
  wafer: { hex: '#6ea8fe', basic: 94 },
  hopper: { hex: '#e5b94e', basic: 93 },
  conifer: { hex: '#a3c76b', basic: 92 },
  superserve: { hex: '#4fc1d9', basic: 36 },
  agentphone: { hex: '#e879a6', basic: 95 },
  agent37: { hex: '#c9a0ff', basic: 35 },
  nodus: { hex: '#8fa3bf', basic: 37 },
  trace: { hex: '#f07178', basic: 91 },
  firecrawl: { hex: '#ff9b4a', basic: 33 },
  ai: { hex: '#a0a7b4', basic: 37 },
};

const SPARE = Object.values(ACCENTS);

// Lines with an id not in rates.js (a vendor named by the API) get a stable color from the set.
export function accentFor(id) {
  if (ACCENTS[id]) return ACCENTS[id];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length];
}
