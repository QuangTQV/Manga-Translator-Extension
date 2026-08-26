"""Pydantic request/response schemas for the translation endpoints."""
from typing import List, Optional

from pydantic import BaseModel


class BubbleInfo(BaseModel):
    bbox: List[float]
    confidence: float
    original_text: Optional[str] = None
    translated_text: str


class TranslateOptions(BaseModel):
    """Fields shared by single and batch translation requests."""

    input_language: str
    output_language: str
    provider: str
    base_url: Optional[str] = None
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = 0.1
    top_p: float = 0.95
    top_k: int = 40
    max_tokens: Optional[int] = None
    translation_mode: str = "one-step"
    ocr_method: str = "LLM"
    reasoning_effort: Optional[str] = None
    special_instructions: Optional[str] = None
    llm_instructions: Optional[str] = None
    font_dir: Optional[str] = None
    max_font_size: int = 16
    min_font_size: int = 8
    supersampling_factor: int = 4
    send_full_page_context: bool = True
    image_detail: str = "auto"
    outside_text_enabled: bool = False
    previous_context_texts: Optional[List[List[str]]] = None  # oldest-to-newest OCR transcripts of prior pages


class TranslateRequest(TranslateOptions):
    image: str  # raw base64 (no data: prefix)


class TranslateResponse(BaseModel):
    translated_image: str  # raw base64
    bubbles: List[BubbleInfo]
    processing_time_seconds: float
    source_language: str
    target_language: str
    provider: str
    ocr_texts: List[str] = []  # this page's OCR transcripts, in reading order


class TranslateBatchItem(BaseModel):
    id: Optional[str] = None
    image: str  # raw base64


class TranslateBatchRequest(TranslateOptions):
    images: List[TranslateBatchItem]


class TranslateBatchItemResponse(BaseModel):
    id: Optional[str] = None
    translated_image: Optional[str] = None
    bubbles: List[BubbleInfo] = []
    error: Optional[str] = None
    processing_time_seconds: Optional[float] = None
    ocr_texts: List[str] = []  # this page's OCR transcripts, in reading order


class TranslateBatchResponse(BaseModel):
    results: List[TranslateBatchItemResponse]
    total_time_seconds: float
    success_count: int
    error_count: int


class SuggestInstructionsRequest(BaseModel):
    """A handful of sample page images from the same manga, used for a
    one-off LLM call that drafts Special Instructions text (cast,
    relationships, tone) for the user to review before saving."""

    images: List[str]  # raw base64 sample page images, no data: prefix
    output_language: str
    provider: str
    base_url: Optional[str] = None
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = 0.1
    top_p: float = 0.95
    top_k: int = 40
    reasoning_effort: Optional[str] = None


class SuggestInstructionsResponse(BaseModel):
    suggestion: str
