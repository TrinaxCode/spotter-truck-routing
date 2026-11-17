import json
import re
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import pytest
import responses
from django.core.cache import cache
from freezegun import freeze_time
from rest_framework.test import APIClient

from planner.services.heatmap import corridor_grid

ROUTING = re.compile(r"https://api.tomtom.com/routing/1/calculateRoute/.*")
WEATHER = "https://api.open-meteo.com/v1/forecast"
REQUEST = {
    "origin": {"lat": 32.7767, "lon": -96.797, "label": "Dallas, TX"},
    "destination": {"lat": 34, "lon": -97.5, "label": "Destination"},
    "departure": "2026-11-16T08:00:00-06:00", "load_lbs": 35000,
    "interval_mi": 25, "hos": True,
}


def weather_callback(request):
    query = parse_qs(urlsplit(request.url).query)
    count = len(query["latitude"][0].split(","))
    time = int(datetime(2026, 11, 16, tzinfo=UTC).timestamp())
    rows = [{"hourly": {
        "time": [time + i * 3600 for i in range(100)],
        "wind_speed_10m": [12] * 100, "wind_gusts_10m": [60] * 100,
        "rain": [0] * 100, "showers": [0] * 100, "snowfall": [0] * 100,
        "temperature_2m": [51] * 100, "weather_code": [3] * 100,
    }} for _ in range(count)]
    return 200, {}, json.dumps(rows if count > 1 else rows[0])


def test_health_is_keyless():
    response = APIClient().get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@freeze_time("2026-11-15T14:00:00Z")
@pytest.mark.parametrize("updates,field", [
    ({"origin": {"lat": 91, "lon": 0}}, "origin"),
    ({"destination": {"lat": 0, "lon": -181}}, "destination"),
    ({"load_lbs": -1}, "load_lbs"), ({"load_lbs": 80001}, "load_lbs"),
    ({"load_lbs": True}, "load_lbs"), ({"load_lbs": 1.5}, "load_lbs"),
    ({"interval_mi": 15}, "interval_mi"), ({"interval_mi": True}, "interval_mi"),
    ({"departure": "2026-11-15T12:59:59Z"}, "departure"),
    ({"departure": "2026-11-29T14:00:01Z"}, "departure"),
    ({"departure": "2026-11-16T14:00:00"}, "departure"),
    ({"departure": "not-a-date"}, "departure"),
    ({"destination": REQUEST["origin"]}, "destination"),
    ({"hos": "maybe"}, "hos"),
    ({"origin": {"lat": "NaN", "lon": 0}}, "origin"),
    ({"destination": {"lat": 0, "lon": "Infinity"}}, "destination"),
])
def test_validation_error_envelope(updates, field):
    response = APIClient().post("/api/routes/plan", REQUEST | updates, format="json")
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert field in error["fields"]


@freeze_time("2026-11-15T14:00:00Z")
def test_missing_key_and_invalid_json_are_structured():
    client = APIClient()
    response = client.post("/api/routes/plan", REQUEST, format="json")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"
    malformed = client.post("/api/routes/plan", "{broken", content_type="application/json")
    assert malformed.status_code == 400
    assert malformed.json()["error"]["code"] == "validation_error"


def test_geocode_validates_query():
    response = APIClient().get("/api/geocode?q=ab")
    assert response.status_code == 400
    assert "q" in response.json()["error"]["fields"]


@freeze_time("2026-11-15T14:00:00Z")
def test_upstream_failure_does_not_expose_credentials(settings, no_network):
    settings.TOMTOM_API_KEY = "sensitive-test-key"
    no_network.get(ROUTING, status=401, json={"error": "sensitive-test-key"})
    response = APIClient().post("/api/routes/plan", REQUEST, format="json")
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_error"
    assert "sensitive-test-key" not in response.content.decode()


@freeze_time("2026-11-15T14:00:00Z")
def test_full_plan_and_49_frame_heatmap(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    no_network.add_callback(responses.GET, WEATHER, weather_callback)
    client = APIClient()
    response = client.post("/api/routes/plan", REQUEST, format="json")
    assert response.status_code == 200, response.content
    plan = response.json()
    assert plan["generated_at"] == "2026-11-15T14:00:00Z"
    assert plan["request"]["departure"] == "2026-11-16T14:00:00Z"
    assert plan["recommended_route_id"] == plan["recommendation"]["route_id"] == "r1"
    assert len(plan["routes"]) == 3
    first = plan["routes"][0]
    assert first["rank"] == 1 and first["recommended"]
    assert first["geometry"]["coordinates"][0] == [-96.797, 32.7767]
    assert first["summary"]["weather_coverage"] == 1
    assert first["summary"]["miles_by_level"]["low"] == pytest.approx(100)
    assert first["summary"]["max_level"] == 0
    assert first["arrival"] == "2026-11-16T16:00:00Z"
    checkpoints = first["checkpoints"]
    assert [p["mile"] for p in checkpoints] == [0, 25, 50, 75, 100]
    assert checkpoints[1]["eta"] == "2026-11-16T14:40:00Z"
    assert checkpoints[0]["weather"]["gust_mph"] == 60
    assert checkpoints[0]["levels"] == {"wind": 0, "rain": 0, "snow": 0}
    heat = client.get("/api/heatmap", {"plan_id": plan["plan_id"]})
    assert heat.status_code == 200, heat.content
    payload = heat.json()
    assert payload["start"] == "2026-11-16T14:00:00Z"
    assert payload["load_lbs"] == 35000 and payload["hours"] == 49
    assert 0 < len(payload["cells"]) <= 450
    for variable in ("risk", "wind", "rain", "snow"):
        assert len(payload[variable]) == len(payload["cells"])
        assert all(len(row) == 49 for row in payload[variable])
    assert all(value == 0 for row in payload["risk"] for value in row)
    count = len(no_network.calls)
    assert client.get("/api/heatmap", {"plan_id": plan["plan_id"]}).json() == payload
    assert len(no_network.calls) == count
    cache.clear()
    assert client.get("/api/heatmap", {"plan_id": plan["plan_id"]}).status_code == 404


@freeze_time("2026-11-15T14:00:00Z")
def test_weather_outage_remains_unknown_and_warns(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    no_network.get(WEATHER, status=503)
    response = APIClient().post("/api/routes/plan", REQUEST, format="json")
    assert response.status_code == 200
    payload = response.json()
    assert any("coverage" in w.lower() for w in payload["warnings"])
    for route in payload["routes"]:
        assert route["summary"]["weather_coverage"] == 0
        assert route["summary"]["max_level"] is None
        assert route["summary"]["miles_by_level"]["unknown"] == route["distance_mi"]
        assert all(p["level"] is None and p["weather"] is None for p in route["checkpoints"])


@pytest.mark.parametrize("coords", [
    [[(-96.8, 32.8), (-97.5, 34)]],
    [[(-122, 37), (-75, 40)], [(-122, 37), (-110, 30), (-75, 40)]],
    [[(-100, 30), (-99.999, 30.001)]],
])
def test_corridor_grid_is_capped_and_covers_route(coords):
    cells, cell_deg = corridor_grid(coords)
    assert 0 < len(cells) <= 450
    assert cell_deg >= .1
    assert len({(c["lon"], c["lat"]) for c in cells}) == len(cells)
    from planner.services.sampling import haversine
    for route in coords:
        for point in route:
            assert min(haversine(point, (c["lon"], c["lat"])) for c in cells) < cell_deg * 100


@freeze_time("2026-11-15T14:00:00Z")
def test_hos_plan_break_locations_and_timestamps(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    payload = fixture_json("tomtom_routes.json")
    for route in payload["routes"]:
        route["summary"]["travelTimeInSeconds"] = 43200
        route["guidance"] = {"instructions": []}
    no_network.get(ROUTING, json=payload)
    no_network.add_callback(responses.GET, WEATHER, weather_callback)
    client = APIClient()
    route = client.post("/api/routes/plan", REQUEST, format="json").json()["routes"][0]
    assert route["total_time_s"] == 81000
    assert route["arrival"] == "2026-11-17T12:30:00Z"
    pauses = route["summary"]["breaks"]
    assert pauses[0] == {"type": "break_30m", "at_mile": pytest.approx(200 / 3),
                         "start": "2026-11-16T22:00:00Z", "end": "2026-11-16T22:30:00Z"}
    assert pauses[1]["type"] == "rest_10h"
    assert pauses[1]["at_mile"] == pytest.approx(1100 / 12)
    assert pauses[1]["start"] == "2026-11-17T01:30:00Z"
    assert pauses[1]["end"] == "2026-11-17T11:30:00Z"
    assert route["checkpoints"][3]["eta"] == "2026-11-16T23:30:00Z"
    without = client.post("/api/routes/plan", REQUEST | {"hos": False}, format="json")
    assert without.json()["routes"][0]["total_time_s"] == 43200
    assert without.json()["routes"][0]["summary"]["breaks"] == []


@freeze_time("2026-11-15T14:00:00Z")
def test_heatmap_uses_load_and_nulls_outside_horizon(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    payload = fixture_json("open_meteo_multi.json")[0]
    payload["hourly"]["wind_speed_10m"] = [35] * 3
    payload["hourly"]["rain"] = payload["hourly"]["showers"] = [0] * 3
    payload["hourly"]["snowfall"] = [0] * 3

    def callback(request):
        count = len(parse_qs(urlsplit(request.url).query)["latitude"][0].split(","))
        return 200, {}, json.dumps([payload] * count if count > 1 else payload)

    no_network.add_callback(responses.GET, WEATHER, callback)
    client = APIClient()
    plan = client.post("/api/routes/plan", REQUEST | {"load_lbs": 40001}, format="json").json()
    heat = client.get("/api/heatmap", {"plan_id": plan["plan_id"]}).json()
    assert all(row[:4] == [3, 3, 3, None] for row in heat["risk"])
    assert all(row[3:] == [None] * 46 for row in heat["wind"])


@freeze_time("2026-11-15T14:00:00Z")
def test_all_no_travel_routes_warn_and_defaults_apply(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))

    def callback(request):
        status, headers, body = weather_callback(request)
        data = json.loads(body)
        for item in data if isinstance(data, list) else [data]:
            item["hourly"]["wind_speed_10m"] = [55] * 100
        return status, headers, json.dumps(data)

    no_network.add_callback(responses.GET, WEATHER, callback)
    request = {key: value for key, value in REQUEST.items() if key not in {"hos", "interval_mi"}}
    plan = APIClient().post("/api/routes/plan", request, format="json").json()
    assert "No route is currently safe; consider a later departure" in plan["warnings"]
    assert plan["request"]["hos"] is True and plan["request"]["interval_mi"] == 25


def test_unknown_heatmap_plan_returns_404():
    response = APIClient().get("/api/heatmap", {"plan_id": "unknown"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@freeze_time("2026-11-15T14:00:00Z")
@pytest.mark.parametrize("departure", ["2026-11-15T13:00:00Z", "2026-11-29T14:00:00Z"])
def test_departure_window_includes_exact_boundaries(departure):
    response = APIClient().post("/api/routes/plan", REQUEST | {"departure": departure},
                                format="json")
    assert response.status_code == 503


@freeze_time("2026-11-15T14:00:00Z")
def test_plan_cache_expires_at_six_hours(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    no_network.add_callback(responses.GET, WEATHER, weather_callback)
    client = APIClient()
    plan = client.post("/api/routes/plan", REQUEST, format="json").json()
    assert client.get("/api/heatmap", {"plan_id": plan["plan_id"]}).status_code == 200
    with freeze_time("2026-11-15T20:00:01Z"):
        assert client.get("/api/heatmap", {"plan_id": plan["plan_id"]}).status_code == 404


def test_geocode_api_maps_real_provider_fields_and_uses_cache(settings, no_network):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(re.compile(r"https://api.tomtom.com/search/2/search/.*"), json={
        "results": [{"address": {"freeformAddress": "Dallas, TX, USA"},
                     "position": {"lat": 32.77, "lon": -96.79}}],
    })
    client = APIClient()
    response = client.get("/api/geocode?q=Dallas")
    assert response.status_code == 200
    assert response.json() == {"results": [{"label": "Dallas, TX, USA",
                                            "lat": 32.77, "lon": -96.79}]}
    assert client.get("/api/geocode?q=Dallas").json() == response.json()
    assert len(no_network.calls) == 1


@freeze_time("2026-11-15T14:00:00Z")
def test_unknown_api_path_and_crashes_use_the_json_error_envelope(monkeypatch):
    client = APIClient(raise_request_exception=False)
    missing = client.get("/api/nope")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"

    def boom(_data):
        raise RuntimeError("secret internals")

    monkeypatch.setattr("planner.views.create_plan", boom)
    crashed = client.post("/api/routes/plan", REQUEST, format="json")
    assert crashed.status_code == 500
    assert crashed.json()["error"]["code"] == "internal_error"
    assert "secret internals" not in crashed.content.decode()


@freeze_time("2026-11-15T14:00:00Z")
def test_heatmap_with_a_weather_outage_is_not_cached(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    no_network.add_callback(responses.GET, WEATHER, weather_callback)
    client = APIClient()
    plan = client.post("/api/routes/plan", REQUEST, format="json").json()
    cache.clear()  # forget cached forecasts so the heatmap must call the provider
    cache.set(f"plan:{plan['plan_id']}", plan, 3600)
    no_network.remove(responses.GET, WEATHER)
    no_network.get(WEATHER, status=503)
    degraded = client.get("/api/heatmap", {"plan_id": plan["plan_id"]})
    assert degraded.status_code == 200
    assert all(value is None for row in degraded.json()["risk"] for value in row)
    no_network.remove(responses.GET, WEATHER)
    no_network.add_callback(responses.GET, WEATHER, weather_callback)
    recovered = client.get("/api/heatmap", {"plan_id": plan["plan_id"]}).json()
    assert any(value is not None for row in recovered["risk"] for value in row)


@pytest.mark.parametrize("origin,allowed", [("https://app.example.com", True),
                                            ("https://evil.example.com", False)])
def test_cors_follows_configured_origins(settings, origin, allowed):
    settings.CORS_ALLOWED_ORIGINS = ["https://app.example.com"]
    response = APIClient().options("/api/routes/plan", HTTP_ORIGIN=origin,
                                   HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
                                   HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type")
    assert ("access-control-allow-origin" in response.headers) is allowed


def test_provider_backed_endpoints_are_rate_limited_per_client(monkeypatch):
    from planner import views

    throttle = views.geocode_view.cls.throttle_classes[0]
    monkeypatch.setattr(throttle, "THROTTLE_RATES", {"geocode": "2/min"})
    client = APIClient()
    # Validation failures still count: the limit protects the server, not only the provider.
    statuses = [client.get("/api/geocode?q=a", REMOTE_ADDR="10.0.0.1").status_code
                for _ in range(3)]
    assert statuses == [400, 400, 429]
    limited = client.get("/api/geocode?q=a", REMOTE_ADDR="10.0.0.1")
    assert limited.json()["error"]["code"] == "throttled"
    assert int(limited["Retry-After"]) > 0
    # Another client has its own budget.
    assert client.get("/api/geocode?q=a", REMOTE_ADDR="10.0.0.2").status_code == 400


def test_every_provider_backed_view_has_a_throttle():
    from planner import views

    scopes = {
        view.cls.throttle_classes[0].scope
        for view in (views.geocode_view, views.plan_view, views.heatmap_view,
                     views.departure_options_view)
    }
    assert scopes == {"geocode", "plan", "plan_data"}
    # The platform health check must never be throttled.
    assert not views.health.cls.throttle_classes


def test_forwarded_for_is_ignored_unless_a_proxy_is_trusted(monkeypatch):
    from planner import views

    throttle = views.geocode_view.cls.throttle_classes[0]
    monkeypatch.setattr(throttle, "THROTTLE_RATES", {"geocode": "1/min"})
    client = APIClient()
    first = client.get("/api/geocode?q=a", REMOTE_ADDR="10.0.0.9", HTTP_X_FORWARDED_FOR="1.1.1.1")
    spoofed = client.get("/api/geocode?q=a", REMOTE_ADDR="10.0.0.9", HTTP_X_FORWARDED_FOR="2.2.2.2")
    assert (first.status_code, spoofed.status_code) == (400, 429)


def test_ipv6_clients_share_their_64_block(monkeypatch):
    from planner import views

    throttle = views.geocode_view.cls.throttle_classes[0]
    monkeypatch.setattr(throttle, "THROTTLE_RATES", {"geocode": "1/min"})
    client = APIClient()
    assert client.get("/api/geocode?q=a", REMOTE_ADDR="2001:db8:1:2::1").status_code == 400
    assert client.get("/api/geocode?q=a", REMOTE_ADDR="2001:db8:1:2::beef").status_code == 429
    assert client.get("/api/geocode?q=a", REMOTE_ADDR="2001:db8:1:3::1").status_code == 400

