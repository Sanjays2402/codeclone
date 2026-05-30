"""Real Kubernetes-style liveness + readiness probes.

Liveness (`/health`, `/healthz`): the process is alive. Cheap. Returns 200
unless the event loop is wedged. Never depends on the model handle: a model
load failure should not cause kubelet to kill+restart the pod in a hot loop,
since the next restart will hit the same failure. Instead readiness goes
unready and traffic is drained while alerts fire.

Readiness (`/ready`, `/readyz`): the pod is ready to receive traffic. This
must reflect real state:

* The model handle is loaded and can answer a trivial probe call.
* The process has not begun shutting down (SIGTERM flips the flag so
  kube-proxy stops sending new requests during the terminationGracePeriod).
* Any optional dependency probe registered by callers is healthy.

The probe runs the handle through a tiny `token_count("ready")` call rather
than `generate(...)`, so it costs microseconds and exercises tokenizer
plumbing without burning a GPU step. Results are cached for `cache_seconds`
so that a 1 rps liveness loop does not stress the model.
"""

from __future__ import annotations

import contextlib
import signal
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from codeclone_config.logging import get_logger

log = get_logger(__name__)


@dataclass
class ProbeResult:
    ok: bool
    reason: str
    details: dict


class ReadinessProbe:
    """Thread-safe readiness state with handle probe + shutdown latch."""

    def __init__(
        self,
        handle_probe: Callable[[], None],
        *,
        cache_seconds: float = 2.0,
        install_signal_handler: bool = True,
    ) -> None:
        self._handle_probe = handle_probe
        self._cache_seconds = cache_seconds
        self._lock = threading.Lock()
        self._cached: ProbeResult | None = None
        self._cached_at: float = 0.0
        self._shutting_down = False
        # Extra dependency checks (name -> callable raising on failure).
        self._deps: dict[str, Callable[[], None]] = {}

        if install_signal_handler:
            try:
                self._install_signal_handler()
            except (ValueError, RuntimeError):
                # Not on main thread (e.g. tests). Caller can flip manually.
                log.debug("readiness.signal_handler.skipped")

    def _install_signal_handler(self) -> None:
        prev_term = signal.getsignal(signal.SIGTERM)

        def _handler(signum, frame):
            log.info("readiness.sigterm_received")
            self.begin_shutdown()
            if callable(prev_term):
                with contextlib.suppress(Exception):  # pragma: no cover
                    prev_term(signum, frame)

        signal.signal(signal.SIGTERM, _handler)

    def register_dependency(self, name: str, check: Callable[[], None]) -> None:
        """Register an extra readiness check (e.g. database ping)."""
        self._deps[name] = check

    def begin_shutdown(self) -> None:
        with self._lock:
            self._shutting_down = True
            self._cached = None  # invalidate

    def is_shutting_down(self) -> bool:
        return self._shutting_down

    def check(self) -> ProbeResult:
        with self._lock:
            now = time.monotonic()
            if (
                self._cached is not None
                and (now - self._cached_at) < self._cache_seconds
                and not self._shutting_down
            ):
                return self._cached

            if self._shutting_down:
                result = ProbeResult(
                    ok=False,
                    reason="shutting_down",
                    details={"shutting_down": True},
                )
                self._cached = result
                self._cached_at = now
                return result

            details: dict = {}
            # Model handle probe.
            t0 = time.perf_counter()
            try:
                self._handle_probe()
                details["model_ms"] = round((time.perf_counter() - t0) * 1000, 2)
            except Exception as exc:
                log.warning("readiness.handle_probe_failed", error=str(exc))
                result = ProbeResult(
                    ok=False,
                    reason=f"model_probe_failed: {exc.__class__.__name__}",
                    details={"model_error": str(exc)},
                )
                self._cached = result
                self._cached_at = now
                return result

            # Optional dependency probes.
            for name, check in self._deps.items():
                try:
                    check()
                    details[f"{name}_ok"] = True
                except Exception as exc:
                    log.warning(
                        "readiness.dependency_failed", dep=name, error=str(exc)
                    )
                    result = ProbeResult(
                        ok=False,
                        reason=f"dependency_failed:{name}",
                        details={f"{name}_error": str(exc), **details},
                    )
                    self._cached = result
                    self._cached_at = now
                    return result

            result = ProbeResult(ok=True, reason="ready", details=details)
            self._cached = result
            self._cached_at = now
            return result
