import json
from pathlib import Path

import pytest
import responses
from django.core.cache import cache


@pytest.fixture(autouse=True)
def isolated_shared_cache(settings, tmp_path):
    settings.CACHES = {"default": {
        "BACKEND": "django.core.cache.backends.filebased.FileBasedCache",
        "LOCATION": str(tmp_path / "cache"),
    }}
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def no_network():
    with responses.RequestsMock(assert_all_requests_are_fired=False) as mock:
        yield mock


@pytest.fixture
def fixture_json():
    def read(name):
        return json.loads((Path(__file__).parent / "fixtures" / name).read_text())
    return read
