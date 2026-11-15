from django.urls import include, path

urlpatterns = [path("api/", include("planner.urls"))]
handler404 = "planner.exceptions.not_found"
handler500 = "planner.exceptions.server_error"
