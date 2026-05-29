"""Typer entrypoint for the `codeclone` command."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from codeclone_config.logging import configure_logging
from codeclone_config.recipes import load_recipe, recipe_hash
from codeclone_config.settings import get_settings


app = typer.Typer(
    help="CodeClone: fine-tune a small code model on YOUR commit history.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


# ---------------- export ----------------


@app.command("export")
def export_cmd(
    user: str = typer.Option(..., help="GitHub username to export"),
    out: Path = typer.Option(Path("data/raw/pairs.jsonl"), help="Output JSONL path"),
    workspace: Path = typer.Option(Path("data/repos"), help="Where to clone repos"),
    include_forks: bool = typer.Option(False, help="Include forked repos"),
    max_repos: Optional[int] = typer.Option(None, help="Limit number of repos"),
    keep_clones: bool = typer.Option(False, help="Keep cloned repos on disk"),
    languages: str = typer.Option(
        "py,ts,js,go,rust,java", help="Comma-separated language tags"
    ),
    license_mode: str = typer.Option("permissive_only", help="strict | permissive_only | off"),
) -> None:
    """Walk authored commits and write (prefix, completion) JSONL."""
    from codeclone_exporter import AuthorFilter, Exporter, GitHubClient

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    if not settings.author_email:
        console.print("[red]AUTHOR_EMAIL is required in env or .env[/red]")
        raise typer.Exit(2)
    if not settings.github_token:
        console.print("[yellow]GITHUB_TOKEN not set; public repos only, low rate limit[/yellow]")

    author = AuthorFilter.from_strings(
        emails=settings.author_email_set(),
        usernames=[user],
    )
    langs = {l.strip().lower() for l in languages.split(",") if l.strip()}

    with GitHubClient(token=settings.github_token) as gh:
        exporter = Exporter(
            author=author,
            workspace=workspace,
            out_path=out,
            languages=langs,
            license_mode=license_mode,
            include_forks=include_forks,
            max_repos=max_repos,
            keep_clones=keep_clones,
        )
        result = exporter.run(user=user, client=gh)

    table = Table(title="Export summary", show_header=True)
    table.add_column("metric")
    table.add_column("value", justify="right")
    table.add_row("repos", str(result.n_repos))
    table.add_row("commits", str(result.n_commits))
    table.add_row("pairs", str(result.n_pairs))
    table.add_row("skipped repos", str(len(result.skipped_repos)))
    console.print(table)
    console.print(f"[green]wrote[/green] {result.out_path}")
    console.print_json(json.dumps({"by_language": result.by_language}))


# ---------------- preprocess ----------------


@app.command("preprocess")
def preprocess_cmd(
    raw: Path = typer.Option(Path("data/raw/pairs.jsonl"), "--in", help="Input JSONL"),
    out: Path = typer.Option(Path("data/processed"), help="Output directory"),
    recipe: Path = typer.Option(Path("recipes/small.yaml"), help="Recipe YAML"),
) -> None:
    """Normalize, filter, dedupe, split."""
    from codeclone_preprocess import Preprocessor

    r = load_recipe(recipe)
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    pp = Preprocessor(recipe=r)
    result = pp.run(raw, out)

    table = Table(title="Preprocess summary")
    table.add_column("split")
    table.add_column("count", justify="right")
    for split, n in result.counts.items():
        table.add_row(split, str(n))
    table.add_row("dropped (filter)", str(result.filter_report.total_dropped()))
    table.add_row("dropped (dedupe)", str(result.dedupe_dropped))
    console.print(table)
    console.print(f"[green]wrote[/green] {result.out_dir}")


# ---------------- train ----------------


@app.command("train")
def train_cmd(
    recipe: Path = typer.Option(..., help="Recipe YAML"),
    data: Path = typer.Option(Path("data/processed"), help="Processed data dir"),
    out: Path = typer.Option(Path("adapters/adapter-v1"), help="Adapter output dir"),
    backend: str = typer.Option("auto", help="auto | mlx | peft"),
    name: Optional[str] = typer.Option(None, help="Adapter name (default = out folder name)"),
) -> None:
    """Run a LoRA fine-tune end-to-end."""
    from codeclone_trainer import Trainer

    r = load_recipe(recipe)
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    adapter_name = name or out.name
    trainer = Trainer(
        recipe=r,
        adapter_name=adapter_name,
        adapters_root=out.parent,
        runs_root=settings.runs_dir,
    )
    train_jsonl = data / "train.jsonl"
    val_jsonl = data / "val.jsonl"
    if not train_jsonl.exists():
        console.print(f"[red]missing[/red] {train_jsonl}")
        raise typer.Exit(2)
    result = trainer.run(train_jsonl, val_jsonl if val_jsonl.exists() else None, backend_name=backend)
    console.print_json(json.dumps(result.to_dict()))


# ---------------- eval ----------------


@app.command("eval")
def eval_cmd(
    model: Path = typer.Option(..., help="Adapter directory"),
    data: Path = typer.Option(Path("data/processed/test.jsonl"), help="Test JSONL"),
    out: Path = typer.Option(Path("runs/eval"), help="Report directory"),
    n_samples: int = typer.Option(4, help="Number of qualitative samples"),
    max_problems: int = typer.Option(8, help="Max mini-suite problems"),
) -> None:
    """Evaluate an adapter."""
    from codeclone_eval import EvalRunner
    from codeclone_serve.model_handle import load_handle

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    handle = load_handle(model)
    runner = EvalRunner(
        model_name=model.name,
        completer=lambda prefix: handle.generate(prefix, max_tokens=256),
    )
    result = runner.run(data, out, n_samples=n_samples, max_problems=max_problems)
    table = Table(title=f"Eval: {model.name}")
    table.add_column("metric")
    table.add_column("value", justify="right")
    if result.perplexity:
        table.add_row("perplexity", f"{result.perplexity.perplexity:.3f}")
        table.add_row("perplexity proxy?", "yes" if result.perplexity.proxy else "no")
    table.add_row("mini pass rate", f"{result.mini_pass_rate:.2%}")
    console.print(table)


# ---------------- serve ----------------


@app.command("serve")
def serve_cmd(
    model: Optional[Path] = typer.Option(None, help="Adapter directory (optional)"),
    host: str = typer.Option("127.0.0.1", help="Bind host"),
    port: int = typer.Option(7461, help="Bind port"),
    reload: bool = typer.Option(False, help="Auto-reload (dev only)"),
) -> None:
    """Run the OpenAI-compatible API server."""
    import uvicorn

    from codeclone_serve.app import create_app

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    app_ = create_app(model_dir=model)
    console.print(f"[green]serving[/green] {host}:{port} (model={model or 'mock'})")
    uvicorn.run(app_, host=host, port=port, reload=reload, log_level=settings.log_level.lower())


# ---------------- models ----------------


models_app = typer.Typer(help="Inspect adapter registry")
app.add_typer(models_app, name="models")


@models_app.command("list")
def models_list(adapters_dir: Path = typer.Option(Path("adapters"))) -> None:
    from codeclone_models.registry import CheckpointRegistry

    reg = CheckpointRegistry(adapters_dir)
    rows = reg.list()
    table = Table(title="Adapters")
    for col in ("name", "base", "backend", "recipe_hash", "created_at", "loss"):
        table.add_column(col)
    for m in rows:
        table.add_row(
            m.name,
            m.base_model,
            m.backend,
            m.recipe_hash,
            m.created_at,
            f"{m.final_train_loss:.3f}" if m.final_train_loss is not None else "-",
        )
    console.print(table)


@models_app.command("show")
def models_show(name: str, adapters_dir: Path = typer.Option(Path("adapters"))) -> None:
    from codeclone_models.registry import CheckpointRegistry

    reg = CheckpointRegistry(adapters_dir)
    m = reg.get(name)
    if not m:
        console.print(f"[red]not found:[/red] {name}")
        raise typer.Exit(2)
    console.print_json(json.dumps(m.to_dict(), indent=2))


@models_app.command("hash-recipe")
def hash_recipe(recipe: Path) -> None:
    r = load_recipe(recipe)
    console.print(recipe_hash(r))


def main() -> None:
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
