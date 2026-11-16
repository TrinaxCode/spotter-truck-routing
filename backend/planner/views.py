from ipaddress import ip_address, ip_network

from rest_framework.decorators import api_view, throttle_classes
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle

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


class ClientThrottle(AnonRateThrottle):
    """Per-client limit; IPv6 clients are keyed by /64, the block one subscriber usually holds."""

    def get_ident(self, request):
        ident = super().get_ident(request)
        try:
            address = ip_address(ident)
        except ValueError:
            return ident
        return str(ip_network(f"{address}/64", strict=False)) if address.version == 6 else ident

    def allow_request(self, request, view):
        allowed = super().allow_request(request, view)
        if not allowed:
            # DRF runs every throttle; tell the service budget not to charge a rejected request.
            request.client_throttled = True
        return allowed


class ServiceBudget(SimpleRateThrottle):
    """One shared counter per scope for the whole service: protects the provider's daily quota."""

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": "all"}

    def allow_request(self, request, view):
        if getattr(request, "client_throttled", False):
            return True
        return super().allow_request(request, view)


def scoped(scope: str, budget: str | None = None):
    """Rate-limit a function view per client (and optionally against a service-wide budget).

    @api_view does not carry a `throttle_scope` attribute over to its view class, so each scope
    gets its own throttle class instead of ScopedRateThrottle.
    """
    def named(base, name):
        class_name = f"{name.title().replace('_', '')}Throttle"
        return type(class_name, (base,), {"scope": name})

    throttles = [named(ClientThrottle, scope)]
    if budget:
        throttles.append(named(ServiceBudget, budget))
    return throttle_classes(throttles)


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


@api_view(["GET"])
@scoped("geocode", budget="geocode_global")
def geocode_view(request):
    serializer = GeocodeSerializer(data=request.query_params)
    serializer.is_valid(raise_exception=True)
    return Response({"results": geocode(serializer.validated_data["q"])})


@api_view(["POST"])
@scoped("plan", budget="plan_global")
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
