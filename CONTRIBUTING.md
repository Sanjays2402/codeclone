# Contributing

Thank you for considering a contribution. CodeClone is a small project with
a deliberately small surface area; the bar for accepting changes is:

1. The change is in scope (see `docs/architecture.md`).
2. There is at least one test that fails before your change and passes after.
3. `pytest -q` and `ruff check .` are clean.
4. New surface includes a doc paragraph or README update.

## Getting set up

```bash
git clone https://github.com/Sanjays2402/codeclone
cd codeclone
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
pytest -q
```

## Pull requests

- Branch off `main`.
- Keep PRs small. One concept per PR. Reviewers will reject grab-bags.
- Use conventional-ish commit messages (`feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`). The CI workflow does not enforce this; humans will.
- Do not commit secrets, tokens, model weights, or training data.

## Style

- Python: ruff defaults plus the project ruleset in `pyproject.toml`.
- TypeScript: the Next.js eslint preset.
- Line length: soft 100 chars, never above 120.
- Public functions get a one-line docstring; non-obvious internal functions
  get a short comment. No vibe-coded explanations.

## What's out of scope

- New model families (you can configure any HF base; we do not maintain a
  registry of them).
- Multi-user serve, tenancy, billing, dashboards beyond `web/`.
- A "GUI" for fine-tuning. The CLI is the surface.

If you are unsure, open a draft issue first.
