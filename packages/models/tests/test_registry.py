from pathlib import Path

from codeclone_models.registry import CheckpointRegistry, CheckpointMeta


def test_register_list_get(tmp_path: Path):
    reg = CheckpointRegistry(tmp_path / "adapters")
    meta = CheckpointMeta(
        name="sanjay-v1",
        base_model="Qwen/Qwen2.5-Coder-1.5B",
        backend="mlx",
        recipe_hash="abc123",
        created_at=CheckpointRegistry.now_iso(),
        final_train_loss=0.42,
    )
    reg.register(meta)
    listing = reg.list()
    assert any(m.name == "sanjay-v1" for m in listing)
    got = reg.get("sanjay-v1")
    assert got is not None and got.final_train_loss == 0.42


def test_update_and_delete(tmp_path: Path):
    reg = CheckpointRegistry(tmp_path / "adapters")
    reg.register(
        CheckpointMeta(
            name="a", base_model="b", backend="mlx", recipe_hash="h",
            created_at=CheckpointRegistry.now_iso(),
        )
    )
    updated = reg.update("a", tags=["small"])
    assert updated.tags == ["small"]
    assert reg.delete("a")
    assert reg.get("a") is None
