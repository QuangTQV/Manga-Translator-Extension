"""Standalone Flux inpainting worker — run this on a REMOTE machine with a
GPU (e.g. a Kaggle notebook, tunneled out via cloudflared) instead of
loading Flux locally on the machine running the main backend. Point the
extension popup's Translate tab -> Outside text -> Inpainting method ->
"Flux Klein 4B (remote)" -> Base URL at this worker's public URL, and
core/image/inpainting.py:FluxKleinInpainter will POST each cropped region
here instead of running inference itself.

See docs/HUONG-DAN-CHAY.md for the full Kaggle + cloudflared walkthrough.

Usage:
    python flux_worker.py [--host 0.0.0.0] [--port 8189] [--variant 4b|9b] [--hf-token hf_xxx]

Needs the exact same installed environment as the main backend
(`pip install -e .` from this directory) — it reuses this repo's own
FluxKleinInpainter directly, not a separate reimplementation, so there's
nothing to keep in sync between the local and remote inference paths.
"""
import argparse
import base64
import io
import sys
from pathlib import Path

_backend_dir = Path(__file__).resolve().parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

from core.image.inpainting import FluxKleinInpainter

app = FastAPI(title="MangaTranslator Flux Worker")

# One inpainter per variant, created (and its weights loaded) on first use
# and cached — a single worker process can serve both "4b" and "9b" if
# both ever get requested, though in practice a user runs one variant per
# worker (picked via --variant at startup, which also preloads it eagerly
# so the first real request isn't stuck behind a 1-2 minute cold load).
_inpainters: dict[str, FluxKleinInpainter] = {}


# Optional Hugging Face token (--hf-token, or the HF_TOKEN env var, which
# huggingface_hub also picks up on its own) — required for the gated 9B repo.
_hf_token = ""


def _get_inpainter(variant: str, num_inference_steps: int) -> FluxKleinInpainter:
    inpainter = _inpainters.get(variant)
    if inpainter is None:
        inpainter = FluxKleinInpainter(
            variant=variant, num_inference_steps=num_inference_steps, verbose=True,
            huggingface_token=_hf_token,
        )
        inpainter.load_models()
        _inpainters[variant] = inpainter
    return inpainter


class InpaintRequest(BaseModel):
    image_base64: str  # PNG, no data: prefix — an already-cropped/resized region
    width: int
    height: int
    seed: int = 1
    num_inference_steps: int = 4
    variant: str = "4b"


class InpaintResponse(BaseModel):
    image_base64: str


@app.get("/health")
async def health() -> dict:
    device = (
        "cuda" if torch.cuda.is_available()
        else "mps" if torch.backends.mps.is_available()
        else "cpu"
    )
    return {"status": "ok", "loaded_variants": list(_inpainters.keys()), "device": device}


@app.post("/inpaint", response_model=InpaintResponse)
async def inpaint(req: InpaintRequest) -> InpaintResponse:
    try:
        image = Image.open(io.BytesIO(base64.b64decode(req.image_base64))).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image_base64: {e}")

    inpainter = _get_inpainter(req.variant, req.num_inference_steps)
    # num_inference_steps can vary per request even though the pipeline
    # itself is cached by variant only — cheap to keep in sync each call.
    inpainter.num_inference_steps = req.num_inference_steps

    result = inpainter._run_local_inference(
        image, req.width, req.height, req.seed, verbose=True
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Flux pipeline unavailable")

    buf = io.BytesIO()
    result.save(buf, format="PNG")
    return InpaintResponse(image_base64=base64.b64encode(buf.getvalue()).decode("ascii"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8189)
    parser.add_argument("--variant", default="4b", choices=["4b", "9b"])
    parser.add_argument("--hf-token", default="", help="Hugging Face token (needed for the gated 9B model)")
    args = parser.parse_args()
    _hf_token = args.hf_token

    print(f"Pre-loading Flux Klein {args.variant.upper()} (first run downloads weights, can take a few minutes)...")
    _get_inpainter(args.variant, num_inference_steps=4)
    print(f"Model ready. Starting server on {args.host}:{args.port} ...")

    uvicorn.run(app, host=args.host, port=args.port)
