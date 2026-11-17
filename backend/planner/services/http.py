import hashlib
import json
import logging
import time
from datetime import UTC, datetime
from urllib.parse import urlsplit

import requests

from planner.exceptions import UpstreamError

logger = logging.getLogger(__name__)
CONNECT_TIMEOUT_S = 5


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
            # A healthy connection opens in well under a second; fail fast on a dead one and retry.
            limits = (min(CONNECT_TIMEOUT_S, timeout), timeout)
            response = requests.get(url, params=params, timeout=limits)
            if attempt == 0 and (response.status_code == 429 or response.status_code >= 500):
                logger.warning("%s answered %s; retrying once", host, response.status_code)
                time.sleep(.25)
                continue
            response.raise_for_status()
            payload = response.json()
            logger.info("%s answered %s in %.1fs (%d kB)", host, response.status_code,
                        time.monotonic() - started, len(response.content) // 1024)
            return payload
        except (requests.ConnectionError, requests.ConnectTimeout) as error:
            # Nothing reached the provider, so the idempotent GET can safely be sent again.
            if attempt == 0:
                logger.warning("%s connection failed (%s); retrying once", host,
                               type(error).__name__)
                time.sleep(.25)
                continue
            logger.warning("%s failed after %.1fs: %s", host, time.monotonic() - started,
                           type(error).__name__)
            raise UpstreamError() from None
        except (requests.RequestException, ValueError) as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            logger.warning("%s failed after %.1fs: %s%s", host, time.monotonic() - started,
                           type(error).__name__, f" {status}" if status else "")
            raise UpstreamError() from None
    raise UpstreamError()
