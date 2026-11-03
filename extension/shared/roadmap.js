// The NeetCode 150 roadmap as data, plus the pure logic the progress tab and
// the next-problem suggestions share. No Node or browser APIs, so the options
// page, the background worker and the companion can all import it.
//
// A problem is { slug, title, difficulty: "Easy"|"Medium"|"Hard", topic }.
// The slug is LeetCode's own (leetcode.com/problems/<slug>/), which is also
// what the extension already reads from the page address.

const DIFFICULTY = { E: 'Easy', M: 'Medium', H: 'Hard' };

// One line per problem: slug | title | E, M or H. Order is NeetCode's order.
const SOURCE = {
  'arrays-hashing': [
    'Arrays & Hashing',
    `contains-duplicate|Contains Duplicate|E
valid-anagram|Valid Anagram|E
two-sum|Two Sum|E
group-anagrams|Group Anagrams|M
top-k-frequent-elements|Top K Frequent Elements|M
encode-and-decode-strings|Encode and Decode Strings|M
product-of-array-except-self|Product of Array Except Self|M
valid-sudoku|Valid Sudoku|M
longest-consecutive-sequence|Longest Consecutive Sequence|M`,
  ],
  'two-pointers': [
    'Two Pointers',
    `valid-palindrome|Valid Palindrome|E
two-sum-ii-input-array-is-sorted|Two Sum II - Input Array Is Sorted|M
3sum|3Sum|M
container-with-most-water|Container With Most Water|M
trapping-rain-water|Trapping Rain Water|H`,
  ],
  'sliding-window': [
    'Sliding Window',
    `best-time-to-buy-and-sell-stock|Best Time to Buy and Sell Stock|E
longest-substring-without-repeating-characters|Longest Substring Without Repeating Characters|M
longest-repeating-character-replacement|Longest Repeating Character Replacement|M
permutation-in-string|Permutation in String|M
minimum-window-substring|Minimum Window Substring|H
sliding-window-maximum|Sliding Window Maximum|H`,
  ],
  stack: [
    'Stack',
    `valid-parentheses|Valid Parentheses|E
min-stack|Min Stack|M
evaluate-reverse-polish-notation|Evaluate Reverse Polish Notation|M
generate-parentheses|Generate Parentheses|M
daily-temperatures|Daily Temperatures|M
car-fleet|Car Fleet|M
largest-rectangle-in-histogram|Largest Rectangle in Histogram|H`,
  ],
  'binary-search': [
    'Binary Search',
    `binary-search|Binary Search|E
search-a-2d-matrix|Search a 2D Matrix|M
koko-eating-bananas|Koko Eating Bananas|M
find-minimum-in-rotated-sorted-array|Find Minimum in Rotated Sorted Array|M
search-in-rotated-sorted-array|Search in Rotated Sorted Array|M
time-based-key-value-store|Time Based Key-Value Store|M
median-of-two-sorted-arrays|Median of Two Sorted Arrays|H`,
  ],
  'linked-list': [
    'Linked List',
    `reverse-linked-list|Reverse Linked List|E
merge-two-sorted-lists|Merge Two Sorted Lists|E
linked-list-cycle|Linked List Cycle|E
reorder-list|Reorder List|M
remove-nth-node-from-end-of-list|Remove Nth Node From End of List|M
copy-list-with-random-pointer|Copy List With Random Pointer|M
add-two-numbers|Add Two Numbers|M
find-the-duplicate-number|Find the Duplicate Number|M
lru-cache|LRU Cache|M
merge-k-sorted-lists|Merge K Sorted Lists|H
reverse-nodes-in-k-group|Reverse Nodes in k-Group|H`,
  ],
  trees: [
    'Trees',
    `invert-binary-tree|Invert Binary Tree|E
maximum-depth-of-binary-tree|Maximum Depth of Binary Tree|E
diameter-of-binary-tree|Diameter of Binary Tree|E
balanced-binary-tree|Balanced Binary Tree|E
same-tree|Same Tree|E
subtree-of-another-tree|Subtree of Another Tree|E
lowest-common-ancestor-of-a-binary-search-tree|Lowest Common Ancestor of a Binary Search Tree|M
binary-tree-level-order-traversal|Binary Tree Level Order Traversal|M
binary-tree-right-side-view|Binary Tree Right Side View|M
count-good-nodes-in-binary-tree|Count Good Nodes in Binary Tree|M
validate-binary-search-tree|Validate Binary Search Tree|M
kth-smallest-element-in-a-bst|Kth Smallest Element in a BST|M
construct-binary-tree-from-preorder-and-inorder-traversal|Construct Binary Tree From Preorder and Inorder Traversal|M
binary-tree-maximum-path-sum|Binary Tree Maximum Path Sum|H
serialize-and-deserialize-binary-tree|Serialize and Deserialize Binary Tree|H`,
  ],
  heap: [
    'Heap / Priority Queue',
    `kth-largest-element-in-a-stream|Kth Largest Element in a Stream|E
last-stone-weight|Last Stone Weight|E
k-closest-points-to-origin|K Closest Points to Origin|M
kth-largest-element-in-an-array|Kth Largest Element in an Array|M
task-scheduler|Task Scheduler|M
design-twitter|Design Twitter|M
find-median-from-data-stream|Find Median From Data Stream|H`,
  ],
  backtracking: [
    'Backtracking',
    `subsets|Subsets|M
combination-sum|Combination Sum|M
permutations|Permutations|M
subsets-ii|Subsets II|M
combination-sum-ii|Combination Sum II|M
word-search|Word Search|M
palindrome-partitioning|Palindrome Partitioning|M
letter-combinations-of-a-phone-number|Letter Combinations of a Phone Number|M
n-queens|N-Queens|H`,
  ],
  tries: [
    'Tries',
    `implement-trie-prefix-tree|Implement Trie (Prefix Tree)|M
design-add-and-search-words-data-structure|Design Add and Search Words Data Structure|M
word-search-ii|Word Search II|H`,
  ],
  graphs: [
    'Graphs',
    `number-of-islands|Number of Islands|M
max-area-of-island|Max Area of Island|M
clone-graph|Clone Graph|M
walls-and-gates|Walls and Gates|M
rotting-oranges|Rotting Oranges|M
pacific-atlantic-water-flow|Pacific Atlantic Water Flow|M
surrounded-regions|Surrounded Regions|M
course-schedule|Course Schedule|M
course-schedule-ii|Course Schedule II|M
graph-valid-tree|Graph Valid Tree|M
number-of-connected-components-in-an-undirected-graph|Number of Connected Components in an Undirected Graph|M
redundant-connection|Redundant Connection|M
word-ladder|Word Ladder|H`,
  ],
  'advanced-graphs': [
    'Advanced Graphs',
    `reconstruct-itinerary|Reconstruct Itinerary|H
min-cost-to-connect-all-points|Min Cost to Connect All Points|M
network-delay-time|Network Delay Time|M
swim-in-rising-water|Swim in Rising Water|H
alien-dictionary|Alien Dictionary|H
cheapest-flights-within-k-stops|Cheapest Flights Within K Stops|M`,
  ],
  'dp-1d': [
    '1-D Dynamic Programming',
    `climbing-stairs|Climbing Stairs|E
min-cost-climbing-stairs|Min Cost Climbing Stairs|E
house-robber|House Robber|M
house-robber-ii|House Robber II|M
longest-palindromic-substring|Longest Palindromic Substring|M
palindromic-substrings|Palindromic Substrings|M
decode-ways|Decode Ways|M
coin-change|Coin Change|M
maximum-product-subarray|Maximum Product Subarray|M
word-break|Word Break|M
longest-increasing-subsequence|Longest Increasing Subsequence|M
partition-equal-subset-sum|Partition Equal Subset Sum|M`,
  ],
  'dp-2d': [
    '2-D Dynamic Programming',
    `unique-paths|Unique Paths|M
longest-common-subsequence|Longest Common Subsequence|M
best-time-to-buy-and-sell-stock-with-cooldown|Best Time to Buy and Sell Stock With Cooldown|M
coin-change-ii|Coin Change II|M
target-sum|Target Sum|M
interleaving-string|Interleaving String|M
longest-increasing-path-in-a-matrix|Longest Increasing Path in a Matrix|H
distinct-subsequences|Distinct Subsequences|H
edit-distance|Edit Distance|M
burst-balloons|Burst Balloons|H
regular-expression-matching|Regular Expression Matching|H`,
  ],
  greedy: [
    'Greedy',
    `maximum-subarray|Maximum Subarray|M
jump-game|Jump Game|M
jump-game-ii|Jump Game II|M
gas-station|Gas Station|M
hand-of-straights|Hand of Straights|M
merge-triplets-to-form-target-triplet|Merge Triplets to Form Target Triplet|M
partition-labels|Partition Labels|M
valid-parenthesis-string|Valid Parenthesis String|M`,
  ],
  intervals: [
    'Intervals',
    `insert-interval|Insert Interval|M
merge-intervals|Merge Intervals|M
non-overlapping-intervals|Non-overlapping Intervals|M
meeting-rooms|Meeting Rooms|E
meeting-rooms-ii|Meeting Rooms II|M
minimum-interval-to-include-each-query|Minimum Interval to Include Each Query|H`,
  ],
  'bit-manipulation': [
    'Bit Manipulation',
    `single-number|Single Number|E
number-of-1-bits|Number of 1 Bits|E
counting-bits|Counting Bits|E
reverse-bits|Reverse Bits|E
missing-number|Missing Number|E
sum-of-two-integers|Sum of Two Integers|M
reverse-integer|Reverse Integer|M`,
  ],
  'math-geometry': [
    'Math & Geometry',
    `rotate-image|Rotate Image|M
spiral-matrix|Spiral Matrix|M
set-matrix-zeroes|Set Matrix Zeroes|M
happy-number|Happy Number|E
plus-one|Plus One|E
powx-n|Pow(x, n)|M
multiply-strings|Multiply Strings|M
detect-squares|Detect Squares|M`,
  ],
};

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

export const NEETCODE_150 = {
  id: 'neetcode-150',
  title: 'NeetCode 150',
  topics: Object.entries(SOURCE).map(([id, [title, lines]]) => ({
    id,
    title,
    problems: lines.split('\n').map((line) => {
      const [slug, name, d] = line.split('|');
      return { slug, title: name, difficulty: DIFFICULTY[d], topic: id };
    }),
  })),
  edges: EDGES,
};

export const ROADMAPS = { [NEETCODE_150.id]: NEETCODE_150 };

export function problemUrl(slug) {
  return `https://leetcode.com/problems/${slug}/`;
}

function index(roadmap) {
  const bySlug = new Map();
  for (const topic of roadmap.topics) for (const p of topic.problems) bySlug.set(p.slug, p);
  return bySlug;
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
// this only orders the suggestions).
export function unlockedTopics(roadmap, solved) {
  const done = new Set(solved);
  const started = new Set(roadmap.topics.filter((t) => t.problems.some((p) => done.has(p.slug))).map((t) => t.id));
  return new Set(
    roadmap.topics
      .filter((t) => roadmap.edges.filter(([, to]) => to === t.id).every(([from]) => started.has(from)))
      .map((t) => t.id)
  );
}

// What to do next, in NeetCode's order: the first unsolved problems of the
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
// solved, easiest first.
export function moreOfTopic(roadmap, solved, slug, { count = 1 } = {}) {
  const done = new Set(solved);
  const problem = index(roadmap).get(slug);
  if (!problem) return { topic: null, problems: [] };
  const topic = roadmap.topics.find((t) => t.id === problem.topic);
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
