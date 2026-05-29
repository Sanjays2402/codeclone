from pathlib import Path

from codeclone_config.recipes import load_recipe
from codeclone_dataset.pairs import Pair, write_pairs
from codeclone_trainer import Trainer
from codeclone_trainer.data_loader import JsonlPairLoader


def _mk(idx):
    return Pair(
        id=str(idx),
        language="py",
        prefix="# header\n",
        completion=f"def f{idx}():\n    return {idx}\n",
        repo="me/r",
        commit_sha="0" * 40,
        path="a.py",
        author_email_hash="deadbeefdeadbeef",
    )


def test_data_loader_batches(tmp_path: Path):
    p = tmp_path / "t.jsonl"
    write_pairs(p, [_mk(i) for i in range(10)])
    loader = JsonlPairLoader(path=p, batch_size=3)
    batches = list(loader.iter_batches())
    sizes = [len(b.inputs) for b in batches]
    assert sum(sizes) == 10
    assert max(sizes) == 3


def test_trainer_smoke(tmp_path: Path, recipes_dir):
    recipe = load_recipe(recipes_dir / "quick.yaml")
    # Shrink to a true smoke loop.
    recipe.train.max_steps = 5
    raw = tmp_path / "train.jsonl"
    write_pairs(raw, [_mk(i) for i in range(8)])
    trainer = Trainer(
        recipe=recipe,
        adapter_name="smoke-adapter",
        adapters_root=tmp_path / "adapters",
        runs_root=tmp_path / "runs",
    )
    result = trainer.run(raw, val_jsonl=None, backend_name="mlx")
    assert result.n_steps == 5
    assert result.adapter_dir.exists()
    assert (result.adapter_dir / "adapter_config.json").exists()
    assert (result.adapter_dir / "meta.json").exists()
    assert (result.run_dir / "metrics.jsonl").exists()
