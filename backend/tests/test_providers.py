import json
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
import responses
from freezegun import freeze_time

from planner.exceptions import NotConfigured, UpstreamError
from planner.services.geocode import geocode
from planner.services.routing import Route, TomTomProvider, get_routes
from planner.services.weather import fetch_forecasts, select_weather

ROUTING = re.compile(r"https://api.tomtom.com/routing/1/calculateRoute/.*")
WEATHER = "https://api.open-meteo.com/v1/forecast"
DEPARTURE = datetime(2026, 11, 16, 14, tzinfo=UTC)


def test_tomtom_verified_parameters_and_piecewise_eta(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    routes = TomTomProvider().calculate_routes((-96.797, 32.7767), (-97.5, 34), DEPARTURE, 35000)
    assert len(routes) == 3
    assert routes[0].distance_mi == pytest.approx(100)
    assert routes[0].drive_seconds_at(25) == pytest.approx(2400)
    assert routes[0].drive_seconds_at(75) == pytest.approx(6000)
    assert routes[0].mile_at_drive(6000) == pytest.approx(75)
    assert routes[1].drive_seconds_at(55) == pytest.approx(4000)
    query = parse_qs(urlsplit(no_network.calls[0].request.url).query)
    assert query["travelMode"] == ["truck"]
    assert query["vehicleCommercial"] == ["true"]
    assert query["vehicleWeight"] == ["31751"]
    assert query["maxAlternatives"] == ["2"]
    assert query["instructionsType"] == ["coded"]
    assert query["routeRepresentation"] == ["polyline"]
    assert query["departAt"] == ["2026-11-16T14:00:00Z"]


def test_keyless_provider_refuses_routes():
    with pytest.raises(NotConfigured):
        TomTomProvider().calculate_routes((0, 0), (1, 1), DEPARTURE, 0)


@pytest.mark.parametrize("payload", [{}, {"routes": []}, {"routes": [{"summary": {}}]}])
def test_malformed_routes_are_typed_upstream_errors(settings, no_network, payload):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=payload)
    with pytest.raises(UpstreamError):
        TomTomProvider().calculate_routes((0, 0), (1, 1), DEPARTURE, 0)


def test_provider_independent_fallback_deduplicates_and_warns():
    class Provider:
        def __init__(self):
            self.vias = []

        def calculate_routes(self, origin, destination, departure, load_lbs,
                             via=None, max_alternatives=2):
            self.vias.append(via)
            return [Route(((0, 0), (1, 0)), 70, 3600, ())]

    provider = Provider()
    routes, warnings = get_routes((0, 0), (1, 0), DEPARTURE, 0, provider)
    assert len(routes) == 1
    assert len(provider.vias) == 5
    assert provider.vias[1][1] == pytest.approx(.15, abs=.001)
    assert provider.vias[2][1] == pytest.approx(-.15, abs=.001)
    assert provider.vias[3][1] == pytest.approx(.3, abs=.001)
    assert warnings


def test_distinct_via_routes_are_real_provider_geometry():
    class Provider:
        def calculate_routes(self, origin, destination, departure, load_lbs,
                             via=None, max_alternatives=2):
            coords = (origin, via, destination) if via else (origin, destination)
            return [Route(coords, 100, 7200, ())]

    routes, warnings = get_routes((0, 0), (1, 0), DEPARTURE, 0, Provider())
    assert len(routes) == 3
    assert warnings == []


def test_routing_cache_uses_departure_hour(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json=fixture_json("tomtom_routes.json"))
    get_routes((-96.797, 32.7767), (-97.5, 34), DEPARTURE, 35000)
    get_routes((-96.797, 32.7767), (-97.5, 34), DEPARTURE + timedelta(minutes=15), 35000)
    assert len(no_network.calls) == 1


def test_geocode_encodes_query_limits_and_caches(settings, no_network):
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(re.compile(r"https://api.tomtom.com/search/2/search/.*"), json={
        "summary": {"numResults": 1}, "results": [{
            "type": "Geography", "address": {"freeformAddress": "Dallas, TX, USA"},
            "position": {"lat": 32.77, "lon": -96.79},
        }],
    })
    assert geocode("Dallas / TX") == [{"label": "Dallas, TX, USA", "lat": 32.77, "lon": -96.79}]
    geocode("Dallas / TX")
    assert len(no_network.calls) == 1
    url = no_network.calls[0].request.url
    assert "%2F" in url
    query = parse_qs(urlsplit(url).query)
    assert query["countrySet"] == ["US,CA"]
    assert query["limit"] == ["6"]


@freeze_time("2026-11-16T14:00:00Z")
def test_weather_multilocation_deduplication_and_cache(no_network, fixture_json):
    no_network.get(WEATHER, json=fixture_json("open_meteo_multi.json"))
    coords = [(-96.797, 32.7767), (-96.801, 32.779), (-97, 33)]
    forecasts = fetch_forecasts(coords)
    first = select_weather(forecasts[(-96.8, 32.8)], DEPARTURE + timedelta(minutes=20))
    assert first.wind_mph == 12
    assert first.gust_mph == 60  # Gusts are display-only.
    assert first.rain_in_hr == pytest.approx(.3)
    assert first.snow_in_hr == .5
    assert first.forecast_time == "2026-11-16T15:00:00Z"
    later = select_weather(forecasts[(-96.8, 32.8)], DEPARTURE + timedelta(minutes=30))
    assert later.wind_mph == 35
    assert select_weather(forecasts[(-97., 33.)], DEPARTURE).wind_mph == 5
    fetch_forecasts(coords)
    assert len(no_network.calls) == 1
    query = parse_qs(urlsplit(no_network.calls[0].request.url).query)
    assert query["latitude"] == ["32.8,33"]
    assert query["temperature_unit"] == ["fahrenheit"]
    assert query["precipitation_unit"] == ["inch"]
    assert query["forecast_days"] == ["16"]


def test_weather_outside_horizon_or_null_does_not_become_low(no_network, fixture_json):
    payload = fixture_json("open_meteo_multi.json")[0]
    payload["hourly"]["rain"][1] = None
    no_network.get(WEATHER, json=payload)
    forecasts = fetch_forecasts([(-96.8, 32.8)])
    forecast = forecasts[(-96.8, 32.8)]
    assert select_weather(forecast, DEPARTURE + timedelta(minutes=20)) is None
    assert select_weather(forecast, DEPARTURE - timedelta(minutes=1)) is None
    assert select_weather(forecast, DEPARTURE + timedelta(hours=3)) is None


def test_weather_retries_once_and_handles_partial_provider_failure(no_network, fixture_json):
    no_network.get(WEATHER, status=429)
    no_network.get(WEATHER, json=fixture_json("open_meteo_multi.json")[0])
    forecasts = fetch_forecasts([(-96.8, 32.8)])
    assert select_weather(forecasts[(-96.8, 32.8)], DEPARTURE).wind_mph == 12
    assert len(no_network.calls) == 2


def test_weather_batches_at_most_100_and_keeps_successful_batches(no_network, fixture_json):
    payload = fixture_json("open_meteo_multi.json")[0]

    def callback(request):
        query = parse_qs(urlsplit(request.url).query)
        count = len(query["latitude"][0].split(","))
        assert count <= 100
        if count == 1:
            return 503, {}, '{}'
        return 200, {}, json.dumps([payload] * count)

    no_network.add_callback(responses.GET, WEATHER, callback)
    forecasts = fetch_forecasts([(-100 + i / 10, 30) for i in range(101)])
    assert sum(bool(f) for f in forecasts.values()) == 100
    assert len(no_network.calls) == 3


@pytest.mark.parametrize("payload", [{"hourly": {}}, [], {"error": True}])
def test_weather_bad_payload_is_missing_not_invented(no_network, payload):
    no_network.get(WEATHER, json=payload)
    assert not fetch_forecasts([(-96.8, 32.8)])[(-96.8, 32.8)]


def test_duplicate_instruction_offsets_at_waypoints_are_usable(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    payload = fixture_json("tomtom_routes.json")
    middle = payload["routes"][0]["guidance"]["instructions"][1]
    payload["routes"][0]["guidance"]["instructions"].insert(2, dict(middle))
    no_network.get(ROUTING, json=payload)
    route = TomTomProvider().calculate_routes((0, 0), (1, 1), DEPARTURE, 0)[0]
    assert route.drive_seconds_at(25) == pytest.approx(2400)


def test_nonmonotonic_guidance_is_typed_error(settings, no_network, fixture_json):
    settings.TOMTOM_API_KEY = "test-key"
    payload = fixture_json("tomtom_routes.json")
    payload["routes"][0]["guidance"]["instructions"].insert(2, {
        "routeOffsetInMeters": 40000, "travelTimeInSeconds": 5000,
    })
    no_network.get(ROUTING, json=payload)
    with pytest.raises(UpstreamError):
        TomTomProvider().calculate_routes((0, 0), (1, 1), DEPARTURE, 0)


def test_weather_overflow_is_unknown(no_network, fixture_json):
    payload = fixture_json("open_meteo_multi.json")[0]
    payload["hourly"]["rain"][0] = payload["hourly"]["showers"][0] = 1e308
    no_network.get(WEATHER, json=payload)
    forecasts = fetch_forecasts([(-96.8, 32.8)])
    assert select_weather(forecasts[(-96.8, 32.8)], DEPARTURE) is None


def test_weather_commercial_host_and_key(settings, no_network, fixture_json):
    settings.OPEN_METEO_API_KEY = "commercial-test-key"
    no_network.get("https://customer-api.open-meteo.com/v1/forecast",
                   json=fixture_json("open_meteo_multi.json")[0])
    forecasts = fetch_forecasts([(-96.8, 32.8)])
    assert select_weather(forecasts[(-96.8, 32.8)], DEPARTURE).wind_mph == 12
    query = parse_qs(urlsplit(no_network.calls[0].request.url).query)
    assert query["apikey"] == ["commercial-test-key"]


def test_routing_timeout_is_sanitized(settings, no_network):
    import requests
    settings.TOMTOM_API_KEY = "secret-test-key"
    no_network.get(ROUTING, body=requests.Timeout("secret-test-key"))
    with pytest.raises(UpstreamError) as error:
        TomTomProvider().calculate_routes((0, 0), (1, 1), DEPARTURE, 0)
    assert "secret-test-key" not in str(error.value)


def test_past_departure_is_sent_to_tomtom_as_now():
    from datetime import timedelta

    from django.utils import timezone

    from planner.services.routing import depart_at

    now = timezone.now()
    assert depart_at(now - timedelta(minutes=30)) == "now"
    assert depart_at(now + timedelta(hours=2)).endswith("Z")
