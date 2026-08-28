class ValidationError(ValueError):
    """Custom exception for validation errors."""

    pass


class ModelError(RuntimeError):
    """Custom exception for model loading and inference failures."""

    pass


class FontError(RuntimeError):
    """Custom exception for font loading and resource failures."""

    pass


class RenderingError(RuntimeError):
    """Custom exception for text rendering and drawing failures."""

    pass


class ImageProcessingError(Exception):
    """Custom exception for image operations failures."""

    pass


class TranslationError(RuntimeError):
    """Custom exception for translation API and processing failures."""

    def __init__(self, message: str, retry_after_seconds: float | None = None):
        super().__init__(message)
        # The provider's own `Retry-After` response header, when it sent
        # one on a 429 — lets the caller cool down that key/model for
        # exactly as long as the provider says, instead of a blind guess.
        # None whenever the provider didn't send one, or the failure isn't
        # rate-limit related at all.
        self.retry_after_seconds = retry_after_seconds


class DetectionError(RuntimeError):
    """Custom exception for speech bubble detection failures."""

    pass


class CleaningError(Exception):
    """Custom exception for bubble cleaning failures."""

    pass


class CancellationError(Exception):
    pass
