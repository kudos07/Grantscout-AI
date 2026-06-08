from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl


class UserProfile(BaseModel):
    narrative: str = Field(..., description="Free-text user description")
    interests: list[str] = Field(default_factory=list)
    location: str | None = None
    status: str | None = None
    free_only: bool = True


OpportunityType = Literal["grant", "fellowship", "scholarship", "startup_credits", "other"]


class Opportunity(BaseModel):
    name: str
    type: OpportunityType = "other"
    official_link: HttpUrl
    application_link: HttpUrl | None = None

    deadline: str | None = None
    amount: str | None = None
    location: str | None = None
    requirements: list[str] = Field(default_factory=list)

    eligibility_score: float = Field(0.0, ge=0.0, le=1.0)
    eligibility_reason: str = ""
    evidence: list[dict[str, Any]] = Field(
        default_factory=list,
        description="List of {url, quote} snippets supporting extracted fields",
    )

    rank: int | None = None
