# Glossary

Short definitions of terms that appear across docs and code.

**Adapter.** A LoRA delta over a base model's attention (and optionally MLP)
weights. Stored in `adapters/<name>/` with a `meta.json`.

**Author filter.** The exporter's safety check that only the configured
user's commits land in the dataset. Implemented in
`services/exporter/codeclone_exporter/author.py`.

**Backend.** One of `mlx`, `peft`. Selected by `Settings.resolve_backend()`
unless a recipe or CLI flag overrides.

**Base model.** The frozen transformer weights the LoRA adapter is trained
against. Default: `Qwen/Qwen2.5-Coder-1.5B`.

**Checkpoint.** Synonym for adapter in this codebase.

**FIM (Fill-in-the-Middle).** A completion shape where the model sees a
prefix and a suffix and is asked to produce the middle. Used by IDE
autocomplete.

**HumanEval mini.** A small in-process Python sandbox suite (8 problems)
used by `services/eval`. Not the canonical 164-problem HumanEval.

**MinHash dedupe.** Locality-sensitive hashing for near-duplicate text
detection. Used by `data.dedupe: minhash`.

**Pair.** A row in the training dataset: `(prefix, completion)` with
provenance. Schema: `packages/dataset/codeclone_dataset/pairs.py`.

**Recipe.** A YAML file describing safety, data, model, train, and eval
settings for a single run. Hashed for reproducibility.

**Run.** One invocation of `codeclone train`. Output lands under
`runs/<utc-timestamp>-<recipe-hash>/`.

**Serve.** The OpenAI-compatible FastAPI endpoint on `:7461`.
