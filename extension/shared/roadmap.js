// The problem lists the Progress tab and the next-problem suggestions follow,
// plus the pure logic they share. No Node or browser APIs, so the options
// page, the background worker and the companion can all import it.
//
// A list is { id, title, short, description, kind, topics, edges, subjects }:
//   topics    its groups in the publisher's order, each { id, title, problems }
//             where a problem is { slug, title, difficulty, topic } (title and
//             difficulty come from the one shared catalog, shared/catalog.js)
//   edges     prerequisite lines [from, to] between topics; only NeetCode 150
//             and NeetCode 250 have them (kind 'graph', one roadmap for both),
//             every other list is drawn as ordered groups (kind 'groups') and
//             its next group is simply the first one not finished
//   subjects  only for a list whose own groups are not subjects (Grind 75's
//             weeks): a second grouping of the same problems by subject, each
//             { id, title, problems } with the problems in the list's order;
//             every problem then also carries `subject`. The list's order (and
//             so what comes next) stays the publisher's; subjects are a view.
// The slug is LeetCode's own (leetcode.com/problems/<slug>/), which is also
// what the extension reads from the page address, so a problem solved once
// counts in every list.

import { CATALOG } from './catalog.js';

const words = (slugs) => slugs.split(/\s+/).filter(Boolean);

// Each group: [id, title, slugs], the slugs one per line in the list's order.
function defineList({ id, title, short, description, groupNoun, groups, edges = [], subjects = null }) {
  const topics = groups.map(([topicId, topicTitle, slugs]) => ({
    id: topicId,
    title: topicTitle,
    problems: words(slugs).map((slug) => {
      const entry = CATALOG.get(slug);
      if (!entry) throw new Error(`${id}: ${slug} is not in the catalog`);
      return { slug, title: entry.title, difficulty: entry.difficulty, topic: topicId };
    }),
  }));
  const size = topics.reduce((n, t) => n + t.problems.length, 0);
  const list = { id, title, short: short || title, description, groupNoun, kind: edges.length ? 'graph' : 'groups', size, topics, edges, subjects: null };
  if (subjects) list.subjects = defineSubjects(list, subjects);
  return list;
}

// Every problem of the list in exactly one subject; each subject keeps the
// list's order.
function defineSubjects(list, subjects) {
  const problems = list.topics.flatMap((t) => t.problems);
  const where = new Map();
  for (const [subjectId, , slugs] of subjects) {
    for (const slug of words(slugs)) {
      if (where.has(slug)) throw new Error(`${list.id}: ${slug} has two subjects`);
      where.set(slug, subjectId);
    }
  }
  for (const p of problems) {
    if (!where.has(p.slug)) throw new Error(`${list.id}: ${p.slug} has no subject`);
    p.subject = where.get(p.slug);
  }
  if (where.size !== problems.length) throw new Error(`${list.id}: a subject names a problem the list does not have`);
  return subjects.map(([subjectId, subjectTitle]) => ({ id: subjectId, title: subjectTitle, problems: problems.filter((p) => p.subject === subjectId) }));
}

// NeetCode 150, in NeetCode's order, with its roadmap's prerequisite lines.
// Membership, topics and the order inside each topic are neetcode.io's own
// list data (https://neetcode.io/practice/practice/neetcode150, the problem
// objects in its main bundle, fetched 2026-11-04: e2e/neetcode-lists.txt,
// which roadmap.test.mjs compares). The older copy in the neetcode-gh/leetcode
// repository (.problemSiteData.json) still has Generate Parentheses under
// Stack; the site now lists it under Backtracking.
// The roadmap's own prerequisite lines: [from, to].
const EDGES = [
  ['arrays-hashing', 'two-pointers'],
  ['arrays-hashing', 'stack'],
  ['two-pointers', 'binary-search'],
  ['two-pointers', 'sliding-window'],
  ['two-pointers', 'linked-list'],
  ['binary-search', 'trees'],
  ['linked-list', 'trees'],
  ['trees', 'tries'],
  ['trees', 'heap'],
  ['trees', 'backtracking'],
  ['backtracking', 'graphs'],
  ['backtracking', 'dp-1d'],
  ['heap', 'intervals'],
  ['heap', 'greedy'],
  ['heap', 'advanced-graphs'],
  ['graphs', 'advanced-graphs'],
  ['graphs', 'dp-2d'],
  ['dp-1d', 'dp-2d'],
  ['dp-1d', 'bit-manipulation'],
  ['dp-2d', 'math-geometry'],
  ['bit-manipulation', 'math-geometry'],
];

export const NEETCODE_150 = defineList({
  id: 'neetcode-150',
  title: 'NeetCode 150',
  description: 'NeetCode\'s expanded Blind 75, by topic on a roadmap.',
  groupNoun: 'topic',
  edges: EDGES,
  groups: [
  ['arrays-hashing', 'Arrays & Hashing', `
    contains-duplicate
    valid-anagram
    two-sum
    group-anagrams
    top-k-frequent-elements
    encode-and-decode-strings
    product-of-array-except-self
    valid-sudoku
    longest-consecutive-sequence`],
  ['two-pointers', 'Two Pointers', `
    valid-palindrome
    two-sum-ii-input-array-is-sorted
    3sum
    container-with-most-water
    trapping-rain-water`],
  ['sliding-window', 'Sliding Window', `
    best-time-to-buy-and-sell-stock
    longest-substring-without-repeating-characters
    longest-repeating-character-replacement
    permutation-in-string
    minimum-window-substring
    sliding-window-maximum`],
  ['stack', 'Stack', `
    valid-parentheses
    min-stack
    evaluate-reverse-polish-notation
    daily-temperatures
    car-fleet
    largest-rectangle-in-histogram`],
  ['binary-search', 'Binary Search', `
    binary-search
    search-a-2d-matrix
    koko-eating-bananas
    find-minimum-in-rotated-sorted-array
    search-in-rotated-sorted-array
    time-based-key-value-store
    median-of-two-sorted-arrays`],
  ['linked-list', 'Linked List', `
    reverse-linked-list
    merge-two-sorted-lists
    linked-list-cycle
    reorder-list
    remove-nth-node-from-end-of-list
    copy-list-with-random-pointer
    add-two-numbers
    find-the-duplicate-number
    lru-cache
    merge-k-sorted-lists
    reverse-nodes-in-k-group`],
  ['trees', 'Trees', `
    invert-binary-tree
    maximum-depth-of-binary-tree
    diameter-of-binary-tree
    balanced-binary-tree
    same-tree
    subtree-of-another-tree
    lowest-common-ancestor-of-a-binary-search-tree
    binary-tree-level-order-traversal
    binary-tree-right-side-view
    count-good-nodes-in-binary-tree
    validate-binary-search-tree
    kth-smallest-element-in-a-bst
    construct-binary-tree-from-preorder-and-inorder-traversal
    binary-tree-maximum-path-sum
    serialize-and-deserialize-binary-tree`],
  ['heap', 'Heap / Priority Queue', `
    kth-largest-element-in-a-stream
    last-stone-weight
    k-closest-points-to-origin
    kth-largest-element-in-an-array
    task-scheduler
    design-twitter
    find-median-from-data-stream`],
  ['backtracking', 'Backtracking', `
    subsets
    combination-sum
    combination-sum-ii
    permutations
    subsets-ii
    generate-parentheses
    word-search
    palindrome-partitioning
    letter-combinations-of-a-phone-number
    n-queens`],
  ['tries', 'Tries', `
    implement-trie-prefix-tree
    design-add-and-search-words-data-structure
    word-search-ii`],
  ['graphs', 'Graphs', `
    number-of-islands
    max-area-of-island
    clone-graph
    walls-and-gates
    rotting-oranges
    pacific-atlantic-water-flow
    surrounded-regions
    course-schedule
    course-schedule-ii
    graph-valid-tree
    number-of-connected-components-in-an-undirected-graph
    redundant-connection
    word-ladder`],
  ['advanced-graphs', 'Advanced Graphs', `
    network-delay-time
    reconstruct-itinerary
    min-cost-to-connect-all-points
    swim-in-rising-water
    alien-dictionary
    cheapest-flights-within-k-stops`],
  ['dp-1d', '1-D Dynamic Programming', `
    climbing-stairs
    min-cost-climbing-stairs
    house-robber
    house-robber-ii
    longest-palindromic-substring
    palindromic-substrings
    decode-ways
    coin-change
    maximum-product-subarray
    word-break
    longest-increasing-subsequence
    partition-equal-subset-sum`],
  ['dp-2d', '2-D Dynamic Programming', `
    unique-paths
    longest-common-subsequence
    best-time-to-buy-and-sell-stock-with-cooldown
    coin-change-ii
    target-sum
    interleaving-string
    longest-increasing-path-in-a-matrix
    distinct-subsequences
    edit-distance
    burst-balloons
    regular-expression-matching`],
  ['greedy', 'Greedy', `
    maximum-subarray
    jump-game
    jump-game-ii
    gas-station
    hand-of-straights
    merge-triplets-to-form-target-triplet
    partition-labels
    valid-parenthesis-string`],
  ['intervals', 'Intervals', `
    insert-interval
    merge-intervals
    non-overlapping-intervals
    meeting-rooms
    meeting-rooms-ii
    minimum-interval-to-include-each-query`],
  ['bit-manipulation', 'Bit Manipulation', `
    single-number
    number-of-1-bits
    counting-bits
    reverse-bits
    missing-number
    sum-of-two-integers
    reverse-integer`],
  ['math-geometry', 'Math & Geometry', `
    rotate-image
    spiral-matrix
    set-matrix-zeroes
    happy-number
    plus-one
    powx-n
    multiply-strings
    detect-squares`],
  ],
});

// NeetCode 250: NeetCode 150 plus 100 more, on the same roadmap (the same
// topics and prerequisite lines). Membership and the order inside each topic
// are neetcode.io's own list data (https://neetcode.io/practice/practice/neetcode250,
// the problem objects in its main bundle, fetched 2026-11-04:
// e2e/neetcode-lists.txt, which roadmap.test.mjs compares). The topics keep
// NeetCode 150's order (neetcode.io puts Math & Geometry before Bit
// Manipulation here, but the roadmap leads from Bit Manipulation to it).
export const NEETCODE_250 = defineList({
  id: 'neetcode-250',
  title: 'NeetCode 250',
  description: 'NeetCode 150 and 100 more, by topic on the same roadmap.',
  groupNoun: 'topic',
  edges: EDGES,
  groups: [
  ['arrays-hashing', 'Arrays & Hashing', `
    concatenation-of-array
    contains-duplicate
    valid-anagram
    two-sum
    longest-common-prefix
    group-anagrams
    remove-element
    majority-element
    design-hashset
    design-hashmap
    sort-an-array
    sort-colors
    top-k-frequent-elements
    encode-and-decode-strings
    range-sum-query-2d-immutable
    product-of-array-except-self
    valid-sudoku
    longest-consecutive-sequence
    best-time-to-buy-and-sell-stock-ii
    majority-element-ii
    subarray-sum-equals-k
    first-missing-positive`],
  ['two-pointers', 'Two Pointers', `
    reverse-string
    valid-palindrome
    valid-palindrome-ii
    merge-strings-alternately
    merge-sorted-array
    remove-duplicates-from-sorted-array
    two-sum-ii-input-array-is-sorted
    3sum
    4sum
    rotate-array
    container-with-most-water
    boats-to-save-people
    trapping-rain-water`],
  ['sliding-window', 'Sliding Window', `
    contains-duplicate-ii
    best-time-to-buy-and-sell-stock
    longest-substring-without-repeating-characters
    longest-repeating-character-replacement
    permutation-in-string
    minimum-size-subarray-sum
    find-k-closest-elements
    minimum-window-substring
    sliding-window-maximum`],
  ['stack', 'Stack', `
    baseball-game
    valid-parentheses
    implement-stack-using-queues
    implement-queue-using-stacks
    min-stack
    evaluate-reverse-polish-notation
    asteroid-collision
    daily-temperatures
    online-stock-span
    car-fleet
    simplify-path
    decode-string
    maximum-frequency-stack
    largest-rectangle-in-histogram`],
  ['binary-search', 'Binary Search', `
    binary-search
    search-insert-position
    guess-number-higher-or-lower
    sqrtx
    search-a-2d-matrix
    koko-eating-bananas
    capacity-to-ship-packages-within-d-days
    find-minimum-in-rotated-sorted-array
    search-in-rotated-sorted-array
    search-in-rotated-sorted-array-ii
    time-based-key-value-store
    split-array-largest-sum
    median-of-two-sorted-arrays
    find-in-mountain-array`],
  ['linked-list', 'Linked List', `
    reverse-linked-list
    merge-two-sorted-lists
    linked-list-cycle
    reorder-list
    remove-nth-node-from-end-of-list
    copy-list-with-random-pointer
    add-two-numbers
    find-the-duplicate-number
    reverse-linked-list-ii
    design-circular-queue
    lru-cache
    lfu-cache
    merge-k-sorted-lists
    reverse-nodes-in-k-group`],
  ['trees', 'Trees', `
    binary-tree-inorder-traversal
    binary-tree-preorder-traversal
    binary-tree-postorder-traversal
    invert-binary-tree
    maximum-depth-of-binary-tree
    diameter-of-binary-tree
    balanced-binary-tree
    same-tree
    subtree-of-another-tree
    lowest-common-ancestor-of-a-binary-search-tree
    insert-into-a-binary-search-tree
    delete-node-in-a-bst
    binary-tree-level-order-traversal
    binary-tree-right-side-view
    construct-quad-tree
    count-good-nodes-in-binary-tree
    validate-binary-search-tree
    kth-smallest-element-in-a-bst
    construct-binary-tree-from-preorder-and-inorder-traversal
    house-robber-iii
    delete-leaves-with-a-given-value
    binary-tree-maximum-path-sum
    serialize-and-deserialize-binary-tree`],
  ['heap', 'Heap / Priority Queue', `
    kth-largest-element-in-a-stream
    last-stone-weight
    k-closest-points-to-origin
    kth-largest-element-in-an-array
    task-scheduler
    design-twitter
    single-threaded-cpu
    reorganize-string
    longest-happy-string
    car-pooling
    find-median-from-data-stream
    ipo`],
  ['backtracking', 'Backtracking', `
    sum-of-all-subset-xor-totals
    subsets
    combination-sum
    combination-sum-ii
    combinations
    permutations
    subsets-ii
    permutations-ii
    generate-parentheses
    word-search
    palindrome-partitioning
    letter-combinations-of-a-phone-number
    matchsticks-to-square
    partition-to-k-equal-sum-subsets
    n-queens
    n-queens-ii
    word-break-ii`],
  ['tries', 'Tries', `
    implement-trie-prefix-tree
    design-add-and-search-words-data-structure
    extra-characters-in-a-string
    word-search-ii`],
  ['graphs', 'Graphs', `
    island-perimeter
    verifying-an-alien-dictionary
    find-the-town-judge
    number-of-islands
    max-area-of-island
    clone-graph
    walls-and-gates
    rotting-oranges
    pacific-atlantic-water-flow
    surrounded-regions
    open-the-lock
    course-schedule
    course-schedule-ii
    graph-valid-tree
    course-schedule-iv
    number-of-connected-components-in-an-undirected-graph
    redundant-connection
    accounts-merge
    evaluate-division
    minimum-height-trees
    word-ladder`],
  ['advanced-graphs', 'Advanced Graphs', `
    path-with-minimum-effort
    network-delay-time
    reconstruct-itinerary
    min-cost-to-connect-all-points
    swim-in-rising-water
    alien-dictionary
    cheapest-flights-within-k-stops
    find-critical-and-pseudo-critical-edges-in-minimum-spanning-tree
    build-a-matrix-with-conditions
    greatest-common-divisor-traversal`],
  ['dp-1d', '1-D Dynamic Programming', `
    climbing-stairs
    min-cost-climbing-stairs
    n-th-tribonacci-number
    house-robber
    house-robber-ii
    longest-palindromic-substring
    palindromic-substrings
    decode-ways
    coin-change
    maximum-product-subarray
    word-break
    longest-increasing-subsequence
    partition-equal-subset-sum
    combination-sum-iv
    perfect-squares
    integer-break
    stone-game-iii`],
  ['dp-2d', '2-D Dynamic Programming', `
    unique-paths
    unique-paths-ii
    minimum-path-sum
    longest-common-subsequence
    last-stone-weight-ii
    best-time-to-buy-and-sell-stock-with-cooldown
    coin-change-ii
    target-sum
    interleaving-string
    stone-game
    stone-game-ii
    longest-increasing-path-in-a-matrix
    distinct-subsequences
    edit-distance
    burst-balloons
    regular-expression-matching`],
  ['greedy', 'Greedy', `
    lemonade-change
    maximum-subarray
    maximum-sum-circular-subarray
    longest-turbulent-subarray
    jump-game
    jump-game-ii
    jump-game-vii
    gas-station
    hand-of-straights
    dota2-senate
    merge-triplets-to-form-target-triplet
    partition-labels
    valid-parenthesis-string
    candy`],
  ['intervals', 'Intervals', `
    insert-interval
    merge-intervals
    non-overlapping-intervals
    meeting-rooms
    meeting-rooms-ii
    meeting-rooms-iii
    minimum-interval-to-include-each-query`],
  ['bit-manipulation', 'Bit Manipulation', `
    single-number
    number-of-1-bits
    counting-bits
    add-binary
    reverse-bits
    missing-number
    sum-of-two-integers
    reverse-integer
    bitwise-and-of-numbers-range
    minimum-array-end`],
  ['math-geometry', 'Math & Geometry', `
    excel-sheet-column-title
    greatest-common-divisor-of-strings
    insert-greatest-common-divisors-in-linked-list
    transpose-matrix
    rotate-image
    spiral-matrix
    set-matrix-zeroes
    happy-number
    plus-one
    roman-to-integer
    powx-n
    multiply-strings
    detect-squares`],
  ],
});

// The original Blind 75, exactly as the 2018 post lists it
// (https://www.teamblind.com/post/New-Year-Gift---Curated-List-of-Top-75-LeetCode-Questions-to-Save-Your-Time-OaM1orEU,
// saved as e2e/blind-75.txt by scripts/list-sources.mjs and compared by
// roadmap.test.mjs): its categories, their order and the order inside each.
// Merge k Sorted Lists is listed under both Linked List and Heap there; it is
// kept once, under Linked List, so the list has 75 distinct problems.
// neetcode.io's Blind 75 (its blind75 flag) has the same problems but one:
// the post's "Combination Sum" links to Combination Sum IV, which neetcode.io
// replaces with Combination Sum. The post's own link is kept here.
export const BLIND_75 = defineList({
  id: 'blind-75',
  title: 'Blind 75',
  description: 'The original 75 from Blind, by category. NeetCode 150 extends it.',
  groupNoun: 'category',
  groups: [
  ['array', 'Array', `
    two-sum
    best-time-to-buy-and-sell-stock
    contains-duplicate
    product-of-array-except-self
    maximum-subarray
    maximum-product-subarray
    find-minimum-in-rotated-sorted-array
    search-in-rotated-sorted-array
    3sum
    container-with-most-water`],
  ['binary', 'Binary', `
    sum-of-two-integers
    number-of-1-bits
    counting-bits
    missing-number
    reverse-bits`],
  ['dynamic-programming', 'Dynamic Programming', `
    climbing-stairs
    coin-change
    longest-increasing-subsequence
    longest-common-subsequence
    word-break
    combination-sum-iv
    house-robber
    house-robber-ii
    decode-ways
    unique-paths
    jump-game`],
  ['graph', 'Graph', `
    clone-graph
    course-schedule
    pacific-atlantic-water-flow
    number-of-islands
    longest-consecutive-sequence
    alien-dictionary
    graph-valid-tree
    number-of-connected-components-in-an-undirected-graph`],
  ['interval', 'Interval', `
    insert-interval
    merge-intervals
    non-overlapping-intervals
    meeting-rooms
    meeting-rooms-ii`],
  ['linked-list', 'Linked List', `
    reverse-linked-list
    linked-list-cycle
    merge-two-sorted-lists
    merge-k-sorted-lists
    remove-nth-node-from-end-of-list
    reorder-list`],
  ['matrix', 'Matrix', `
    set-matrix-zeroes
    spiral-matrix
    rotate-image
    word-search`],
  ['string', 'String', `
    longest-substring-without-repeating-characters
    longest-repeating-character-replacement
    minimum-window-substring
    valid-anagram
    group-anagrams
    valid-parentheses
    valid-palindrome
    longest-palindromic-substring
    palindromic-substrings
    encode-and-decode-strings`],
  ['tree', 'Tree', `
    maximum-depth-of-binary-tree
    same-tree
    invert-binary-tree
    binary-tree-maximum-path-sum
    binary-tree-level-order-traversal
    serialize-and-deserialize-binary-tree
    subtree-of-another-tree
    construct-binary-tree-from-preorder-and-inorder-traversal
    validate-binary-search-tree
    kth-smallest-element-in-a-bst
    lowest-common-ancestor-of-a-binary-search-tree
    implement-trie-prefix-tree
    design-add-and-search-words-data-structure
    word-search-ii`],
  ['heap', 'Heap', `
    top-k-frequent-elements
    find-median-from-data-stream`],
  ],
});

// Grind 75 (Yangshun Tay, techinterviewhandbook.org/grind75) in its default
// schedule: 8 weeks at 8 hours a week, in its order.
export const GRIND_75 = defineList({
  id: 'grind-75',
  title: 'Grind 75',
  description: 'Yangshun Tay\'s updated Blind 75, in eight weekly sets or by subject.',
  groupNoun: 'week',
  groups: [
  ['week-1', 'Week 1', `
    two-sum
    valid-parentheses
    merge-two-sorted-lists
    best-time-to-buy-and-sell-stock
    valid-palindrome
    invert-binary-tree
    valid-anagram
    binary-search
    flood-fill
    lowest-common-ancestor-of-a-binary-search-tree
    balanced-binary-tree
    linked-list-cycle
    implement-queue-using-stacks`],
  ['week-2', 'Week 2', `
    first-bad-version
    ransom-note
    climbing-stairs
    longest-palindrome
    reverse-linked-list
    majority-element
    add-binary
    diameter-of-binary-tree
    middle-of-the-linked-list
    maximum-depth-of-binary-tree
    contains-duplicate
    maximum-subarray`],
  ['week-3', 'Week 3', `
    insert-interval
    01-matrix
    k-closest-points-to-origin
    longest-substring-without-repeating-characters
    3sum
    binary-tree-level-order-traversal
    clone-graph
    evaluate-reverse-polish-notation`],
  ['week-4', 'Week 4', `
    course-schedule
    implement-trie-prefix-tree
    coin-change
    product-of-array-except-self
    min-stack
    validate-binary-search-tree
    number-of-islands
    rotting-oranges`],
  ['week-5', 'Week 5', `
    search-in-rotated-sorted-array
    combination-sum
    permutations
    merge-intervals
    lowest-common-ancestor-of-a-binary-tree
    time-based-key-value-store
    accounts-merge
    sort-colors`],
  ['week-6', 'Week 6', `
    word-break
    partition-equal-subset-sum
    string-to-integer-atoi
    spiral-matrix
    subsets
    binary-tree-right-side-view
    longest-palindromic-substring
    unique-paths
    construct-binary-tree-from-preorder-and-inorder-traversal`],
  ['week-7', 'Week 7', `
    container-with-most-water
    letter-combinations-of-a-phone-number
    word-search
    find-all-anagrams-in-a-string
    minimum-height-trees
    task-scheduler
    lru-cache
    kth-smallest-element-in-a-bst`],
  ['week-8', 'Week 8', `
    minimum-window-substring
    serialize-and-deserialize-binary-tree
    trapping-rain-water
    find-median-from-data-stream
    word-ladder
    basic-calculator
    maximum-profit-in-job-scheduling
    merge-k-sorted-lists
    largest-rectangle-in-histogram`],
  ],
  // Grind 75 groups by week only, so each problem also gets one subject, in
  // NeetCode's topic names and order: its NeetCode 150 topic; else its
  // Blind 75 category, Top Interview 150 section or Top 100 Liked group, put
  // under the NeetCode topic of the same name (Hashmap and Array / String are
  // Arrays & Hashing, Binary Tree General is Trees); else by judgment (Flood
  // Fill, 01 Matrix, Accounts Merge and Minimum Height Trees are Graphs,
  // Implement Queue using Stacks is Stack, First Bad Version is Binary Search,
  // Longest Palindrome is Arrays & Hashing, Middle of the Linked List is
  // Linked List, Sort Colors is Two Pointers, String to Integer (atoi) is Math
  // & Geometry, Maximum Profit in Job Scheduling is 1-D Dynamic Programming).
  // roadmap.test.mjs checks the first rule.
  subjects: [
  ['arrays-hashing', 'Arrays & Hashing', `
    two-sum
    valid-anagram
    ransom-note
    longest-palindrome
    majority-element
    contains-duplicate
    product-of-array-except-self`],
  ['two-pointers', 'Two Pointers', `
    valid-palindrome
    3sum
    sort-colors
    container-with-most-water
    trapping-rain-water`],
  ['sliding-window', 'Sliding Window', `
    best-time-to-buy-and-sell-stock
    longest-substring-without-repeating-characters
    find-all-anagrams-in-a-string
    minimum-window-substring`],
  ['stack', 'Stack', `
    valid-parentheses
    implement-queue-using-stacks
    evaluate-reverse-polish-notation
    min-stack
    basic-calculator
    largest-rectangle-in-histogram`],
  ['binary-search', 'Binary Search', `
    binary-search
    first-bad-version
    search-in-rotated-sorted-array
    time-based-key-value-store`],
  ['linked-list', 'Linked List', `
    merge-two-sorted-lists
    linked-list-cycle
    reverse-linked-list
    middle-of-the-linked-list
    lru-cache
    merge-k-sorted-lists`],
  ['trees', 'Trees', `
    invert-binary-tree
    lowest-common-ancestor-of-a-binary-search-tree
    balanced-binary-tree
    diameter-of-binary-tree
    maximum-depth-of-binary-tree
    binary-tree-level-order-traversal
    validate-binary-search-tree
    lowest-common-ancestor-of-a-binary-tree
    binary-tree-right-side-view
    construct-binary-tree-from-preorder-and-inorder-traversal
    kth-smallest-element-in-a-bst
    serialize-and-deserialize-binary-tree`],
  ['heap', 'Heap / Priority Queue', `
    k-closest-points-to-origin
    task-scheduler
    find-median-from-data-stream`],
  ['backtracking', 'Backtracking', `
    combination-sum
    permutations
    subsets
    letter-combinations-of-a-phone-number
    word-search`],
  ['tries', 'Tries', `
    implement-trie-prefix-tree`],
  ['graphs', 'Graphs', `
    flood-fill
    01-matrix
    clone-graph
    course-schedule
    number-of-islands
    rotting-oranges
    accounts-merge
    minimum-height-trees
    word-ladder`],
  ['dp-1d', '1-D Dynamic Programming', `
    climbing-stairs
    coin-change
    word-break
    partition-equal-subset-sum
    longest-palindromic-substring
    maximum-profit-in-job-scheduling`],
  ['dp-2d', '2-D Dynamic Programming', `
    unique-paths`],
  ['greedy', 'Greedy', `
    maximum-subarray`],
  ['intervals', 'Intervals', `
    insert-interval
    merge-intervals`],
  ['bit-manipulation', 'Bit Manipulation', `
    add-binary`],
  ['math-geometry', 'Math & Geometry', `
    string-to-integer-atoi
    spiral-matrix`],
  ],
});

// LeetCode's own Top 100 Liked study plan (plan top-100-liked), with its
// groups exactly as LeetCode's GraphQL gave them on 2026-11-04 (so Binary Tree
// Maximum Path Sum sits under Binary Search, as LeetCode has it), checked
// against e2e/leetcode-study-plans.txt by roadmap.test.mjs.
export const TOP_100_LIKED = defineList({
  id: 'top-100-liked',
  title: 'Top 100 Liked',
  description: 'LeetCode\'s 100 most liked problems, by topic.',
  groupNoun: 'topic',
  groups: [
  ['backtracking', 'Backtracking', `
    letter-combinations-of-a-phone-number
    generate-parentheses
    combination-sum
    permutations
    n-queens
    subsets
    word-search
    palindrome-partitioning`],
  ['binary-search', 'Binary Search', `
    median-of-two-sorted-arrays
    search-in-rotated-sorted-array
    find-first-and-last-position-of-element-in-sorted-array
    search-insert-position
    search-a-2d-matrix
    binary-tree-maximum-path-sum
    find-minimum-in-rotated-sorted-array`],
  ['binary-tree', 'Binary Tree', `
    binary-tree-inorder-traversal
    validate-binary-search-tree
    symmetric-tree
    binary-tree-level-order-traversal
    maximum-depth-of-binary-tree
    construct-binary-tree-from-preorder-and-inorder-traversal
    convert-sorted-array-to-binary-search-tree
    flatten-binary-tree-to-linked-list
    binary-tree-right-side-view
    invert-binary-tree
    kth-smallest-element-in-a-bst
    lowest-common-ancestor-of-a-binary-tree
    path-sum-iii
    diameter-of-binary-tree`],
  ['dynamic-programming', 'Dynamic Programming', `
    longest-palindromic-substring
    longest-valid-parentheses
    unique-paths
    minimum-path-sum
    climbing-stairs
    edit-distance
    pascals-triangle
    word-break
    maximum-product-subarray
    house-robber
    perfect-squares
    longest-increasing-subsequence
    coin-change
    partition-equal-subset-sum
    longest-common-subsequence`],
  ['graph', 'Graph', `
    number-of-islands
    course-schedule
    rotting-oranges`],
  ['greedy', 'Greedy', `
    jump-game-ii
    jump-game
    best-time-to-buy-and-sell-stock
    partition-labels`],
  ['hashing', 'Hashing', `
    two-sum
    group-anagrams
    longest-consecutive-sequence
    subarray-sum-equals-k`],
  ['heap', 'Heap', `
    kth-largest-element-in-an-array
    find-median-from-data-stream
    top-k-frequent-elements`],
  ['linked-lists', 'Linked Lists', `
    add-two-numbers
    remove-nth-node-from-end-of-list
    merge-two-sorted-lists
    merge-k-sorted-lists
    swap-nodes-in-pairs
    reverse-nodes-in-k-group
    copy-list-with-random-pointer
    linked-list-cycle
    linked-list-cycle-ii
    lru-cache
    sort-list
    intersection-of-two-linked-lists
    reverse-linked-list
    palindrome-linked-list`],
  ['matrix', 'Matrix', `
    rotate-image
    spiral-matrix
    set-matrix-zeroes
    search-a-2d-matrix-ii`],
  ['sliding-window', 'Sliding Window', `
    longest-substring-without-repeating-characters
    minimum-window-substring
    sliding-window-maximum
    find-all-anagrams-in-a-string`],
  ['stack', 'Stack', `
    valid-parentheses
    largest-rectangle-in-histogram
    min-stack
    decode-string
    daily-temperatures`],
  ['two-pointers', 'Two Pointers', `
    container-with-most-water
    3sum
    trapping-rain-water
    move-zeroes`],
  ['trie', 'Trie', `
    implement-trie-prefix-tree`],
  ['misc', 'Misc', `
    next-permutation
    first-missing-positive
    maximum-subarray
    merge-intervals
    sort-colors
    single-number
    majority-element
    rotate-array
    product-of-array-except-self
    find-the-duplicate-number`],
  ],
});

// LeetCode's own Top Interview 150 study plan, with its sections, as
// LeetCode's GraphQL (studyPlanV2Detail, plan top-interview-150) gave them on
// 2026-11-04: e2e/leetcode-study-plans.txt, which roadmap.test.mjs compares.
export const TOP_INTERVIEW_150 = defineList({
  id: 'top-interview-150',
  title: 'Top Interview 150',
  description: 'LeetCode\'s own interview study plan, section by section.',
  groupNoun: 'section',
  groups: [
  ['array-string', 'Array / String', `
    merge-sorted-array
    remove-element
    remove-duplicates-from-sorted-array
    remove-duplicates-from-sorted-array-ii
    majority-element
    rotate-array
    best-time-to-buy-and-sell-stock
    best-time-to-buy-and-sell-stock-ii
    jump-game
    jump-game-ii
    h-index
    insert-delete-getrandom-o1
    product-of-array-except-self
    gas-station
    candy
    trapping-rain-water
    roman-to-integer
    integer-to-roman
    length-of-last-word
    longest-common-prefix
    reverse-words-in-a-string
    zigzag-conversion
    find-the-index-of-the-first-occurrence-in-a-string
    text-justification`],
  ['two-pointers', 'Two Pointers', `
    valid-palindrome
    is-subsequence
    two-sum-ii-input-array-is-sorted
    container-with-most-water
    3sum`],
  ['sliding-window', 'Sliding Window', `
    minimum-size-subarray-sum
    longest-substring-without-repeating-characters
    substring-with-concatenation-of-all-words
    minimum-window-substring`],
  ['matrix', 'Matrix', `
    valid-sudoku
    spiral-matrix
    rotate-image
    set-matrix-zeroes
    game-of-life`],
  ['hashmap', 'Hashmap', `
    ransom-note
    isomorphic-strings
    word-pattern
    valid-anagram
    group-anagrams
    two-sum
    happy-number
    contains-duplicate-ii
    longest-consecutive-sequence`],
  ['intervals', 'Intervals', `
    summary-ranges
    merge-intervals
    insert-interval
    minimum-number-of-arrows-to-burst-balloons`],
  ['stack', 'Stack', `
    valid-parentheses
    simplify-path
    min-stack
    evaluate-reverse-polish-notation
    basic-calculator`],
  ['linked-list', 'Linked List', `
    linked-list-cycle
    add-two-numbers
    merge-two-sorted-lists
    copy-list-with-random-pointer
    reverse-linked-list-ii
    reverse-nodes-in-k-group
    remove-nth-node-from-end-of-list
    remove-duplicates-from-sorted-list-ii
    rotate-list
    partition-list
    lru-cache`],
  ['binary-tree-general', 'Binary Tree General', `
    maximum-depth-of-binary-tree
    same-tree
    invert-binary-tree
    symmetric-tree
    construct-binary-tree-from-preorder-and-inorder-traversal
    construct-binary-tree-from-inorder-and-postorder-traversal
    populating-next-right-pointers-in-each-node-ii
    flatten-binary-tree-to-linked-list
    path-sum
    sum-root-to-leaf-numbers
    binary-tree-maximum-path-sum
    binary-search-tree-iterator
    count-complete-tree-nodes
    lowest-common-ancestor-of-a-binary-tree`],
  ['binary-tree-bfs', 'Binary Tree BFS', `
    binary-tree-right-side-view
    average-of-levels-in-binary-tree
    binary-tree-level-order-traversal
    binary-tree-zigzag-level-order-traversal`],
  ['binary-search-tree', 'Binary Search Tree', `
    minimum-absolute-difference-in-bst
    kth-smallest-element-in-a-bst
    validate-binary-search-tree`],
  ['graph-general', 'Graph General', `
    number-of-islands
    surrounded-regions
    clone-graph
    evaluate-division
    course-schedule
    course-schedule-ii`],
  ['graph-bfs', 'Graph BFS', `
    snakes-and-ladders
    minimum-genetic-mutation
    word-ladder`],
  ['trie', 'Trie', `
    implement-trie-prefix-tree
    design-add-and-search-words-data-structure
    word-search-ii`],
  ['backtracking', 'Backtracking', `
    letter-combinations-of-a-phone-number
    combinations
    permutations
    combination-sum
    n-queens-ii
    generate-parentheses
    word-search`],
  ['divide-conquer', 'Divide & Conquer', `
    convert-sorted-array-to-binary-search-tree
    sort-list
    construct-quad-tree
    merge-k-sorted-lists`],
  ['kadane', "Kadane's Algorithm", `
    maximum-subarray
    maximum-sum-circular-subarray`],
  ['binary-search', 'Binary Search', `
    search-insert-position
    search-a-2d-matrix
    find-peak-element
    search-in-rotated-sorted-array
    find-first-and-last-position-of-element-in-sorted-array
    find-minimum-in-rotated-sorted-array
    median-of-two-sorted-arrays`],
  ['heap', 'Heap', `
    kth-largest-element-in-an-array
    ipo
    find-k-pairs-with-smallest-sums
    find-median-from-data-stream`],
  ['bit-manipulation', 'Bit Manipulation', `
    add-binary
    reverse-bits
    number-of-1-bits
    single-number
    single-number-ii
    bitwise-and-of-numbers-range`],
  ['math', 'Math', `
    palindrome-number
    plus-one
    factorial-trailing-zeroes
    sqrtx
    powx-n
    max-points-on-a-line`],
  ['dp-1d', '1D DP', `
    climbing-stairs
    house-robber
    word-break
    coin-change
    longest-increasing-subsequence`],
  ['dp-multi', 'Multidimensional DP', `
    triangle
    minimum-path-sum
    unique-paths-ii
    longest-palindromic-substring
    interleaving-string
    edit-distance
    best-time-to-buy-and-sell-stock-iii
    best-time-to-buy-and-sell-stock-iv
    maximal-square`],
  ],
});

// LeetCode's own SQL 50 study plan (database problems, plan top-sql-50), with
// its sections, checked against e2e/leetcode-study-plans.txt the same way.
export const SQL_50 = defineList({
  id: 'sql-50',
  title: 'SQL 50',
  description: 'LeetCode\'s study plan for database problems.',
  groupNoun: 'section',
  groups: [
  ['select', 'Select', `
    recyclable-and-low-fat-products
    find-customer-referee
    big-countries
    article-views-i
    invalid-tweets`],
  ['basic-joins', 'Basic Joins', `
    replace-employee-id-with-the-unique-identifier
    product-sales-analysis-i
    customer-who-visited-but-did-not-make-any-transactions
    rising-temperature
    average-time-of-process-per-machine
    employee-bonus
    students-and-examinations
    managers-with-at-least-5-direct-reports
    confirmation-rate`],
  ['basic-aggregate', 'Basic Aggregate Functions', `
    not-boring-movies
    average-selling-price
    project-employees-i
    percentage-of-users-attended-a-contest
    queries-quality-and-percentage
    monthly-transactions-i
    immediate-food-delivery-ii
    game-play-analysis-iv`],
  ['sorting-grouping', 'Sorting and Grouping', `
    number-of-unique-subjects-taught-by-each-teacher
    user-activity-for-the-past-30-days-i
    product-sales-analysis-iii
    classes-with-at-least-5-students
    find-followers-count
    biggest-single-number
    customers-who-bought-all-products`],
  ['advanced-select-joins', 'Advanced Select and Joins', `
    the-number-of-employees-which-report-to-each-employee
    primary-department-for-each-employee
    triangle-judgement
    consecutive-numbers
    product-price-at-a-given-date
    last-person-to-fit-in-the-bus
    count-salary-categories`],
  ['subqueries', 'Subqueries', `
    employees-whose-manager-left-the-company
    exchange-seats
    movie-rating
    restaurant-growth
    friend-requests-ii-who-has-the-most-friends
    investments-in-2016
    department-top-three-salaries`],
  ['advanced-string', 'Advanced String Functions / Regex / Clause', `
    fix-names-in-a-table
    patients-with-a-condition
    delete-duplicate-emails
    second-highest-salary
    group-sold-products-by-the-date
    list-the-products-ordered-in-a-period
    find-users-with-valid-e-mails`],
  ],
});

// Every list, in the order the Progress tab offers them.
export const LISTS = [NEETCODE_150, NEETCODE_250, BLIND_75, GRIND_75, TOP_100_LIKED, TOP_INTERVIEW_150, SQL_50];
export const ROADMAPS = Object.fromEntries(LISTS.map((list) => [list.id, list]));
export const DEFAULT_LIST_ID = NEETCODE_150.id;

// The list with this id; anything unknown (an old or damaged stored value)
// means the default, NeetCode 150.
export function listById(id) {
  return (typeof id === 'string' && Object.hasOwn(ROADMAPS, id) && ROADMAPS[id]) || NEETCODE_150;
}

export function problemUrl(slug) {
  return `https://leetcode.com/problems/${slug}/`;
}

function index(roadmap) {
  const bySlug = new Map();
  for (const topic of roadmap.topics) for (const p of topic.problems) bySlug.set(p.slug, p);
  return bySlug;
}

// The problem as this list has it, or null when it is not on the list.
export function problemInList(roadmap, slug) {
  return index(roadmap).get(slug) || null;
}

// Solved and total counts per topic and overall. `solved` is any iterable of
// slugs (the student's accepted submissions); slugs outside the roadmap are
// ignored for the counts.
export function progress(roadmap, solved) {
  const done = new Set(solved);
  const topics = roadmap.topics.map((topic) => {
    const solvedCount = topic.problems.filter((p) => done.has(p.slug)).length;
    return { id: topic.id, title: topic.title, solved: solvedCount, total: topic.problems.length, complete: solvedCount === topic.problems.length };
  });
  const solvedTotal = topics.reduce((n, t) => n + t.solved, 0);
  const total = topics.reduce((n, t) => n + t.total, 0);
  return { topics, solved: solvedTotal, total };
}

// A topic is unlocked when every topic that points to it has at least one
// problem solved (the roadmap is a guide, not a gate: nothing is blocked,
// this only orders the suggestions). A list without edges has every group
// unlocked, so its order alone decides.
export function unlockedTopics(roadmap, solved) {
  const done = new Set(solved);
  const started = new Set(roadmap.topics.filter((t) => t.problems.some((p) => done.has(p.slug))).map((t) => t.id));
  return new Set(
    roadmap.topics
      .filter((t) => roadmap.edges.filter(([, to]) => to === t.id).every(([from]) => started.has(from)))
      .map((t) => t.id)
  );
}

// What to do next, in the list's order: the first unsolved problems of the
// earliest topic that is unlocked and not finished.
export function nextOnRoadmap(roadmap, solved, { count = 1 } = {}) {
  const done = new Set(solved);
  const open = unlockedTopics(roadmap, done);
  const out = [];
  for (const topic of roadmap.topics) {
    if (!open.has(topic.id)) continue;
    for (const p of topic.problems) {
      if (!done.has(p.slug)) out.push(p);
      if (out.length >= count) return out;
    }
  }
  return out;
}

// More of the same kind: unsolved problems in the topic of the one just
// solved (its subject, on a list that has subjects), easiest first.
export function moreOfTopic(roadmap, solved, slug, { count = 1 } = {}) {
  const done = new Set(solved);
  const problem = index(roadmap).get(slug);
  if (!problem) return { topic: null, problems: [] };
  const topic = roadmap.subjects ? roadmap.subjects.find((t) => t.id === problem.subject) : roadmap.topics.find((t) => t.id === problem.topic);
  const rank = { Easy: 0, Medium: 1, Hard: 2 };
  const problems = topic.problems
    .filter((p) => !done.has(p.slug) && p.slug !== slug)
    .sort((a, b) => rank[a.difficulty] - rank[b.difficulty])
    .slice(0, count);
  return { topic: { id: topic.id, title: topic.title }, problems };
}

// Everything the "nice job" message needs after an accepted submission.
export function suggestAfterSolve(roadmap, solved, slug, { count = 1 } = {}) {
  const done = new Set(solved);
  done.add(slug);
  return {
    roadmap: { id: roadmap.id, title: roadmap.title },
    agenda: nextOnRoadmap(roadmap, done, { count }),
    sameTopic: moreOfTopic(roadmap, done, slug, { count }),
  };
}
