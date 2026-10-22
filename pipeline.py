"""
NFL Matchup Lab - data pipeline
===============================
Pulls free weekly NFL data from nflverse (GitHub) and builds the tables behind
the NFL Matchup Lab dashboard. Every output is a plain CSV, so this is also the
data layer for a future app or website.

Outputs (in --out, default ./data):
  dvp.csv            one row per DEFENSE per window ("season" / "last3"): fantasy points
                     allowed per game to QB/RB/WR/TE in std / half / PPR, 1-32 ranks
                     (1 = allows the most = softest matchup), plus yards/TDs/targets allowed
  dvp_weekly.csv     points + stats each defense allowed to each position, every week
  logs.csv           every QB/RB/WR/TE game log with opponent (this season + last season)
  player_season.csv  this season's per-game averages per player, plus next week's
                     opponent and that defense's rank vs the player's position
  team_season.csv    team offense / defense per game with ranks and record
  team_weekly.csv    team offense / defense, every game
  upcoming.csv       next week's games with Vegas spread / total / implied team totals

Usage:
  pip install pandas
  python pipeline.py                       # current season, auto-detected
  python pipeline.py --season 2026 --out ./data

Source: https://github.com/nflverse/nflverse-data - refreshed through the season,
normally complete by Tuesday morning after Monday Night Football.
"""
import argparse
import datetime as dt
import os

import pandas as pd

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
POSITIONS = ["QB", "RB", "WR", "TE"]
FORMATS = ["std", "half", "ppr"]

STAT_COLS = [
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
    "carries", "rushing_yards", "rushing_tds", "targets", "receptions",
    "receiving_yards", "receiving_tds",
]
# stats shown per position on the defense-vs-position view
POS_STATS = {
    "QB": {"pass_yds": "passing_yards", "pass_td": "passing_tds", "int": "passing_interceptions",
           "rush_yds": "rushing_yards"},
    "RB": {"rush_yds": "rushing_yards", "rush_td": "rushing_tds", "rec": "receptions",
           "rec_yds": "receiving_yards"},
    "WR": {"tgt": "targets", "rec": "receptions", "rec_yds": "receiving_yards", "rec_td": "receiving_tds"},
    "TE": {"tgt": "targets", "rec": "receptions", "rec_yds": "receiving_yards", "rec_td": "receiving_tds"},
}


def load_week_stats(season):
    df = pd.read_csv(f"{BASE}/stats_player/stats_player_week_{season}.csv", low_memory=False)
    df = df[df["season_type"] == "REG"].copy()
    df["position"] = df["position"].replace({"FB": "RB"})
    df["fp_std"] = df["fantasy_points"].fillna(0)
    df["fp_ppr"] = df["fantasy_points_ppr"].fillna(0)
    df["fp_half"] = (df["fp_std"] + df["fp_ppr"]) / 2
    return df


def dvp_window(dvp_w, weeks, label):
    w = dvp_w[dvp_w["week"].isin(weeks)]
    games = w.groupby("defense")["week"].nunique()
    out = pd.DataFrame({"defense": sorted(dvp_w["defense"].unique())}).set_index("defense")
    out["window"] = label
    out["games"] = games
    for pos in POSITIONS:
        p = w[w["position"] == pos].groupby("defense").sum(numeric_only=True)
        p = p.reindex(out.index).fillna(0)
        k = pos.lower()
        for fmt in FORMATS:
            out[f"{k}_{fmt}_pg"] = (p[f"fp_{fmt}"] / out["games"]).round(1)
            out[f"{k}_{fmt}_rank"] = out[f"{k}_{fmt}_pg"].rank(ascending=False, method="min").astype(int)
        for short, col in POS_STATS[pos].items():
            out[f"{k}_{short}_pg"] = (p[col] / out["games"]).round(1)
    return out.reset_index()


def build(season, out):
    os.makedirs(out, exist_ok=True)
    stats = load_week_stats(season)
    try:
        prev = load_week_stats(season - 1)
    except Exception:
        prev = stats.iloc[0:0]
    games = pd.read_csv(f"{BASE}/schedules/games.csv")
    sched = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()

    skill = stats[stats["position"].isin(POSITIONS)].copy()
    skill[STAT_COLS] = skill[STAT_COLS].fillna(0)
    last_week = int(stats["week"].max())
    upcoming_week = last_week + 1

    # ---- defense vs position, weekly ----
    sums = STAT_COLS + ["fp_std", "fp_half", "fp_ppr"]
    dvp_w = (skill.groupby(["opponent_team", "position", "week"])[sums].sum().reset_index()
             .rename(columns={"opponent_team": "defense"}))
    opp_of = skill.groupby(["opponent_team", "week"])["team"].first().rename("offense")
    dvp_w = dvp_w.join(opp_of, on=["defense", "week"])
    dvp_w[["fp_std", "fp_half", "fp_ppr"]] = dvp_w[["fp_std", "fp_half", "fp_ppr"]].round(1)
    dvp_w.to_csv(f"{out}/dvp_weekly.csv", index=False)

    # ---- defense vs position, season + last 3 weeks ----
    all_weeks = sorted(dvp_w["week"].unique())
    dvp = pd.concat([dvp_window(dvp_w, all_weeks, "season"),
                     dvp_window(dvp_w, all_weeks[-3:], "last3")], ignore_index=True)
    dvp.to_csv(f"{out}/dvp.csv", index=False)

    # ---- game logs (this + last season) ----
    logcols = ["player_id", "player_display_name", "position", "season", "week", "team", "opponent_team",
               "target_share"] + STAT_COLS + ["fp_std", "fp_half", "fp_ppr"]
    both = pd.concat([skill, prev[prev["position"].isin(POSITIONS)]], ignore_index=True)
    both[STAT_COLS] = both[STAT_COLS].fillna(0)
    logs = both[logcols].rename(columns={"player_display_name": "player", "opponent_team": "opp"})
    logs["target_share"] = (logs["target_share"] * 100).round(1)
    logs[["fp_std", "fp_half", "fp_ppr"]] = logs[["fp_std", "fp_half", "fp_ppr"]].round(1)
    logs = logs.sort_values(["season", "week", "fp_ppr"], ascending=[False, False, False])
    logs.to_csv(f"{out}/logs.csv", index=False)

    # ---- upcoming games + Vegas lines ----
    up = sched[sched["week"] == upcoming_week][[
        "game_id", "week", "gameday", "weekday", "gametime", "away_team", "home_team",
        "spread_line", "total_line", "away_moneyline", "home_moneyline", "roof"]].copy()
    # nflverse spread_line is from the home team's view: positive = home team favored
    up["home_implied"] = ((up["total_line"] + up["spread_line"]) / 2).round(1)
    up["away_implied"] = ((up["total_line"] - up["spread_line"]) / 2).round(1)
    up["matchup"] = up["away_team"] + " @ " + up["home_team"]
    def fav(r):
        if pd.isna(r["spread_line"]):
            return None
        if r["spread_line"] == 0:
            return "PK"
        return f'{r["home_team"] if r["spread_line"] > 0 else r["away_team"]} -{abs(r["spread_line"]):g}'
    up["favorite"] = up.apply(fav, axis=1)
    up["kickoff"] = pd.to_datetime(up["gameday"]).dt.strftime("%a %b %-d") + " " + up["gametime"].fillna("")
    up.to_csv(f"{out}/upcoming.csv", index=False)
    nxt = pd.concat([
        up[["home_team", "away_team", "home_implied"]].rename(
            columns={"home_team": "team", "away_team": "next_opp", "home_implied": "team_implied"}).assign(home=1),
        up[["away_team", "home_team", "away_implied"]].rename(
            columns={"away_team": "team", "home_team": "next_opp", "away_implied": "team_implied"}).assign(home=0),
    ])

    # ---- player season averages + next matchup ----
    cur = skill.sort_values("week")
    ps = cur.groupby("player_id").agg(
        player=("player_display_name", "last"), position=("position", "last"), team=("team", "last"),
        games=("week", "nunique"), **{f"{c}": (c, "sum") for c in STAT_COLS},
        fp_std=("fp_std", "sum"), fp_half=("fp_half", "sum"), fp_ppr=("fp_ppr", "sum"),
        tgt_share=("target_share", "mean"), last_week=("week", "max"),
    ).reset_index()
    for c in STAT_COLS + ["fp_std", "fp_half", "fp_ppr"]:
        ps[f"{c}_pg"] = (ps[c] / ps["games"]).round(1)
    ps["tgt_share"] = (ps["tgt_share"] * 100).round(1)
    ps = ps.merge(nxt, on="team", how="left")
    season_dvp = dvp[dvp["window"] == "season"].set_index("defense")
    for fmt in FORMATS:
        ps[f"opp_rank_{fmt}"] = [
            season_dvp.at[o, f"{p.lower()}_{fmt}_rank"] if isinstance(o, str) and o in season_dvp.index else None
            for o, p in zip(ps["next_opp"], ps["position"])]
        ps[f"opp_allowed_{fmt}"] = [
            season_dvp.at[o, f"{p.lower()}_{fmt}_pg"] if isinstance(o, str) and o in season_dvp.index else None
            for o, p in zip(ps["next_opp"], ps["position"])]
    ps["next_opp"] = ps["next_opp"].fillna("BYE")
    keep = ["player_id", "player", "position", "team", "games", "last_week", "next_opp", "home",
            "team_implied", "tgt_share"] + [f"{c}_pg" for c in STAT_COLS + ["fp_std", "fp_half", "fp_ppr"]] + \
           [f"opp_rank_{f}" for f in FORMATS] + [f"opp_allowed_{f}" for f in FORMATS]
    ps = ps[keep].sort_values("fp_ppr_pg", ascending=False)
    ps.to_csv(f"{out}/player_season.csv", index=False)

    # ---- team offense / defense ----
    off = stats.groupby(["team", "week"]).agg(
        pass_yds=("passing_yards", "sum"), rush_yds=("rushing_yards", "sum"),
        ints_thrown=("passing_interceptions", "sum"), fum_lost=("fumbles_lost_total", "sum"),
        sacks_taken=("sacks_suffered", "sum"), opp=("opponent_team", "first"),
    ).reset_index()
    sc = pd.concat([
        sched[["week", "home_team", "home_score", "away_score"]].rename(
            columns={"home_team": "team", "home_score": "pts_for", "away_score": "pts_against"}),
        sched[["week", "away_team", "away_score", "home_score"]].rename(
            columns={"away_team": "team", "away_score": "pts_for", "home_score": "pts_against"}),
    ]).dropna()
    tw = off.merge(sc, on=["team", "week"], how="inner")
    tw["total_yds"] = tw["pass_yds"] + tw["rush_yds"]
    tw["turnovers"] = tw["ints_thrown"] + tw["fum_lost"]
    d = tw[["team", "week", "pass_yds", "rush_yds", "total_yds", "turnovers", "sacks_taken"]].rename(
        columns={"team": "opp", "pass_yds": "pass_yds_allowed", "rush_yds": "rush_yds_allowed",
                 "total_yds": "yds_allowed", "turnovers": "takeaways", "sacks_taken": "sacks"})
    tw = tw.merge(d, on=["opp", "week"], how="left")
    tw.to_csv(f"{out}/team_weekly.csv", index=False)

    num = ["pts_for", "pts_against", "pass_yds", "rush_yds", "total_yds", "turnovers",
           "pass_yds_allowed", "rush_yds_allowed", "yds_allowed", "takeaways", "sacks"]
    ts = tw.groupby("team")[num].mean().round(1)
    ts["games"] = tw.groupby("team")["week"].nunique()
    rec = tw.assign(w=(tw.pts_for > tw.pts_against).astype(int), l=(tw.pts_for < tw.pts_against).astype(int),
                    t=(tw.pts_for == tw.pts_against).astype(int)).groupby("team")[["w", "l", "t"]].sum()
    ts = ts.join(rec)
    ts["record"] = ts["w"].astype(str) + "-" + ts["l"].astype(str) + ts["t"].map(lambda t: f"-{t}" if t else "")
    ts["point_diff_pg"] = (ts["pts_for"] - ts["pts_against"]).round(1)
    ts["off_rank"] = ts["pts_for"].rank(ascending=False, method="min").astype(int)
    ts["def_rank"] = ts["pts_against"].rank(ascending=True, method="min").astype(int)
    ts = ts.reset_index().merge(nxt[["team", "next_opp"]], on="team", how="left")
    ts["next_opp"] = ts["next_opp"].fillna("BYE")
    ts.to_csv(f"{out}/team_season.csv", index=False)

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
