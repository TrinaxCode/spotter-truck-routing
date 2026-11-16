import re

import pytest
from rest_framework.test import APIClient

from planner.exceptions import ProviderBudgetExhausted
from planner.services.budget import spend
from planner.services.geocode import geocode

ROUTING = re.compile(r"https://api.tomtom.com/routing/1/calculateRoute/.*")
SEARCH = re.compile(r"https://api.tomtom.com/search/2/search/.*")
GEOCODE_PAYLOAD = {"results": [{"position": {"lat": 32.78, "lon": -96.8},
                                "address": {"freeformAddress": "Dallas, TX"}}]}


@pytest.fixture
def budget(settings):
    settings.TOMTOM_API_KEY = "test-key"
    settings.PROVIDER_DAILY_BUDGET = {"tomtom": 2}
    return settings.PROVIDER_DAILY_BUDGET


def test_spend_stops_at_the_daily_limit(budget):
    spend("tomtom")
    spend("tomtom")
    with pytest.raises(ProviderBudgetExhausted):
        spend("tomtom")


def test_cache_hits_and_invalid_requests_cost_nothing(budget, no_network):
    no_network.get(SEARCH, json=GEOCODE_PAYLOAD)
    geocode("Dallas")
    geocode("dallas ")  # same normalised query: served from cache
    client = APIClient()
    assert client.get("/api/geocode?q=ab").status_code == 400  # rejected before any provider call
    assert len(no_network.calls) == 1
    spend("tomtom")  # one call left: only the real request was charged
    with pytest.raises(ProviderBudgetExhausted):
        spend("tomtom")


def test_exhausted_budget_is_a_clear_503(budget, no_network):
    no_network.get(SEARCH, json=GEOCODE_PAYLOAD)
    spend("tomtom", 2)
    response = APIClient().get("/api/geocode?q=Dallas")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_budget_exhausted"
    assert len(no_network.calls) == 0


def test_running_out_during_via_point_search_keeps_found_routes(budget, no_network, fixture_json):
    from datetime import UTC, datetime, timedelta

    from planner.services.routing import get_routes

    payload = fixture_json("tomtom_routes.json")
    payload["routes"] = payload["routes"][:1]  # one route: the via-point fallback has to run
    no_network.get(ROUTING, json=payload)
    routes, warnings = get_routes((-96.797, 32.7767), (-104.9903, 39.7392),
                                  datetime.now(UTC) + timedelta(hours=2), 30000)
    assert len(routes) >= 1
    assert warnings  # fewer than three distinct routes is reported, not hidden
    # Main call + one via point fit the budget of 2; later via points were refused, not sent.
    assert len(no_network.calls) == 2
