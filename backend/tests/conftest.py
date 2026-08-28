import sys
from pathlib import Path

# Every module under backend/ imports with bare names ("from core.config
# import ...", not "from backend.core.config import ..."), matching how
# main.py is actually run (`cd backend && python main.py`). Insert the
# backend/ directory itself onto sys.path so tests work the same way
# regardless of where `pytest` is invoked from.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest

# core/__init__.py eagerly imports the full pipeline (detection/cleaning/
# translation/rendering), which pulls in torch/ultralytics/etc. Import it
# once here, at collection time, so every test file can freely import
# leaf modules (core.config, core.services.translation, ...) without
# hitting that heavy import machinery mid-test or triggering circular-
# import ordering issues (see the session's own manual test scripts,
# which needed the same "import core.config first" warm-up).
import core.config  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_rotation_state():
    """The rate-limit cooldown map and round-robin cursor are process-
    lifetime module globals in core.services.translation, by design (see
    that module's own comments) — reset them before every test so one
    test's rate-limit/rotation state can never leak into another."""
    from core.services import translation as translation_module

    translation_module._cooldowns.clear()
    translation_module._round_robin_cursors.clear()
    yield
    translation_module._cooldowns.clear()
    translation_module._round_robin_cursors.clear()
