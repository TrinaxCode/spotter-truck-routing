from django.http import JsonResponse
from rest_framework.exceptions import APIException, ParseError, ValidationError
from rest_framework.response import Response
from rest_framework.views import exception_handler


class UpstreamError(APIException):
    status_code = 502
    default_detail = "An upstream provider is unavailable or returned invalid data. Please retry."
    default_code = "upstream_error"


class NotConfigured(APIException):
    status_code = 503
    default_detail = "Routing is not configured. Set TOMTOM_API_KEY on the server."
    default_code = "not_configured"


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)
    if response is None:
        return None
    if isinstance(exc, (ValidationError, ParseError)):
        fields = exc.detail if isinstance(exc.detail, dict) else {"non_field_errors": exc.detail}
        return Response({"error": {"code": "validation_error", "message": "Invalid request.",
                                   "fields": fields}}, status=400)
    code = getattr(exc, "default_code", "request_error")
    return Response({"error": {"code": code, "message": str(exc.detail)}},
                    status=response.status_code, headers=response.headers)


def json_error(status: int, code: str, message: str) -> JsonResponse:
    return JsonResponse({"error": {"code": code, "message": message}}, status=status)


def not_found(request, exception=None):
    return json_error(404, "not_found", "Not found.")


def server_error(request):
    # Django's default 500 page is HTML; the SPA contract is always the JSON error envelope.
    return json_error(500, "internal_error", "Unexpected server error. Please retry.")
