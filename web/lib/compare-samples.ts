/**
 * Built-in sample pairs for the /compare page.
 * Real code, no Lorem. Chosen to span the score range:
 *   near-duplicate (rename only), partial overlap (same algo, different style),
 *   distinct (unrelated function with shared vocabulary).
 */

export interface CompareSample {
  id: string;
  title: string;
  hint: string;
  language: string;
  a: string;
  b: string;
}

export const COMPARE_SAMPLES: CompareSample[] = [
  {
    id: "rename",
    title: "Renamed variables",
    hint: "Two-sum, identifier renames only. Expect near-duplicate.",
    language: "python",
    a: `def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        complement = target - n
        if complement in seen:
            return [seen[complement], i]
        seen[n] = i
    return None
`,
    b: `def find_pair(values, goal):
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
    id: "restyle",
    title: "Same algorithm, different style",
    hint: "Iterative vs functional Fibonacci. Expect partial overlap.",
    language: "python",
    a: `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
`,
    b: `from functools import reduce

def fib(n):
    return reduce(lambda acc, _: (acc[1], acc[0] + acc[1]), range(n), (0, 1))[0]
`,
  },
  {
    id: "distinct",
    title: "Distinct functions, shared vocabulary",
    hint: "Different problems that both use 'for', 'range', 'return'. Expect low score.",
    language: "python",
    a: `def is_prime(n):
    if n < 2:
        return False
    for d in range(2, int(n ** 0.5) + 1):
        if n % d == 0:
            return False
    return True
`,
    b: `def reverse_words(sentence):
    parts = sentence.strip().split()
    out = []
    for word in reversed(parts):
        out.append(word)
    return " ".join(out)
`,
  },
];

export const COMPARE_LANGUAGES = [
  "auto", "python", "typescript", "javascript", "go", "rust", "java", "c", "cpp", "ruby", "shell",
];
