import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-key-abcdefghijklmnopqrstuvwxyz-0123456789")

from .settings import *  # noqa: E402,F403

SECURE_SSL_REDIRECT = False
TOMTOM_API_KEY = ""
OPEN_METEO_API_KEY = ""
ALLOWED_HOSTS = ["testserver", "localhost", "127.0.0.1"]
# Tests exercise API middleware without depending on collected development assets.
WHITENOISE_AUTOREFRESH = True
