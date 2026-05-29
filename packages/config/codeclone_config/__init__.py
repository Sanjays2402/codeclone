"""CodeClone configuration package.

Pydantic-settings driven, environment-first. Single source of truth for
runtime knobs across exporter, preprocess, trainer, eval, and serve.
"""

from .settings import Settings, get_settings
from .recipes import (
    Recipe,
    RecipeSafety,
    RecipeData,
    RecipeModel,
    RecipeTrain,
    RecipeEval,
    load_recipe,
    recipe_hash,
)

__all__ = [
    "Settings",
    "get_settings",
    "Recipe",
    "RecipeSafety",
    "RecipeData",
    "RecipeModel",
    "RecipeTrain",
    "RecipeEval",
    "load_recipe",
    "recipe_hash",
]

__version__ = "0.1.0"
