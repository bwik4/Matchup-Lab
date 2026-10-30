"""
Matchup Lab - NBA data pipeline
===============================
Pulls free NBA box scores and schedules from SportsDataverse (hoopR data, sourced from
ESPN, refreshed daily on GitHub) and builds the tables behind the NBA side of the site.
Every output is a plain CSV in --out (default ./data/nba).

  logs.csv   every player game this season + last season (players who got minutes):
             points, rebounds, assists, threes, steals, blocks, turnovers, minutes
  games.csv  this season's schedule with scores, records and, when ESPN has them,
             the spread, total and moneylines
  dvp.csv    defense vs position: what each defense allows per game to guards,
             forwards and centers for every prop stat, ranked 1-30 (1 = toughest)
  teams.csv  team names and colors (for the badges)
  meta.txt   season, last game date, build time

Usage:
  pip install pandas pyarrow
  python nba_pipeline.py --out data/nba
"""
import argparse
import datetime as dt
import json
import os
import re
import urllib.request
from zoneinfo import ZoneInfo

import pandas as pd

REL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
ET = ZoneInfo("America/New_York")
STATS = {"points": "pts", "rebounds": "reb", "assists": "ast", "three_point_field_goals_made": "fg3m",
         "steals": "stl", "blocks": "blk", "turnovers": "tov", "minutes": "min"}
COMBOS = {"pra": ["pts", "reb", "ast"], "pr": ["pts", "reb"], "pa": ["pts", "ast"], "ra": ["reb", "ast"], "sb": ["stl", "blk"]}
PROP_STATS = ["pts", "reb", "ast", "fg3m", "pra", "pr", "pa", "ra", "sb"]
POS_MAP = {"G": "G", "PG": "G", "SG": "G", "G-F": "G", "F": "F", "SF": "F", "PF": "F", "F-C": "F", "F-G": "F", "C": "C", "C-F": "C"}
ODDS_COLS = ["spread_line", "total_line", "away_moneyline", "home_moneyline", "away_spread_odds", "home_spread_odds", "over_odds", "under_odds"]


def load(tag, name):
    return pd.read_parquet(f"{REL}/{tag}/{name}.parquet")


def player_logs(season):
    try:
        pb = load("espn_nba_player_boxscores", f"player_box_{season}")
    except Exception as err:
        print(f"nba: no player box scores for {season} ({err})")
        return pd.DataFrame()
    pb = pb[(pb["season_type"].isin([2, 3])) & (~pb["did_not_play"].fillna(False)) & (pb["minutes"].fillna(0) > 0)].copy()
    out = pd.DataFrame({
        "player_id": pd.to_numeric(pb["athlete_id"], errors="coerce").astype("Int64").astype(str),
        "player": pb["athlete_display_name"],
        "position": pb["athlete_position_abbreviation"].fillna("").map(POS_MAP).fillna("F"),
        "season": pb["season"].astype(int),
        "date": pd.to_datetime(pb["game_date"]).dt.strftime("%Y-%m-%d"),
        "game_id": pb["game_id"].astype(str),
        "team": pb["team_abbreviation"],
        "opp": pb["opponent_team_abbreviation"],
        "home": (pb["home_away"] == "home").astype(int),
        "starter": pb["starter"].fillna(False).astype(int),
    })
    for src, dst in STATS.items():
        out[dst] = pd.to_numeric(pb[src], errors="coerce").fillna(0).round(0).astype(int)
    return out


def american(v):
    try:
        if v in (None, "", "EVEN", "even"):
            return 100 if v in ("EVEN", "even") else None
        return int(float(str(v).replace("+", "")))
    except (TypeError, ValueError):
        return None


def espn_odds(dates):
    """Spread / total / moneylines from ESPN's scoreboard for the given dates. Best effort: {} on any failure."""
    found = {}
    for d in dates:
        url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={d:%Y%m%d}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as r:
                sb = json.loads(r.read().decode())
        except Exception as err:
            print(f"nba: ESPN odds unavailable for {d} ({err})")
            continue
        for ev in sb.get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            odds = (comp.get("odds") or [None])[0]
            if not odds:
                continue
            teams = {c.get("homeAway"): c.get("team", {}).get("abbreviation") for c in comp.get("competitors", [])}
            row = {}
            # spread: "details" looks like "LAL -5.5"; spread_line = home team's expected margin (+ = home favored)
            det = str(odds.get("details") or "").split()
            if len(det) == 2:
                try:
                    pts = abs(float(det[1]))
                    row["spread_line"] = pts if det[0] == teams.get("home") else -pts if det[0] == teams.get("away") else None
                except ValueError:
                    pass
            elif str(odds.get("details") or "").upper() in ("EVEN", "PK", "PICK"):
                row["spread_line"] = 0.0
            if odds.get("overUnder") is not None:
                row["total_line"] = float(odds["overUnder"])
            for side in ("home", "away"):
                t = odds.get(f"{side}TeamOdds") or {}
                ml = american(t.get("moneyLine"))
                so = american(t.get("spreadOdds"))
                # newer format: odds["moneyline"]["home"]["close"]["odds"]
                if ml is None:
                    ml = american((((odds.get("moneyline") or {}).get(side) or {}).get("close") or {}).get("odds"))
                if so is None:
                    so = american((((odds.get("pointSpread") or {}).get(side) or {}).get("close") or {}).get("odds"))
                row[f"{side}_moneyline"], row[f"{side}_spread_odds"] = ml, so
            tot = odds.get("total") or {}
            row["over_odds"] = american(((tot.get("over") or {}).get("close") or {}).get("odds")) or american(odds.get("overOdds"))
            row["under_odds"] = american(((tot.get("under") or {}).get("close") or {}).get("odds")) or american(odds.get("underOdds"))
            found[str(ev.get("id"))] = row
    return found


def record(arr):
    """Overall W-L from ESPN's records field (a list of dicts, sometimes stored as its printed text)."""
    if isinstance(arr, str):
        m = re.search(r"'type': 'total', 'summary': '([^']+)'", arr) or re.search(r"'name': 'overall'[^}]*'summary': '([^']+)'", arr)
        return m.group(1) if m else None
    try:
        for r in list(arr):
            if isinstance(r, dict) and (r.get("type") == "total" or r.get("name") == "overall"):
                return r.get("summary")
    except TypeError:
        pass
    return None


def build(season, out):
    os.makedirs(out, exist_ok=True)
    cur, prev = player_logs(season), player_logs(season - 1)
    logs = pd.concat([cur, prev], ignore_index=True).sort_values(["date", "game_id"])
    if cur.empty:
        raise SystemExit("nba: no games for this season yet")
    logs.to_csv(f"{out}/logs.csv", index=False)  # the site adds up combos (PRA etc.) itself
    for k, parts in COMBOS.items():
        logs[k] = logs[parts].sum(axis=1)

    # ---------- schedule + lines ----------
    sc = load("espn_nba_schedules", f"nba_schedule_{season}")
    sc = sc[sc["season_type"].isin([2, 3])].copy()
    when = pd.to_datetime(sc["game_date_time"], utc=True).dt.tz_convert(ET)
    games = pd.DataFrame({
        "game_id": sc["game_id"].astype(str),
        "gameday": when.dt.strftime("%Y-%m-%d"),
        "gametime": when.dt.strftime("%H:%M"),
        "away_team": sc["away_abbreviation"], "home_team": sc["home_abbreviation"],
        "status": sc["status_type_completed"].map(lambda c: "final" if c else "scheduled"),
        "away_score": pd.to_numeric(sc["away_score"], errors="coerce"),
        "home_score": pd.to_numeric(sc["home_score"], errors="coerce"),
        "away_record": sc["away_records"].map(record), "home_record": sc["home_records"].map(record),
    })
    games.loc[games["status"] != "final", ["away_score", "home_score"]] = None
    games = games.sort_values(["gameday", "gametime", "game_id"])
    # keep lines pulled on earlier days, then add today's from ESPN
    old_path = f"{out}/games.csv"
    if os.path.exists(old_path):
        old = pd.read_csv(old_path, dtype={"game_id": str})
        keep = [c for c in ODDS_COLS if c in old.columns]
        games = games.merge(old[["game_id"] + keep], on="game_id", how="left")
    for c in ODDS_COLS:
        if c not in games.columns:
            games[c] = None
    today = dt.datetime.now(ET).date()
    upcoming = sorted({dt.date.fromisoformat(d) for d in games.loc[games["status"] != "final", "gameday"]
                       if today - dt.timedelta(days=1) <= dt.date.fromisoformat(d) <= today + dt.timedelta(days=2)})
    odds = espn_odds(upcoming)
    for gid, row in odds.items():
        m = games["game_id"] == gid
        for k, v in row.items():
            if v is not None:
                games.loc[m, k] = v
    games.to_csv(old_path, index=False)

    # ---------- team names + colors ----------
    pb = load("espn_nba_player_boxscores", f"player_box_{season}")
    tm = pb.drop_duplicates("team_abbreviation")
    teams = pd.DataFrame({"team": tm["team_abbreviation"], "name": tm["team_display_name"], "nick": tm["team_name"],
                          "color": "#" + tm["team_color"].fillna("555555"), "color2": "#" + tm["team_alternate_color"].fillna("888888")})
    teams.sort_values("team").to_csv(f"{out}/teams.csv", index=False)

    # ---------- defense vs position (this season) ----------
    c = logs[logs["season"] == season]
    per = c.groupby(["game_id", "opp", "position"])[PROP_STATS].sum().reset_index()
    gp = c.groupby("opp")["game_id"].nunique().rename("games")
    rows = []
    for pos in ["G", "F", "C"]:
        sub = per[per["position"] == pos].groupby("opp")[PROP_STATS].sum()
        sub = sub.reindex(gp.index).fillna(0).div(gp, axis=0)
        for st in PROP_STATS:
            rk = sub[st].rank(method="min", ascending=True).astype(int)
            for d in sub.index:
                rows.append({"defense": d, "position": pos, "stat": st, "games": int(gp[d]), "per_game": round(sub.at[d, st], 2), "rank": int(rk[d])})
    pd.DataFrame(rows).to_csv(f"{out}/dvp.csv", index=False)

    with open(f"{out}/meta.txt", "w") as f:
        f.write(f"season={season}\nseason_label={season - 1}-{str(season)[2:]}\nthrough_date={cur['date'].max()}\n"
                f"teams={len(teams)}\nbuilt_at={dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}\n")
    print(f"nba: {len(logs)} player games, {len(games)} games ({len(odds)} with ESPN lines), through {cur['date'].max()}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    today = dt.date.today()
    # hoopR names a season by the year it ends: 2026-27 = 2027
    ap.add_argument("--season", type=int, default=today.year + 1 if today.month >= 9 else today.year)
    ap.add_argument("--out", default="data/nba")
    a = ap.parse_args()
    build(a.season, a.out)
