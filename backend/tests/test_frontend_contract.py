"""Pins the real API payloads consumed by the frontend.

`frontend/src/mocks/backend-*.sample.json` are produced by the real planner (mocked TomTom and
Open-Meteo, frozen clock). The frontend contract test loads them, so a backend response change
fails here until the samples are regenerated with `WRITE_SAMPLES=1 uv run pytest -q
tests/test_frontend_contract.py`.
"""

import json
import os
import re
from datetime import UTC, datetime
from math import cos, pi, sin
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import responses
from freezegun import freeze_time
from rest_framework.test import APIClient

from planner.services.sampling import METERS_PER_MILE, haversine

SAMPLES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "mocks"
ROUTING = re.compile(r"https://api.tomtom.com/routing/1/calculateRoute/.*")
WEATHER = "https://api.open-meteo.com/v1/forecast"
ORIGIN, DESTINATION = (-96.797, 32.7767), (-104.9903, 39.7392)
REQUEST = {
    "origin": {"lat": ORIGIN[1], "lon": ORIGIN[0], "label": "Dallas, TX, USA"},
    "destination": {"lat": DESTINATION[1], "lon": DESTINATION[0], "label": "Denver, CO, USA"},
    "departure": "2026-11-16T08:00:00-06:00", "load_lbs": 42000, "interval_mi": 50, "hos": True,
}
FORECAST_HOURS = 30  # shorter than the trip so late checkpoints have unknown weather


def tomtom_route(bulge: float, mph: float) -> dict:
    points = []
    for i in range(61):
        t = i / 60
        lon = ORIGIN[0] + (DESTINATION[0] - ORIGIN[0]) * t - bulge * sin(pi * t)
        lat = ORIGIN[1] + (DESTINATION[1] - ORIGIN[1]) * t + bulge * sin(pi * t) * .5
        points.append((lon, lat))
    cumulative = [0.0]
    for a, b in zip(points, points[1:], strict=False):
        cumulative.append(cumulative[-1] + haversine(a, b))
    meters = cumulative[-1] * METERS_PER_MILE
    seconds = round(cumulative[-1] / mph * 3600)
    return {
        "summary": {"lengthInMeters": round(meters), "travelTimeInSeconds": seconds},
        "legs": [{"points": [{"latitude": lat, "longitude": lon} for lon, lat in points]}],
        "guidance": {"instructions": [
            {"routeOffsetInMeters": round(cumulative[i] * METERS_PER_MILE),
             "travelTimeInSeconds": round(cumulative[i] / mph * 3600)} for i in range(0, 61, 6)
        ]},
    }


def weather_callback(request):
    query = parse_qs(urlsplit(request.url).query)
    lats = [float(v) for v in query["latitude"][0].split(",")]
    lons = [float(v) for v in query["longitude"][0].split(",")]
    start = int(datetime(2026, 11, 16, tzinfo=UTC).timestamp())
    rows = []
    for lat, lon in zip(lats, lons, strict=True):
        hours = range(FORECAST_HOURS)
        wind = [round(8 + 40 * abs(sin(lon * .7 + h * .11)), 1) for h in hours]
        rows.append({"hourly": {
            "time": [start + h * 3600 for h in hours],
            "wind_speed_10m": wind, "wind_gusts_10m": [round(w * 1.4, 1) for w in wind],
            "rain": [round(max(0, .6 * sin(lat + h * .2)), 2) for h in hours],
            "showers": [0.0 for _ in hours],
            "snowfall": [round(max(0, 3.2 * cos(lon + lat + h * .15)) if lat > 37 else 0, 2)
                         for h in hours],
            "temperature_2m": [round(55 - 1.5 * (lat - 32) - h * .2, 1) for h in hours],
            "weather_code": [3 for _ in hours],
        }})
    return 200, {}, json.dumps(rows if len(rows) > 1 else rows[0])


@freeze_time("2026-11-15T14:00:00Z")
def test_real_plan_and_heatmap_match_frontend_samples(settings, no_network, monkeypatch):
    class FixedUuid:
        hex = "c0ffee1234567890"

    monkeypatch.setattr("planner.services.planner.uuid4", lambda: FixedUuid)
    settings.TOMTOM_API_KEY = "test-key"
    no_network.get(ROUTING, json={"formatVersion": "0.0.12", "routes": [
        tomtom_route(.0, 62), tomtom_route(1.6, 66), tomtom_route(-1.6, 58)]})
    no_network.add_callback(responses.GET, WEATHER, weather_callback)
    client = APIClient()
    plan = client.post("/api/routes/plan", REQUEST, format="json")
    assert plan.status_code == 200, plan.content
    heat = client.get("/api/heatmap", {"plan_id": plan.json()["plan_id"]})
    assert heat.status_code == 200, heat.content
    body = plan.json()
    stamp = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")  # whole seconds, UTC
    assert stamp.match(body["generated_at"]) and stamp.match(body["request"]["departure"])
    for route in body["routes"]:
        etas = [point["eta"] for point in route["checkpoints"]]
        assert all(stamp.match(value) for value in etas + [route["departure"], route["arrival"]])
        assert etas == sorted(etas) and etas[-1] == route["arrival"]
    payloads = {"backend-plan.sample.json": plan.json(), "backend-heatmap.sample.json": heat.json()}
    for name, payload in payloads.items():
        text = json.dumps(payload, indent=1) + "\n"
        if os.getenv("WRITE_SAMPLES"):
            (SAMPLES / name).write_text(text)
        assert (SAMPLES / name).read_text() == text, f"{name} is stale; set WRITE_SAMPLES=1"
