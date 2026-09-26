"""Download visibility (core/ml/download_status.py): ModelManager registers
every weight download, and GET /health lists the active ones so the extension
can tell the user why a first translation is slow."""
import threading
from pathlib import Path

from fastapi.testclient import TestClient

import core.ml.model_manager as mm
import main
from core.ml.download_status import active_downloads, track_download

client = TestClient(main.app, raise_server_exceptions=False)


def test_known_repos_get_a_friendly_name_and_size_and_unknown_ones_only_a_name():
    with track_download("PaddlePaddle/PaddleOCR-VL-1.5"), track_download("someone/else"):
        rows = {r["name"]: r for r in active_downloads()}
    assert rows["PaddleOCR-VL"]["approx_mb"] == 1930
    assert rows["someone/else"]["approx_mb"] is None
    assert all(isinstance(r["elapsed_seconds"], int) for r in rows.values())
    assert active_downloads() == []  # cleared when the block exits


def test_is_cleared_even_when_the_download_fails():
    try:
        with track_download("x/y"):
            raise RuntimeError("network down")
    except RuntimeError:
        pass
    assert active_downloads() == []


def test_two_threads_downloading_the_same_model_show_once_until_both_finish():
    inside, release = threading.Event(), threading.Event()
    second_in = threading.Event()

    def worker(signal):
        with track_download("kha-white/manga-ocr-base"):
            signal.set()
            release.wait(5)

    t1 = threading.Thread(target=worker, args=(inside,))
    t2 = threading.Thread(target=worker, args=(second_in,))
    t1.start(); inside.wait(5)
    t2.start(); second_in.wait(5)
    assert [r["name"] for r in active_downloads()] == ["manga-ocr"]
    release.set()
    t1.join(5); t2.join(5)
    assert active_downloads() == []


def test_hf_file_download_is_tracked_while_it_runs(monkeypatch, tmp_path: Path):
    seen = []

    def fake_hf_hub_download(repo_id, filename, local_dir, token):
        seen.append([r["name"] for r in active_downloads()])
        target = Path(local_dir) / filename
        target.write_bytes(b"weights")
        return str(target)

    monkeypatch.setattr(mm, "hf_hub_download", fake_hf_hub_download)
    manager = mm.ModelManager.__new__(mm.ModelManager)
    manager.hf_token = None
    manager._ensure_hf_file("JosephCatrambone/big-lama-torchscript", "lama.pt", tmp_path / "lama.pt")
    assert seen == [["LaMa inpainting"]]
    assert active_downloads() == []


def test_hf_repo_download_is_tracked_and_cleared_on_failure(monkeypatch, tmp_path: Path):
    def boom(**kwargs):
        assert [r["name"] for r in active_downloads()] == ["PaddleOCR-VL"]
        raise OSError("connection reset")

    monkeypatch.setattr(mm, "snapshot_download", boom)
    monkeypatch.setattr(mm, "_models_dir", lambda: tmp_path)
    manager = mm.ModelManager.__new__(mm.ModelManager)
    manager.hf_token = None
    try:
        manager._ensure_hf_repo("PaddlePaddle/PaddleOCR-VL-1.5", tmp_path / "paddle")
    except Exception as e:  # ModelError
        assert "PaddleOCR-VL-1.5" in str(e)
    else:
        raise AssertionError("expected the failed download to raise")
    assert active_downloads() == []


def test_health_lists_active_downloads_and_is_never_gated():
    assert client.get("/health").json()["downloads"] == []
    with track_download("JosephCatrambone/big-lama-torchscript"):
        body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["downloads"][0]["name"] == "LaMa inpainting"
    assert body["downloads"][0]["approx_mb"] == 206
