from datetime import UTC, datetime, timedelta
from time import perf_counter
from unittest.mock import patch

import pytest
from django.core.cache import cache
from freezegun import freeze_time
from rest_framework.test import APIClient

from planner.services import planner
from planner.services.recommend import RouteScore
from planner.services.routing import Route
from planner.services.weather import rounded_coord, select_weather

BASE = datetime(2026, 11, 16, 14, tzinfo=UTC)
DATA = {
    "origin": {"lon": -96.797, "lat": 32.7767},
    "destination": {"lon": -104.9903, "lat": 39.7392},
    "departure": BASE, "load_lbs": 35000, "interval_mi": 25, "hos": True,
}


def forecast(wind=12, hours=408):
    start = int(BASE.timestamp())
    return {"hourly": {
        "time": [start + h * 3600 for h in range(hours)],
        "wind_speed_10m": [wind] * hours, "wind_gusts_10m": [60] * hours,
        "rain": [0] * hours, "showers": [0] * hours, "snowfall": [0] * hours,
        "temperature_2m": [51] * hours, "weather_code": [3] * hours,
    }}


def make_plan(monkeypatch, data=None, weather=None):
    # Nonuniform instruction travel times, an 8h break and a 10h rest matter to ETAs.
    routes = [Route(((-96.797, 32.7767), (-104.9903, 39.7392)), 100, 43200,
                    ((0, 0), (25, 1800), (50, 28800), (100, 43200)))]
    monkeypatch.setattr(planner, "get_routes", lambda *args: (routes, []))
    values = weather if weather is not None else forecast()

    def fetch(coords):
        return dict.fromkeys((rounded_coord(c) for c in coords), values)

    monkeypatch.setattr(planner, "fetch_forecasts", fetch)
    plan = planner.create_plan(data or DATA)
    # Newly registered departure code must use the weather boundary once, not routing.
    return plan, fetch


@freeze_time("2026-11-15T14:00:00Z")
@pytest.mark.parametrize("hos", [True, False])
def test_zero_offset_exactly_reproduces_plan_and_shifts_every_eta(monkeypatch, hos):
    from planner.services import departures

    # At this subsecond instant, rounding the saved ETA down crosses a weather boundary.
    data = DATA | {"hos": hos, "departure": BASE + timedelta(microseconds=500000)}
    weather = forecast()
    weather["hourly"]["rain"][1] = .5
    plan, fetch = make_plan(monkeypatch, data=data, weather=weather)
    observed = []

    def select(value, eta):
        observed.append(eta)
        return select_weather(value, eta)

    with patch.object(departures, "fetch_forecasts", side_effect=fetch) as weather_fetch:
        with patch.object(departures, "select_weather", side_effect=select):
            response = APIClient().get("/api/departure-options", {"plan_id": plan["plan_id"]})
    assert response.status_code == 200, response.content
    result = response.json()
    assert result["plan_id"] == plan["plan_id"]
    assert result["base_departure"] == plan["request"]["departure"]
    assert [o["offset_h"] for o in result["options"]] == list(range(25))
    route = plan["routes"][0]
    baseline = result["options"][0]
    assert baseline["best_route_id"] == plan["recommended_route_id"]
    for field in ("miles_by_level", "avg_risk", "weather_coverage", "max_level"):
        assert baseline["routes"][0][field] == route["summary"][field]
    count = len(route["checkpoints"])
    assert len(observed) == 25 * count
    for offset, option in enumerate(result["options"]):
        assert datetime.fromisoformat(option["departure"]) == BASE + timedelta(hours=offset)
        assert option["routes"][0]["total_time_s"] == route["total_time_s"]
        assert datetime.fromisoformat(option["routes"][0]["arrival"]) == (
            datetime.fromisoformat(route["arrival"]) + timedelta(hours=offset))
        assert observed[offset * count:(offset + 1) * count] == [
            eta + timedelta(hours=offset) for eta in observed[:count]]
    assert weather_fetch.call_count == 1
    coords = weather_fetch.call_args.args[0]
    assert len(coords) == len(set(rounded_coord(c) for c in coords))


@freeze_time("2026-11-15T14:00:00Z")
def test_no_improvement_cached_and_no_routing(monkeypatch):
    from planner.services import departures

    plan, fetch = make_plan(monkeypatch)
    with patch.object(departures, "fetch_forecasts", side_effect=fetch) as weather_fetch:
        with patch.object(planner, "get_routes", side_effect=AssertionError("No routing")):
            client = APIClient()
            first = client.get("/api/departure-options", {"plan_id": plan["plan_id"]})
            second = client.get("/api/departure-options", {"plan_id": plan["plan_id"]})
    assert first.status_code == 200
    assert first.json()["suggestion"] is None
    assert first.json() == second.json()
    assert weather_fetch.call_count == 1


@freeze_time("2026-11-15T14:00:00Z")
def test_beyond_horizon_is_unknown_not_low(monkeypatch):
    from planner.services import departures

    plan, fetch = make_plan(monkeypatch, weather=forecast(hours=24))
    monkeypatch.setattr(departures, "fetch_forecasts", fetch)
    body = APIClient().get("/api/departure-options", {"plan_id": plan["plan_id"]}).json()
    late = body["options"][24]["routes"][0]
    assert late["weather_coverage"] == 0
    assert late["max_level"] is None
    assert late["miles_by_level"] == {
        "low": 0, "moderate": 0, "high": 0, "severe": 0, "no_travel": 0, "unknown": 100}
    assert body["options"][1]["routes"][0]["weather_coverage"] < 1
    assert body["suggestion"] is None


def test_unknown_departure_plan_returns_error_envelope():
    response = APIClient().get("/api/departure-options", {"plan_id": "unknown"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert "Plan is unknown or expired" in response.json()["error"]["message"]


@pytest.mark.parametrize("query", [{}, {"plan_id": ""}, {"plan_id": "../plan"},
                                  {"plan_id": "a" * 65}])
def test_departure_query_validation(query):
    response = APIClient().get("/api/departure-options", query)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_error"
    assert "plan_id" in response.json()["error"]["fields"]


def score(route_id="r1", *, no_travel=0, severe=0, high=0, avg=0, unknown=0, time=81000):
    return RouteScore(route_id, {"no_travel": no_travel, "severe": severe, "high": high,
                                 "unknown": unknown}, avg, time)


def test_suggestion_earliest_equal_risk_and_headline_priority():
    from planner.services.departures import suggest_departure

    result = suggest_departure([
        score(no_travel=2, severe=50, high=20, avg=2),
        score("r2", severe=10, high=10, avg=1, time=90000),
        score("r3", severe=10, high=10, avg=1, time=10000),
    ], BASE, {"r1": "Route A", "r2": "Route B", "r3": "Route C"})
    assert result == {
        "offset_h": 1, "departure": "2026-11-16T15:00:00Z", "route_id": "r2",
        "headline": "Leave 1 h later on Route B to avoid 2 mi of No Travel weather.",
        "improvement": {"no_travel_mi": 2, "severe_mi": 40, "high_mi": 10},
    }


def test_suggestion_global_minimum_and_coverage_priority():
    from planner.services.departures import suggest_departure

    best = suggest_departure([
        score(severe=100, avg=2), score(severe=50, avg=1), score(avg=.5),
        score(avg=.5, time=10000), score(unknown=100),
    ], BASE, {"r1": "Route A"})
    assert best["offset_h"] == 2
    assert best["headline"] == "Leave 2 h later on Route A to avoid 100 mi of Severe weather."


@freeze_time("2026-11-15T14:00:00Z")
def test_temporal_improvement_selects_earliest_safer_departure(monkeypatch):
    from planner.services import departures

    weather = forecast()
    weather["hourly"]["wind_speed_10m"][:2] = [55, 55]
    plan, fetch = make_plan(monkeypatch, weather=weather)
    monkeypatch.setattr(departures, "fetch_forecasts", fetch)
    body = APIClient().get("/api/departure-options", {"plan_id": plan["plan_id"]}).json()
    assert body["suggestion"]["offset_h"] == 2
    assert body["suggestion"]["improvement"]["no_travel_mi"] == 37.5
    assert body["suggestion"]["headline"] == (
        "Leave 2 h later on Route A to avoid 37.5 mi of No Travel weather.")
    assert body["options"][1]["routes"][0]["miles_by_level"]["no_travel"] > 0


@freeze_time("2026-11-15T14:00:00Z")
def test_weather_outage_all_offsets_unknown(monkeypatch):
    from planner.services import departures

    plan, _ = make_plan(monkeypatch)
    monkeypatch.setattr(departures, "fetch_forecasts", lambda coords: dict.fromkeys(coords))
    body = APIClient().get("/api/departure-options", {"plan_id": plan["plan_id"]}).json()
    assert body["suggestion"] is None
    assert all(option["routes"][0]["weather_coverage"] == 0 for option in body["options"])
    assert all(option["routes"][0]["max_level"] is None for option in body["options"])


@pytest.mark.parametrize("baseline,later", [
    (score(time=90000), score("r2", time=10000)),
    (score(no_travel=1.04, avg=1.004), score(no_travel=1.01, avg=1.001, time=10000)),
])
def test_strict_improvement_ignores_time_and_uses_ranking_rounding(baseline, later):
    from planner.services.departures import suggest_departure

    assert suggest_departure([baseline, later], BASE, {"r1": "Route A", "r2": "Route B"}) is None


@pytest.mark.parametrize("baseline,later,ending", [
    (score(severe=42, high=30, avg=2), score(high=19.5, avg=1),
     "to avoid 42 mi of Severe weather."),
    (score(high=10.5, avg=1), score(avg=.5), "to avoid 10.5 mi of High weather."),
    (score(avg=.8), score(avg=.4), "to lower average risk from 0.80 to 0.40."),
    (score(unknown=100), score(avg=.4), "for complete weather coverage."),
])
def test_headline_uses_largest_risk_criterion(baseline, later, ending):
    from planner.services.departures import suggest_departure

    result = suggest_departure([baseline, later], BASE, {"r1": "Route A"})
    assert result["headline"] == f"Leave 1 h later on Route A {ending}"


@freeze_time("2026-11-15T14:00:00Z")
def test_departure_cache_shares_plan_expiry(monkeypatch):
    from planner.services import departures

    plan, fetch = make_plan(monkeypatch)
    monkeypatch.setattr(departures, "fetch_forecasts", fetch)
    with freeze_time("2026-11-15T19:00:00Z"):
        assert APIClient().get("/api/departure-options", {
            "plan_id": plan["plan_id"]}).status_code == 200
    with freeze_time("2026-11-15T20:00:01Z"):
        assert cache.get(f"departures:{plan['plan_id']}") is None
        assert APIClient().get("/api/departure-options", {
            "plan_id": plan["plan_id"]}).status_code == 404


def test_scoring_25_offsets_three_routes_300_checkpoints_under_one_second(monkeypatch):
    from planner.services import departures

    weather = forecast()
    coords = [(-125 + i * .1, 40) for i in range(300)]
    routes = [{
        "id": f"r{r + 1}", "label": f"Route {chr(65 + r)}", "distance_mi": 2990,
        "total_time_s": 400000,
        "checkpoints": [{"lon": lon, "lat": lat, "mile": i * 10}
                        for i, (lon, lat) in enumerate(coords)],
    } for r in range(3)]
    plan = {"plan_id": "large", "request": {"departure": BASE.isoformat(), "load_lbs": 35000},
            "routes": routes, "_departure": BASE,
            "_eta_offsets_s": {r["id"]: [i * 400000 / 299 for i in range(300)] for r in routes},
            "_expires_at": datetime.now(UTC).timestamp() + 21600}
    cache.set("plan:large", plan, 21600)
    monkeypatch.setattr(departures, "fetch_forecasts", lambda coords: dict.fromkeys(
        (rounded_coord(c) for c in coords), weather))
    start = perf_counter()
    result = departures.get_departure_options("large")
    elapsed = perf_counter() - start
    print(f"\n25 x 3 x 300 checkpoint scoring (408-hour forecasts): {elapsed:.4f}s")
    assert len(result["options"]) == 25
    assert all(len(option["routes"]) == 3 for option in result["options"])
    assert result["options"][24]["routes"][0]["miles_by_level"]["low"] == 2990
    assert elapsed < 1
