from urllib.parse import quote

from django.conf import settings
from django.core.cache import cache

from planner.exceptions import NotConfigured, UpstreamError

from .http import cache_key, get_json


def geocode(query: str) -> list[dict]:
    if not settings.TOMTOM_API_KEY:
        raise NotConfigured()
    key = cache_key("geocode", query.casefold().strip())
    cached = cache.get(key)
    if cached is not None:
        return cached
    payload = get_json(f"https://api.tomtom.com/search/2/search/{quote(query, safe='')}.json", {
        "key": settings.TOMTOM_API_KEY, "countrySet": "US,CA", "limit": 6,
    })
    try:
        result = []
        for item in payload["results"][:6]:
            lat, lon = float(item["position"]["lat"]), float(item["position"]["lon"])
            label = item["address"]["freeformAddress"]
            if not (-90 <= lat <= 90 and -180 <= lon <= 180) or not isinstance(label, str):
                raise ValueError("Invalid geocode")
            result.append({"label": label, "lat": lat, "lon": lon})
    except (KeyError, TypeError, ValueError):
        raise UpstreamError() from None
    cache.set(key, result, 24 * 3600)
    return result
