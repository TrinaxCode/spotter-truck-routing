from threading import Lock

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from planner.exceptions import ProviderBudgetExhausted

DAY_S = 24 * 3600
# Via-point routes are requested from parallel threads; serialise the read-modify-write here.
_lock = Lock()


def spend(provider: str, calls: int = 1) -> None:
    """Charges real upstream calls against the provider's service-wide daily budget.

    Called right before each HTTP request, so invalid input and cache hits cost nothing. The file
    cache's incr is get-then-set, so concurrent workers can overshoot by a few calls; the budget
    keeps a margin under the provider's hard quota for that reason.
    """
    limit = settings.PROVIDER_DAILY_BUDGET[provider]
    key = f"budget:{provider}:{timezone.now():%Y%m%d}"
    with _lock:
        cache.add(key, 0, 2 * DAY_S)
        try:
            used = cache.incr(key, calls)
        except ValueError:
            # Evicted between add and incr: start the day's count again.
            cache.set(key, calls, 2 * DAY_S)
            used = calls
    if used > limit:
        raise ProviderBudgetExhausted()
