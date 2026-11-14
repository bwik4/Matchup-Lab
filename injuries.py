"""
Matchup Lab - injury report
===========================
Pulls the current injury list for NFL, NBA, college football and college basketball from
ESPN and writes one small CSV per sport. The site uses it on each game's Players tab to tag
players as questionable / doubtful and to pull players who are out.

  data/injuries.csv        NFL
  data/nba/injuries.csv
  data/cfb/injuries.csv
  data/cbb/injuries.csv

Columns: team, player, position, status (out / doubtful / questionable / probable),
label (ESPN's wording: Out, Injured Reserve, Day-To-Day ...), detail (e.g. "Knee"),
return_date, updated.

Source order for each sport:
  1. ESPN's league-wide injuries feed (one request)
  2. college only, if that comes back empty: ESPN's per-team injury lists for every team
     on the upcoming slate (scoreboard -> team ids -> injuries)
  3. NFL only, if ESPN fails: nflverse's weekly injury report

Every step is best effort. A sport that fails keeps yesterday's file.

Usage:
  python injuries.py            # all four sports
  python injuries.py --debug    # also print the raw shape of the first entries
"""
import argparse
import datetime as dt
import json
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

UA = {"User-Agent": "Mozilla/5.0"}
SITE = "https://site.api.espn.com/apis/site/v2/sports"
CORE = "https://sports.core.api.espn.com/v2/sports"
SPORTS = {
    #  key   path                                      out file                    team names file
    "nfl": ("football/nfl", "football/leagues/nfl", "data/injuries.csv", "data/team_info.csv"),
    "nba": ("basketball/nba", "basketball/leagues/nba", "data/nba/injuries.csv", "data/nba/teams.csv"),
    "cfb": ("football/college-football", "football/leagues/college-football", "data/cfb/injuries.csv", "data/cfb/teams.csv"),
    "cbb": ("basketball/mens-college-basketball", "basketball/leagues/mens-college-basketball", "data/cbb/injuries.csv", "data/cbb/teams.csv"),
}
# ESPN abbreviation -> the code the site uses (nflverse differs on two NFL teams)
ABBR_FIX = {"nfl": {"LAR": "LA", "WSH": "WAS"}}
COLS = ["team", "player", "position", "status", "label", "detail", "return_date", "updated"]
DEBUG = False


def get(url, timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.loads(r.read().decode())


def norm_status(*words):
    s = " ".join(str(w or "") for w in words).lower()
    if any(k in s for k in ("out", "injured reserve", "injured_reserve", " ir", "suspen", "physically unable", "pup", "non-football", "inactive")):
        return "out"
    if "doubt" in s:
        return "doubtful"
    if "question" in s or "day-to-day" in s or "day to day" in s or "game time" in s or "gtd" in s:
        return "questionable"
    if "probable" in s:
        return "probable"
    return None


def detail_of(inj):
    d = inj.get("details") or {}
    part = " ".join(x for x in [d.get("side") if d.get("side") not in (None, "Not Specified") else None, d.get("type")] if x)
    extra = d.get("detail")
    txt = part or ""
    if extra and extra not in ("Not Specified",) and extra.lower() not in txt.lower():
        txt = f"{txt} ({extra})" if txt else extra
    return txt or (inj.get("shortComment") or "")[:80]


def team_codes(sport):
    """ESPN display name / nickname -> site team code, from the teams file the site already uses."""
    path = SPORTS[sport][3]
    if not os.path.exists(path):
        return {}
    t = pd.read_csv(path)
    m = {}
    for _, r in t.iterrows():
        for k in ("name", "nick", "team"):
            if k in t.columns and isinstance(r[k], str):
                m.setdefault(r[k].lower(), r["team"])
    return m


def row_from(sport, inj, team_hint, names):
    ath = inj.get("athlete") or {}
    name = ath.get("displayName") or " ".join(x for x in [ath.get("firstName"), ath.get("lastName")] if x)
    if not name:
        return None
    when = str(inj.get("date") or "")[:10]
    try:
        if when and (dt.date.today() - dt.date.fromisoformat(when)).days > 60:
            return None  # stale entry ESPN never cleared
    except ValueError:
        pass
    typ = inj.get("type") or {}
    label = inj.get("status") or typ.get("description") or typ.get("name") or ""
    status = norm_status(label, typ.get("name"), typ.get("abbreviation")) or norm_status((inj.get("details") or {}).get("fantasyStatus", {}).get("description"))
    if not status:
        return None
    team = None
    at = ath.get("team") or {}
    if isinstance(at, dict) and at.get("abbreviation"):
        team = at["abbreviation"]
    team = team or team_hint
    if team and team.lower() in names:
        team = names[team.lower()]
    team = ABBR_FIX.get(sport, {}).get(team, team)
    pos = (ath.get("position") or {}).get("abbreviation", "") if isinstance(ath.get("position"), dict) else ""
    return {"team": team, "player": name, "position": pos, "status": status, "label": str(label).replace("_", " ").title() if label else status.title(),
            "detail": detail_of(inj), "return_date": (inj.get("details") or {}).get("returnDate", ""), "updated": inj.get("date", "")}


def site_feed(sport):
    data = get(f"{SITE}/{SPORTS[sport][0]}/injuries")
    groups = data.get("injuries") or []
    if DEBUG:
        print(f"{sport}: top keys {list(data)[:8]}, {len(groups)} team groups")
        if groups:
            g0 = groups[0]
            print(f"{sport}: group keys {list(g0)[:10]}")
            if g0.get("injuries"):
                print(f"{sport}: first injury {json.dumps(g0['injuries'][0])[:900]}")
    names, rows = team_codes(sport), []
    for g in groups:
        hint = g.get("abbreviation") or (g.get("team") or {}).get("abbreviation") or g.get("displayName")
        for inj in g.get("injuries") or []:
            r = row_from(sport, inj, hint, names)
            if r:
                rows.append(r)
    return rows


def slate_team_ids(sport):
    """ESPN team ids + abbreviations for every team on the next few days of games."""
    path, ids = SPORTS[sport][0], {}
    today = dt.date.today()
    if sport == "cfb":
        urls = [f"{SITE}/{path}/scoreboard?groups=80&limit=300"]
    else:
        urls = [f"{SITE}/{path}/scoreboard?groups=50&limit=400&dates={(today + dt.timedelta(days=i)):%Y%m%d}" for i in range(2)]
    for u in urls:
        try:
            sb = get(u)
        except Exception as err:
            print(f"{sport}: scoreboard unavailable ({err})")
            continue
        for ev in sb.get("events", []):
            for c in ((ev.get("competitions") or [{}])[0]).get("competitors", []):
                t = c.get("team") or {}
                if t.get("id") and t.get("abbreviation"):
                    ids[str(t["id"])] = t["abbreviation"]
    return ids


def team_feed(sport):
    """Per-team ESPN injury lists (core API) for teams on the upcoming slate."""
    league, names = SPORTS[sport][1], team_codes(sport)
    ids = slate_team_ids(sport)
    print(f"{sport}: checking {len(ids)} teams one by one")
    first = next(iter(ids), None)

    def one(item):
        tid, abbr = item
        out = []
        try:
            lst = get(f"{CORE}/{league}/teams/{tid}/injuries?limit=100", timeout=15)
        except Exception as err:
            if DEBUG and tid == first:
                print(f"{sport}: team {abbr} injuries failed ({err})")
            return out
        for ref in lst.get("items", [])[:40]:
            try:
                inj = get(ref["$ref"], timeout=15) if "$ref" in ref else ref
                ath = inj.get("athlete") or {}
                if "$ref" in ath and not ath.get("displayName"):
                    inj["athlete"] = get(ath["$ref"], timeout=15)
                    p = inj["athlete"].get("position")
                    if isinstance(p, dict) and "$ref" in p and not p.get("abbreviation"):
                        inj["athlete"]["position"] = get(p["$ref"], timeout=15)
                inj["athlete"].pop("team", None)
                r = row_from(sport, inj, abbr, names)
                if r:
                    out.append(r)
            except Exception:
                continue
        return out

    rows = []
    with ThreadPoolExecutor(16) as ex:
        for part in ex.map(one, ids.items()):
            rows.extend(part)
    return rows


def nflverse_feed():
    """nflverse weekly injury report (NFL fallback). Uses the latest week in the file."""
    season = dt.date.today().year if dt.date.today().month >= 8 else dt.date.today().year - 1
    df = pd.read_csv(f"https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{season}.csv")
    df = df[df["week"] == df["week"].max()]
    rows = []
    for _, r in df.iterrows():
        st = norm_status(r.get("report_status"))
        if not st:
            continue
        rows.append({"team": r["team"], "player": r["full_name"], "position": r.get("position", ""), "status": st, "label": r.get("report_status", ""),
                     "detail": r.get("report_primary_injury", "") if isinstance(r.get("report_primary_injury"), str) else "", "return_date": "", "updated": r.get("date_modified", "")})
    return rows


def run(sport):
    rows, src = [], None
    try:
        rows, src = site_feed(sport), "ESPN injuries feed"
    except Exception as err:
        print(f"{sport}: ESPN injuries feed failed ({err})")
    if not rows and sport in ("cfb", "cbb"):
        try:
            rows, src = team_feed(sport), "ESPN team injury lists"
        except Exception as err:
            print(f"{sport}: team injury lists failed ({err})")
    if not rows and sport == "nfl":
        try:
            rows, src = nflverse_feed(), "nflverse injury report"
        except Exception as err:
            print(f"nfl: nflverse injuries failed ({err})")
    out = SPORTS[sport][2]
    if not rows:
        if sport in ("cfb", "cbb"):
            # nothing published is a real answer for college: write an empty file so stale tags don't linger
            pd.DataFrame(columns=COLS).to_csv(out, index=False)
        print(f"{sport}: no injuries found")
        return
    df = pd.DataFrame(rows, columns=COLS).dropna(subset=["team", "player"]).drop_duplicates(["team", "player"], keep="first")
    df.to_csv(out, index=False)
    print(f"{sport}: {len(df)} players ({df['status'].value_counts().to_dict()}) from {src} -> {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--sports", default="nfl,nba,cfb,cbb")
    a = ap.parse_args()
    DEBUG = a.debug
    for sp in a.sports.split(","):
        try:
            run(sp)
        except Exception as err:
            print(f"{sp}: injuries skipped ({err})")
