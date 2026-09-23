"""GET /fonts — lists font packs under backend/fonts/ for the popup's font
picker (see pipeline/wrapper.py:_resolve_font_dir, which reads the same
folder by name). No ML/network needed; uses a temp fonts directory so it
doesn't depend on what's actually installed in this checkout."""
from fastapi.testclient import TestClient

import main
from config import settings

client = TestClient(main.app, raise_server_exceptions=False)


def test_lists_only_directories_that_actually_contain_font_files(tmp_path, monkeypatch):
    (tmp_path / "Roboto").mkdir()
    (tmp_path / "Roboto" / "Roboto-Regular.ttf").write_bytes(b"")
    (tmp_path / "Noto Sans SC").mkdir()
    (tmp_path / "Noto Sans SC" / "NotoSansSC-Regular.otf").write_bytes(b"")
    (tmp_path / "empty-pack").mkdir()  # dropped in but no font files yet — not usable
    (tmp_path / "place_font_packs_here.txt").write_text("")  # a stray file, not a directory

    monkeypatch.setattr(settings, "fonts_base_dir", tmp_path)
    resp = client.get("/fonts")
    assert resp.status_code == 200
    assert resp.json() == {"fonts": ["Noto Sans SC", "Roboto"]}


def test_missing_fonts_directory_returns_an_empty_list(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "fonts_base_dir", tmp_path / "does-not-exist")
    assert client.get("/fonts").json() == {"fonts": []}
