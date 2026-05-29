# Recipes

A recipe is a YAML file that fully describes a training run: which base
model, what LoRA shape, which data filters, which split fractions, which
optimizer settings, and which evals to run after. The recipe is hashed
(`packages/config/codeclone_config/recipes.py:recipe_hash`) and the hash is
stored in the run directory and the checkpoint metadata. Two runs with the
same recipe hash should be byte-for-byte close (modulo wall-clock noise).

## Presets

The four bundled recipes are positions on a single dial:

- `quick.yaml` is for "did anything break?". 200 steps, LoRA rank 8, 1024
  context, one base model. Runs in roughly ten minutes on M-series.
- `small.yaml` is the daily-driver. 1000 steps, rank 16, 2048 context,
  Qwen2.5-Coder-1.5B. Roughly one hour on M-series 16-32GB.
- `standard.yaml` widens the target module set and bumps the base to 3B.
  Three hours on M-series 32GB+. Use this once you have a stable export.
- `full.yaml` is overnight / CUDA. 8000 steps, rank 64, MinHash dedupe,
  full target module set. Use this for the model you want to actually use.

## Anatomy

```yaml
name: small                  # human label; appears in registry tags
description: ...             # one-liner for humans

safety:                       # author filter, license filter, secret scrub
  require_author_match: true
  license_filter: permissive_only
  drop_secret_lines: true
  ...

data:                         # which rows land in the training set
  languages: [py, ts, js, ...]
  min_lines: 3
  max_lines: 500
  dedupe: exact               # exact | minhash | off
  train_split: 0.9            # must sum to ~1.0 with val/test
  val_split: 0.05
  test_split: 0.05
  shuffle_seed: 42

model:                        # what we're adapting
  base: Qwen/Qwen2.5-Coder-1.5B
  context_length: 2048
  lora_rank: 16
  lora_alpha: 32
  lora_dropout: 0.05
  lora_target_modules: [q_proj, k_proj, v_proj, o_proj]

train:                        # how we're adapting it
  backend: auto               # auto | mlx | peft
  batch_size: 4
  grad_accum: 1
  learning_rate: 2.0e-4
  warmup_steps: 20
  max_steps: 1000
  eval_every: 100
  save_every: 200
  seed: 1337
  bf16: true
  gradient_checkpointing: true

eval:                         # what we compute after
  perplexity: true
  mini_humaneval: true
  sample_completions: 4
  max_problems: 16
```

## Hashing

```bash
codeclone models hash-recipe recipes/small.yaml
```

prints the 16-char hex prefix used in checkpoint and run IDs.

## Composing your own

Copy `recipes/small.yaml` and edit. The schema is enforced by
`Recipe.model_validate`, so a typo will fail loudly with a useful pointer.
There is no "merge with default" pass; what you write is what you get.
