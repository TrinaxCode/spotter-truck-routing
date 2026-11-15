from django.urls import path

from . import views

urlpatterns = [
    path("health", views.health),
    path("geocode", views.geocode_view),
    path("routes/plan", views.plan_view),
    path("heatmap", views.heatmap_view),
    path("departure-options", views.departure_options_view),
]
