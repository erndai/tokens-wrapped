import { makeStyle, usd, usdWhole, padEnd, padStart, truncate, bar, visibleLength } from './format.js';
import { AI_RATE, EVERYTHING_ELSE_RATE, ERND, findLine } from './rates.js';
import { THEME, accentFor } from './theme.js';

const MAX_OUTER = 70;
const MIN_OUTER = 44;
const TOP_ITEMS = 5;
const MIN_BAR = 8;
const MIN_NAME = 12;
const MON_HEAD = 'a month';
const BACK_HEAD = 'back a year';

// Word-wrap plain text to `width` columns.
export function wrapText(text, width) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => truncate(l, width));
}

function fmtRate(r) {
  return `${r}%`;
}

function closingFor(line) {
  return findLine(line.id)?.closing || `${fmtRate(line.rate_pct)} at ${line.name}`;
}

// The closing 3 lines. Only claims from rates.js.
export function erndLines(bill, innerWidth) {
  const total = bill.back_per_year_usd;
  const exact = bill.back_per_year_exact_usd;
  const hasPerk = bill.lines.some((l) => l.kind === 'perk_only' && l.monthly_usd > 0);
  const base = `${fmtRate(AI_RATE)} at every AI vendor.`;
  let first;
  let neutral = false;
  if (total >= 100) first = `With the ernd card: about ${usdWhole(total)} back a year.`;
  else if (exact > 0) first = 'With the ernd card: under $100 back a year.';
  else if (hasPerk) first = 'With the ernd card, you get the perks above.';
  else {
    first = `With the ernd card: ${fmtRate(AI_RATE)} back at every AI vendor.`;
    neutral = true;
  }

  const partners = bill.lines
    .filter((l) => l.kind === 'partner' && l.rate_pct > AI_RATE && l.monthly_usd > 0)
    .sort((a, b) => b.rate_pct - a.rate_pct || b.monthly_usd - a.monthly_usd);
  let second;
  if (neutral) {
    second = ERND.upTo;
  } else if (partners.length) {
    const parts = partners.map(closingFor);
    second = `${base} ${parts.slice(0, 2).join(', ')}.`;
    if (visibleLength(second) > innerWidth) second = `${base} ${parts[0]}.`;
  } else if (bill.other_monthly_usd > 0) {
    second = `${base} ${fmtRate(EVERYTHING_ELSE_RATE)} on everything else.`;
  } else {
    second = `${base} ${ERND.upTo}`;
  }
  const third = `No annual fee. Request it free at ${ERND.short}`;
  return [first, second, third];
}

// periodLabel: shown top right only for API data ("last 30 days"). Empty for typed numbers.
export function render(bill, { color = false, columns = 80, byModel = false, periodLabel = '' } = {}) {
  const st = makeStyle(color);
  const cols = Number(columns) > 0 ? Number(columns) : 80;
  // Too narrow for a box: draw the same rows without the border.
  const boxed = cols >= MIN_OUTER + 2;
  const outer = boxed ? Math.min(MAX_OUTER, cols - 4) : 0;
  const indent = boxed ? '  ' : '';
  const C = boxed ? outer - 6 : Math.max(24, cols - 1); // content width: borders (2) + side padding (2 + 2)

  const ai = bill.lines
    .filter((l) => l.kind !== 'card' && l.monthly_usd > 0)
    .sort((a, b) => b.monthly_usd - a.monthly_usd);
  const card = bill.lines.filter((l) => l.kind === 'card' && l.monthly_usd > 0);
  const maxAi = Math.max(0, ...ai.map((l) => l.monthly_usd));

  const backCell = (l) => (l.kind === 'perk_only' ? 'perk' : usdWhole(l.back_per_year_usd));

  // Money columns are as wide as the widest value, so big numbers never push the border out.
  const monW = Math.max(
    MON_HEAD.length,
    ...[...ai, ...card].map((l) => usd(l.monthly_usd).length),
    ai.length ? usd(bill.ai_monthly_usd).length : 0,
  );
  const backW = Math.max(BACK_HEAD.length, ...[...ai, ...card].map((l) => backCell(l).length));
  const fixed = 2 + monW + 2 + backW;

  // Bar rows use the full name when it fits, a short name when not, and cut it only as a last resort.
  const fullLen = Math.max(0, ...ai.map((l) => l.name.length));
  const shortLen = Math.max(0, ...ai.map((l) => (l.short || l.name).length));
  // The bar is the only flexible column: it gives up width before any name is cut.
  // Names get two spaces before the bar when there is room, one when not.
  let nameW = 0;
  let useShort = true;
  search: for (const minBar of [MIN_BAR, 4, 2]) {
    const budget = C - fixed - minBar;
    for (const gap of [2, 1]) {
      if (fullLen + gap <= budget) {
        nameW = Math.max(Math.min(MIN_NAME, budget), fullLen + gap);
        useShort = false;
        break search;
      }
    }
    for (const gap of [2, 1]) {
      if (shortLen + gap <= budget) {
        nameW = shortLen + gap;
        break search;
      }
    }
  }
  if (!nameW) nameW = Math.max(4, C - fixed - 2);
  const barW = Math.max(0, C - nameW - fixed);
  const wideName = nameW + barW; // rows with no bar

  const rows = [];
  const push = (s = '') => rows.push(s);
  const pushText = (text, paint = (x) => x, pad = '') => {
    for (const l of wrapText(text, C - pad.length)) push(paint(pad + l));
  };

  const muted = st.fg(THEME.muted);
  const dim = st.dim;
  const title = st.bold(dim('AI BILL'));
  const label = periodLabel ? dim(truncate(periodLabel, C - 9)) : '';
  push(label ? padEnd(title, C - visibleLength(label)) + label : title);
  push();
  if (ai.length) {
    // The hero: the yearly number bold, the words after it quiet.
    const hero = usd(bill.ai_yearly_usd);
    for (const l of wrapText(`${hero} a year on AI`, C)) {
      push(l.startsWith(hero) ? st.bold(hero) + dim(l.slice(hero.length)) : dim(l));
    }
  } else {
    pushText('No AI spend given', st.bold);
  }
  push();

  const colHead = padStart(dim(MON_HEAD), monW) + '  ' + padStart(dim(BACK_HEAD), backW);
  push(padStart(colHead, C));

  const cells = (mon, back) => '  ' + padStart(mon, monW) + '  ' + padStart(back, backW);
  const barRow = (name, barStr, mon, back) =>
    padEnd(truncate(name, nameW - 1), nameW) + padEnd(barStr, barW) + cells(mon, back);
  const plainRow = (name, mon, back, short) => {
    const n = name.length + 1 > wideName && short ? short : name;
    return padEnd(truncate(n, wideName - 1), wideName) + cells(mon, back);
  };
  const paintBack = (l, text) => (l.kind === 'perk_only' ? dim(text) : st.fg(THEME.back)(text));

  for (const l of ai) {
    const b = st.ramp(bar(maxAi ? l.monthly_usd / maxAi : 0, barW), accentFor(l.id));
    const name = useShort ? l.short || l.name : l.name;
    push(barRow(name, b, st.bold(usd(l.monthly_usd)), paintBack(l, backCell(l))));
    if (l.kind === 'perk_only' || l.kind === 'limits') {
      pushText(l.perk, dim, '  ');
    }
    if (byModel && l.by_item?.length) {
      const top = l.by_item.slice(0, TOP_ITEMS);
      const rest = l.by_item.slice(TOP_ITEMS);
      const itemW = wideName - 2;
      for (const it of top) {
        push(dim('  ' + padEnd(truncate(it.name, itemW - 1), itemW) + '  ' + padStart(usd(it.usd), monW)));
      }
      if (rest.length) {
        const restUsd = rest.reduce((a, b2) => a + b2.usd, 0);
        const lbl = `${rest.length} more`;
        push(dim('  ' + padEnd(lbl, itemW) + '  ' + padStart(usd(restUsd), monW)));
      }
    }
  }

  if (ai.length) {
    push(st.fg(THEME.border)('─'.repeat(C)));
    // Only the closing line carries a total back, so the AI total shows spend only.
    push(st.bold(plainRow('AI total', usd(bill.ai_monthly_usd), '')));
  }
  for (const l of card) {
    push(plainRow(l.name, st.bold(usd(l.monthly_usd)), paintBack(l, backCell(l)), l.short));
  }

  push();
  const [e1, e2, e3] = erndLines(bill, C);
  // ernd stays quiet: one line in its accent, two in gray, the link in the accent.
  const accent = st.fg(THEME.ernd);
  pushText(e1, (x) => st.bold(accent(x)));
  pushText(e2, muted);
  for (const l of wrapText(e3, C)) {
    const at = l.indexOf(ERND.short);
    push(at < 0 ? muted(l) : muted(l.slice(0, at)) + st.underline(accent(ERND.short)) + muted(l.slice(at + ERND.short.length)));
  }

  if (!boxed) return ['', ...rows, ''].join('\n');
  const edge = st.fg(THEME.border);
  const top = indent + edge('╭' + '─'.repeat(outer - 2) + '╮');
  const bottom = indent + edge('╰' + '─'.repeat(outer - 2) + '╯');
  const side = edge('│');
  const body = ['', ...rows, ''].map((r) => indent + side + '  ' + padEnd(r, C) + '  ' + side);
  return ['', top, ...body, bottom, ''].join('\n');
}
