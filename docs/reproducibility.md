# Reproducibility

CodeClone aims for "you can re-derive the same adapter from the same inputs
on the same hardware". Three pillars:

1. **Deterministic recipe hashing.** Every YAML recipe is canonicalized and
   SHA256'd. The first 16 hex chars of that hash land in:
   - the run ID (`runs/<utc-timestamp>-<recipehash>/`)
   - the adapter `meta.json`
   - the registry `index.json`
2. **Seeded randomness.** Three seeds, all controllable:
   - `data.shuffle_seed` (recipe) → train/val/test split + within-split order
   - `train.seed` (recipe) → backend PRNG + mock trainer noise
   - the loader's `JsonlPairLoader.seed` (defaults to `train.seed`)
3. **Deterministic data split.** `deterministic_split` shuffles by index
   buckets then partitions, never by float boundary, so a row's split
   placement is a function of `(index, seed)` only.

## What this guarantees

- Given the same `data/raw/pairs.jsonl` and the same recipe, you will get
  the same `train.jsonl`, `val.jsonl`, `test.jsonl` (byte-for-byte).
- Given the same train file, recipe, seed, and backend mock path, you will
  get the same training metrics curve.

## What this does NOT guarantee

- Cross-backend reproducibility. MLX and PEFT will diverge on the same
  recipe; they should agree on the *shape* of the loss curve, not the values.
- Cross-hardware reproducibility for real GPU runs. CUDA non-determinism
  (atomic adds, cuBLAS heuristics) means even seeded PEFT runs can drift on
  different GPUs. We do not attempt to force `torch.use_deterministic_algorithms`.
- Cross-base-model-version reproducibility. If Hugging Face publishes a new
  revision of the base, you must pin a revision to keep results stable.

## Pinning the base model revision

Recipes accept `model.base` as a free-form HF id; you can append `@<revision>`
to pin:

```yaml
model:
  base: Qwen/Qwen2.5-Coder-1.5B@a1b2c3d4
```

The loader passes this through to `from_pretrained(revision=...)`.

## Re-running an old experiment

Every checkpoint stores its recipe hash. To rebuild a checkpoint:

```bash
codeclone models show me-v1 | jq -r .extra.run_id
cat runs/<run_id>/params.json | jq .recipe > /tmp/recipe.yaml
codeclone train --recipe /tmp/recipe.yaml --data data/processed \
                --out adapters/me-v1-replay
diff <(jq -S . adapters/me-v1/meta.json | grep -v created_at) \
     <(jq -S . adapters/me-v1-replay/meta.json | grep -v created_at)
```

The two `meta.json`s should match on every field except timestamps and the
adapter name.
