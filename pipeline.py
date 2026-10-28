"""
NFL Matchup Lab - data pipeline (betting edition)
=================================================
Pulls free NFL data from nflverse (GitHub) and builds the tables behind the site.
Every output is a plain CSV in --out (default ./data).

  matchups.csv         defense vs position, long format: one row per defense / window /
                       position / stat with the per-game amount allowed and a 1-32 rank
                       (1 = toughest defense, 32 = easiest matchup). Windows: season, last3.
                       Stats include real box-score stats plus fantasy points (std/half/ppr).
  matchups_weekly.csv  what each defense allowed to each position, every week
  logs.csv             every QB/RB/WR/TE game (this season + last) with box score,
                       red-zone usage, longest completion / rush / reception, air yards
                       and fantasy points
  players.csv          this season's per-game averages, next opponent, team implied total
  games.csv            every game this season: Vegas lines (with the juice on the spread and
                       total), no-vig win %, implied totals, rest days, roof, listed starting QBs,
                       final score, and whether it covered / went over
  team_info.csv        team names and colors (for the team badges on the site)
  teams.csv            team efficiency (EPA/play, success rate, yards/play, pass rate,
                       pace, red-zone TD %, 3rd-down %, explosive plays, turnover margin)
                       and betting records (straight up, against the spread, over/under)
  avail.csv            every player on every roster (this season + last): the weeks he was on
                       the team and the weeks he took a snap, for "games without X" filters
  team_games.csv       one row per team per game (this season + last) with the score, line and
                       the offense/defense play totals, so the site can re-total any set of games
  meta.txt             season, last week played, upcoming week, build time

Usage:
  pip install pandas
  python pipeline.py                       # current season, auto-detected
  python pipeline.py --season 2026 --out ./data

Source: https://github.com/nflverse/nflverse-data
"""
import argparse
import datetime as dt
import os

import numpy as np
import pandas as pd

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
POSITIONS = ["QB", "RB", "WR", "TE"]

BOX = [
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered",
    "carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds",
]
EXTRA = ["passing_air_yards", "receiving_air_yards", "receiving_yards_after_catch"]
FP = ["fp_std", "fp_half", "fp_ppr"]
# longest single play in a game (from play-by-play)
LONG = ["long_completion", "long_rush", "long_reception"]
# extra schedule columns: the juice on the spread and total, and the listed starting QBs
ODDS_COLS = ["away_spread_odds", "home_spread_odds", "over_odds", "under_odds", "away_qb_name", "home_qb_name"]
# stats ranked on the matchups page (everything a prop could be set on)
MATCHUP_STATS = BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + LONG + FP


def load_week_stats(season):
    df = pd.read_csv(f"{BASE}/stats_player/stats_player_week_{season}.csv", low_memory=False)
    df = df[df["season_type"] == "REG"].copy()
    df["position"] = df["position"].replace({"FB": "RB"})
    df[BOX + EXTRA] = df[BOX + EXTRA].fillna(0)
    df["fp_std"] = df["fantasy_points"].fillna(0)
    df["fp_ppr"] = df["fantasy_points_ppr"].fillna(0)
    df["fp_half"] = (df["fp_std"] + df["fp_ppr"]) / 2
    df["rush_rec_yds"] = df["rushing_yards"] + df["receiving_yards"]
    df["pass_rush_yds"] = df["passing_yards"] + df["rushing_yards"]
    return df


def load_pbp(season):
    p = pd.read_csv(f"{BASE}/pbp/play_by_play_{season}.csv.gz", low_memory=False)
    return p[p["season_type"] == "REG"] if "season_type" in p.columns else p


def red_zone_usage(pbp):
    """Red-zone (inside the 20) targets and carries per player per week."""
    rz = pbp[(pbp["yardline_100"] <= 20) & pbp["play_type"].isin(["pass", "run"]) & (pbp["two_point_attempt"] != 1)]
    t = rz.dropna(subset=["receiver_player_id"]).groupby(["receiver_player_id", "week"]).size().rename("rz_targets")
    c = rz.dropna(subset=["rusher_player_id"]).groupby(["rusher_player_id", "week"]).size().rename("rz_carries")
    t.index.names = ["player_id", "week"]
    c.index.names = ["player_id", "week"]
    return pd.concat([t, c], axis=1).fillna(0).reset_index()


def longest_plays(pbp):
    """Longest completion (passer), longest rush and longest reception per player per week."""
    pl = pbp[pbp["play_type"].isin(["pass", "run"]) & (pbp["two_point_attempt"] != 1)]
    comp = pl[pl["complete_pass"] == 1]
    out = [
        comp.dropna(subset=["passer_player_id"]).groupby(["passer_player_id", "week"])["yards_gained"].max().rename("long_completion"),
        comp.dropna(subset=["receiver_player_id"]).groupby(["receiver_player_id", "week"])["yards_gained"].max().rename("long_reception"),
        pl[pl["rush"] == 1].dropna(subset=["rusher_player_id"]).groupby(["rusher_player_id", "week"])["yards_gained"].max().rename("long_rush"),
    ]
    for o in out:
        o.index.names = ["player_id", "week"]
    return pd.concat(out, axis=1).reset_index()


def add_pbp_usage(skill, pbp):
    """Attach red-zone usage and longest plays to a season's player-week stats."""
    skill = skill.merge(red_zone_usage(pbp), on=["player_id", "week"], how="left")
    skill[["rz_targets", "rz_carries"]] = skill[["rz_targets", "rz_carries"]].fillna(0)
    skill = skill.merge(longest_plays(pbp), on=["player_id", "week"], how="left")
    # a player with no completion / rush / catch that week has a longest of 0
    skill["long_completion"] = np.where(skill["completions"] > 0, skill["long_completion"].fillna(0), 0)
    skill["long_rush"] = np.where(skill["carries"] > 0, skill["long_rush"].fillna(0), 0)
    skill["long_reception"] = np.where(skill["receptions"] > 0, skill["long_reception"].fillna(0), 0)
    return skill


def team_efficiency(pbp):
    plays = pbp[pbp["play_type"].isin(["pass", "run"]) & (pbp["two_point_attempt"] != 1)].copy()
    plays["explosive"] = ((plays["pass"] == 1) & (plays["yards_gained"] >= 20)) | ((plays["rush"] == 1) & (plays["yards_gained"] >= 10))
    neutral = plays[plays["down"].isin([1, 2]) & plays["wp"].between(0.2, 0.8) & (plays["qtr"] <= 3)]

    def side(key, pre):
        g = plays.groupby(key)
        out = pd.DataFrame({
            f"{pre}_plays_pg": g.size() / g["game_id"].nunique(),
            f"{pre}_epa_play": g["epa"].mean(),
            f"{pre}_success": g["success"].mean() * 100,
            f"{pre}_ypp": g["yards_gained"].mean(),
            f"{pre}_explosive": g["explosive"].mean() * 100,
            f"{pre}_pass_epa": plays[plays["pass"] == 1].groupby(key)["epa"].mean(),
            f"{pre}_rush_epa": plays[plays["rush"] == 1].groupby(key)["epa"].mean(),
        })
        third = plays[plays["down"] == 3].groupby(key)
        out[f"{pre}_3rd_pct"] = third["third_down_converted"].sum() / (third["third_down_converted"].sum() + third["third_down_failed"].sum()) * 100
        drives = pbp.dropna(subset=["posteam", "fixed_drive"]).groupby(["game_id", "posteam", "defteam", "fixed_drive"]).agg(
            best=("yardline_100", "min"), result=("fixed_drive_result", "first")).reset_index()
        rzd = drives[drives["best"] <= 20]
        out[f"{pre}_rz_td_pct"] = rzd.groupby(key)["result"].apply(lambda r: (r == "Touchdown").mean() * 100)
        return out

    off = side("posteam", "off")
    off["off_pass_rate"] = plays.groupby("posteam")["pass"].mean() * 100
    off["off_neutral_pass_rate"] = neutral.groupby("posteam")["pass"].mean() * 100
    de = side("defteam", "def")
    eff = off.join(de, how="outer")
    eff.index.name = "team"
    return eff.round(3)


# ---------------- availability: who was on the roster / who actually played ----------------
ROSTER_KEEP = {"ACT", "INA", "RES"}  # active, inactive, reserve (IR etc.); practice squad and cuts are ignored


def _norm(name):
    import re
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", str(name).lower())
    return re.sub(r"[^a-z]", "", n)


def _last_init(name):
    import re
    parts = [x for x in re.split(r"\s+", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", str(name), flags=re.I).strip()) if x]
    return (re.sub(r"[^a-z]", "", parts[-1].lower()) + "|" + parts[0][0].lower()) if parts else ""


def availability(season, sched):
    """One row per player per team-season: weeks he was on the roster and weeks he took a snap.
    A player "missed" a game when he was on the roster that week but took no snaps."""
    ros = pd.read_csv(f"{BASE}/weekly_rosters/roster_weekly_{season}.csv", low_memory=False)
    ros = ros[(ros["game_type"] == "REG") & ros["status"].isin(ROSTER_KEEP) & ros["gsis_id"].notna()]
    snaps = pd.read_csv(f"{BASE}/snap_counts/snap_counts_{season}.csv")
    snaps = snaps[snaps["game_type"] == "REG"].copy()
    snaps["snaps"] = snaps[["offense_snaps", "defense_snaps", "st_snaps"]].fillna(0).sum(axis=1)
    snaps = snaps[snaps["snaps"] > 0]

    # link snap rows (PFR ids) to roster rows (GSIS ids): by id, then exact name + team,
    # then last name + first initial + team (catches Mike/Michael style nicknames)
    ids = ros.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id")["gsis_id"]
    ros = ros.assign(k1=ros["team"] + "|" + ros["full_name"].map(_norm), k2=ros["team"] + "|" + ros["full_name"].map(_last_init))
    by1 = ros.drop_duplicates("k1").set_index("k1")["gsis_id"]
    u2 = ros.drop_duplicates(["k2", "gsis_id"])
    by2 = u2[~u2["k2"].duplicated(keep=False)].set_index("k2")["gsis_id"]
    snaps["gsis_id"] = snaps["pfr_player_id"].map(ids)
    miss = snaps["gsis_id"].isna()
    snaps.loc[miss, "gsis_id"] = (snaps.loc[miss, "team"] + "|" + snaps.loc[miss, "player"].map(_norm)).map(by1)
    miss = snaps["gsis_id"].isna()
    snaps.loc[miss, "gsis_id"] = (snaps.loc[miss, "team"] + "|" + snaps.loc[miss, "player"].map(_last_init)).map(by2)
    snaps = snaps.dropna(subset=["gsis_id"])

    # only weeks the team actually played a finished game count
    fin = sched[sched["home_score"].notna()]
    team_weeks = set(zip(fin["home_team"], fin["week"])) | set(zip(fin["away_team"], fin["week"]))
    r = ros[[tw in team_weeks for tw in zip(ros["team"], ros["week"])]]
    played = snaps[["gsis_id", "team", "week"]].drop_duplicates()
    onr = pd.concat([r[["gsis_id", "team", "week"]], played]).drop_duplicates()  # played => was on the team

    info = (pd.concat([ros[["gsis_id", "full_name", "position", "week"]],
                       snaps.rename(columns={"player": "full_name"})[["gsis_id", "full_name", "position", "week"]]])
            .sort_values("week").groupby("gsis_id")[["full_name", "position"]].last())
    wk = lambda d: " ".join(str(int(w)) for w in sorted(set(d)))
    a = onr.groupby(["team", "gsis_id"])["week"].apply(wk).rename("rost").to_frame()
    a = a.join(played.groupby(["team", "gsis_id"])["week"].apply(wk).rename("played")).reset_index()
    a = a.join(info, on="gsis_id").rename(columns={"gsis_id": "player_id", "full_name": "player"})
    a["season"] = season
    a["played"] = a["played"].fillna("")
    return a[["season", "team", "player_id", "player", "position", "rost", "played"]]


# ---------------- per-game team numbers (the site re-totals these for any set of games) ----------------
def team_game_rows(season, pbp, sched, stats):
    fin = sched[sched["home_score"].notna()]
    tg = pd.concat([
        pd.DataFrame({"game_id": fin["game_id"], "week": fin["week"], "team": fin["home_team"], "opp": fin["away_team"], "home": 1,
                      "pf": fin["home_score"], "pa": fin["away_score"], "line": fin["spread_line"], "total_line": fin["total_line"]}),
        pd.DataFrame({"game_id": fin["game_id"], "week": fin["week"], "team": fin["away_team"], "opp": fin["home_team"], "home": 0,
                      "pf": fin["away_score"], "pa": fin["home_score"], "line": -fin["spread_line"], "total_line": fin["total_line"]}),
    ])
    plays = pbp[pbp["play_type"].isin(["pass", "run"]) & (pbp["two_point_attempt"] != 1)].copy()
    plays["explosive"] = (((plays["pass"] == 1) & (plays["yards_gained"] >= 20)) | ((plays["rush"] == 1) & (plays["yards_gained"] >= 10))).astype(int)
    k = ["game_id", "posteam"]
    g = plays.groupby(k)
    o = pd.DataFrame({
        "plays": g.size(), "epa_n": g["epa"].count(), "epa": g["epa"].sum(),
        "succ_n": g["success"].count(), "succ": g["success"].sum(),
        "yds_n": g["yards_gained"].count(), "yds": g["yards_gained"].sum(), "expl": g["explosive"].sum(),
        "pass": g["pass"].sum(),
    })
    for lab, m in (("pass", plays["pass"] == 1), ("rush", plays["rush"] == 1)):
        gg = plays[m].groupby(k)["epa"]
        o[f"{lab}_epa_n"] = gg.count()
        o[f"{lab}_epa"] = gg.sum()
    third = plays[plays["down"] == 3].groupby(k)
    o["third_conv"] = third["third_down_converted"].sum()
    o["third_fail"] = third["third_down_failed"].sum()
    neutral = plays[plays["down"].isin([1, 2]) & plays["wp"].between(0.2, 0.8) & (plays["qtr"] <= 3)].groupby(k)["pass"]
    o["neutral_n"] = neutral.count()
    o["neutral_pass"] = neutral.sum()
    drives = pbp.dropna(subset=["posteam", "fixed_drive"]).groupby(["game_id", "posteam", "defteam", "fixed_drive"]).agg(
        best=("yardline_100", "min"), result=("fixed_drive_result", "first")).reset_index()
    rzd = drives[drives["best"] <= 20]
    o["rz_drives"] = rzd.groupby(k).size()
    o["rz_tds"] = rzd[rzd["result"] == "Touchdown"].groupby(k).size()
    o = o.fillna(0).reset_index().rename(columns={"posteam": "team"})
    off = o.rename(columns={c: f"off_{c}" for c in o.columns if c not in ("game_id", "team")})
    de = o.rename(columns={"team": "opp", **{c: f"def_{c}" for c in o.columns if c not in ("game_id", "team")}})
    tg = tg.merge(off, on=["game_id", "team"], how="left").merge(de, on=["game_id", "opp"], how="left")
    # turnovers and sacks from box scores
    st = stats.assign(sack_yds=stats["sack_yards_lost"].fillna(0).abs()) if "sack_yards_lost" in stats.columns else stats.assign(sack_yds=0)
    tw = st.groupby(["team", "week"]).agg(ints=("passing_interceptions", "sum"), fum=("fumbles_lost_total", "sum"),
                                          sacks_taken=("sacks_suffered", "sum"), pass_gross=("passing_yards", "sum"), sack_yds=("sack_yds", "sum"),
                                          rush_yds=("rushing_yards", "sum"), pass_td=("passing_tds", "sum"), rush_td=("rushing_tds", "sum")).reset_index()
    tw["giveaways"] = tw["ints"] + tw["fum"]
    tw["pass_yds"] = tw["pass_gross"] - tw["sack_yds"]  # net passing yards, like the official team stat
    tw["total_yds"] = tw["pass_yds"] + tw["rush_yds"]
    box = ["pass_yds", "rush_yds", "total_yds", "pass_td", "rush_td"]
    mine = tw[["team", "week", "giveaways", "sacks_taken"] + box].rename(columns={c: f"off_{c}" for c in box})
    tg = tg.merge(mine, on=["team", "week"], how="left")
    tk = tw[["team", "week", "giveaways", "sacks_taken"] + box].rename(
        columns={"team": "opp", "giveaways": "takeaways", "sacks_taken": "sacks", **{c: f"def_{c}" for c in box}})
    tg = tg.merge(tk, on=["opp", "week"], how="left")
    tg.insert(0, "season", season)
    num = tg.select_dtypes("float").columns
    tg[num] = tg[num].round(4)
    return tg.sort_values(["week", "team"])


def build(season, out):
    os.makedirs(out, exist_ok=True)
    stats = load_week_stats(season)
    try:
        prev = load_week_stats(season - 1)
    except Exception:
        prev = stats.iloc[0:0]
    pbp = load_pbp(season)
    try:
        prev_pbp = load_pbp(season - 1)
    except Exception:
        prev_pbp = None
    games = pd.read_csv(f"{BASE}/schedules/games.csv")
    sched = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()

    last_week = int(stats["week"].max())
    # the "current" week is the earliest week that still has an unplayed game, so a
    # mid-week update (e.g. after Thursday night) doesn't skip ahead
    unplayed = sched[sched["home_score"].isna()]
    upcoming_week = int(unplayed["week"].min()) if len(unplayed) else last_week + 1

    skill = add_pbp_usage(stats[stats["position"].isin(POSITIONS)].copy(), pbp)

    # ---------------- defense vs position ----------------
    sums = BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + FP
    mw = (skill.groupby(["opponent_team", "position", "week"])[sums].sum().reset_index()
          .rename(columns={"opponent_team": "defense"}))
    # longest play allowed to the position that week (the max, not a sum)
    lw = (skill.groupby(["opponent_team", "position", "week"])[LONG].max().reset_index()
          .rename(columns={"opponent_team": "defense"}))
    mw = mw.merge(lw, on=["defense", "position", "week"], how="left")
    mw = mw.join(skill.groupby(["opponent_team", "week"])["team"].first().rename("offense"), on=["defense", "week"])
    mw[FP] = mw[FP].round(1)
    mw.to_csv(f"{out}/matchups_weekly.csv", index=False)

    weeks = sorted(mw["week"].unique())
    rows = []
    for label, wk in [("season", weeks), ("last3", weeks[-3:])]:
        w = mw[mw["week"].isin(wk)]
        gp = w.groupby("defense")["week"].nunique()
        tot = w.groupby(["defense", "position"])[sums + LONG].sum()
        full = pd.MultiIndex.from_product([sorted(mw["defense"].unique()), POSITIONS], names=["defense", "position"])
        tot = tot.reindex(full).fillna(0)
        pg = tot.div(gp, axis=0, level="defense")
        for stat in MATCHUP_STATS:
            s = pg[stat].round(2).rename("per_game").reset_index()
            # 1 = toughest defense (allows the least), 32 = easiest (allows the most).
            # For interceptions and sacks a defense that forces more is tougher, so flip those.
            tougher_when_high = stat in ("passing_interceptions", "sacks_suffered")
            s["rank"] = s.groupby("position")["per_game"].rank(ascending=not tougher_when_high, method="min").astype("Int64")
            s["stat"] = stat
            s["window"] = label
            s["games"] = s["defense"].map(gp)
            rows.append(s)
    matchups = pd.concat(rows)[["defense", "window", "position", "stat", "games", "per_game", "rank"]]
    matchups.to_csv(f"{out}/matchups.csv", index=False)

    # ---------------- game logs ----------------
    prev_skill = prev[prev["position"].isin(POSITIONS)].copy()
    try:
        prev_skill = add_pbp_usage(prev_skill, prev_pbp)
    except Exception:
        for c in ["rz_targets", "rz_carries"] + LONG:
            prev_skill[c] = np.nan
    both = pd.concat([skill, prev_skill], ignore_index=True)
    logcols = (["player_id", "player_display_name", "position", "season", "week", "team", "opponent_team", "target_share"]
               + BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + LONG + EXTRA + FP)
    logs = both[logcols].rename(columns={"player_display_name": "player", "opponent_team": "opp"})
    logs["target_share"] = (logs["target_share"] * 100).round(1)
    logs[FP] = logs[FP].round(1)
    logs = logs.sort_values(["season", "week"], ascending=[False, False])
    logs.to_csv(f"{out}/logs.csv", index=False)

    # ---------------- games + lines ----------------
    g = sched[["game_id", "week", "gameday", "weekday", "gametime", "away_team", "home_team", "away_score", "home_score",
               "spread_line", "total_line", "away_moneyline", "home_moneyline", "away_rest", "home_rest", "div_game",
               "roof", "surface"] + [c for c in ODDS_COLS if c in sched.columns]].copy()
    g["matchup"] = g["away_team"] + " @ " + g["home_team"]
    g["kickoff"] = pd.to_datetime(g["gameday"]).dt.strftime("%a %b %-d") + " " + g["gametime"].fillna("")
    # nflverse spread_line is from the home team's view: positive = home team favored by that many
    g["home_implied"] = ((g["total_line"] + g["spread_line"]) / 2).round(1)
    g["away_implied"] = ((g["total_line"] - g["spread_line"]) / 2).round(1)

    def fav(r):
        if pd.isna(r["spread_line"]):
            return None
        if r["spread_line"] == 0:
            return "PK"
        return f'{r["home_team"] if r["spread_line"] > 0 else r["away_team"]} -{abs(r["spread_line"]):g}'
    g["favorite"] = g.apply(fav, axis=1)

    def implied(ml):
        return np.where(ml < 0, -ml / (-ml + 100), 100 / (ml + 100))
    ph, pa = implied(g["home_moneyline"].astype(float)), implied(g["away_moneyline"].astype(float))
    g["home_win_pct"] = (ph / (ph + pa) * 100).round(1)  # vig removed
    g["away_win_pct"] = (pa / (ph + pa) * 100).round(1)
    played = g["home_score"].notna()
    g["status"] = np.where(played, "final", "upcoming")
    margin = g["home_score"] - g["away_score"]
    g["final"] = np.where(played, g["away_team"] + " " + g["away_score"].astype("Int64").astype(str) + ", "
                          + g["home_team"] + " " + g["home_score"].astype("Int64").astype(str), None)
    g["ats_winner"] = np.select([~played, margin > g["spread_line"], margin < g["spread_line"]],
                                [None, g["home_team"], g["away_team"]], "PUSH")
    tot = g["home_score"] + g["away_score"]
    g["total_points"] = tot
    g["ou_result"] = np.select([~played, tot > g["total_line"], tot < g["total_line"]], [None, "OVER", "UNDER"], "PUSH")
    g.to_csv(f"{out}/games.csv", index=False)

    # ---------------- team names + colors ----------------
    try:
        ti = pd.read_csv(f"{BASE}/teams/teams_colors_logos.csv")
        ti = ti[ti["team_abbr"].isin(set(g["home_team"]) | set(g["away_team"]))]
        ti = ti.rename(columns={"team_abbr": "team", "team_name": "name", "team_nick": "nick", "team_conf": "conf",
                                "team_division": "division", "team_color": "color", "team_color2": "color2"})
        ti[["team", "name", "nick", "conf", "division", "color", "color2"]].to_csv(f"{out}/team_info.csv", index=False)
    except Exception as e:
        print(f"team info skipped: {e}")

    # ---------------- teams: betting records ----------------
    fin = g[played]
    tg = pd.concat([
        pd.DataFrame({"team": fin["home_team"], "home": 1, "pf": fin["home_score"], "pa": fin["away_score"],
                      "line": fin["spread_line"], "total_line": fin["total_line"]}),
        pd.DataFrame({"team": fin["away_team"], "home": 0, "pf": fin["away_score"], "pa": fin["home_score"],
                      "line": -fin["spread_line"], "total_line": fin["total_line"]}),
    ])
    tg["margin"] = tg["pf"] - tg["pa"]
    tg["cover_by"] = tg["margin"] - tg["line"]  # >0 covered
    tg["fav"] = tg["line"] > 0
    tg["tot"] = tg["pf"] + tg["pa"]

    def rec(df, col, pos_lab="W", neg_lab="L"):
        w, l, p = (df[col] > 0).sum(), (df[col] < 0).sum(), (df[col] == 0).sum()
        return f"{w}-{l}" + (f"-{p}" if p else "")

    recs = []
    for team, d in tg.groupby("team"):
        d_ou = d.assign(ou=d["tot"] - d["total_line"])
        r = {
            "team": team, "games": len(d),
            "su": rec(d, "margin"), "ats": rec(d, "cover_by"),
            "ats_home": rec(d[d.home == 1], "cover_by"), "ats_away": rec(d[d.home == 0], "cover_by"),
            "ats_fav": rec(d[d.fav], "cover_by"), "ats_dog": rec(d[~d.fav], "cover_by"),
            "ou": rec(d_ou, "ou"),
            "ats_pct": round((d["cover_by"] > 0).sum() / max(1, (d["cover_by"] != 0).sum()) * 100, 1),
            "over_pct": round((d_ou["ou"] > 0).sum() / max(1, (d_ou["ou"] != 0).sum()) * 100, 1),
            "avg_cover_margin": round(d["cover_by"].mean(), 1),
            "avg_total_vs_line": round(d_ou["ou"].mean(), 1),
            "pts_for": round(d["pf"].mean(), 1), "pts_against": round(d["pa"].mean(), 1),
            "point_diff": round(d["margin"].mean(), 1),
        }
        recs.append(r)
    teams = pd.DataFrame(recs).set_index("team")

    # turnovers / sacks from box scores
    tw = stats.groupby(["team", "week"]).agg(
        giveaways=("passing_interceptions", "sum"), fum=("fumbles_lost_total", "sum"),
        sacks_taken=("sacks_suffered", "sum"), opp=("opponent_team", "first")).reset_index()
    tw["giveaways"] = tw["giveaways"] + tw["fum"]
    tk = tw[["team", "week", "giveaways", "sacks_taken"]].rename(
        columns={"team": "opp", "giveaways": "takeaways", "sacks_taken": "sacks"})
    tw = tw.merge(tk, on=["opp", "week"], how="left")
    to = tw.groupby("team")[["giveaways", "takeaways", "sacks", "sacks_taken"]].mean()
    to["to_margin"] = to["takeaways"] - to["giveaways"]
    teams = teams.join(to.round(2)).join(team_efficiency(pbp))

    # ranks: 1 = best
    best_high = ["pts_for", "point_diff", "off_epa_play", "off_success", "off_ypp", "off_explosive", "off_3rd_pct",
                 "off_rz_td_pct", "to_margin", "sacks", "off_plays_pg", "off_pass_rate"]
    best_low = ["pts_against", "def_epa_play", "def_success", "def_ypp", "def_explosive", "def_3rd_pct", "def_rz_td_pct"]
    for c in best_high:
        teams[f"{c}_rank"] = teams[c].rank(ascending=False, method="min").astype("Int64")
    for c in best_low:
        teams[f"{c}_rank"] = teams[c].rank(ascending=True, method="min").astype("Int64")
    # defensive funnel: which is easier to attack, pass or run (higher EPA allowed = easier)
    teams["def_pass_epa_rank"] = teams["def_pass_epa"].rank(ascending=True, method="min").astype("Int64")
    teams["def_rush_epa_rank"] = teams["def_rush_epa"].rank(ascending=True, method="min").astype("Int64")
    teams["funnel"] = np.where(teams["def_pass_epa_rank"] > teams["def_rush_epa_rank"] + 5, "Pass funnel",
                               np.where(teams["def_rush_epa_rank"] > teams["def_pass_epa_rank"] + 5, "Run funnel", "Balanced"))

    # each team's next unplayed game (a team that already played this week moves on to its next one)
    upg = g[g["status"] == "upcoming"].sort_values("week")
    nxt = pd.concat([
        upg[["week", "home_team", "away_team", "home_implied"]].rename(columns={"home_team": "team", "away_team": "next_opp", "home_implied": "team_implied"}).assign(home=1),
        upg[["week", "away_team", "home_team", "away_implied"]].rename(columns={"away_team": "team", "home_team": "next_opp", "away_implied": "team_implied"}).assign(home=0),
    ]).sort_values("week")
    nxt = nxt.drop_duplicates("team", keep="first")
    # a team with no game at all in the current week is on bye (a team that already
    # played this week, e.g. on Thursday, keeps its next game instead)
    playing = set(sched.loc[sched["week"] == upcoming_week, "home_team"]) | set(sched.loc[sched["week"] == upcoming_week, "away_team"])
    bye = ~nxt["team"].isin(playing)
    nxt.loc[bye, "next_opp"] = None
    nxt.loc[bye, "team_implied"] = None
    nxt = nxt.drop(columns="week")
    teams = teams.reset_index().merge(nxt[["team", "next_opp"]], on="team", how="left")
    teams["next_opp"] = teams["next_opp"].fillna("BYE")
    num = teams.select_dtypes("float").columns
    teams[num] = teams[num].round(3)
    teams.to_csv(f"{out}/teams.csv", index=False)

    # ---------------- players ----------------
    cur = skill.sort_values("week")
    avg_cols = BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + LONG + EXTRA + FP
    ps = cur.groupby("player_id").agg(
        player=("player_display_name", "last"), position=("position", "last"), team=("team", "last"),
        games=("week", "nunique"), last_week=("week", "max"), tgt_share=("target_share", "mean"),
        **{c: (c, "mean") for c in avg_cols}).reset_index()
    ps[avg_cols] = ps[avg_cols].round(1)
    ps["tgt_share"] = (ps["tgt_share"] * 100).round(1)
    ps = ps.merge(nxt, on="team", how="left")
    ps["next_opp"] = ps["next_opp"].fillna("BYE")
    ps = ps.sort_values(["position", "games"], ascending=[True, False])
    ps.to_csv(f"{out}/players.csv", index=False)

    # ---------------- availability + per-game team numbers (this season and last) ----------------
    av, tgs = [], []
    for yr, st, pb in ((season, stats, pbp), (season - 1, prev, prev_pbp)):
        sc = games[(games["season"] == yr) & (games["game_type"] == "REG")]
        try:
            av.append(availability(yr, sc))
        except Exception as e:
            print(f"availability {yr} skipped: {e}")
        try:
            if pb is not None and len(st):
                tgs.append(team_game_rows(yr, pb, sc, st))
        except Exception as e:
            print(f"team games {yr} skipped: {e}")
    pd.concat(av).to_csv(f"{out}/avail.csv", index=False)
    pd.concat(tgs).to_csv(f"{out}/team_games.csv", index=False)

    with open(f"{out}/meta.txt", "w") as f:
        f.write(f"season={season}\nthrough_week={last_week}\nupcoming_week={upcoming_week}\n"
                f"built_at={dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}\n")
    print(f"Built {season} through week {last_week} (upcoming week {upcoming_week}) -> {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    today = dt.date.today()
    ap.add_argument("--season", type=int, default=today.year if today.month >= 8 else today.year - 1)
    ap.add_argument("--out", default="data")
    a = ap.parse_args()
    build(a.season, a.out)
