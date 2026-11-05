"""Server Management Centre settings: validated, stored in the module's own database, with safe defaults.

Nothing here is a secret. Values the browser may change are listed in ``SCHEMA`` with their limits; anything outside
the limits, or an unknown key, is rejected rather than stored.
"""

from __future__ import annotations

from typing import Any

#: key -> (default, minimum, maximum, description). Lists are validated separately (``LISTS``).
SCHEMA: dict[str, tuple[float, float, float, str]] = {
    "sample_interval_s": (300, 60, 3600, "Seconds between system-metric samples"),
    "daily_snapshot_hour": (18, 0, 23, "IST hour of the daily storage snapshot"),
    "daily_snapshot_minute": (45, 0, 59, "IST minute of the daily storage snapshot"),
    "scan_timeout_s": (180, 10, 1800, "A storage scan stops and is marked partial after this many seconds"),
    "inventory_max_files": (300, 0, 5000, "Largest files recorded per snapshot (0 turns file tracking off)"),
    "disk_warn_pct": (80, 50, 99, "Filesystem used, warning (%)"),
    "disk_crit_pct": (90, 51, 100, "Filesystem used, critical (%)"),
    "disk_free_crit_gb": (2, 0.1, 500, "Free space below this is critical (GB); the sampler pauses at 2 GB"),
    "growth_warn_mb_day": (500, 1, 100000, "Net growth above this per day raises a warning (MB)"),
    "ram_warn_pct": (85, 50, 99, "Memory in use (total minus available), warning (%)"),
    "ram_crit_pct": (92, 51, 100, "Memory in use, critical (%)"),
    "cpu_warn_pct": (85, 30, 100, "CPU use averaged over the last 5 samples, warning (%)"),
    "metrics_retention_days": (14, 1, 365, "Days of system-metric samples kept"),
    "snapshot_retention_days": (730, 30, 3650, "Days of daily storage snapshots kept"),
    "inventory_retention_days": (30, 1, 365, "Days of file inventories kept"),
    "audit_retention_days": (730, 30, 3650, "Days of audit and alert history kept"),
    "forecast_threshold_pct": (90, 50, 99, "Filesystem use at which the forecast counts the days left (%)"),
    "forecast_min_days": (5, 3, 60, "Valid daily observations needed before a forecast is shown"),
}

#: list-valued keys: (default, max items)
LISTS: dict[str, tuple[list[str], int]] = {
    "excluded_dirs": ([], 50),  # empty: every directory counts toward the total unless you exclude it
    "excluded_patterns": ([], 50),
    "manageable_services": (["nse-universe"], 10),
}

SERVICE_ALL = {"nse-universe"}  # the only service an operator may ever be allowed to restart from the website
STATUS_ONLY_SERVICES = ("nse-universe", "caddy", "nse-universe-backup.timer", "nse-universe-monitor.timer", "nse-universe-update.timer")


def defaults() -> dict[str, Any]:
    return {**{k: v[0] for k, v in SCHEMA.items()}, **{k: list(v[0]) for k, v in LISTS.items()}}


class ConfigError(ValueError):
    pass


def validate(changes: dict[str, Any], current: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the cleaned changes or raise ``ConfigError`` naming the first bad key."""
    out: dict[str, Any] = {}
    for k, v in changes.items():
        if k in SCHEMA:
            _, lo, hi, _ = SCHEMA[k]
            if isinstance(v, bool) or not isinstance(v, int | float) or not lo <= v <= hi:
                raise ConfigError(f"{k} must be a number from {lo:g} to {hi:g}")
            out[k] = v
        elif k in LISTS:
            _, cap = LISTS[k]
            if not isinstance(v, list) or len(v) > cap or not all(isinstance(x, str) and 0 < len(x) <= 120 and "\x00" not in x for x in v):
                raise ConfigError(f"{k} must be a list of at most {cap} short strings")
            if k == "manageable_services":
                bad = [x for x in v if x not in SERVICE_ALL]
                if bad:
                    raise ConfigError(f"manageable_services may only contain: {', '.join(sorted(SERVICE_ALL))}")
            if k == "excluded_dirs" and any("/" in x or "\\" in x or x in {".", ".."} for x in v):
                raise ConfigError("excluded_dirs are directory names, not paths")
            out[k] = v
        else:
            raise ConfigError(f"unknown setting {k}")
    merged = {**defaults(), **(current or {}), **out}
    if merged["disk_warn_pct"] >= merged["disk_crit_pct"]:
        raise ConfigError("disk_warn_pct must be below disk_crit_pct")
    if merged["ram_warn_pct"] >= merged["ram_crit_pct"]:
        raise ConfigError("ram_warn_pct must be below ram_crit_pct")
    return out
