"""Тесты token-bucket лимитера."""

from __future__ import annotations

from expor_sieve_proxy.ratelimit import TokenBucketLimiter


def test_first_request_allowed(settings):
    rl = TokenBucketLimiter(settings=settings)
    ok, retry = rl.check("1.2.3.4")
    assert ok
    assert retry == 0


def test_burst_then_blocked(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "5")
    from expor_sieve_proxy import config as config_mod

    config_mod.reset_settings_cache()
    settings = config_mod.get_settings()
    rl = TokenBucketLimiter(settings=settings)
    rl._now = lambda: 0.0  # время заморожено
    for i in range(5):
        ok, _ = rl.check("ip")
        assert ok, f"req {i} rejected"
    ok, retry = rl.check("ip")
    assert not ok
    assert retry > 0


def test_refill_after_time(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "60")  # rate=1 token/sec
    from expor_sieve_proxy import config as config_mod

    config_mod.reset_settings_cache()
    settings = config_mod.get_settings()
    rl = TokenBucketLimiter(settings=settings)
    fake = [0.0]
    rl._now = lambda: fake[0]

    for _ in range(60):
        rl.check("ip")
    assert not rl.check("ip")[0]

    fake[0] += 1.5  # один токен и немного
    ok, _ = rl.check("ip")
    assert ok


def test_per_ip_independent(settings):
    rl = TokenBucketLimiter(settings=settings)
    rl._now = lambda: 0.0
    # exhaust ip-A
    for _ in range(settings.rate_limit_per_min):
        rl.check("a")
    assert not rl.check("a")[0]
    # ip-B свеж
    assert rl.check("b")[0]


def test_eviction_does_not_crash(settings):
    rl = TokenBucketLimiter(settings=settings)
    rl.max_buckets = 3
    for i in range(10):
        rl.check(f"ip-{i}")
    assert len(rl._buckets) <= 3
