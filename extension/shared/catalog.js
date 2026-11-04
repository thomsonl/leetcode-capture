// Every problem any bundled list uses, once, keyed by LeetCode's own slug,
// with LeetCode's own title (its exact casing) and difficulty. Lists
// (shared/roadmap.js) refer to problems by slug only, so a problem shared by
// several lists has one title and one difficulty, and solving it once counts
// in every list.
//
// One line per problem: slug | title | E, M or H. Grouped by the first list
// that uses it, only to keep the file readable. extension/e2e/list-slugs.json
// is generated from this (node extension/scripts/list-slugs.mjs) so the
// slugs can be checked against LeetCode itself; roadmap.test.mjs fails when
// the two differ.
//
// Pure data, no Node or browser APIs (extension/shared.test.js checks that).

const DIFFICULTY = { E: 'Easy', M: 'Medium', H: 'Hard' };

const SOURCE = `
# NeetCode 150
contains-duplicate|Contains Duplicate|E
valid-anagram|Valid Anagram|E
two-sum|Two Sum|E
group-anagrams|Group Anagrams|M
top-k-frequent-elements|Top K Frequent Elements|M
encode-and-decode-strings|Encode and Decode Strings|M
product-of-array-except-self|Product of Array Except Self|M
valid-sudoku|Valid Sudoku|M
longest-consecutive-sequence|Longest Consecutive Sequence|M
valid-palindrome|Valid Palindrome|E
two-sum-ii-input-array-is-sorted|Two Sum II - Input Array Is Sorted|M
3sum|3Sum|M
container-with-most-water|Container With Most Water|M
trapping-rain-water|Trapping Rain Water|H
best-time-to-buy-and-sell-stock|Best Time to Buy and Sell Stock|E
longest-substring-without-repeating-characters|Longest Substring Without Repeating Characters|M
longest-repeating-character-replacement|Longest Repeating Character Replacement|M
permutation-in-string|Permutation in String|M
minimum-window-substring|Minimum Window Substring|H
sliding-window-maximum|Sliding Window Maximum|H
valid-parentheses|Valid Parentheses|E
min-stack|Min Stack|M
evaluate-reverse-polish-notation|Evaluate Reverse Polish Notation|M
generate-parentheses|Generate Parentheses|M
daily-temperatures|Daily Temperatures|M
car-fleet|Car Fleet|M
largest-rectangle-in-histogram|Largest Rectangle in Histogram|H
binary-search|Binary Search|E
search-a-2d-matrix|Search a 2D Matrix|M
koko-eating-bananas|Koko Eating Bananas|M
find-minimum-in-rotated-sorted-array|Find Minimum in Rotated Sorted Array|M
search-in-rotated-sorted-array|Search in Rotated Sorted Array|M
time-based-key-value-store|Time Based Key-Value Store|M
median-of-two-sorted-arrays|Median of Two Sorted Arrays|H
reverse-linked-list|Reverse Linked List|E
merge-two-sorted-lists|Merge Two Sorted Lists|E
linked-list-cycle|Linked List Cycle|E
reorder-list|Reorder List|M
remove-nth-node-from-end-of-list|Remove Nth Node From End of List|M
copy-list-with-random-pointer|Copy List with Random Pointer|M
add-two-numbers|Add Two Numbers|M
find-the-duplicate-number|Find the Duplicate Number|M
lru-cache|LRU Cache|M
merge-k-sorted-lists|Merge k Sorted Lists|H
reverse-nodes-in-k-group|Reverse Nodes in k-Group|H
invert-binary-tree|Invert Binary Tree|E
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
construct-binary-tree-from-preorder-and-inorder-traversal|Construct Binary Tree from Preorder and Inorder Traversal|M
binary-tree-maximum-path-sum|Binary Tree Maximum Path Sum|H
serialize-and-deserialize-binary-tree|Serialize and Deserialize Binary Tree|H
kth-largest-element-in-a-stream|Kth Largest Element in a Stream|E
last-stone-weight|Last Stone Weight|E
k-closest-points-to-origin|K Closest Points to Origin|M
kth-largest-element-in-an-array|Kth Largest Element in an Array|M
task-scheduler|Task Scheduler|M
design-twitter|Design Twitter|M
find-median-from-data-stream|Find Median from Data Stream|H
subsets|Subsets|M
combination-sum|Combination Sum|M
permutations|Permutations|M
subsets-ii|Subsets II|M
combination-sum-ii|Combination Sum II|M
word-search|Word Search|M
palindrome-partitioning|Palindrome Partitioning|M
letter-combinations-of-a-phone-number|Letter Combinations of a Phone Number|M
n-queens|N-Queens|H
implement-trie-prefix-tree|Implement Trie (Prefix Tree)|M
design-add-and-search-words-data-structure|Design Add and Search Words Data Structure|M
word-search-ii|Word Search II|H
number-of-islands|Number of Islands|M
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
word-ladder|Word Ladder|H
reconstruct-itinerary|Reconstruct Itinerary|H
min-cost-to-connect-all-points|Min Cost to Connect All Points|M
network-delay-time|Network Delay Time|M
swim-in-rising-water|Swim in Rising Water|H
alien-dictionary|Alien Dictionary|H
cheapest-flights-within-k-stops|Cheapest Flights Within K Stops|M
climbing-stairs|Climbing Stairs|E
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
partition-equal-subset-sum|Partition Equal Subset Sum|M
unique-paths|Unique Paths|M
longest-common-subsequence|Longest Common Subsequence|M
best-time-to-buy-and-sell-stock-with-cooldown|Best Time to Buy and Sell Stock with Cooldown|M
coin-change-ii|Coin Change II|M
target-sum|Target Sum|M
interleaving-string|Interleaving String|M
longest-increasing-path-in-a-matrix|Longest Increasing Path in a Matrix|H
distinct-subsequences|Distinct Subsequences|H
edit-distance|Edit Distance|M
burst-balloons|Burst Balloons|H
regular-expression-matching|Regular Expression Matching|H
maximum-subarray|Maximum Subarray|M
jump-game|Jump Game|M
jump-game-ii|Jump Game II|M
gas-station|Gas Station|M
hand-of-straights|Hand of Straights|M
merge-triplets-to-form-target-triplet|Merge Triplets to Form Target Triplet|M
partition-labels|Partition Labels|M
valid-parenthesis-string|Valid Parenthesis String|M
insert-interval|Insert Interval|M
merge-intervals|Merge Intervals|M
non-overlapping-intervals|Non-overlapping Intervals|M
meeting-rooms|Meeting Rooms|E
meeting-rooms-ii|Meeting Rooms II|M
minimum-interval-to-include-each-query|Minimum Interval to Include Each Query|H
single-number|Single Number|E
number-of-1-bits|Number of 1 Bits|E
counting-bits|Counting Bits|E
reverse-bits|Reverse Bits|E
missing-number|Missing Number|E
sum-of-two-integers|Sum of Two Integers|M
reverse-integer|Reverse Integer|M
rotate-image|Rotate Image|M
spiral-matrix|Spiral Matrix|M
set-matrix-zeroes|Set Matrix Zeroes|M
happy-number|Happy Number|E
plus-one|Plus One|E
powx-n|Pow(x, n)|M
multiply-strings|Multiply Strings|M
detect-squares|Detect Squares|M

# Blind 75
combination-sum-iv|Combination Sum IV|M

# Grind 75
flood-fill|Flood Fill|E
implement-queue-using-stacks|Implement Queue using Stacks|E
first-bad-version|First Bad Version|E
ransom-note|Ransom Note|E
longest-palindrome|Longest Palindrome|E
majority-element|Majority Element|E
add-binary|Add Binary|E
middle-of-the-linked-list|Middle of the Linked List|E
01-matrix|01 Matrix|M
lowest-common-ancestor-of-a-binary-tree|Lowest Common Ancestor of a Binary Tree|M
accounts-merge|Accounts Merge|M
sort-colors|Sort Colors|M
string-to-integer-atoi|String to Integer (atoi)|M
find-all-anagrams-in-a-string|Find All Anagrams in a String|M
minimum-height-trees|Minimum Height Trees|M
basic-calculator|Basic Calculator|H
maximum-profit-in-job-scheduling|Maximum Profit in Job Scheduling|H

# Top Interview 150
merge-sorted-array|Merge Sorted Array|E
remove-element|Remove Element|E
remove-duplicates-from-sorted-array|Remove Duplicates from Sorted Array|E
remove-duplicates-from-sorted-array-ii|Remove Duplicates from Sorted Array II|M
rotate-array|Rotate Array|M
best-time-to-buy-and-sell-stock-ii|Best Time to Buy and Sell Stock II|M
h-index|H-Index|M
insert-delete-getrandom-o1|Insert Delete GetRandom O(1)|M
candy|Candy|H
roman-to-integer|Roman to Integer|E
integer-to-roman|Integer to Roman|M
length-of-last-word|Length of Last Word|E
longest-common-prefix|Longest Common Prefix|E
reverse-words-in-a-string|Reverse Words in a String|M
zigzag-conversion|Zigzag Conversion|M
find-the-index-of-the-first-occurrence-in-a-string|Find the Index of the First Occurrence in a String|E
text-justification|Text Justification|H
is-subsequence|Is Subsequence|E
minimum-size-subarray-sum|Minimum Size Subarray Sum|M
substring-with-concatenation-of-all-words|Substring with Concatenation of All Words|H
game-of-life|Game of Life|M
isomorphic-strings|Isomorphic Strings|E
word-pattern|Word Pattern|E
contains-duplicate-ii|Contains Duplicate II|E
summary-ranges|Summary Ranges|E
minimum-number-of-arrows-to-burst-balloons|Minimum Number of Arrows to Burst Balloons|M
simplify-path|Simplify Path|M
reverse-linked-list-ii|Reverse Linked List II|M
remove-duplicates-from-sorted-list-ii|Remove Duplicates from Sorted List II|M
rotate-list|Rotate List|M
partition-list|Partition List|M
symmetric-tree|Symmetric Tree|E
construct-binary-tree-from-inorder-and-postorder-traversal|Construct Binary Tree from Inorder and Postorder Traversal|M
populating-next-right-pointers-in-each-node-ii|Populating Next Right Pointers in Each Node II|M
flatten-binary-tree-to-linked-list|Flatten Binary Tree to Linked List|M
path-sum|Path Sum|E
sum-root-to-leaf-numbers|Sum Root to Leaf Numbers|M
binary-search-tree-iterator|Binary Search Tree Iterator|M
count-complete-tree-nodes|Count Complete Tree Nodes|M
average-of-levels-in-binary-tree|Average of Levels in Binary Tree|E
binary-tree-zigzag-level-order-traversal|Binary Tree Zigzag Level Order Traversal|M
minimum-absolute-difference-in-bst|Minimum Absolute Difference in BST|E
evaluate-division|Evaluate Division|M
snakes-and-ladders|Snakes and Ladders|M
minimum-genetic-mutation|Minimum Genetic Mutation|M
combinations|Combinations|M
n-queens-ii|N-Queens II|H
convert-sorted-array-to-binary-search-tree|Convert Sorted Array to Binary Search Tree|E
sort-list|Sort List|M
construct-quad-tree|Construct Quad Tree|M
maximum-sum-circular-subarray|Maximum Sum Circular Subarray|M
search-insert-position|Search Insert Position|E
find-peak-element|Find Peak Element|M
find-first-and-last-position-of-element-in-sorted-array|Find First and Last Position of Element in Sorted Array|M
ipo|IPO|H
find-k-pairs-with-smallest-sums|Find K Pairs with Smallest Sums|M
single-number-ii|Single Number II|M
bitwise-and-of-numbers-range|Bitwise AND of Numbers Range|M
palindrome-number|Palindrome Number|E
factorial-trailing-zeroes|Factorial Trailing Zeroes|M
sqrtx|Sqrt(x)|E
max-points-on-a-line|Max Points on a Line|H
triangle|Triangle|M
minimum-path-sum|Minimum Path Sum|M
unique-paths-ii|Unique Paths II|M
best-time-to-buy-and-sell-stock-iii|Best Time to Buy and Sell Stock III|H
best-time-to-buy-and-sell-stock-iv|Best Time to Buy and Sell Stock IV|H
maximal-square|Maximal Square|M

# SQL 50
recyclable-and-low-fat-products|Recyclable and Low Fat Products|E
find-customer-referee|Find Customer Referee|E
big-countries|Big Countries|E
article-views-i|Article Views I|E
invalid-tweets|Invalid Tweets|E
replace-employee-id-with-the-unique-identifier|Replace Employee ID With The Unique Identifier|E
product-sales-analysis-i|Product Sales Analysis I|E
customer-who-visited-but-did-not-make-any-transactions|Customer Who Visited but Did Not Make Any Transactions|E
rising-temperature|Rising Temperature|E
average-time-of-process-per-machine|Average Time of Process per Machine|E
employee-bonus|Employee Bonus|E
students-and-examinations|Students and Examinations|E
managers-with-at-least-5-direct-reports|Managers with at Least 5 Direct Reports|M
confirmation-rate|Confirmation Rate|M
not-boring-movies|Not Boring Movies|E
average-selling-price|Average Selling Price|E
project-employees-i|Project Employees I|E
percentage-of-users-attended-a-contest|Percentage of Users Attended a Contest|E
queries-quality-and-percentage|Queries Quality and Percentage|E
monthly-transactions-i|Monthly Transactions I|M
immediate-food-delivery-ii|Immediate Food Delivery II|M
game-play-analysis-iv|Game Play Analysis IV|M
number-of-unique-subjects-taught-by-each-teacher|Number of Unique Subjects Taught by Each Teacher|E
user-activity-for-the-past-30-days-i|User Activity for the Past 30 Days I|E
product-sales-analysis-iii|Product Sales Analysis III|M
classes-with-at-least-5-students|Classes With at Least 5 Students|E
find-followers-count|Find Followers Count|E
biggest-single-number|Biggest Single Number|E
customers-who-bought-all-products|Customers Who Bought All Products|M
the-number-of-employees-which-report-to-each-employee|The Number of Employees Which Report to Each Employee|E
primary-department-for-each-employee|Primary Department for Each Employee|E
triangle-judgement|Triangle Judgement|E
consecutive-numbers|Consecutive Numbers|M
product-price-at-a-given-date|Product Price at a Given Date|M
last-person-to-fit-in-the-bus|Last Person to Fit in the Bus|M
count-salary-categories|Count Salary Categories|M
employees-whose-manager-left-the-company|Employees Whose Manager Left the Company|E
exchange-seats|Exchange Seats|M
movie-rating|Movie Rating|M
restaurant-growth|Restaurant Growth|M
friend-requests-ii-who-has-the-most-friends|Friend Requests II: Who Has the Most Friends|M
investments-in-2016|Investments in 2016|M
department-top-three-salaries|Department Top Three Salaries|H
fix-names-in-a-table|Fix Names in a Table|E
patients-with-a-condition|Patients With a Condition|E
delete-duplicate-emails|Delete Duplicate Emails|E
second-highest-salary|Second Highest Salary|M
group-sold-products-by-the-date|Group Sold Products By The Date|E
list-the-products-ordered-in-a-period|List the Products Ordered in a Period|E
find-users-with-valid-e-mails|Find Users With Valid E-Mails|E
# Top 100 Liked
binary-tree-inorder-traversal|Binary Tree Inorder Traversal|E
path-sum-iii|Path Sum III|M
longest-valid-parentheses|Longest Valid Parentheses|H
pascals-triangle|Pascal's Triangle|E
perfect-squares|Perfect Squares|M
subarray-sum-equals-k|Subarray Sum Equals K|M
swap-nodes-in-pairs|Swap Nodes in Pairs|M
linked-list-cycle-ii|Linked List Cycle II|M
intersection-of-two-linked-lists|Intersection of Two Linked Lists|E
palindrome-linked-list|Palindrome Linked List|E
search-a-2d-matrix-ii|Search a 2D Matrix II|M
decode-string|Decode String|M
move-zeroes|Move Zeroes|E
next-permutation|Next Permutation|M
first-missing-positive|First Missing Positive|H
`;

function parse(source) {
  const out = new Map();
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [slug, title, d] = line.split('|');
    if (out.has(slug)) throw new Error(`catalog: ${slug} twice`);
    if (!DIFFICULTY[d]) throw new Error(`catalog: bad difficulty for ${slug}`);
    out.set(slug, Object.freeze({ slug, title, difficulty: DIFFICULTY[d] }));
  }
  return out;
}

// slug -> { slug, title, difficulty }, in the order above.
export const CATALOG = parse(SOURCE);

export function catalogEntry(slug) {
  return CATALOG.get(slug) || null;
}
