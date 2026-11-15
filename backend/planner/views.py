from rest_framework.decorators import api_view
from rest_framework.response import Response

from .serializers import GeocodeSerializer, HeatmapSerializer, PlanSerializer
from .services.geocode import geocode
from .services.heatmap import get_heatmap
from .services.planner import create_plan


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


@api_view(["GET"])
def geocode_view(request):
    serializer = GeocodeSerializer(data=request.query_params)
    serializer.is_valid(raise_exception=True)
    return Response({"results": geocode(serializer.validated_data["q"])})


@api_view(["POST"])
def plan_view(request):
    serializer = PlanSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    return Response(create_plan(serializer.validated_data))


@api_view(["GET"])
def heatmap_view(request):
    serializer = HeatmapSerializer(data=request.query_params)
    serializer.is_valid(raise_exception=True)
    return Response(get_heatmap(serializer.validated_data["plan_id"]))
