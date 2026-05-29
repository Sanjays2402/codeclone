# Backends

CodeClone trains via one of two backends, both of which are optional installs.

## Selection

```
recipe.train.backend (yaml)  >  CLI --backend flag  >  CODECLONE_BACKEND env  >  auto
```

`auto` resolves to:

- `mlx` on Darwin/arm64
- `peft` everywhere else

## MLX (Apple Silicon)

- Install: `uv pip install -e ".[mlx]"`
- Requires Apple Silicon and recent macOS.
- Uses `mlx_lm.lora` under the hood.
- Memory tip: drop `model.context_length` to 1024 if you OOM on a 16 GB
  machine.

If `mlx_lm` is not importable, the trainer silently falls back to the mock
loop (deterministic decreasing-loss curve). This means the full pipeline
remains testable on any machine.

## PEFT (CUDA / CPU)

- Install: `uv pip install -e ".[cuda]"` (works on CPU too, just slower).
- Uses `peft.get_peft_model(transformers_model, LoraConfig(...))` and a
  hand-rolled step loop. Optimizer is AdamW. We do not call `transformers.Trainer`
  because we want a streaming metrics contract.
- `bitsandbytes` is included as an extras dep for non-Darwin so 4/8-bit
  quantization is one config away. We do not enable it by default.

Same mock fallback applies if `peft`/`transformers` are absent.

## What both backends share

- The `TrainBackend` protocol (`services/trainer/codeclone_trainer/backends/base.py`).
- `prepare(base_model, lora_config, train_config)` set up once.
- `train(batches, max_steps, ...)` yields `StepMetrics` per step.
- `save_adapter(out_dir)` writes the LoRA delta + `adapter_config.json`.

This keeps the rest of the trainer (loader, run log, registry write,
eval handoff) backend-agnostic.

## Future backends

Adding a backend means: implement the protocol, name yourself in
`driver._pick_backend`, and ship a small mock fallback. Open an issue first;
the bar is "do you have a real user".
