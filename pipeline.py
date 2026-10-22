"""
NFL Matchup Lab - data pipeline (betting edition)
=================================================
Pulls free NFL data from nflverse (GitHub) and builds the tables behind the site.
Every output is a plain CSV in --out (default ./data).

  matchups.csv         defense vs position, long format: one row per defense / window /
                       position / stat with the per-game amount allowed and a 1-32 rank
                       (1 = allows the most = softest matchup). Windows: season, last3.
                       Stats include real box-score stats plus fantasy points (std/half/ppr).
  matchups_weekly.csv  what each defense allowed to each position, every week
  logs.csv             every QB/RB/WR/TE game (this season + last) with box score,
                       red-zone usage, air yards and fantasy points
  players.csv          this season's per-game averages, next opponent, team implied total
  games.csv            every game this season: Vegas lines, no-vig win %, implied totals,
                       rest days, roof, final score, and whether it covered / went over
  teams.csv            team efficiency (EPA/play, success rate, yards/play, pass rate,
                       pace, red-zone TD %, 3rd-down %, explosive plays, turnover margin)
                       and betting records (straight up, against the spread, over/under)
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
# stats ranked on the matchups page (everything a prop could be set on)
MATCHUP_STATS = BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + FP


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


def build(season, out):
    os.makedirs(out, exist_ok=True)
    stats = load_week_stats(season)
    try:
        prev = load_week_stats(season - 1)
    except Exception:
        prev = stats.iloc[0:0]
    pbp = load_pbp(season)
    games = pd.read_csv(f"{BASE}/schedules/games.csv")
    sched = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()

    last_week = int(stats["week"].max())
    upcoming_week = last_week + 1

    skill = stats[stats["position"].isin(POSITIONS)].copy()
    rz = red_zone_usage(pbp)
    skill = skill.merge(rz, on=["player_id", "week"], how="left")
    skill[["rz_targets", "rz_carries"]] = skill[["rz_targets", "rz_carries"]].fillna(0)

    # ---------------- defense vs position ----------------
    sums = BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + FP
    mw = (skill.groupby(["opponent_team", "position", "week"])[sums].sum().reset_index()
          .rename(columns={"opponent_team": "defense"}))
    mw = mw.join(skill.groupby(["opponent_team", "week"])["team"].first().rename("offense"), on=["defense", "week"])
    mw[FP] = mw[FP].round(1)
    mw.to_csv(f"{out}/matchups_weekly.csv", index=False)

    weeks = sorted(mw["week"].unique())
    rows = []
    for label, wk in [("season", weeks), ("last3", weeks[-3:])]:
        w = mw[mw["week"].isin(wk)]
        gp = w.groupby("defense")["week"].nunique()
        tot = w.groupby(["defense", "position"])[sums].sum()
        full = pd.MultiIndex.from_product([sorted(mw["defense"].unique()), POSITIONS], names=["defense", "position"])
        tot = tot.reindex(full).fillna(0)
        pg = tot.div(gp, axis=0, level="defense")
        for stat in MATCHUP_STATS:
            s = pg[stat].round(2).rename("per_game").reset_index()
            s["rank"] = s.groupby("position")["per_game"].rank(ascending=False, method="min").astype("Int64")
            s["stat"] = stat
            s["window"] = label
            s["games"] = s["defense"].map(gp)
            rows.append(s)
    matchups = pd.concat(rows)[["defense", "window", "position", "stat", "games", "per_game", "rank"]]
    matchups.to_csv(f"{out}/matchups.csv", index=False)

    # ---------------- game logs ----------------
    prev_skill = prev[prev["position"].isin(POSITIONS)].copy()
    prev_skill["rz_targets"] = np.nan
    prev_skill["rz_carries"] = np.nan
    both = pd.concat([skill, prev_skill], ignore_index=True)
    logcols = (["player_id", "player_display_name", "position", "season", "week", "team", "opponent_team", "target_share"]
               + BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + EXTRA + FP)
    logs = both[logcols].rename(columns={"player_display_name": "player", "opponent_team": "opp"})
    logs["target_share"] = (logs["target_share"] * 100).round(1)
    logs[FP] = logs[FP].round(1)
    logs = logs.sort_values(["season", "week"], ascending=[False, False])
    logs.to_csv(f"{out}/logs.csv", index=False)

    # ---------------- games + lines ----------------
    g = sched[["game_id", "week", "gameday", "weekday", "gametime", "away_team", "home_team", "away_score", "home_score",
               "spread_line", "total_line", "away_moneyline", "home_moneyline", "away_rest", "home_rest", "div_game",
               "roof", "surface"]].copy()
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
    g.drop(columns=["gameday", "gametime"]).to_csv(f"{out}/games.csv", index=False)

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

    upg = g[g["week"] == upcoming_week]
    nxt = pd.concat([
        upg[["home_team", "away_team", "home_implied"]].rename(columns={"home_team": "team", "away_team": "next_opp", "home_implied": "team_implied"}).assign(home=1),
        upg[["away_team", "home_team", "away_implied"]].rename(columns={"away_team": "team", "home_team": "next_opp", "away_implied": "team_implied"}).assign(home=0),
    ])
    teams = teams.reset_index().merge(nxt[["team", "next_opp"]], on="team", how="left")
    teams["next_opp"] = teams["next_opp"].fillna("BYE")
    num = teams.select_dtypes("float").columns
    teams[num] = teams[num].round(3)
    teams.to_csv(f"{out}/teams.csv", index=False)

    # ---------------- players ----------------
    cur = skill.sort_values("week")
    avg_cols = BOX + ["rush_rec_yds", "pass_rush_yds", "rz_targets", "rz_carries"] + EXTRA + FP
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
