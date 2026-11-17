"""
Matchup Lab - NBA shot zones
============================
Reads this season's ESPN play-by-play (SportsDataverse hoopR release, free, refreshed daily) and works
out where every field goal attempt came from, then builds two tables for the site:

  shot_team.csv    for every team, what its defense ALLOWS and what its offense TAKES in each zone,
                   overall and split by the shooter's position (G / F / C):
                   attempts and makes per game, FG%, share of all shots, % of makes that were assisted,
                   plus ranks. Defense ranks: 1st = fewest makes allowed (toughest), 30th = most (easiest).
                   Offense ranks: 1st = most makes per game.
  shot_player.csv  for every player, attempts and makes per game in each zone, FG%, share of his shots,
                   % of makes assisted, and his league rank in makes per game from that zone.

Zones (NBA.com style): Restricted Area (within 4 ft), Paint (non-RA), Mid-Range, Corner 3, Above The Break 3.

"Open" shots: ESPN's free data has no defender-distance tracking, so the closest stand-in is the assisted
share (a pass right before the shot = usually a catch-and-shoot / cleaner look).

Needs data/nba/logs.csv from nba_pipeline.py (for positions). Usage:
  python nba_shots.py --out data/nba
"""
import argparse
import datetime as dt
import os

import numpy as np
import pandas as pd

REL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
ZONES = ["ra", "paint", "mid", "c3", "ab3"]
HOOP_X = 41.75  # ESPN coordinates: x runs baseline to baseline (-47..47), the hoops sit 5.25 ft in from each end


def zone_of(x, y, pts):
    """Zone for each shot, from ESPN court coordinates (feet from center court)."""
    ax = np.abs(x)
    dist = np.sqrt((ax - HOOP_X) ** 2 + y ** 2)
    three = pts == 3
    corner = three & (np.abs(y) >= 21) & (ax >= 33)
    paint = (~three) & (ax >= 28) & (np.abs(y) <= 8)
    return np.select(
        [three & corner, three, dist <= 4, paint],
        ["c3", "ab3", "ra", "paint"], default="mid")


def build(season, out):
    pbp = pd.read_parquet(f"{REL}/espn_nba_pbp/play_by_play_{season}.parquet")
    pbp = pbp[pbp["season_type"].isin([2, 3])]
    s = pbp[(pbp["shooting_play"] == True) & (~pbp["type_text"].fillna("").str.contains("Free Throw"))].copy()  # noqa: E712
    s = s[s["coordinate_x"].notna() & s["coordinate_y"].notna() & s["athlete_id_1"].notna()]
    s["pts"] = pd.to_numeric(s["points_attempted"], errors="coerce").fillna(2).astype(int)
    s["zone"] = zone_of(s["coordinate_x"].to_numpy(), s["coordinate_y"].to_numpy(), s["pts"].to_numpy())
    s["made"] = s["scoring_play"].fillna(False).astype(bool).astype(int)
    # on a make, athlete 2 is the passer; on a miss it can be the shot blocker
    s["ast"] = (s["made"].eq(1) & s["athlete_id_2"].notna() & s["text"].fillna("").str.contains("assist")).astype(int)
    s["player_id"] = s["athlete_id_1"].astype("int64").astype(str)
    tid = s["team_id"].astype("Int64")
    home = tid == s["home_team_id"].astype("Int64")
    s["off"] = np.where(home, s["home_team_abbrev"], s["away_team_abbrev"])
    s["def"] = np.where(home, s["away_team_abbrev"], s["home_team_abbrev"])
    s["game_id"] = s["game_id"].astype(str)

    logs = pd.read_csv(f"{out}/logs.csv", dtype={"player_id": str, "game_id": str})
    cur = logs[logs["season"] == season]
    pos = cur.sort_values("date").groupby("player_id")["position"].last()
    s["position"] = s["player_id"].map(pos).fillna("F")

    # ---------- teams: defense allowed + offense taken ----------
    games = pd.concat([s[["game_id", "off"]].rename(columns={"off": "team"}), s[["game_id", "def"]].rename(columns={"def": "team"})]).drop_duplicates()
    gp = games.groupby("team")["game_id"].nunique()
    rows = []
    for side in ["def", "off"]:
        for p in ["ALL", "G", "F", "C"]:
            sub = s if p == "ALL" else s[s["position"] == p]
            tot = sub.groupby(side)["made"].size()
            g = sub.groupby([side, "zone"]).agg(fga=("made", "size"), fgm=("made", "sum"), ast=("ast", "sum")).reset_index()
            full = pd.MultiIndex.from_product([gp.index, ZONES], names=[side, "zone"])
            g = g.set_index([side, "zone"]).reindex(full, fill_value=0).reset_index()
            g["games"] = g[side].map(gp)
            g["fga_pg"] = g["fga"] / g["games"]
            g["fgm_pg"] = g["fgm"] / g["games"]
            g["fg_pct"] = np.where(g["fga"] > 0, g["fgm"] / g["fga"] * 100, np.nan)
            g["share"] = g["fga"] / g[side].map(tot).replace(0, np.nan) * 100
            g["ast_pct"] = np.where(g["fgm"] > 0, g["ast"] / g["fgm"] * 100, np.nan)
            asc = side == "def"  # defense: fewest allowed = 1st (toughest); offense: most = 1st
            g["rank_fgm"] = g.groupby("zone")["fgm_pg"].rank(method="min", ascending=asc).astype(int)
            g["rank_pct"] = g.groupby("zone")["fg_pct"].rank(method="min", ascending=asc).fillna(len(gp)).astype(int)
            g["rank_fga"] = g.groupby("zone")["fga_pg"].rank(method="min", ascending=asc).astype(int)
            for _, r in g.iterrows():
                rows.append({"side": side, "team": r[side], "position": p, "zone": r["zone"], "games": int(r["games"]),
                             "fga_pg": round(r["fga_pg"], 2), "fgm_pg": round(r["fgm_pg"], 2),
                             "fg_pct": None if pd.isna(r["fg_pct"]) else round(r["fg_pct"], 1),
                             "share": None if pd.isna(r["share"]) else round(r["share"], 1),
                             "ast_pct": None if pd.isna(r["ast_pct"]) else round(r["ast_pct"], 1),
                             "rank_fgm": int(r["rank_fgm"]), "rank_pct": int(r["rank_pct"]), "rank_fga": int(r["rank_fga"])})
    pd.DataFrame(rows).to_csv(f"{out}/shot_team.csv", index=False)

    # ---------- players ----------
    pg = cur[cur["game_id"].isin(set(s["game_id"]))].groupby("player_id")["game_id"].nunique()
    last = cur.sort_values("date").groupby("player_id")[["player", "team", "position"]].last()
    g = s.groupby(["player_id", "zone"]).agg(fga=("made", "size"), fgm=("made", "sum"), ast=("ast", "sum")).reset_index()
    g = g[g["player_id"].isin(pg.index)]
    tot = g.groupby("player_id")["fga"].sum()
    g["games"] = g["player_id"].map(pg)
    g["fga_pg"] = g["fga"] / g["games"]
    g["fgm_pg"] = g["fgm"] / g["games"]
    g["fg_pct"] = g["fgm"] / g["fga"] * 100
    g["share"] = g["fga"] / g["player_id"].map(tot) * 100
    g["ast_pct"] = np.where(g["fgm"] > 0, g["ast"] / g["fgm"] * 100, np.nan)
    # league rank in makes per game from each zone, among players with 3+ games
    ok = g["games"] >= 3
    g["rank_fgm"] = np.nan
    g.loc[ok, "rank_fgm"] = g[ok].groupby("zone")["fgm_pg"].rank(method="min", ascending=False)
    g = g.join(last, on="player_id")
    g = g[["player_id", "player", "team", "position", "zone", "games", "fga", "fgm", "fga_pg", "fgm_pg", "fg_pct", "share", "ast_pct", "rank_fgm"]]
    for c in ["fga_pg", "fgm_pg"]:
        g[c] = g[c].round(2)
    for c in ["fg_pct", "share", "ast_pct"]:
        g[c] = g[c].round(1)
    g["rank_fgm"] = g["rank_fgm"].astype("Int64")
    g.sort_values(["player_id", "zone"]).to_csv(f"{out}/shot_player.csv", index=False)

    team_efficiency(pbp, logs, out)

    with open(f"{out}/shots_meta.txt", "w") as f:
        f.write(f"season={season}\ngames={s['game_id'].nunique()}\nshots={len(s)}\nthrough_date={str(pbp['game_date'].max())[:10]}\n"
                f"built_at={dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}\n")
    print(f"nba shots: {len(s)} shots from {s['game_id'].nunique()} games, {g['player_id'].nunique()} players")


def team_efficiency(pbp, logs, out):
    """Possessions, offensive and defensive efficiency (points per 100 possessions) and pace for every team.
    Possessions = FGA + 0.44 x FTA - offensive rebounds + turnovers (turnovers from the player box scores)."""
    p = pbp.copy()
    p["game_id"] = p["game_id"].astype(str)
    tid = pd.to_numeric(p["team_id"], errors="coerce")
    home = (tid == pd.to_numeric(p["home_team_id"], errors="coerce")).to_numpy()
    away = (tid == pd.to_numeric(p["away_team_id"], errors="coerce")).to_numpy()
    p["team"] = np.where(home, p["home_team_abbrev"], np.where(away, p["away_team_abbrev"], None))
    p = p[p["team"].notna()]
    tt = p["type_text"].fillna("")
    p["fga"] = ((p["shooting_play"] == True) & ~tt.str.contains("Free Throw")).astype(int)  # noqa: E712
    p["fta"] = (tt.str.startswith("Free Throw") & ~tt.str.contains("Technical")).astype(int)
    p["oreb"] = ((tt == "Offensive Rebound") & p["athlete_id_1"].notna()).astype(int)  # team rebounds (no player) are not possessions
    g = p.groupby(["game_id", "team"])[["fga", "fta", "oreb"]].sum().reset_index()
    cur = logs.copy(); cur["game_id"] = cur["game_id"].astype(str)
    tov = cur.groupby(["game_id", "team"])["tov"].sum().reset_index()
    g = g.merge(tov, on=["game_id", "team"], how="left").fillna({"tov": 0})
    g["poss"] = g["fga"] + 0.44 * g["fta"] - g["oreb"] + g["tov"]
    games = pd.read_csv(f"{out}/games.csv", dtype={"game_id": str})
    games = games[games["status"] == "final"]
    sc = pd.concat([games[["game_id", "away_team", "away_score", "home_score"]].rename(columns={"away_team": "team", "away_score": "pf", "home_score": "pa"}),
                    games[["game_id", "home_team", "home_score", "away_score"]].rename(columns={"home_team": "team", "home_score": "pf", "away_score": "pa"})])
    g = g.merge(sc, on=["game_id", "team"], how="inner")
    opp = g[["game_id", "team", "poss"]].rename(columns={"team": "opp", "poss": "opp_poss"})
    g = g.merge(opp, on="game_id"); g = g[g["team"] != g["opp"]]
    g["pace"] = (g["poss"] + g["opp_poss"]) / 2
    t = g.groupby("team").agg(games=("game_id", "nunique"), pf=("pf", "sum"), pa=("pa", "sum"), poss=("poss", "sum"), opp_poss=("opp_poss", "sum"), pace=("pace", "mean")).reset_index()
    t["off_eff"] = (t["pf"] / t["poss"] * 100).round(1)
    t["def_eff"] = (t["pa"] / t["opp_poss"] * 100).round(1)
    t["pace"] = t["pace"].round(1)
    t["off_eff_rk"] = t["off_eff"].rank(ascending=False, method="min").astype(int)
    t["def_eff_rk"] = t["def_eff"].rank(ascending=True, method="min").astype(int)
    t["pace_rk"] = t["pace"].rank(ascending=False, method="min").astype(int)
    t[["team", "games", "off_eff", "def_eff", "pace", "off_eff_rk", "def_eff_rk", "pace_rk"]].to_csv(f"{out}/team_eff.csv", index=False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    today = dt.date.today()
    ap.add_argument("--season", type=int, default=today.year + 1 if today.month >= 9 else today.year)
    ap.add_argument("--out", default="data/nba")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    build(a.season, a.out)
