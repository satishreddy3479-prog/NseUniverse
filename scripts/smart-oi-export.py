"""Export the stored sessions the Smart OI divergence research needs, read-only, from the app's own API on the server.

Run ON the server (it only does GET requests to 127.0.0.1:8010 and writes JSON files into a new folder under /tmp):
    python3 smart-oi-export.py /tmp/smartoi_research
Then copy the folder to this machine and run the research (see docs/smart-oi-research.md).

Per stored session day, for the nearest collected expiry on or after that day: the Smart OI totals (all strikes), the per-strike series of ATM +-10
(ATM of the day's first sample), and that day's NIFTY future series. Nothing is modified on the server.
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "http://127.0.0.1:8010/api"
IST = timezone(timedelta(hours=5, minutes=30))


def get(path, **q):
    url = f"{BASE}{path}?{urllib.parse.urlencode({k: v for k, v in q.items() if v is not None})}"
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r)


def day_bounds(day):
    d = datetime.fromisoformat(day).replace(tzinfo=IST)
    return d.astimezone(timezone.utc).isoformat(), (d + timedelta(days=1)).astimezone(timezone.utc).isoformat()


def ist_day(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(IST).date().isoformat()


def main(out):
    import os

    os.makedirs(out, exist_ok=False)
    ex = get("/expiries")
    expiries = sorted(ex.get("last_session", {}).keys())
    per_day = {}  # day -> (expiry, first observation)
    for e in expiries:
        obs = get("/history/observations", expiry=e, max_points=1000).get("observations", [])
        firsts = {}
        for o in obs:
            firsts.setdefault(ist_day(o["retrieved_at"]), o)
        for day, o in firsts.items():
            if day <= e and (day not in per_day or e < per_day[day][0]):
                per_day[day] = (e, o)
    days = sorted(per_day)
    summary = []
    for day in days:
        e, first = per_day[day]
        since, until = day_bounds(day)
        atm = first.get("atm_strike")
        oi = get("/history/oi-series", expiry=e, strikes="all", since=since, until=until, max_points=1000)
        strikes = ",".join(str(int(atm) + 50 * k) for k in range(-10, 11)) if atm else None
        ss = get("/history/strike-series", expiry=e, strikes=strikes, since=since, until=until, max_points=1000) if strikes else None
        fut = get("/futures/series", day=day)  # the future of that day (the series is one session at a time)
        json.dump({"day": day, "expiry": e, "atm": atm, "oi": oi, "strikes": ss, "future": fut}, open(f"{out}/{day}.json", "w"))
        summary.append({"day": day, "expiry": e, "samples": len(oi.get("times", []))})
    json.dump(summary, open(f"{out}/index.json", "w"), indent=1)
    print(json.dumps(summary))


if __name__ == "__main__":
    main(sys.argv[1])
