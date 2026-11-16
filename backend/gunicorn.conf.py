"""Loaded automatically by gunicorn from the working directory, whatever start command the host
uses, so timeouts and concurrency do not depend on a platform config file being honoured."""

import os

bind = f"0.0.0.0:{os.getenv('PORT', '8000')}"
workers = int(os.getenv("WEB_CONCURRENCY", "2"))
# Threads keep a worker responsive while another request waits on TomTom or Open-Meteo.
worker_class = "gthread"
threads = int(os.getenv("GUNICORN_THREADS", "4"))
# A coast-to-coast plan with a cold cache can take ~30 s upstream; leave ample headroom.
timeout = int(os.getenv("GUNICORN_TIMEOUT", "120"))
graceful_timeout = 30
accesslog = "-"
