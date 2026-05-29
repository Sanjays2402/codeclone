"""Integration test for `codeclone models` CLI flow against a temp registry."""

import json
from pathlib import Path

from codeclone_models.registry import CheckpointMeta, CheckpointRegistry


def test_registry_index_is_consistent_with_files(tmp_path: Path):
    reg = CheckpointRegistry(tmp_path)
    for i in range(5):
        reg.register(
            CheckpointMeta(
                name=f"adapter-{i}",
                base_model="Qwen/Qwen2.5-Coder-1.5B",
                backend="mlx",
                recipe_hash=f"hash{i:04d}",
                created_at=CheckpointRegistry.now_iso(),
                final_train_loss=1.0 - i * 0.1,
                seed=1337 + i,
                tags=[f"v{i}"],
            )
        )
    idx = json.loads((tmp_path / "index.json").read_text())
    assert len(idx) == 5
    listed = reg.list()
    names = {m.name for m in listed}
    assert names == {f"adapter-{i}" for i in range(5)}
    # Filesystem reflects each adapter dir.
    for i in range(5):
        assert (tmp_path / f"adapter-{i}" / "meta.json").exists()


def test_registry_recovers_missing_index(tmp_path: Path):
    reg = CheckpointRegistry(tmp_path)
    reg.register(
        CheckpointMeta(
            name="solo",
            base_model="x",
            backend="peft",
            recipe_hash="abc",
            created_at=CheckpointRegistry.now_iso(),
        )
    )
    # Nuke the index; ensure list() still finds the adapter via FS walk.
    (tmp_path / "index.json").unlink()
    listed = reg.list()
    assert [m.name for m in listed] == ["solo"]
