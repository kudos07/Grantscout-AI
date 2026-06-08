from __future__ import annotations

import os
from typing import Any


def has_mistral() -> bool:
    return bool(os.getenv("MISTRAL_API_KEY"))


def _client():
    # Import lazily so local runs still work without the package.
    from mistralai import Mistral

    api_key = os.environ["MISTRAL_API_KEY"]
    return Mistral(api_key=api_key)


def mistral_json(system: str, user: str, *, model: str = "mistral-small-latest") -> Any:
    """
    Best-effort: ask Mistral for strict JSON and parse it.
    """
    import json

    c = _client()
    resp = c.chat.complete(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    text = resp.choices[0].message.content
    return json.loads(text)

