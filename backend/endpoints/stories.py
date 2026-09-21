"""Story DB endpoints (character database / relationships / glossary) for
the professional-translation feature — see auth.py:require_login and
core/story_context.py. Opt-in per user regardless of MT_REQUIRE_AUTH: any
logged-in account (registered or Google-signed-in via the extension's
Account tab) can create and use stories here.
"""
from fastapi import APIRouter, Depends, HTTPException

from auth import require_login
from core.accounts import Account
from core.story_context import (
    StoryNotFoundError,
    create_story,
    delete_story,
    get_story,
    list_stories,
    save_story,
)
from schemas import CreateStoryRequest, StoryContextPayload, StoryDetail, StorySummary

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
