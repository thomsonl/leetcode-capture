// extension/shared/reply-guard.js - the post-check guard for the tutor's
// prompt rules, shared by every runtime: the extension's own engine
// (tutor-engine.js) and the companion (companion.js) run every tutor turn
// through `guardedSend`, so a reply that breaks a rule the code can check is
// fixed before the student sees it, the same way in both.
//
// A local model ignores some rules some of the time (a first hint that names
// the data structure, a "better way" answer with a whole solution, an em
// dash). The guard does not judge quality; it only enforces what is
// mechanically checkable, per kind of turn (see `classifyMessage`):
//   - every turn: em dashes and spaced en dashes become commas, emoji go,
//     Unicode arrows become ASCII (outside code), "repairs";
//   - a hint or an "I'm stuck" turn is held back (the panel shows the typing
//     dots, nothing streams) and checked whole; a broken one is re-asked
//     once with the rule it broke, and if that fails too, the offending
//     sentences are removed or a safe fallback stands in;
//   - every other checked turn streams sentence by sentence, each sentence
//     (and each code block, whole) checked before it is released; one that
//     breaks a rule is dropped and never shown, so nothing on screen is ever
//     replaced;
//   - a turn the student asked to be given everything in (the full answer,
//     code, a fix) streams word by word with only the repairs.
// The rejected reply never stays in the backend's history: the guard hands
// the final text to `replaceLastReply`.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

// ---- limits ------------------------------------------------------------------

// A first hint is "the smallest nudge, one question"; past these it is not.
export const FIRST_HINT_MAX_CHARS = 450;
export const LATER_HINT_MAX_CHARS = 900;
export const STUCK_MAX_CHARS = 450;
// A held reply this far past its limit is stopped early (the backend aborts
// the request), since it will be re-asked anyway: no point paying for the
// rest of a runaway local generation.
export const EARLY_STOP_FACTOR = 1.6;

// What stands in when a held reply and its one re-ask both break a rule and
// nothing safe is left of either.
export const FALLBACK_TEXT = {
  hint: 'Pick a small input and trace your code on it by hand, one step at a time. What do you notice about what it does at each step?',
  laterHint: 'Go back to the step from the last hint and trace just that part of your code on a small input. What happens there?',
  stuck: 'What have you tried so far, and which step is unclear? I can give you a small hint if you like.',
  other: 'I could not answer that within my tutoring rules. Could you ask it another way?',
};

// ---- turn kinds ----------------------------------------------------------------

const ANSWER_RE = /\b(?:full|complete|whole|entire|working)\s+(?:solution|answer|code|implementation)\b|\b(?:give|show|tell)\s+me\s+(?:the\s+)?(?:answer|solution)\b|\bjust\s+(?:give|show|tell)\s+me\b|\bsolve\s+it\s+for\s+me\b|\bi\s+give\s+up\b|\bsoluci\u00F3n\s+completa\b/i;
const HINT_RE = /\bhints?\b|\bnudge\b|\bclue\b|\bpista\b/i;
const STUCK_RE = /\b(?:i'?m|i\s+am|im)\s+(?:so\s+|really\s+|totally\s+|completely\s+)?stuck\b|\bno\s+idea\s+(?:how|where|what)\b|\bdon'?t\s+know\s+(?:how|where|what)\s+to\s+(?:start|begin|do|go)\b/i;
const ALTERNATIVES_RE = /\b(?:better|faster|other|another|different|alternative|more\s+efficient|cleaner|optimal)\s+(?:way|ways|approach|approaches|method|methods|solution|solutions|algorithm|algorithms)\b|\balternatives?\b|\boptimi[sz]e\b/i;
const CODE_REQUEST_RE = /\b(?:show|give|write|send|share|post)\s+(?:me\s+)?(?:the\s+|some\s+|working\s+)?(?:code|implementation|pseudo-?code)\b|\b(?:with|in|as)\s+(?:the\s+)?(?:code|pseudo-?code)\b|\bcode\s+(?:it|this|that)\b|\bimplement\s+(?:it|this|that)\b|\bwrite\s+(?:it|this|that)\s+(?:out|for\s+me)\b|\bpseudo-?code\b/i;
const FIX_REQUEST_RE = /\b(?:fix|repair|correct\s+(?:it|this|that|my)|how\s+(?:do|can|should|would)\s+i\s+(?:change|correct|make))\b/i;

// What kind of turn the student's own words ask for. `trigger` 'submit' is a
// Submit review; `hintsGiven` counts earlier hint turns on this problem.
// Returns { kind, hintNumber? } with kind one of 'submit', 'answer', 'hint',
// 'stuck', 'alternatives', 'chat'.
export function classifyMessage(text, { trigger = null, hintsGiven = 0 } = {}) {
  if (trigger === 'submit') return { kind: 'submit' };
  const value = typeof text === 'string' ? text : '';
  if (ANSWER_RE.test(value)) return { kind: 'answer' };
  if (HINT_RE.test(value)) return { kind: 'hint', hintNumber: hintsGiven + 1 };
  const alternatives = ALTERNATIVES_RE.test(value);
  if (alternatives) return { kind: CODE_REQUEST_RE.test(value) ? 'answer' : 'alternatives' };
  if (CODE_REQUEST_RE.test(value) || FIX_REQUEST_RE.test(value)) return { kind: 'answer' };
  if (STUCK_RE.test(value) && !value.includes('?')) return { kind: 'stuck' };
  return { kind: 'chat' };
}

// ---- techniques ------------------------------------------------------------------

// Methods and data structures the tutor must not volunteer. A group counts as
// named once the student wrote any of its terms, its code shows one of its
// signals, or a reply the student already saw mentioned it.
const TECHNIQUES = [
  { id: 'hash-map', terms: /\bhash\s*(?:map|table|maps|tables|ing)\b|\bhashmaps?\b|\bdictionar(?:y|ies)\b|\bdicts?\b|\blookup\s+table\b/i, signals: /\bdict\s*\(|\bdefaultdict\b|\bCounter\s*\(|=\s*\{\s*\}|\bHashMap\b|\bunordered_map\b|\bnew\s+Map\b|\bMap\s*<|\bmap\s*\[|\bmake\s*\(\s*map\b|\bdictionary\b|\bhash\b/i },
  { id: 'hash-set', terms: /\bhash\s*sets?\b|\bhashsets?\b/i, signals: /\bset\s*\(|\bHashSet\b|\bunordered_set\b|\bnew\s+Set\b|\bSet\s*<|=\s*\{\s*\w[^:}]*\}/i },
  { id: 'heap', terms: /\b(?:min-?|max-?)?heaps?\b|\bpriority\s+queues?\b/i, signals: /\bheapq\b|\bPriorityQueue\b|\bpriority_queue\b|\bheap\b/i },
  { id: 'stack', terms: /\bmonotonic\s+(?:stack|queue)\b|\b(?:an?|explicit|own)\s+stack\b|\bstack-based\b|\buse\s+a\s+stack\b/i, signals: /\bstack\b/i },
  { id: 'queue', terms: /\b(?:a|explicit)\s+queue\b|\bdeque\b/i, signals: /\bdeque\b|\bqueue\b|\bQueue\b/i },
  { id: 'trie', terms: /\btries\b|\btrie\b|\bprefix\s+tree\b/i, signals: /\btrie\b/i },
  { id: 'union-find', terms: /\bunion[\s-]*find\b|\bdisjoint[\s-]*set\b|\bdsu\b/i, signals: /\bunion\s*\(|\bfind\s*\(|\bparent\s*\[/i },
  { id: 'tree-index', terms: /\bsegment\s+trees?\b|\bfenwick\b|\bbinary\s+indexed\s+trees?\b/i, signals: /\bsegment\b|\bfenwick\b|\bbit\s*\[/i },
  { id: 'binary-search', terms: /\bbinary\s+search\b|\bbisect\w*\b/i, signals: /\bbisect\b|\bmid\b|\blo\s*\+\s*hi\b|\bleft\s*\+\s*right\b/i },
  { id: 'two-pointers', terms: /\btwo[\s-]+pointers?\b/i, signals: /\b(?:left|lo|l)\b[\s\S]*\b(?:right|hi|r)\b/ },
  { id: 'sliding-window', terms: /\bsliding[\s-]+windows?\b/i, signals: /\bwindow\b/i },
  { id: 'prefix-sum', terms: /\bprefix[\s-]+sums?\b|\bcumulative\s+sums?\b|\brunning\s+sums?\b/i, signals: /\bprefix\b|\bcumsum\b|\baccumulate\b/i },
  { id: 'dynamic-programming', terms: /\bdynamic\s+programming\b|\bmemoi[sz]\w*\b|\bdp\s+(?:table|array)\b|\btabulation\b|\b(?:top-down|bottom-up)\b/i, signals: /\bdp\b|\bmemo\b|\blru_cache\b|\bcache\b/i },
  { id: 'bfs', terms: /\bbfs\b|\bbreadth[\s-]+first\b|\blevel[\s-]+order\b/i, signals: /\bdeque\b|\bqueue\b|\bpopleft\b/i },
  { id: 'dfs', terms: /\bdfs\b|\bdepth[\s-]+first\b/i, signals: null },
  { id: 'iterative', terms: /\biterative(?:ly)?\s+(?:version|approach|solution|dfs|bfs|traversal|implementation)\b|\bexplicit\s+stack\b/i, signals: null },
  { id: 'graph-search', terms: /\btopological\s+sort\w*\b|\bdijkstra\w*\b|\bbellman[\s-]+ford\b|\bkruskal\w*\b|\bprim'?s\b|\bkahn'?s\b/i, signals: /\bindegree\b|\bdist\b|\bheapq\b/i },
  { id: 'greedy', terms: /\bgreedy\b|\bgreedily\b/i, signals: null },
  { id: 'backtracking', terms: /\bbacktrack\w*\b/i, signals: null },
  { id: 'bits', terms: /\bbit\s*(?:manipulation|mask|masks|masking|wise)\b|\bbitmasks?\b|\bxor\b/i, signals: /\^|<<|>>|\bxor\b/i },
  { id: 'sorting', terms: /\bsort(?:ing)?\s+(?:the|it|them|your|both|first|array|list|input|numbers|values)\b|\bsorted\s+order\b|\bafter\s+sorting\b/i, signals: /\bsort\s*\(|\bsorted\s*\(|\.sort\b|\bArrays\.sort\b/i },
  { id: 'recursion', terms: /\brecursion\b|\brecursive(?:ly)?\b/i, signals: null },
];

// Whether `code` calls a function it defines from inside (recursion), which
// makes DFS and recursion the student's own ideas.
function usesRecursion(code) {
  const names = new Set();
  for (const match of code.matchAll(/\b(?:def|function|func|fn)\s+([A-Za-z_]\w*)\s*\(/g)) names.add(match[1]);
  for (const match of code.matchAll(/\b(?:int|void|bool|boolean|long|double|auto|string|String|List<[^>]*>|vector<[^>]*>)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g)) names.add(match[1]);
  for (const name of names) {
    const calls = code.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) || [];
    if (calls.length >= 2) return true;
  }
  return false;
}

// Text as the patterns read it: the non-breaking and other Unicode hyphens a
// model writes ("depth\u2011first") become '-', odd spaces become ' '.
export function matchable(text) {
  return String(text || '').replace(/[\u2010-\u2012]/g, '-').replace(/[\u00A0\u2007\u202F]/g, ' ');
}

// The technique groups `material` (student words, code, replies already
// shown) has named, as a Set of ids.
export function namedTechniques({ prose: rawProse = '', code = '' } = {}) {
  const prose = matchable(rawProse);
  const named = new Set();
  for (const technique of TECHNIQUES) {
    if (technique.terms.test(prose) || technique.terms.test(code)) named.add(technique.id);
    else if (technique.signals && code && technique.signals.test(code)) named.add(technique.id);
  }
  if (code && usesRecursion(code)) {
    named.add('dfs');
    named.add('recursion');
  }
  // Talking about a recursive DFS makes recursion named, and the reverse.
  if (named.has('dfs')) named.add('recursion');
  if (named.has('recursion')) named.add('dfs');
  if (named.has('bfs')) named.add('queue');
  return named;
}

// The technique terms in `text` whose group is not in `named`, as the
// matched words (first match per group).
export function unnamedTechniques(rawText, named) {
  const text = matchable(rawText);
  const found = [];
  for (const technique of TECHNIQUES) {
    if (named.has(technique.id)) continue;
    const match = text.match(technique.terms);
    if (match) found.push(match[0]);
  }
  return found;
}

// Technique groups whose code signals show up in `code` but not in `named`:
// a code block that brings in a structure the student never used.
function unnamedSignals(code, named) {
  const found = [];
  for (const technique of TECHNIQUES) {
    if (named.has(technique.id) || !technique.signals) continue;
    // Too loose to tell anything from a code block on their own.
    if (technique.id === 'two-pointers' || technique.id === 'binary-search' || technique.id === 'union-find') continue;
    const match = code.match(technique.signals);
    if (match) found.push(match[0]);
  }
  return found;
}

// ---- patterns ----------------------------------------------------------------------

const ANY_COMPLEXITY_RE = /\bO\s*\(|\b(?:linear|constant|logarithmic|quadratic|polynomial)[\s-]+(?:time|space|lookups?)\b|\b(?:one|single)[\s-]+pass\b|\bin\s+one\s+go\b|\bsub-?quadratic\b/i;
const TARGET_COMPLEXITY_RE = /\b(?:possible|achievable|achieve|target|optimal|reduce[sd]?|down\s+to|improve[sd]?|bring\s+(?:it\s+)?down|can\s+be\s+done\s+in|could\s+be\s+done\s+in|faster|better)\b[^.!?\n]*\bO\s*\(|\bO\s*\([^)]*\)[^.!?\n]*\b(?:is\s+possible|is\s+achievable|is\s+optimal|is\s+the\s+best|would\s+be\s+(?:better|faster))\b|\b(?:in|with)\s+(?:a\s+)?(?:one|single)[\s-]+pass\b|\bconstant[\s-]+time\s+lookups?\b/i;
const EDGE_CASE_RE = /\bedge[\s-]+cases?\b|\bcorner[\s-]+cases?\b|\b(?:no|zero)\s+(?:two\s+numbers|pairs?|solutions?|valid\s+(?:pairs?|answers?))\b|\bempty\s+(?:list|array|input|grid|string)\b|\bif\s+(?:there\s+(?:is|are)\s+)?no\s+(?:two|pair|answer|solution)\b|\b(?:does\s+not|doesn'?t)\s+exist\b|\bduplicates?\b|\bnegative\s+numbers?\b/i;
const STUCK_QUESTION_RE = /\b(?:tried|try|attempted|so\s+far|unclear|confus\w*|stuck|which\s+(?:step|part)|what\s+part|walk\s+me\s+through)\b/i;
const IMPROVE_RE = /\b(?:improv\w*|optimi[sz]\w*|faster|more\s+efficient(?:ly)?|efficiency|speed\s+(?:it\s+)?up|better\s+(?:method|approach|way|algorithm|solution|complexity))\b/i;
const VERDICT_RE = /\b(?:accepted|would\s+pass|will\s+pass|should\s+pass|passes\s+all\s+(?:the\s+)?(?:tests?|test\s+cases|cases)|time\s+limit\s+exceeded|wrong\s+answer\s+verdict)\b/i;
const OPTIMAL_RE = /\b(?:optimal\s+(?:solution|approach|complexity)|(?:a\s+)?(?:better|more\s+efficient|faster)\s+(?:approach|solution|algorithm|method|way)\s+(?:would|is|exists|could)|you\s+could\s+(?:instead\s+)?(?:use|switch)|consider\s+using|switch(?:ing)?\s+to)\b/i;
const REPAIR_RE = /\b(?:to\s+fix\s+(?:this|it|that|the)|the\s+fix\s+is|fix(?:ed)?\s+(?:it|this)\s+by|change\s+(?:the|your|it|this|that|line)\b[^.!?\n]{0,80}\bto\b|should\s+(?:start|begin|instead|be\s+changed)|start\s+(?:the\s+inner\s+loop|j)\s+at|replace\b[^.!?\n]{0,60}\bwith\b|instead\s+of\b[^.!?\n]{0,60}\buse\b|you\s+(?:need|have)\s+to\s+(?:change|add|start|use)|(?:a|the)\s+corrected\s+version)\b/i;
// Lines that make a block program code: definitions, control flow,
// statements. A plain assignment of a literal (`nums = [1, 0, 2]`) or a call
// (`count_islands(grid)`) is an example input, not code.
const STRUCTURE_LINE_RE = /^\s*(?:def\s|class\s|return\b|for\s+\w+(?:\s*,\s*\w+)*\s+in\s|for\s*\(|while\s*[(\w]|if\s*\(|if\s.+:\s*$|elif\s|else\s*[:{]|else\s+if\b|function\b|public\s|private\s|static\s|void\s|#include|import\s|from\s+\w+\s+import|[{}]\s*;?\s*$|(?:const|let|var|int|long|bool|auto)\s+\w+\s*=.*;\s*$|\w+(?:\[[^\]]*\])*\s*(?:\+|-|\*|\/)=)/;
const CODE_LANGS = /^(?:python3?|py|java|cpp|c\+\+|c|cs|csharp|c#|js|javascript|ts|typescript|go|golang|rust|rs|kotlin|kt|swift|ruby|rb|php|scala|dart|sql|mysql)$/i;
const PLAN_ITEM_RE = /^\s*(?:\d+[.)]|[-*+]|step\s+\d+[:.])\s+\S/gim;

// Whether a fenced block is program code (rather than a diagram, a trace or
// an example input).
export function isCodeBlock(info, body) {
  const lines = body.split('\n').filter((line) => line.trim());
  const structural = lines.filter((line) => STRUCTURE_LINE_RE.test(line)).length;
  if (CODE_LANGS.test((info || '').trim().split(/\s+/)[0] || '')) return structural >= 1;
  return structural >= 2;
}

function normalizeLine(line) {
  return line.replace(/\s+/g, ' ').trim();
}

// Whether every non-empty line of `body` is a line of the student's code
// (quoting their own code is always fine).
function quotesStudentCode(body, code) {
  if (!code) return false;
  const own = new Set(code.split('\n').map(normalizeLine).filter(Boolean));
  const lines = body.split('\n').map(normalizeLine).filter(Boolean);
  return lines.length > 0 && lines.every((line) => own.has(line));
}

// Inline code spans that look like code and are not quoted from the
// student's code.
function foreignInlineCode(text, code) {
  const found = [];
  const ownCode = normalizeLine(code || '');
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1].trim();
    if (!/[()=[\];{}]|\bfor\b|\bwhile\b|\breturn\b/.test(span)) continue;
    if (ownCode.includes(normalizeLine(span))) continue;
    found.push(span);
  }
  return found;
}

// ---- repairs -----------------------------------------------------------------------

// Fixes what never needs a re-ask, in text that is not code: an em dash or a
// spaced en dash becomes a comma, emoji are removed, Unicode arrows become
// ASCII. `text` must hold no fence (the gate repairs prose units only);
// inline code spans are left alone.
export function repairProse(text) {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/[ \t\u00a0\u202f]*\u2014[ \t\u00a0\u202f]*/g, ', ')
        .replace(/([A-Za-z.,)'"\u2019\u201d]{2,})[ \t\u00a0\u202f]+\u2013[ \t\u00a0\u202f]+(?=[A-Za-z(\u2018\u201c])/g, '$1, ')
        .replace(/,(\s*,)+/g, ',')
        .replace(/,\s*([.!?])/g, '$1')
        .replace(/(?![\u00A9\u00AE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA])\p{Extended_Pictographic}\uFE0F?[ \t]?/gu, '')
        .replace(/\u2192|\u27F6|\u279C|\u2794/g, '->')
        .replace(/\u2190|\u27F5/g, '<-')
        .replace(/\u21D2|\u27F9/g, '=>')
        .replace(/\u2194|\u27F7/g, '<->');
    })
    .join('');
}

// ---- policies ----------------------------------------------------------------------

// What a turn of each kind may and may not contain. `mode` is how the gate
// releases text: 'hold' (all at the end, re-asked when broken), 'sentence'
// (checked unit by unit, broken units dropped) or 'word' (repairs only).
export function turnPolicy(kindInfo) {
  const { kind, hintNumber = 1 } = kindInfo;
  if (kind === 'hint') {
    const first = hintNumber <= 1;
    return {
      kind,
      hintNumber,
      mode: 'hold',
      maxChars: first ? FIRST_HINT_MAX_CHARS : LATER_HINT_MAX_CHARS,
      noFence: first ? 'any' : 'code',
      noForeignInlineCode: true,
      noTechniques: first,
      noComplexity: first ? 'any' : 'target',
      noPlan: !first,
      needsQuestion: false,
      noImprove: first,
      noEdgeCase: first,
      fallback: first ? FALLBACK_TEXT.hint : FALLBACK_TEXT.laterHint,
    };
  }
  if (kind === 'stuck') {
    return {
      kind,
      mode: 'hold',
      maxChars: STUCK_MAX_CHARS,
      noFence: 'any',
      noForeignInlineCode: true,
      noTechniques: true,
      noComplexity: 'any',
      noPlan: true,
      needsQuestion: true,
      noImprove: true,
      fallback: FALLBACK_TEXT.stuck,
    };
  }
  if (kind === 'alternatives') {
    return { kind, mode: 'sentence', dropFences: 'code', fallback: FALLBACK_TEXT.other };
  }
  if (kind === 'chat') {
    return { kind, mode: 'sentence', dropFences: 'foreign', dropTechniques: true, dropTargets: true, dropRepairs: true, fallback: FALLBACK_TEXT.other };
  }
  if (kind === 'submit') {
    return { kind, mode: 'sentence', dropFences: 'foreign', dropTechniques: true, dropTargets: true, dropVerdicts: true, fallback: FALLBACK_TEXT.other };
  }
  return { kind: 'answer', mode: 'word', fallback: FALLBACK_TEXT.other };
}

// ---- checks ------------------------------------------------------------------------

// Splits a whole reply into fenced blocks and prose sentences, in order:
// [{ type: 'fence', text, info, body } | { type: 'prose', text }]. Joining
// every unit's text gives the reply back.
export function splitUnits(text) {
  const gate = createGate({ mode: 'sentence' }, { named: new Set(), code: '' }, { collect: true });
  gate.push(text);
  gate.finish();
  return gate.units;
}

// The rule a held reply breaks, as violations [{ rule, detail }], for the
// whole text. `context` is { named, code }.
export function checkHeld(text, policy, context) {
  const violations = [];
  const units = splitUnits(text);
  const prose = matchable(units.filter((unit) => unit.type === 'prose').map((unit) => unit.text).join(''));
  for (const unit of units) {
    if (unit.type !== 'fence') continue;
    if (policy.noFence === 'any' || (policy.noFence === 'code' && isCodeBlock(unit.info, unit.body) && !quotesStudentCode(unit.body, context.code))) {
      violations.push({ rule: 'fence' });
      break;
    }
  }
  if (policy.noForeignInlineCode) {
    const spans = foreignInlineCode(prose, context.code);
    if (spans.length) violations.push({ rule: 'inline-code', detail: spans[0] });
  }
  if (policy.noTechniques) {
    const terms = unnamedTechniques(prose, context.named);
    if (terms.length) violations.push({ rule: 'technique', detail: terms.join(', ') });
  }
  if (policy.noComplexity === 'any') {
    const match = prose.match(ANY_COMPLEXITY_RE);
    if (match) violations.push({ rule: 'complexity', detail: match[0] });
  } else if (policy.noComplexity === 'target') {
    const match = prose.match(TARGET_COMPLEXITY_RE);
    if (match) violations.push({ rule: 'complexity', detail: match[0] });
  }
  if (policy.noImprove) {
    const match = prose.match(IMPROVE_RE);
    if (match) violations.push({ rule: 'improve', detail: match[0] });
  }
  if (policy.noEdgeCase) {
    const match = prose.match(EDGE_CASE_RE);
    if (match) violations.push({ rule: 'edge-case', detail: match[0] });
  }
  if (policy.noPlan && (prose.match(PLAN_ITEM_RE) || []).length >= 3) violations.push({ rule: 'plan' });
  if (policy.needsQuestion && !askedWhatTried(prose)) violations.push({ rule: 'question' });
  if (policy.maxChars && text.trim().length > policy.maxChars) violations.push({ rule: 'length' });
  return violations;
}

// Whether some question in `prose` asks what the student tried or which step
// is unclear.
function askedWhatTried(prose) {
  return prose.split(/(?<=[.!?])\s+/).some((sentence) => sentence.includes('?') && STUCK_QUESTION_RE.test(sentence));
}

// Why a streamed unit must be dropped (a short rule name), or null.
function dropReason(unit, policy, context) {
  if (unit.type === 'fence') {
    if (!policy.dropFences) return null;
    if (quotesStudentCode(unit.body, context.code)) return null;
    if (policy.dropFences === 'code') return isCodeBlock(unit.info, unit.body) ? 'fence' : null;
    // 'foreign': program code that is not a quote of theirs and either
    // repairs it unasked or brings in a structure they never used.
    if (!isCodeBlock(unit.info, unit.body)) return null;
    if (policy.dropRepairs) return 'fence';
    return unnamedSignals(unit.body, context.named).length || unnamedTechniques(unit.body, context.named).length ? 'fence' : null;
  }
  const text = matchable(unit.text);
  if (policy.dropVerdicts && VERDICT_RE.test(text)) return 'verdict';
  if (policy.dropTechniques && unnamedTechniques(text, context.named).length) return 'technique';
  if (policy.dropTargets && (TARGET_COMPLEXITY_RE.test(text) || OPTIMAL_RE.test(text))) return 'complexity';
  if (policy.dropRepairs && REPAIR_RE.test(text)) return 'repair';
  return null;
}

// The re-ask: what the rejected reply broke, in the words of the rules, and
// what to do instead. The rejected reply is in the request right before it.
const RULE_TEXT = {
  fence: 'It contains a code block. This reply must have no code.',
  'inline-code': 'It shows code the student did not write. Use plain words about their code.',
  technique: 'It names a method or data structure the student has not mentioned',
  complexity: 'It mentions a target complexity or speed',
  improve: 'It points toward improving or optimizing the code',
  plan: 'It lays out a step-by-step plan. Give one nudge instead.',
  question: 'It does not ask what the student tried or which step is unclear.',
  length: 'It is too long.',
  'edge-case': 'It is about an edge case. A first hint asks about what their code does or repeats',
  verdict: 'It guesses a LeetCode verdict.',
  repair: 'It gives a fix the student did not ask for.',
};

export function reaskPrompt(violations, policy) {
  const lines = violations.map((violation) => {
    const base = RULE_TEXT[violation.rule] || violation.rule;
    const detail = violation.detail && ['technique', 'complexity', 'improve', 'edge-case'].includes(violation.rule)
      ? ` ("${violation.detail}").`
      : base.endsWith('.') ? '' : '.';
    return `- ${base}${detail}`;
  });
  const shape = policy.kind !== 'stuck' && policy.kind !== 'hint'
    ? "Answer the student's last message again without those parts."
    : policy.kind === 'stuck'
    ? 'Reply with only a short question about what they tried or which step is unclear, and offer a hint. Give no hint or method now.'
    : policy.hintNumber > 1
      ? 'Reply with one hint, one notch more concrete than the last, about their actual code, in plain words.'
      : 'Reply with one short question about what their code does or about one property of the input. Name no method, data structure or complexity.';
  return `Your reply above breaks the tutoring rules:\n${lines.join('\n')}\nRewrite it so it follows every rule. ${shape} Reply with the rewritten answer only.`;
}

// What is left of a held reply once every sentence and block that breaks a
// rule is removed, cut to its length limit; '' when nothing safe is left.
export function salvage(text, policy, context) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const kept = [];
  let length = 0;
  for (const unit of splitUnits(text)) {
    if (unit.type === 'fence') continue;
    const piece = repairProse(unit.text);
    if (!piece.trim()) {
      if (kept.length) kept.push(piece);
      continue;
    }
    if (checkHeld(piece, { ...policy, maxChars: 0, needsQuestion: false, noPlan: false }, context).length) continue;
    if (/^\s*(?:\d+[.)]|[-*+])\s/.test(piece) && policy.noPlan) continue;
    if (policy.maxChars && length + piece.trim().length > policy.maxChars) break;
    kept.push(piece);
    length += piece.trim().length;
  }
  const result = kept.join('').replace(/\n{3,}/g, '\n\n').trim().replace(/:$/, '.');
  if (!result) return '';
  if (policy.needsQuestion && !askedWhatTried(matchable(result))) return '';
  return result;
}


// ---- the streaming gate --------------------------------------------------------------

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\n/;
const FENCE_OPEN_PARTIAL_RE = /^ {0,3}(?:`{1,2}|~{1,2}|(?:`{3,}|~{3,})[^\n`]*)$/;
const FOLLOW_UP_RE = /^\s*(?:[-*+]\s+)?(?:this\s+way|that\s+way|now\b|then\b|with\s+(?:this|that|the)\s+(?:change|fix)|after\s+(?:this|that|the)\s+(?:change|fix)|this\s+(?:change|fix|ensures|guarantees|makes|prevents|avoids)|that\s+(?:change|fix)|either\s+way)/i;
const BLOCK_LINE_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\||>)/;
const SPACE_RE = /[ \t\u00A0\u202F]/;
const DASH_RE = /[\u2013\u2014-]/;

// Takes a reply chunk by chunk and returns, from each push, the text that
// may be shown now:
//   - 'word' releases up to the last safe word break (never right after a
//     dash, so a dash repair sees both sides) and code blocks line by line;
//   - 'sentence' releases whole checked sentences (or lines) and whole code
//     blocks, and drops a broken one together with a lead-in ending in ':';
//   - 'hold' releases nothing (the caller checks `raw` at the end).
// Code blocks are never repaired. `collect` only splits (see splitUnits).
function createGate(policy, context, { collect = false } = {}) {
  const mode = collect ? 'collect' : policy.mode;
  let all = '';
  let pending = '';
  let released = '';
  let fence = null; // { marker, info, open, body, close } inside a fenced block
  let atLineStart = true;
  let leadIn = null; // a prose unit ending with ':', waiting for what follows
  let afterDrop = false;
  let lastDropped = false;
  let carryBreak = false;
  const units = [];
  const dropped = [];

  function emit(text) {
    if (!text) return '';
    let out = text;
    if (!released) {
      // Nothing shown yet: no leading blank lines.
      out = out.replace(/^\s+/, '');
    } else if (carryBreak && !released.endsWith('\n')) {
      // A dropped unit took its line break with it: put it back.
      out = `\n${out}`;
    } else if (afterDrop && released.endsWith('\n') && out.startsWith('\n')) {
      // Never more than one blank line where units were dropped.
      out = out.replace(/^\n+/, released.endsWith('\n\n') ? '' : '\n');
    }
    carryBreak = false;
    if (!out) return '';
    afterDrop = false;
    released += out;
    return out;
  }

  // A complete unit in 'sentence' mode: kept, dropped, or held as a lead-in.
  function settle(unit) {
    if (mode === 'collect') {
      units.push(unit);
      return '';
    }
    // A sentence that only follows up on a dropped part ("This way j is
    // always larger") goes with it.
    const reason = dropReason(unit, policy, context) || (lastDropped && unit.type === 'prose' && FOLLOW_UP_RE.test(matchable(unit.text)) ? 'follow-up' : null);
    if (reason) {
      lastDropped = true;
      dropped.push({ rule: reason, text: unit.text });
      if (unit.text.endsWith('\n')) carryBreak = true;
      leadIn = null;
      afterDrop = true;
      return '';
    }
    const text = unit.type === 'fence' ? unit.text : repairProse(unit.text);
    if (leadIn !== null && unit.type === 'prose' && !text.trim()) {
      leadIn += text;
      return '';
    }
    if (text.trim()) lastDropped = false;
    let out = '';
    if (leadIn !== null) {
      out += emit(leadIn);
      leadIn = null;
    }
    if (unit.type === 'prose' && /:\s*$/.test(text)) {
      leadIn = text;
      return out;
    }
    return out + emit(text);
  }

  function closeFence() {
    const unit = { type: 'fence', info: fence.info, body: fence.body.replace(/\n$/, ''), text: fence.open + fence.body + fence.close };
    const out = mode === 'word' ? emit(fence.close) : settle(unit);
    fence = null;
    atLineStart = true;
    return out;
  }

  // Splits complete units off the front of `pending`; `final` means no more
  // text is coming.
  function drain(final) {
    let out = '';
    while (pending) {
      if (fence) {
        const closing = new RegExp(`^ {0,3}${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}[ \\t]*$`);
        let closed = false;
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0 && !final) break;
          const line = newline < 0 ? pending : pending.slice(0, newline);
          const piece = newline < 0 ? pending : pending.slice(0, newline + 1);
          pending = pending.slice(piece.length);
          if (closing.test(line)) {
            fence.close = piece;
            closed = true;
            break;
          }
          fence.body += piece;
          if (mode === 'word') out += emit(piece);
          if (!pending) break;
        }
        if (closed || (final && !pending)) {
          out += closeFence();
          continue;
        }
        break;
      }
      if (atLineStart) {
        const open = pending.match(FENCE_OPEN_RE);
        if (open || (final && /^ {0,3}(`{3,}|~{3,})([^\n`]*)$/.test(pending))) {
          const match = open || pending.match(/^ {0,3}(`{3,}|~{3,})([^\n`]*)$/);
          fence = { marker: match[1], info: match[2].trim(), open: match[0], body: '', close: '' };
          pending = pending.slice(match[0].length);
          if (mode === 'word') out += emit(match[0]);
          continue;
        }
        if (!final && FENCE_OPEN_PARTIAL_RE.test(pending)) break;
      }
      const end = proseUnitEnd(pending, final, mode === 'word');
      if (end <= 0) break;
      const text = pending.slice(0, end);
      pending = pending.slice(end);
      atLineStart = text.endsWith('\n');
      out += mode === 'word' ? emit(repairProse(text)) : settle({ type: 'prose', text });
    }
    // A block still open when the reply ends is a whole (unclosed) block.
    if (final && fence) out += closeFence();
    return out;
  }

  return {
    units,
    dropped,
    push(chunk) {
      if (typeof chunk !== 'string' || !chunk) return '';
      all += chunk;
      if (mode === 'hold') return '';
      pending += chunk;
      return drain(false);
    },
    finish() {
      if (mode === 'hold') return '';
      let out = drain(true);
      if (leadIn !== null) {
        out += emit(leadIn);
        leadIn = null;
      }
      return out;
    },
    // Everything pushed so far.
    get raw() {
      return all;
    },
    get released() {
      return released;
    },
  };
}

// Where the first complete prose unit at the start of `text` ends (an index
// past it), or 0 when none is complete yet. A unit ends after a newline, or
// (sentence units) after a sentence end (. ! ? and closing marks) and the
// spaces after it, or (word units) before the last
// space that has a plain character after it and no dash before it. Inline
// code spans are never split.
function proseUnitEnd(text, final, word) {
  let inCode = false;
  let lastWordBreak = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      if (word) return i + 1;
      // A model that hard-wraps its prose breaks lines mid-sentence: such a
      // line stays in the unit with the next one, so a dropped sentence is
      // never cut in half. Only a line that ends a sentence, or a block
      // line (list item, heading, table row, quote), or one followed by a
      // new block, ends the unit here.
      const line = text.slice(text.lastIndexOf('\n', i - 1) + 1, i);
      if (!line.trim() || BLOCK_LINE_RE.test(line) || /[.!?:]["')\]*_\u2019\u201D]*[ \t]*$/.test(line)) return i + 1;
      const rest = text.slice(i + 1);
      const nextEnd = rest.indexOf('\n');
      const next = nextEnd < 0 ? rest : rest.slice(0, nextEnd);
      if (nextEnd < 0 && next.length < 4 && !final) return 0;
      if (!next.trim() || BLOCK_LINE_RE.test(next) || /^ {0,3}(?:`{3}|~{3})/.test(next)) return i + 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      if (run < 3) inCode = !inCode;
      i += run - 1;
      continue;
    }
    if (inCode) continue;
    if (word) {
      if (SPACE_RE.test(ch) && i + 1 < text.length && !/\s/.test(text[i + 1]) && !DASH_RE.test(text[i + 1])) {
        let j = i - 1;
        while (j >= 0 && SPACE_RE.test(text[j])) j -= 1;
        if (j >= 0 && !DASH_RE.test(text[j])) lastWordBreak = i;
      }
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < text.length && /["')\]*_\u2019\u201D]/.test(text[j])) j += 1;
      if (j < text.length && SPACE_RE.test(text[j])) {
        let k = j;
        while (k < text.length && SPACE_RE.test(text[k])) k += 1;
        // "e.g." and the like are not sentence ends.
        if (ch === '.' && /\b(?:e\.g|i\.e|etc|vs|approx|Dr|Mr|Ms|Mrs)$/i.test(text.slice(Math.max(0, i - 6), i))) continue;
        // Nor is a list marker ("1. ") at the start of a line.
        if (ch === '.' && /^[ \t]*\d+$/.test(text.slice(text.lastIndexOf('\n', i) + 1, i))) continue;
        // Released as soon as its trailing space arrives (more spaces, or a
        // newline, start the next unit), so a sentence never waits for the
        // next one to begin.
        if (k === text.length || text[k] !== '\n') return k;
      }
    }
  }
  if (word && lastWordBreak > 0) return lastWordBreak;
  return final ? text.length : 0;
}

// ---- the guard ----------------------------------------------------------------------

const MAX_MATERIAL_CHARS = 60_000;

// One guard per tutor conversation. It remembers how many hints were given
// and what the student has named or already seen (their messages, their
// code, every reply shown), and is reset with the conversation (a problem
// switch, /reset).
export function createReplyGuard() {
  let hintsGiven = 0;
  let seenProse = '';
  let seenCode = '';
  const keep = (value) => (value.length > MAX_MATERIAL_CHARS ? value.slice(-MAX_MATERIAL_CHARS) : value);

  return {
    // The policy and context for one turn: `text` is the student's own
    // words (null for a Submit), `trigger` 'submit' or null, `code` their
    // current code (or null). `done(shown)` records the finished turn
    // (guardedSend calls it).
    begin({ text = null, trigger = null, code = null } = {}) {
      const words = typeof text === 'string' ? text : '';
      const current = typeof code === 'string' ? code : '';
      const policy = turnPolicy(classifyMessage(words, { trigger, hintsGiven }));
      const context = {
        named: namedTechniques({ prose: `${seenProse}\n${words}`, code: `${seenCode}\n${current}` }),
        code: current,
      };
      return {
        policy,
        context,
        done(shown) {
          if (policy.kind === 'hint') hintsGiven += 1;
          seenProse = keep(`${seenProse}\n${words}\n${typeof shown === 'string' ? shown : ''}`);
          if (current) seenCode = keep(current);
        },
      };
    },
    reset() {
      hintsGiven = 0;
      seenProse = '';
      seenCode = '';
    },
    get hintsGiven() {
      return hintsGiven;
    },
  };
}

// Runs one tutor turn through the guard.
//   - `backend.sendMessage(text, options)` is called with `onChunk` and, for
//     a held turn, `shouldStop(textSoFar)` (a backend that supports it ends
//     the request early and returns what it had).
//   - `onText(piece)` receives each piece the student may see, in order; the
//     resolved string is the whole reply as shown, always exactly the
//     concatenation of those pieces.
//   - A backend with `reviseLastReply(instruction, { shouldStop })` gets one
//     re-ask for a broken held reply (and for a streamed one whose every
//     part was dropped); one with `replaceLastReply(text)` keeps the shown
//     text, never the rejected one, in its history.
//   - Backend errors propagate unchanged, except that a cut-off error's
//     `partialReply` becomes what may be shown of it.
// `turn` comes from guard.begin(); null sends the turn unguarded.
export async function guardedSend({ backend, text, options = {}, turn, onText = () => {}, log = () => {} }) {
  if (!turn) return backend.sendMessage(text, { ...options, onChunk: onText });
  const { policy, context } = turn;
  const gate = createGate(policy, context);
  let shown = '';
  const show = (piece) => {
    if (!piece) return;
    shown += piece;
    onText(piece);
  };
  let chunks = 0;
  const hold = policy.mode === 'hold';
  const shouldStop = hold ? heldStop(policy) : undefined;

  let reply;
  try {
    reply = await backend.sendMessage(text, {
      ...options,
      onChunk: (chunk) => {
        chunks += 1;
        show(gate.push(chunk));
      },
      ...(shouldStop ? { shouldStop } : {}),
    });
  } catch (err) {
    if (err && err.cutOff) {
      if (!chunks && typeof err.partialReply === 'string') show(gate.push(err.partialReply));
      show(gate.finish());
      if (hold) show(salvage(gate.raw, policy, context));
      err.partialReply = shown || undefined;
    }
    throw err;
  }
  if (!(typeof reply === 'string' && reply.trim())) return reply;
  // A backend that did not stream hands over the whole reply at the end.
  if (!chunks) show(gate.push(reply));
  show(gate.finish());

  if (hold) {
    const raw = gate.raw;
    const violations = checkHeld(raw, policy, context);
    if (!violations.length) {
      show(repairHeld(raw));
    } else {
      log(`guard: a ${policy.kind} reply broke ${violations.map((v) => v.rule).join(', ')}; re-asking once`);
      show(await reaskHeld({ backend, original: raw, violations, policy, context, log }));
    }
  } else if (gate.dropped.length) {
    log(`guard: dropped ${gate.dropped.map((d) => d.rule).join(', ')} from a ${policy.kind} reply`);
    if (!shown.trim()) {
      // Every part was dropped and nothing is on screen yet, so a re-ask
      // cannot replace anything the student saw.
      show(await reaskStreamed({ backend, violations: gate.dropped.map((d) => ({ rule: d.rule })), policy, context, log }));
    }
  }
  if (shown !== reply && typeof backend.replaceLastReply === 'function') backend.replaceLastReply(shown);
  turn.done(shown);
  return shown;
}

// When a held reply is past saving anyway: well over its length limit, or
// (where no code block is allowed) a code block has started.
function heldStop(policy) {
  const limit = policy.maxChars ? Math.ceil(policy.maxChars * EARLY_STOP_FACTOR) : Infinity;
  return (soFar) => soFar.length > limit || (policy.noFence === 'any' && /(?:^|\n) {0,3}(?:```|~~~)/.test(soFar));
}

// A held reply's text as shown: prose repaired, code blocks as they are.
function repairHeld(text) {
  return splitUnits(text)
    .map((unit) => (unit.type === 'fence' ? unit.text : repairProse(unit.text)))
    .join('')
    .trim();
}

async function revise(backend, violations, policy, log) {
  if (typeof backend.reviseLastReply !== 'function') return null;
  try {
    const revised = await backend.reviseLastReply(reaskPrompt(violations, policy), { shouldStop: heldStop(policy) });
    return typeof revised === 'string' && revised.trim() ? revised : null;
  } catch (err) {
    log(`guard: the re-ask failed (${err.message})`);
    return null;
  }
}

// One re-ask of a held reply; if that breaks a rule too, what is safe of the
// re-ask, then of the original, then the fallback.
async function reaskHeld({ backend, original, violations, policy, context, log }) {
  const revised = await revise(backend, violations, policy, log);
  if (revised) {
    const again = checkHeld(revised, policy, context);
    if (!again.length) return repairHeld(revised);
    log(`guard: the re-ask broke ${again.map((v) => v.rule).join(', ')} too`);
    const kept = salvage(revised, policy, context);
    if (kept) return kept;
  }
  return salvage(original, policy, context) || policy.fallback || FALLBACK_TEXT.other;
}

// One re-ask of a streamed reply that had nothing left to show, put through
// the same sentence checks; then the fallback.
async function reaskStreamed({ backend, violations, policy, context, log }) {
  const revised = await revise(backend, violations, policy, log);
  if (revised) {
    const gate = createGate(policy, context);
    const text = (gate.push(revised) + gate.finish()).trim();
    if (text) return text;
  }
  return policy.fallback || FALLBACK_TEXT.other;
}
