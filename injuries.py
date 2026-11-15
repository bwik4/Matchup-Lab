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
season_out (1 = ESPN says out for the season, or lists a return date past the season; the
site only acts on these), comment,
label (ESPN's wording: Out, Injured Reserve, Day-To-Day ...), detail (e.g. "Knee"),
return_date, updated.

Source order for each sport (Nov 2026):
  NFL  Sleeper's public API (free, no key; their news desk keeps statuses current), then ESPN, then nflverse.
       Also writes data/sleeper_players.csv (Sleeper id -> nflverse id, depth chart) and data/sleeper_trending.csv.
  NBA  the league's official injury report PDF (updated every 15 minutes on game days), then ESPN.
  College: no reliable public feed, so an empty file (the site uses box-score absences + data/manual.csv).

Older notes:
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
COLS = ["team", "player", "position", "status", "label", "detail", "return_date", "updated", "season_out", "comment",
        "practice", "game", "player_id", "source"]
# a player only counts as done for the year when ESPN says so in words, or lists him out with a return date past the season
SEASON_TXT = re.compile(r"(out for (the )?(rest of the |remainder of the )?(season|year)|season[- ]ending|rest of the (regular )?season|remainder of the (regular )?season|miss the (rest|remainder) of|done for the (season|year)|out indefinitely and (will|is expected to) miss the season)", re.I)


def season_end(sport):
    t = dt.date.today()
    y = t.year if t.month >= 7 else t.year - 1
    return {"nfl": dt.date(y + 1, 1, 15), "nba": dt.date(y + 1, 4, 15), "cfb": dt.date(y + 1, 1, 20), "cbb": dt.date(y + 1, 4, 10)}[sport]


def is_season_out(sport, status, text, ret):
    if status != "out":
        return 0
    try:
        back = dt.date.fromisoformat(str(ret)[:10]) if ret else None
    except ValueError:
        back = None
    if back:  # ESPN's estimated return date decides when there is one
        return int(back > season_end(sport))
    t = text or ""
    if re.search(r"(hope|could|may|might|possib|not ruled out|haven't ruled out|hasn't ruled out|potential)", t, re.I):
        return 0
    return int(bool(SEASON_TXT.search(t)))
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
    ret = (inj.get("details") or {}).get("returnDate", "")
    text = " ".join(str(inj.get(k) or "") for k in ("shortComment", "longComment"))
    return {"team": team, "player": name, "position": pos, "status": status, "label": str(label).replace("_", " ").title() if label else status.title(),
            "detail": detail_of(inj), "return_date": ret, "updated": inj.get("date", ""),
            "season_out": is_season_out(sport, status, text + " " + str(label), ret), "comment": (inj.get("shortComment") or "")[:200],
            "practice": "", "game": "", "player_id": "", "source": "ESPN"}


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
                     "detail": r.get("report_primary_injury", "") if isinstance(r.get("report_primary_injury"), str) else "", "return_date": "", "updated": r.get("date_modified", ""),
                     "season_out": 0, "comment": "", "practice": "", "game": "", "player_id": r.get("gsis_id", ""), "source": "nflverse"})
    return rows


# ---------------------------------------------------------------- NFL: Sleeper
SLEEPER = "https://api.sleeper.app/v1"
SLEEPER_TEAM_FIX = {"LAR": "LA", "WSH": "WAS", "JAC": "JAX"}
SLEEPER_STATUS = {"questionable": "questionable", "doubtful": "doubtful", "out": "out", "ir": "out", "pup": "out", "sus": "out", "cov": "out", "na": "out", "dnr": "out"}
SLEEPER_LABEL = {"IR": "Injured Reserve", "PUP": "PUP list", "Sus": "Suspended", "COV": "Illness list", "NA": "Not active", "DNR": "Not with team"}


def sleeper_nfl():
    """Every NFL player's injury status from Sleeper (free, no key). Also saves the player map + trending adds/drops."""
    players = get(f"{SLEEPER}/players/nfl", timeout=90)
    rows, pmap = [], []
    for sid, p in players.items():
        team = SLEEPER_TEAM_FIX.get(p.get("team") or "", p.get("team"))
        pos = p.get("position") or ""
        name = p.get("full_name") or " ".join(x for x in [p.get("first_name"), p.get("last_name")] if x)
        if not team or not name:
            continue
        if p.get("active") and pos in ("QB", "RB", "WR", "TE", "K", "DEF") or (pos == "DEF"):
            pmap.append({"sleeper_id": sid, "gsis_id": p.get("gsis_id") or "", "player": name, "team": team, "position": pos,
                         "depth_pos": p.get("depth_chart_position") or "", "depth": p.get("depth_chart_order") if p.get("depth_chart_order") is not None else "",
                         "status": p.get("status") or "", "injury": p.get("injury_status") or ""})
        inj = p.get("injury_status")
        st_raw = (p.get("status") or "")
        if not inj and st_raw not in ("Injured Reserve", "Physically Unable to Perform"):
            continue
        key = (inj or ("IR" if st_raw == "Injured Reserve" else "PUP")).lower()
        status = SLEEPER_STATUS.get(key) or norm_status(inj, st_raw)
        if not status:
            continue
        label = SLEEPER_LABEL.get(inj or "", inj) if inj else st_raw
        if st_raw == "Injured Reserve":
            label = "Injured Reserve"
        notes = p.get("injury_notes") or ""
        upd = p.get("news_updated")
        try:
            upd = dt.datetime.fromtimestamp(int(upd) / 1000, dt.timezone.utc).isoformat()[:16] if upd else ""
        except (TypeError, ValueError):
            upd = ""
        text = f"{notes} {label}"
        rows.append({"team": team, "player": name, "position": pos, "status": status, "label": label,
                     "detail": p.get("injury_body_part") or "", "return_date": "", "updated": upd,
                     "season_out": int(bool(SEASON_TXT.search(text)) and not re.search(r"(hope|could|may|might|possib|ruled out)", text, re.I)),
                     "comment": notes[:200], "practice": p.get("practice_participation") or "", "game": "",
                     "player_id": p.get("gsis_id") or "", "source": "Sleeper"})
    pd.DataFrame(pmap).to_csv("data/sleeper_players.csv", index=False)
    print(f"nfl: Sleeper player map {len(pmap)} rows -> data/sleeper_players.csv")
    trend = []
    for kind in ("add", "drop"):
        try:
            for t in get(f"{SLEEPER}/players/nfl/trending/{kind}?lookback_hours=24&limit=25"):
                p = players.get(str(t.get("player_id")), {})
                trend.append({"type": kind, "sleeper_id": t.get("player_id"), "count": t.get("count"),
                              "player": p.get("full_name") or p.get("player_id") or t.get("player_id"), "team": SLEEPER_TEAM_FIX.get(p.get("team") or "", p.get("team") or ""),
                              "position": p.get("position") or "", "gsis_id": p.get("gsis_id") or "", "injury": p.get("injury_status") or ""})
        except Exception as err:
            print(f"nfl: Sleeper trending {kind} failed ({err})")
    if trend:
        pd.DataFrame(trend).to_csv("data/sleeper_trending.csv", index=False)
        print(f"nfl: Sleeper trending {len(trend)} rows -> data/sleeper_trending.csv")
    if DEBUG and rows:
        print("nfl: sample", rows[:3])
    return rows


# ---------------------------------------------------------------- NBA: official league injury report (PDF)
NBA_STATUSES = ("Out", "Doubtful", "Questionable", "Probable", "Available")


def nba_report_url():
    """Newest official NBA injury report PDF. Tries the league's index page, then walks back from now in 15-minute steps."""
    from zoneinfo import ZoneInfo
    pat = re.compile(r"https://ak-static\.cms\.nba\.com/referee/injury/Injury-Report_[0-9_\-]+(?:AM|PM)\.pdf")
    now = dt.datetime.now(ZoneInfo("America/New_York"))
    for y in (now.year, now.year - 1):
        for page in (f"https://official.nba.com/nba-injury-report-{y}-{str(y + 1)[2:]}-season/", f"https://official.nba.com/nba-injury-report-{y}-{str(y + 1)[2:]}/"):
            try:
                with urllib.request.urlopen(urllib.request.Request(page, headers=UA), timeout=20) as r:
                    links = pat.findall(r.read().decode("utf-8", "ignore"))
                if links:
                    return links[-1]
            except Exception:
                continue
    t = now.replace(second=0, microsecond=0, minute=(now.minute // 15) * 15)
    for _ in range(4 * 36):
        h12 = t.strftime("%I")
        ampm = t.strftime("%p")
        cands = [f"{t:%Y-%m-%d}_{h12}_{t:%M}{ampm}"]
        if t.minute == 30:
            cands.append(f"{t:%Y-%m-%d}_{h12}{ampm}")
        for c in cands:
            url = f"https://ak-static.cms.nba.com/referee/injury/Injury-Report_{c}.pdf"
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA, method="HEAD"), timeout=10) as r:
                    if r.status == 200:
                        return url
            except Exception:
                pass
        t -= dt.timedelta(minutes=15)
    return None


def nba_official():
    import io
    import pdfplumber
    url = nba_report_url()
    if not url:
        raise RuntimeError("no report found")
    print(f"nba: official report {url}")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        pdf = pdfplumber.open(io.BytesIO(r.read()))
    t = pd.read_csv("data/nba/teams.csv")
    names = {}
    for _, x in t.iterrows():
        names[x["name"]] = x["team"]
    names.update({"LA Clippers": "LAC", "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL"})
    team_re = re.compile("|".join(sorted((re.escape(n) for n in names), key=len, reverse=True)))
    stamp = re.search(r"Injury-Report_([0-9_\-]+(?:AM|PM))", url).group(1)
    rows, team, game, cuts = [], None, "", None
    for page in pdf.pages:
        words = page.extract_words(keep_blank_chars=False, use_text_flow=False, x_tolerance=1.5)
        hdr = {w["text"]: w["x0"] for w in words if w["text"] in ("Matchup", "Team", "Player", "Current", "Reason")}
        if {"Team", "Player", "Current", "Reason"} <= set(hdr):
            cuts = [("team", hdr["Team"]), ("player", hdr["Player"]), ("status", hdr["Current"]), ("reason", hdr["Reason"])]
            if "Matchup" in hdr:
                cuts.insert(0, ("matchup", hdr["Matchup"]))
        if not cuts:  # pages after the first may repeat no header: reuse the first page's columns
            continue
        def col(x):
            c = "pre"
            for name, x0 in cuts:
                if x >= x0 - 3:
                    c = name
            return c
        lines = {}
        for w in words:
            if w["top"] < 40:  # page header
                continue
            lines.setdefault(round(w["top"] / 3), []).append(w)
        prow = []  # (top, row dict)
        loose = []  # reason fragments without a player on the line
        for k in sorted(lines):
            ws = sorted(lines[k], key=lambda w: w["x0"])
            cells = {}
            for w in ws:
                cells.setdefault(col(w["x0"]), []).append(w["text"])
            txt = {c: " ".join(v) for c, v in cells.items()}
            if txt.get("player") == "Player Name" or txt.get("status", "").startswith("Current"):
                continue
            if txt.get("matchup") and "@" in txt["matchup"]:
                game = txt["matchup"].split()[0]
            tm = txt.get("team", "")
            m = team_re.search(tm) if tm else None
            if m:
                team = names[m.group(0)]
            if "NOT YET SUBMITTED" in " ".join(txt.values()):
                continue
            st = txt.get("status", "").strip()
            top = ws[0]["top"]
            if st in NBA_STATUSES and txt.get("player"):
                rows.append({"_top": top, "_page": page.page_number, "team": team, "pname": txt["player"], "label": st, "reason": txt.get("reason", ""), "game": game})
                prow.append(rows[-1])
            elif txt.get("reason"):
                loose.append((top, txt["reason"]))
        for top, frag in loose:  # wrapped reason text: attach to the nearest player line on the page
            near = min(prow, key=lambda r: abs(r["_top"] - top), default=None)
            if near is not None:
                near["reason"] = (f"{frag} {near['reason']}" if top < near["_top"] else f"{near['reason']} {frag}").strip()
    out = []
    for r in rows:
        nm = r["pname"]
        if "," in nm:
            last, first = [x.strip() for x in nm.split(",", 1)]
            nm = f"{first} {last}"
        reason = re.sub(r"\s+", " ", r["reason"]).strip()
        if r["label"] == "Available" or re.match(r"G League", reason):
            continue  # cleared to play, or a two-way/G League assignment (not an injury)
        detail = reason.replace("Injury/Illness - ", "")
        out.append({"team": r["team"], "player": nm, "position": "", "status": r["label"].lower(), "label": r["label"], "detail": detail,
                    "return_date": "", "updated": stamp, "season_out": 0, "comment": "", "practice": "", "game": r["game"], "player_id": "", "source": "NBA official report"})
    if DEBUG:
        print(f"nba: {len(pdf.pages)} pages, {len(rows)} lines with a status; sample", out[:5])
    return out


def run(sport):
    rows, src = [], None
    primary = {"nfl": (sleeper_nfl, "Sleeper"), "nba": (nba_official, "NBA official injury report")}.get(sport)
    if primary:
        try:
            rows, src = primary[0](), primary[1]
        except Exception as err:
            print(f"{sport}: {primary[1]} failed ({err})")
    if sport in ("cfb", "cbb"):
        # no reliable, current public feed for college (ESPN's is empty or years old), so write an empty file;
        # the site shows box-score absences and data/manual.csv for college instead
        pd.DataFrame(columns=COLS).to_csv(SPORTS[sport][2], index=False)
        print(f"{sport}: no reliable public injury feed; wrote empty file")
        return
    if not rows:
        try:
            rows, src = site_feed(sport), "ESPN injuries feed (backup)"
        except Exception as err:
            print(f"{sport}: ESPN injuries feed failed ({err})")
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
    print(f"{sport}: {len(df)} players ({df['status'].value_counts().to_dict()}, {int(df['season_out'].sum())} out for the season) from {src} -> {out}")


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
