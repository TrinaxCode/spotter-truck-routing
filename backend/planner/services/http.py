import hashlib
import json
import logging
import time
from datetime import UTC, datetime
from urllib.parse import urlsplit

import requests

from planner.exceptions import UpstreamError

logger = logging.getLogger(__name__)


def utc_iso(value: datetime) -> str:
    """ISO-8601 UTC with `Z`, whole seconds (browsers parse sub-millisecond digits unevenly)."""
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def cache_key(namespace: str, *values) -> str:
    digest = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    return f"{namespace}:v1:{digest}"


def get_json(url: str, params: dict, timeout: float = 10):
    """Never expose a requests exception: its URL may contain provider credentials.

    Failures are logged with the host and the status or exception class only, never the URL.
    """
    host = urlsplit(url).netloc
    for attempt in range(2):
        started = time.monotonic()
        try:
            response = requests.get(url, params=params, timeout=timeout)
            if attempt == 0 and (response.status_code == 429 or response.status_code >= 500):
                logger.warning("%s answered %s; retrying once", host, response.status_code)
                time.sleep(.25)
                continue
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            logger.warning("%s failed after %.1fs: %s%s", host, time.monotonic() - started,
                           type(error).__name__, f" {status}" if status else "")
            raise UpstreamError() from None
    raise UpstreamError()
