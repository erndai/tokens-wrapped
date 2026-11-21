// Every rate, perk string and claim about ernd lives in this one file.
// source: ernd facts.md, 2026-11-20
//
// Rates are percent back on spend. A partner rate replaces the 4% AI rate, it never stacks.
// kind:
//   vendor   any AI vendor, 4% back (OpenAI and Anthropic are vendors, not partners)
//   partner  a partner with a % back that replaces the 4%
//   perk_only a partner perk with no % back: show the text, add nothing
//   limits    a partner perk that is a usage perk: show the text, spend earns the standard 1.5%
//   card      non-AI card spend, 1.5% back
// short:   a shorter name for narrow cards. closing: how the partner reads in the card's closing line.

export const AI_RATE = 4;
export const EVERYTHING_ELSE_RATE = 1.5;

export const LINES = [
  { id: 'openai', name: 'OpenAI', kind: 'vendor', rate: AI_RATE },
  { id: 'anthropic', name: 'Anthropic', kind: 'vendor', rate: AI_RATE },
  { id: 'wafer', name: 'Wafer', kind: 'partner', rate: 10, perk: '10% back', closing: '10% at Wafer' },
  {
    id: 'hopper',
    name: 'Hopper',
    kind: 'partner',
    rate: 8,
    perk: '8% back on API credits',
    closing: '8% on Hopper API credits',
  },
  { id: 'conifer', name: 'Conifer', kind: 'partner', rate: 6, perk: '6% back', closing: '6% at Conifer' },
  { id: 'superserve', name: 'Superserve', kind: 'partner', rate: 5, perk: '5% back', closing: '5% at Superserve' },
  {
    id: 'agentphone',
    name: 'AgentPhone',
    kind: 'partner',
    rate: 5,
    perk: '5% back',
    closing: '5% at AgentPhone',
    aliases: ['agent-phone'],
  },
  {
    id: 'agent37',
    name: 'Agent 37',
    kind: 'partner',
    rate: 4,
    perk: '4% back',
    closing: '4% at Agent 37',
    aliases: ['agent-37'],
  },
  {
    id: 'nodus',
    name: 'Nodus Compute',
    short: 'Nodus',
    kind: 'perk_only',
    rate: 0,
    perk: '7.5% off spot and on-demand GPU rentals',
    aliases: ['nodus-compute'],
  },
  {
    id: 'trace',
    name: 'Trace',
    kind: 'perk_only',
    rate: 0,
    perk: '62% off the Startup plan, $1,500 instead of $4,000',
  },
  { id: 'firecrawl', name: 'Firecrawl', kind: 'limits', rate: EVERYTHING_ELSE_RATE, perk: '2x usage limits' },
  { id: 'ai', name: 'Other AI vendors', short: 'Other AI', kind: 'vendor', rate: AI_RATE },
  { id: 'other', name: 'Everything else', short: 'Other', kind: 'card', rate: EVERYTHING_ELSE_RATE },
];

export const ERND = {
  oneLiner: 'ernd is the credit card for the AI stack.',
  rates: '4% back at every AI vendor, including OpenAI and Anthropic. 1.5% back on everything else.',
  upTo: 'Up to 10% back with partners.',
  fees: 'No annual fee. Requesting is free.',
  notEndorsed: "OpenAI and Anthropic don't sponsor or endorse ernd.",
  url: 'https://ernd.ai',
  short: 'ernd.ai',
};

// Biggest monthly amount a flag or answer accepts, so the card layout has a bound.
export const MAX_MONTHLY_USD = 1e9;

// Names people type in the interactive answer that map to a line.
// Cloud platforms count as card spend (1.5%), never as 4% vendors.
// Some vendors are never named on the card: they show as "Other AI vendors".
export const ANSWER_ALIASES = {
  claude: 'anthropic',
  gpt: 'openai',
  chatgpt: 'openai',
  azure: 'other',
  bedrock: 'other',
  aws: 'other',
  gcp: 'other',
  vertex: 'other',
  'google cloud': 'other',
  glm: 'ai',
  'z.ai': 'ai',
  zai: 'ai',
  zhipu: 'ai',
};

const byId = new Map();
for (const line of LINES) {
  byId.set(line.id, line);
  for (const a of line.aliases || []) byId.set(a, line);
}

// Look up a line by id or alias ("agent-37", "Agent 37", "nodus-compute"). Returns undefined if unknown.
export function findLine(name) {
  if (!name) return undefined;
  const k = String(name).trim().toLowerCase();
  return byId.get(k) || byId.get(k.replace(/[\s_]+/g, '-')) || byId.get(k.replace(/[\s_-]+/g, ''));
}

// Every flag name that takes a monthly USD amount.
export function spendFlagNames() {
  return [...byId.keys()];
}
