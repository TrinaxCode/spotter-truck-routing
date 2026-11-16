from rest_framework.decorators import api_view, throttle_classes
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from .serializers import (
    DepartureOptionsSerializer,
    GeocodeSerializer,
    HeatmapSerializer,
    PlanSerializer,
)
from .services.departures import get_departure_options
from .services.geocode import geocode
from .services.heatmap import get_heatmap
from .services.planner import create_plan


def scoped(scope: str):
    """Rate-limit a function view per client IP under a DEFAULT_THROTTLE_RATES scope.

    @api_view does not carry a `throttle_scope` attribute over to its view class, so each scope
    gets its own throttle class instead of ScopedRateThrottle.
    """
    name = f"{scope.title().replace('_', '')}Throttle"
    throttle = type(name, (AnonRateThrottle,), {"scope": scope})
    return throttle_classes([throttle])


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


@api_view(["GET"])
@scoped("geocode")
def geocode_view(request):
    serializer = GeocodeSerializer(data=request.query_params)
    serializer.is_valid(raise_exception=True)
    return Response({"results": geocode(serializer.validated_data["q"])})


@api_view(["POST"])
@scoped("plan")
def plan_view(request):
    serializer = PlanSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    return Response(create_plan(serializer.validated_data))


@api_view(["GET"])
@scoped("plan_data")
def heatmap_view(request):
    serializer = HeatmapSerializer(data=request.query_params)
    serializer.is_valid(raise_exception=True)
    return Response(get_heatmap(serializer.validated_data["plan_id"]))


@api_view(["GET"])
@scoped("plan_data")
def departure_options_view(request):
    serializer = DepartureOptionsSerializer(data=request.query_params)
    serializer.is_valid(raise_exception=True)
    return Response(get_departure_options(serializer.validated_data["plan_id"]))
