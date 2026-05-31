/**
 * Built-in sample snippet sets for the /batch page.
 *
 * Real code, no placeholders. Chosen to expose clear clusters in the
 * NxN similarity matrix: a few near-duplicates, a few same-intent
 * variants, and at least one unrelated function so the heatmap has
 * structure a first-time viewer can read at a glance.
 */

export interface BatchSnippet {
  id: string;
  label: string;
  code: string;
}

export interface BatchSampleSet {
  id: string;
  title: string;
  hint: string;
  language: string;
  snippets: BatchSnippet[];
}

export const BATCH_SAMPLES: BatchSampleSet[] = [
  {
    id: "two-sum-cluster",
    title: "Two-sum family + an outlier",
    hint: "Three two-sum variants (rename, restyle, brute-force) and a string reverser. Expect one dense cluster.",
    language: "python",
    snippets: [
      {
        id: "ts_dict",
        label: "two_sum · dict, original",
        code: `def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        complement = target - n
        if complement in seen:
            return [seen[complement], i]
        seen[n] = i
    return None
`,
      },
      {
        id: "ts_renamed",
        label: "find_pair · renamed identifiers",
        code: `def find_pair(values, goal):
    cache = {}
    for idx, v in enumerate(values):
        diff = goal - v
        if diff in cache:
            return [cache[diff], idx]
        cache[v] = idx
    return None
`,
      },
      {
        id: "ts_restyled",
        label: "two_sum · single-pass restyled",
        code: `def two_sum(arr, t):
    table = dict()
    for position, value in enumerate(arr):
        need = t - value
        if need in table:
            return (table[need], position)
        table[value] = position
`,
      },
      {
        id: "ts_brute",
        label: "two_sum · O(n^2) brute force",
        code: `def two_sum_brute(nums, target):
    n = len(nums)
    for i in range(n):
        for j in range(i + 1, n):
            if nums[i] + nums[j] == target:
                return [i, j]
    return None
`,
      },
      {
        id: "reverse_str",
        label: "reverse_string · unrelated",
        code: `def reverse_string(s):
    chars = list(s)
    left, right = 0, len(chars) - 1
    while left < right:
        chars[left], chars[right] = chars[right], chars[left]
        left += 1
        right -= 1
    return "".join(chars)
`,
      },
    ],
  },
  {
    id: "fib-cluster",
    title: "Fibonacci variants",
    hint: "Iterative, recursive, memoized, generator. Same intent, different shape.",
    language: "python",
    snippets: [
      {
        id: "fib_iter",
        label: "fib · iterative",
        code: `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
`,
      },
      {
        id: "fib_rec",
        label: "fib · naive recursive",
        code: `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
`,
      },
      {
        id: "fib_memo",
        label: "fib · memoized",
        code: `def fib(n, cache={0: 0, 1: 1}):
    if n in cache:
        return cache[n]
    cache[n] = fib(n - 1, cache) + fib(n - 2, cache)
    return cache[n]
`,
      },
      {
        id: "fib_gen",
        label: "fib · generator stream",
        code: `def fib_stream():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b
`,
      },
      {
        id: "sum_digits",
        label: "sum_digits · unrelated",
        code: `def sum_digits(n):
    total = 0
    while n > 0:
        total += n % 10
        n //= 10
    return total
`,
      },
    ],
  },
];
