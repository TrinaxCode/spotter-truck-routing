import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).lower() in {"1", "true", "yes", "on"}


DEBUG = env_bool("DEBUG")
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY is required when DEBUG is false.")
    SECRET_KEY = "development-only-insecure-key-do-not-use-in-production"

ALLOWED_HOSTS = [v.strip() for v in os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
                 if v.strip()]
if railway_domain := os.getenv("RAILWAY_PUBLIC_DOMAIN"):
    # Railway health checks arrive over plain HTTP from this host.
    ALLOWED_HOSTS += [railway_domain, "healthcheck.railway.app"]
CORS_ALLOWED_ORIGINS = [v.strip() for v in os.getenv(
    "CORS_ALLOWED_ORIGINS", "http://localhost:5173" if DEBUG else ""
).split(",") if v.strip()]
CORS_ALLOW_CREDENTIALS = False
CORS_URLS_REGEX = r"^/api/.*$"
INSTALLED_APPS = ["django.contrib.staticfiles", "rest_framework", "corsheaders", "planner"]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
CACHE_DIR = os.getenv("CACHE_DIR", str(BASE_DIR / ".cache"))
CACHES = {"default": {
    "BACKEND": "django.core.cache.backends.filebased.FileBasedCache",
    "LOCATION": CACHE_DIR,
    "OPTIONS": {"MAX_ENTRIES": 10000},
}}
TOMTOM_API_KEY = os.getenv("TOMTOM_API_KEY", "")
OPEN_METEO_API_KEY = os.getenv("OPEN_METEO_API_KEY", "")
# Cargo is specified by the request; routing restrictions require gross vehicle weight.
TRUCK_TARE_LBS = float(os.getenv("TRUCK_TARE_LBS", "35000"))
SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", not DEBUG)
SECURE_REDIRECT_EXEMPT = [r"^api/health$"]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
X_FRAME_OPTIONS = "DENY"
APPEND_SLASH = False
DATA_UPLOAD_MAX_MEMORY_SIZE = 65536
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "planner.exceptions.api_exception_handler",
    "UNAUTHENTICATED_USER": None,
    # Per-client limits protect the provider quotas (TomTom's free tier is 2,500 calls a day and a
    # plan can use five). 429 responses carry Retry-After and the usual error envelope.
    "DEFAULT_THROTTLE_RATES": {
        "plan": os.getenv("THROTTLE_PLAN", "12/min"),
        "geocode": os.getenv("THROTTLE_GEOCODE", "60/min"),
        "plan_data": os.getenv("THROTTLE_PLAN_DATA", "120/min"),
        # Whole-service daily budgets: many clients together must not exhaust the provider quota
        # (300 plans x up to 5 TomTom calls + geocoding stays under 2,500 calls a day).
        "plan_global": os.getenv("THROTTLE_PLAN_GLOBAL", "300/day"),
        "geocode_global": os.getenv("THROTTLE_GEOCODE_GLOBAL", "800/day"),
    },
    # 0 = trust only REMOTE_ADDR. Behind Railway's edge set 1: DRF then takes the entry that proxy
    # appended to X-Forwarded-For. Never None, which would trust a client-supplied header.
    "NUM_PROXIES": int(os.getenv("NUM_PROXIES", "0")),
}
LOGGING = {
    "version": 1, "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
