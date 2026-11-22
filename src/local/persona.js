// The fun bits: a personality from the numbers, and tokens as novels.

// Tokens to "novels": about 0.75 words a token, 90,000 words a novel.
export const WORDS_PER_TOKEN = 0.75;
export const WORDS_PER_NOVEL = 90000;
// A fast typist, for "if a person typed it".
export const TYPING_WPM = 40;
export function novels(tokens) {
  return Math.round((tokens * WORDS_PER_TOKEN) / WORDS_PER_NOVEL);
}

// One personality from the numbers, checked in this order. The line states the rule that earned the name without
// repeating a number another card shows (at most 36 characters).
export function personality(u) {
  if (!u) return null;
  const modelCount = u.models.length;
  const outRatio = u.tokens.input ? u.tokens.output / u.tokens.input : 0;
  const late = u.busiestHour != null && (u.busiestHour >= 22 || u.busiestHour < 4);
  if (u.together?.agents >= 25) {
    return { name: 'The Conductor', line: 'You ran a crowd of agents at once.' };
  }
  if (u.built?.lines >= 100000) {
    return { name: 'The Shipper', line: 'You let your agents write the code.' };
  }
  if (late) return { name: 'The Night Owl', line: 'Your agents worked hardest after 10pm.' };
  if (u.harnesses?.length >= 3) return { name: 'The Harness Hopper', line: 'You moved between coding agents.' };
  if (u.streak >= 30) return { name: 'The Marathoner', line: 'You showed up day after day.' };
  if (u.cacheHit != null && u.cacheHit >= 0.6) {
    return { name: 'The Cache Whisperer', line: 'You kept your context warm.' };
  }
  if (modelCount >= 6) return { name: 'The Explorer', line: 'You tried model after model.' };
  if (outRatio >= 0.5) return { name: 'The Author', line: 'Your models wrote more than most.' };
  if (u.peak && u.tokens.total && u.peak.tokens / u.tokens.total >= 0.1) {
    return { name: 'The Sprinter', line: 'One day carried your year.' };
  }
  return { name: 'The Builder', line: 'You built with agents all year.' };
}
