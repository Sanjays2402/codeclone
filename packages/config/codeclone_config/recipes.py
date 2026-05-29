"""Recipe loader. YAML in, validated pydantic models out, deterministic hash."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator


LanguageTag = Literal["py", "ts", "js", "go", "rust", "java", "tsx", "jsx"]


class RecipeSafety(BaseModel):
    require_author_match: bool = True
    skip_merge_commits: bool = True
    skip_reverts: bool = True
    license_filter: Literal["strict", "permissive_only", "off"] = "permissive_only"
    min_commit_age_days: int = 0
    max_files_per_commit: int = 64
    max_diff_lines: int = 4000
    drop_secret_lines: bool = True


class RecipeData(BaseModel):
    languages: list[LanguageTag] = Field(default_factory=lambda: ["py", "ts", "js", "go", "rust", "java"])
    min_lines: int = 3
    max_lines: int = 600
    dedupe: Literal["exact", "minhash", "off"] = "exact"
    train_split: float = 0.9
    val_split: float = 0.05
    test_split: float = 0.05
    shuffle_seed: int = 42

    @field_validator("train_split", "val_split", "test_split")
    @classmethod
    def _frac(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("split fractions must be in [0,1]")
        return v


class RecipeModel(BaseModel):
    base: str = "Qwen/Qwen2.5-Coder-1.5B"
    tokenizer: str | None = None
    context_length: int = 2048
    lora_rank: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    lora_target_modules: list[str] = Field(
        default_factory=lambda: ["q_proj", "k_proj", "v_proj", "o_proj"]
    )


class RecipeTrain(BaseModel):
    backend: Literal["auto", "mlx", "peft"] = "auto"
    batch_size: int = 4
    grad_accum: int = 1
    learning_rate: float = 2e-4
    warmup_steps: int = 20
    max_steps: int = 1000
    eval_every: int = 100
    save_every: int = 200
    seed: int = 1337
    bf16: bool = True
    gradient_checkpointing: bool = True


class RecipeEval(BaseModel):
    perplexity: bool = True
    mini_humaneval: bool = True
    sample_completions: int = 4
    max_problems: int = 32


class Recipe(BaseModel):
    name: str
    description: str = ""
    safety: RecipeSafety = Field(default_factory=RecipeSafety)
    data: RecipeData = Field(default_factory=RecipeData)
    model: RecipeModel = Field(default_factory=RecipeModel)
    train: RecipeTrain = Field(default_factory=RecipeTrain)
    eval: RecipeEval = Field(default_factory=RecipeEval)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


def load_recipe(path: str | Path) -> Recipe:
    """Load a YAML recipe and validate it."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"recipe not found: {p}")
    with p.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"recipe file must be a YAML mapping: {p}")
    return Recipe.model_validate(raw)


def recipe_hash(recipe: Recipe) -> str:
    """Stable SHA256 prefix over the canonicalized recipe.

    Used as part of run/adapter IDs for reproducibility tracking.
    """
    payload = json.dumps(recipe.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]
