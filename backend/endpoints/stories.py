"""Story DB endpoints (character database / relationships / glossary) for
the professional-translation feature — see auth.py:require_login and
core/story_context.py. Opt-in per user regardless of MT_REQUIRE_AUTH: any
logged-in account (registered or Google-signed-in via the extension's
Account tab) can create and use stories here.
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException

from auth import require_login, verify_token
from core.accounts import Account
from core.services.translation import generate_story_update
from core.story_context import (
    StoryNotFoundError,
    StoryUpdateParseError,
    create_story,
    delete_story,
    get_story,
    list_stories,
    merge_story_update,
    save_story,
)
from endpoints.translate import _apply_shared_llm_config, _config_for_request
from schemas import (
    CreateStoryRequest,
    StoryContextPayload,
    StoryDetail,
    StorySummary,
    StoryUpdateRequest,
    StoryUpdateResponse,
)

router = APIRouter(prefix="/stories", tags=["stories"])


def _to_summary(row) -> StorySummary:
    return StorySummary(id=row.id, name=row.name, updated_at=row.updated_at)


def _to_detail(row) -> StoryDetail:
    return StoryDetail(
        id=row.id,
        name=row.name,
        characters=row.characters,
        relationships=row.relationships,
        glossary=row.glossary,
        continuity_notes=row.continuity_notes,
        continuity_notes_enabled=row.continuity_notes_enabled,
        updated_at=row.updated_at,
    )


@router.get("", response_model=list[StorySummary])
async def list_my_stories(account: Account = Depends(require_login)) -> list[StorySummary]:
    return [_to_summary(row) for row in list_stories(account.email)]


@router.post("", response_model=StoryDetail)
async def create_my_story(
    req: CreateStoryRequest, account: Account = Depends(require_login),
) -> StoryDetail:
    row = create_story(account.email, req.name)
    return _to_detail(row)


@router.get("/{story_id}", response_model=StoryDetail)
async def get_my_story(story_id: str, account: Account = Depends(require_login)) -> StoryDetail:
    try:
        row = get_story(story_id, account.email)
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="Story not found")
    return _to_detail(row)


@router.put("/{story_id}", response_model=StoryDetail)
async def save_my_story(
    story_id: str, req: StoryContextPayload, account: Account = Depends(require_login),
) -> StoryDetail:
    try:
        row = save_story(
            story_id,
            account.email,
            name=req.name,
            characters=[c.model_dump() for c in req.characters],
            relationships=[r.model_dump() for r in req.relationships],
            glossary=[g.model_dump() for g in req.glossary],
            continuity_notes=[n.model_dump() for n in req.continuity_notes],
            continuity_notes_enabled=req.continuity_notes_enabled,
        )
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="Story not found")
    return _to_detail(row)


@router.delete("/{story_id}")
async def delete_my_story(story_id: str, account: Account = Depends(require_login)) -> dict:
    try:
        delete_story(story_id, account.email)
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="Story not found")
    return {"ok": True}


@router.post("/update-from-description", response_model=StoryUpdateResponse)
async def update_story_from_description(
    req: StoryUpdateRequest, account=Depends(verify_token),
) -> StoryUpdateResponse:
    """Turn a free-text note about a story development ("chapter 39, the
    villain turns out to be Akira's childhood friend Hina, so they switch
    to hostile pronouns") into a Story DB update — see
    core/services/translation.py:generate_story_update and
    core/story_context.py:merge_story_update.

    Gated by verify_token (a one-off LLM-cost-incurring helper, same as
    /suggest-instructions and /region/translate) rather than require_login
    like this router's other routes — it never reads or writes the
    database, so there's no account-scoped row to protect; the Story DB
    tab it's called from is already login-gated in the popup regardless.
    Stateless: takes whatever characters/relationships the caller currently
    has (saved or not) and returns the merged result for review — the
    caller decides whether/how to save it.
    """
    if not req.description.strip():
        raise HTTPException(status_code=400, detail="No description provided.")
    _apply_shared_llm_config(req, account)
    config = _config_for_request(req)
    config.translation.enable_web_search = req.enable_web_search
    characters = [c.model_dump() for c in req.characters]
    relationships = [r.model_dump() for r in req.relationships]

    try:
        raw_reply = await asyncio.to_thread(
            generate_story_update,
            config.translation, req.description, characters, relationships, req.output_language,
            story_title=req.story_title,
        )
        merged_characters, merged_relationships, continuity_note = merge_story_update(
            characters, relationships, raw_reply,
        )
    except StoryUpdateParseError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Story update failed: {e}")

    return StoryUpdateResponse(
        characters=merged_characters,
        relationships=merged_relationships,
        continuity_note=continuity_note,
    )
