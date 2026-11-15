from datetime import timedelta
from math import isfinite

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers


class FiniteFloatField(serializers.FloatField):
    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if isinstance(data, bool) or not isfinite(value):
            raise serializers.ValidationError("A finite number is required.")
        return value


class StrictIntegerField(serializers.IntegerField):
    def to_internal_value(self, data):
        if isinstance(data, bool) or not isinstance(data, int):
            raise serializers.ValidationError("An integer is required.")
        return super().to_internal_value(data)


class LocationSerializer(serializers.Serializer):
    lat = FiniteFloatField(min_value=-90, max_value=90)
    lon = FiniteFloatField(min_value=-180, max_value=180)
    label = serializers.CharField(max_length=200, required=False, default="", allow_blank=True)


class DepartureField(serializers.DateTimeField):
    def to_internal_value(self, value):
        try:
            parsed = parse_datetime(value) if isinstance(value, str) else None
        except ValueError:
            parsed = None
        if parsed is None or timezone.is_naive(parsed):
            raise serializers.ValidationError("Use an ISO-8601 timestamp with a timezone offset.")
        return super().to_internal_value(value)


class PlanSerializer(serializers.Serializer):
    origin = LocationSerializer()
    destination = LocationSerializer()
    departure = DepartureField()
    load_lbs = StrictIntegerField(min_value=0, max_value=80000)
    interval_mi = StrictIntegerField(default=25)
    hos = serializers.BooleanField(default=True)

    def validate_interval_mi(self, value):
        if value not in (10, 25, 50):
            raise serializers.ValidationError("Choose 10, 25 or 50 miles.")
        return value

    def validate_departure(self, value):
        now = timezone.now()
        if not now - timedelta(hours=1) <= value <= now + timedelta(days=14):
            raise serializers.ValidationError(
                "Departure must be between one hour ago and 14 days ahead.")
        return value

    def validate(self, attrs):
        a, b = attrs["origin"], attrs["destination"]
        if a["lat"] == b["lat"] and a["lon"] == b["lon"]:
            raise serializers.ValidationError({"destination": "Choose a different destination."})
        return attrs


class GeocodeSerializer(serializers.Serializer):
    q = serializers.CharField(min_length=3, max_length=200)


class HeatmapSerializer(serializers.Serializer):
    plan_id = serializers.RegexField(r"^[a-zA-Z0-9_-]{1,64}$")
