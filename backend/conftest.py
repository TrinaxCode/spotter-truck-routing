import os

# Test startup must be independent of a developer's local .env and credentials.
os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-key-abcdefghijklmnopqrstuvwxyz-0123456789")
os.environ.setdefault("SECURE_SSL_REDIRECT", "false")
