"""
Matchup Lab - college football data pipeline
============================================
Pulls free college football data from SportsDataverse (ESPN box scores, the full schedule,
betting lines, team info and rosters, refreshed on GitHub) and builds the tables behind the
CFB side of the site. Every output is a plain CSV in --out (default ./data/cfb).

  logs.csv   every QB/RB/WR/TE game this season + last (same column names as the NFL logs)
  games.csv  this season's FBS schedule: kickoff, Top 25 ranks, records, scores, and the
             spread / total (from the betting file, plus ESPN's scoreboard for upcoming games)
  dvp.csv    defense vs position: what each FBS defense allows per game to QBs, RBs, WRs
             and TEs for every prop stat, ranked (1 = toughest)
  teams.csv  team names and colors (for the badges)
  meta.txt   season, last week played, upcoming week, build time

Usage:
  pip install pandas pyarrow
  python cfb_pipeline.py --out data/cfb
"""
import argparse
import datetime as dt
import json
import os
import urllib.request
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

REL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
ET = ZoneInfo("America/New_York")
POS = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE"}
STAT_COLS = ["completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
             "rushing_tds", "long_rush", "receptions", "receiving_yards", "receiving_tds", "long_reception"]
DVP_STATS = ["passing_yards", "attempts", "completions", "passing_tds", "passing_interceptions", "pass_rush_yds", "rushing_yards",
             "carries", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "rush_rec_yds", "long_reception", "long_rush"]
ODDS_COLS = ["spread_line", "total_line", "away_moneyline", "home_moneyline"]


def load(tag, name):
    try:
        return pd.read_parquet(f"{REL}/{tag}/{name}.parquet")
    except Exception as err:
        print(f"cfb: couldn't load {tag}/{name} ({err})")
        return pd.DataFrame()


def num(s):
    return pd.to_numeric(s, errors="coerce")


def player_logs(season, teams_by_id):
    pb = load("espn_cfb_player_box", f"player_box_{season}")
    sc = load("espn_cfb_schedules", f"cfb_schedule_{season}")
    if pb.empty or sc.empty:
        return pd.DataFrame()
    pb = pb[pb["category"].isin(["passing", "rushing", "receiving"])].copy()
    ca = pb["completions/passingAttempts"].astype(str).str.split("/", expand=True)
    pb["completions"], pb["attempts"] = num(ca[0]), num(ca[1]) if ca.shape[1] > 1 else np.nan
    ren = {"passingYards": "passing_yards", "passingTouchdowns": "passing_tds", "interceptions": "passing_interceptions",
           "rushingAttempts": "carries", "rushingYards": "rushing_yards", "rushingTouchdowns": "rushing_tds", "longRushing": "long_rush",
           "receptions": "receptions", "receivingYards": "receiving_yards", "receivingTouchdowns": "receiving_tds", "longReception": "long_reception"}
    for a, b in ren.items():
        pb[b] = num(pb[a])
    # passing / rushing / receiving rows -> one row per player per game
    g = pb.groupby(["game_id", "athlete_id", "team_id"], as_index=False).agg({**{c: "max" for c in STAT_COLS}, "athlete_name": "first"})
    g[STAT_COLS] = g[STAT_COLS].fillna(0).astype(int)
    when = pd.to_datetime(sc["game_date"], utc=True).dt.tz_convert(ET)
    info = pd.DataFrame({"game_id": sc["game_id"], "week": sc["week"], "date": when.dt.strftime("%Y-%m-%d"),
                         "home_id": sc["home_id"], "away_id": sc["away_id"]})
    g = g.merge(info, on="game_id", how="inner")
    g["home"] = (g["team_id"] == g["home_id"]).astype(int)
    g["opp_id"] = np.where(g["home"] == 1, g["away_id"], g["home_id"])
    g["team"] = g["team_id"].map(teams_by_id)
    g["opp"] = g["opp_id"].map(teams_by_id)
    g["season"] = season
    return g.dropna(subset=["team", "opp"])


def positions(logs, season):
    pos = {}
    for yr in (season - 1, season):  # this season's roster wins
        r = load("espn_cfb_rosters", f"cfb_rosters_{yr}")
        if not r.empty:
            for a, p in zip(r["athlete_id"], r["position_abbreviation"]):
                if p in POS:
                    pos[a] = POS[p]
    # anyone not on a roster file: guess from how he was used
    use = logs.groupby("athlete_id")[["attempts", "carries", "receptions"]].sum()
    guess = np.where(use["attempts"] >= 10, "QB", np.where(use["carries"] > use["receptions"], "RB", "WR"))
    return logs["athlete_id"].map(lambda a: pos.get(a)).fillna(logs["athlete_id"].map(dict(zip(use.index, guess))))


def espn_odds(week, season):
    """Upcoming FBS spreads / totals from ESPN's scoreboard. Best effort: {} on any failure."""
    url = f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&seasontype=2&week={week}&dates={season}&limit=300"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25) as r:
            sb = json.loads(r.read().decode())
    except Exception as err:
        print(f"cfb: ESPN odds unavailable ({err})")
        return {}
    out = {}
    for ev in sb.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        odds = (comp.get("odds") or [None])[0]
        if not odds:
            continue
        ids = {c.get("homeAway"): str(c.get("team", {}).get("abbreviation")) for c in comp.get("competitors", [])}
        row = {}
        det = str(odds.get("details") or "").split()
        if len(det) == 2:
            try:
                pts = abs(float(det[1]))
                row["spread_line"] = pts if det[0] == ids.get("home") else -pts if det[0] == ids.get("away") else None
            except ValueError:
                pass
        if odds.get("overUnder") is not None:
            row["total_line"] = float(odds["overUnder"])
        for side in ("home", "away"):
            ml = (odds.get(f"{side}TeamOdds") or {}).get("moneyLine")
            try:
                row[f"{side}_moneyline"] = int(ml) if ml not in (None, "") else None
            except (TypeError, ValueError):
                pass
        out[str(ev.get("id"))] = row
    return out


def build(season, out):
    os.makedirs(out, exist_ok=True)
    ti = load("cfb_team_info", f"cfb_team_info_{season}")
    ti = ti[ti["classification"].isin(["fbs", "fcs"])].copy()
    ti["abbreviation"] = ti["abbreviation"].fillna(ti["school"].str[:4].str.upper())
    dup = ti["abbreviation"].duplicated(keep=False)
    ti.loc[dup & (ti["classification"] == "fcs"), "abbreviation"] = ti["abbreviation"] + "-" + ti["team_id"].astype(str)
    by_id = dict(zip(ti["team_id"], ti["abbreviation"]))
    fbs = set(ti.loc[ti["classification"] == "fbs", "abbreviation"])
    col = lambda c: ti[c].where(ti[c].astype(str).str.match(r"^#[0-9a-fA-F]{6}$"), None)
    teams = pd.DataFrame({"team": ti["abbreviation"], "name": ti["school"] + " " + ti["mascot"].fillna(""), "nick": ti["school"],
                          "color": col("color").fillna("#555555"), "color2": col("alt_color").fillna("#888888"), "fbs": ti["classification"].eq("fbs").astype(int)})
    teams.sort_values("team").to_csv(f"{out}/teams.csv", index=False)

    cur = player_logs(season, by_id)
    if cur.empty:
        raise SystemExit("cfb: no games for this season yet")
    prev = player_logs(season - 1, by_id)
    prev = prev[prev["athlete_id"].isin(set(cur["athlete_id"]))]  # last season only for players still around
    logs = pd.concat([cur, prev], ignore_index=True)
    logs["position"] = positions(logs, season)
    logs = logs[logs["position"].isin(["QB", "RB", "WR", "TE"])]
    logs["rush_rec_yds"] = logs["rushing_yards"] + logs["receiving_yards"]
    logs["pass_rush_yds"] = logs["passing_yards"] + logs["rushing_yards"]
    logs = logs.rename(columns={"athlete_id": "player_id", "athlete_name": "player"}).sort_values(["season", "week", "game_id"])
    keep = ["player_id", "player", "position", "season", "week", "date", "game_id", "team", "opp", "home"] + STAT_COLS + ["rush_rec_yds", "pass_rush_yds"]
    logs[keep].to_csv(f"{out}/logs.csv", index=False)

    # ---------- schedule (FBS games), ranks, records, lines ----------
    sc = load("cfb_schedules", f"cfb_schedules_{season}")
    sc = sc[sc["home_id"].isin(by_id) & sc["away_id"].isin(by_id)].copy()
    sc["home_team"], sc["away_team"] = sc["home_id"].map(by_id), sc["away_id"].map(by_id)
    sc = sc[sc["home_team"].isin(fbs) | sc["away_team"].isin(fbs)]
    when = pd.to_datetime(sc["start_date"], utc=True).dt.tz_convert(ET)
    games = pd.DataFrame({
        "game_id": sc["game_id"].astype(str), "week": sc["week"].astype(int),
        "gameday": when.dt.strftime("%Y-%m-%d"), "gametime": np.where(sc["start_time_tbd"].fillna(False), "", when.dt.strftime("%H:%M")),
        "away_team": sc["away_team"], "home_team": sc["home_team"],
        "away_rank": num(sc["away_rank"]), "home_rank": num(sc["home_rank"]),
        "status": np.where(sc["completed"].fillna(False), "final", "scheduled"),
        "away_score": num(sc["away_points"]), "home_score": num(sc["home_points"]),
        "neutral": sc["neutral_site"].fillna(False).astype(int),
    }).sort_values(["week", "gameday", "gametime"])
    # records (straight up) going into each game, from finals
    wl = {}
    recs = {"away_record": [], "home_record": []}
    for _, g in games.iterrows():
        for side in ("away", "home"):
            w, l = wl.get(g[f"{side}_team"], (0, 0))
            recs[f"{side}_record"].append(f"{w}-{l}")
        if g["status"] == "final" and pd.notna(g["home_score"]):
            hw = g["home_score"] > g["away_score"]
            for side, won in (("home", hw), ("away", not hw)):
                w, l = wl.get(g[f"{side}_team"], (0, 0))
                wl[g[f"{side}_team"]] = (w + won, l + (not won))
    games = games.assign(**recs)
    # current record for games not played yet
    for side in ("away", "home"):
        m = games["status"] != "final"
        games.loc[m, f"{side}_record"] = games.loc[m, f"{side}_team"].map(lambda t: "%d-%d" % wl.get(t, (0, 0)))
    bet = load("espn_cfb_betting", f"betting_{season}")
    if not bet.empty:
        bet = pd.DataFrame({"game_id": bet["game_id"].astype(str), "spread_line": -num(bet["home_team_spread"]), "total_line": num(bet["over_under"])})
        games = games.merge(bet, on="game_id", how="left")
    old_path = f"{out}/games.csv"
    if os.path.exists(old_path):  # keep upcoming lines pulled on earlier days
        old = pd.read_csv(old_path, dtype={"game_id": str})
        for c in ODDS_COLS:
            if c in old.columns:
                prior = games["game_id"].map(dict(zip(old["game_id"], old[c])))
                games[c] = games[c].fillna(prior) if c in games.columns else prior
    for c in ODDS_COLS:
        if c not in games.columns:
            games[c] = np.nan
    open_weeks = games.loc[games["status"] != "final", "week"]
    up_week = int(open_weeks.min()) if len(open_weeks) else int(games["week"].max())
    found = espn_odds(up_week, season)
    for gid, row in found.items():
        m = games["game_id"] == gid
        for k, v in row.items():
            if v is not None:
                games.loc[m, k] = v
    games.to_csv(old_path, index=False)

    # ---------- defense vs position (FBS defenses, this season) ----------
    c = logs[logs["season"] == season]
    per = c.groupby(["game_id", "opp", "position"])[DVP_STATS].agg(
        {s: ("max" if s.startswith("long") else "sum") for s in DVP_STATS}).reset_index()
    gp = c.groupby("opp")["game_id"].nunique().rename("games")
    gp = gp[gp.index.isin(fbs)]
    rows = []
    for pos in ["QB", "RB", "WR", "TE"]:
        sub = per[per["position"] == pos].groupby("opp")[DVP_STATS].sum().reindex(gp.index).fillna(0).div(gp, axis=0)
        for st in DVP_STATS:
            rk = sub[st].rank(method="min", ascending=True).astype(int)
            for d in sub.index:
                rows.append({"defense": d, "position": pos, "stat": st, "games": int(gp[d]), "per_game": round(sub.at[d, st], 2), "rank": int(rk[d])})
    pd.DataFrame(rows).to_csv(f"{out}/dvp.csv", index=False)

    with open(f"{out}/meta.txt", "w") as f:
        done = games.groupby("week")["status"].apply(lambda x: (x == "final").all())
        thru = int(done[done].index.max()) if done.any() else 0
        f.write(f"season={season}\nthrough_week={thru}\nupcoming_week={up_week}\nfbs_teams={len(gp)}\n"
                f"built_at={dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}\n")
    print(f"cfb: {len(logs)} player games, {len(games)} FBS games, week {up_week} next ({len(found)} with ESPN lines)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    today = dt.date.today()
    ap.add_argument("--season", type=int, default=today.year if today.month >= 8 else today.year - 1)
    ap.add_argument("--out", default="data/cfb")
    a = ap.parse_args()
    build(a.season, a.out)
