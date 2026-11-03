"""
Matchup Lab - men's college basketball data pipeline
====================================================
Pulls free men's college basketball data from SportsDataverse (hoopR data, sourced from ESPN,
refreshed daily on GitHub) plus betting lines from ESPN's scoreboard, and builds the tables
behind the CBB side of the site. Every output is a plain CSV in --out (default ./data/cbb).

  logs.csv     every player game this season (+ last season for players still around):
               points, rebounds, assists, threes, steals, blocks, turnovers, minutes
  games.csv    this season's D1 schedule: tip time, AP ranks, records, scores, halftime scores,
               the spread / total / moneylines, and the model's projected score for games not played yet
  totals.csv   the over/under dataset: one row per team per D1 game, this season and last, with
               the final total, the closing total, over/under result and margin, first and second
               half points, possessions, offensive / defensive efficiency, shooting volume and OT
  ratings.csv  tempo and efficiency ratings for every D1 team (adjusted for opponent and venue),
               the inputs to the projected totals
  dvp.csv      defense vs position: what each D1 defense allows per game to guards, forwards and
               centers for every prop stat, ranked (1 = toughest)
  lines.csv    every line pulled from ESPN so far (kept between runs so old lines aren't lost)
  teams.csv    team names, colors and conference (for the badges)
  meta.txt     season, last game date, build time

Usage:
  pip install pandas pyarrow
  python cbb_pipeline.py --out data/cbb
"""
import argparse
import datetime as dt
import json
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

REL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
TAG = "espn_mens_college_basketball"
ET = ZoneInfo("America/New_York")
STATS = {"points": "pts", "rebounds": "reb", "assists": "ast", "three_point_field_goals_made": "fg3m",
         "steals": "stl", "blocks": "blk", "turnovers": "tov", "minutes": "min"}
COMBOS = {"pra": ["pts", "reb", "ast"], "pr": ["pts", "reb"], "pa": ["pts", "ast"], "ra": ["reb", "ast"], "sb": ["stl", "blk"]}
PROP_STATS = ["pts", "reb", "ast", "fg3m", "pra", "pr", "pa", "ra", "sb"]
POS_MAP = {"G": "G", "PG": "G", "SG": "G", "F": "F", "SF": "F", "PF": "F", "C": "C"}
LINE_COLS = ["spread_line", "total_line", "away_moneyline", "home_moneyline", "away_spread_odds", "home_spread_odds", "over_odds", "under_odds", "open_total"]
HCA = 1.4        # home-court edge, points per 100 possessions on each side of the ball
PRIOR_GAMES = 5  # early in the season, ratings lean on last season as if it were this many games
MAX_LINE_DAYS = 200  # most scoreboard days to pull per run when backfilling old lines
MAX_CORE_GAMES = 3000  # most finished games to look up one by one per run (ESPN's scoreboard drops lines once a game is over)


def load(kind, name):
    try:
        return pd.read_parquet(f"{REL}/{TAG}_{kind}/{name}.parquet")
    except Exception as err:
        print(f"cbb: couldn't load {kind}/{name} ({err})")
        return pd.DataFrame()


def num(s):
    return pd.to_numeric(s, errors="coerce")


def parse_list(v):
    """ESPN list columns (records, linescores) come as arrays of dicts or as their printed text."""
    if isinstance(v, str):
        return [dict(re.findall(r"'(\w+)': '?([^',}\n]*)'?", chunk)) for chunk in re.findall(r"\{[^}]*\}", v)]
    try:
        return [x for x in list(v) if isinstance(x, dict)]
    except TypeError:
        return []


def record(v):
    for r in parse_list(v):
        if r.get("type") == "total" or r.get("name") == "overall":
            return r.get("summary")
    return None


def halves(v):
    """[1st half, 2nd half, OT periods] from a linescores column."""
    vals = []
    for r in parse_list(v):
        try:
            vals.append(float(r.get("value")))
        except (TypeError, ValueError):
            pass
    return (vals[0] if vals else np.nan, vals[1] if len(vals) > 1 else np.nan, max(0, len(vals) - 2))


# ---------------------------------------------------------------- schedule + teams
def schedule(season):
    sc = load("schedules", f"mbb_schedule_{season}")
    if sc.empty:
        return sc
    sc = sc[sc["season_type"].isin([2, 3])].copy()
    sc["home_id"], sc["away_id"] = sc["home_id"].astype(str), sc["away_id"].astype(str)
    return sc.drop_duplicates("game_id")


def team_table(scheds):
    """One row per team seen in either season's schedule. D1 = has a conference id."""
    rows = []
    for sc in scheds:
        for side in ("home", "away"):
            rows.append(pd.DataFrame({"id": sc[f"{side}_id"], "abbr": sc[f"{side}_abbreviation"], "loc": sc[f"{side}_location"],
                                      "name": sc[f"{side}_display_name"], "color": sc[f"{side}_color"], "color2": sc[f"{side}_alternate_color"],
                                      "conf": sc[f"{side}_conference_id"], "season": sc["season"]}))
    t = pd.concat(rows).sort_values("season").groupby("id").agg("last").reset_index()
    conf = pd.concat(rows).groupby("id")["conf"].apply(lambda s: s.dropna().iloc[-1] if s.notna().any() else np.nan)
    t["conf"] = t["id"].map(conf)
    t["d1"] = t["conf"].notna().astype(int)
    t["abbr"] = t["abbr"].fillna(t["loc"].astype(str).str[:4].str.upper())
    # D1 teams keep ESPN's abbreviation; any non-D1 team that collides gets its id tacked on
    dup = t["abbr"].duplicated(keep=False)
    t.loc[dup & (t["d1"] == 0), "abbr"] = t["abbr"] + "-" + t["id"]
    dup = t["abbr"].duplicated(keep=False)
    t.loc[dup, "abbr"] = t["abbr"] + "-" + t["id"]
    hexc = lambda s: ("#" + s.fillna("").astype(str).str.lstrip("#")).where(s.fillna("").astype(str).str.lstrip("#").str.match(r"^[0-9a-fA-F]{6}$"), None)
    return pd.DataFrame({"id": t["id"], "team": t["abbr"], "name": t["name"], "nick": t["loc"], "color": hexc(t["color"]).fillna("#555555"),
                         "color2": hexc(t["color2"]).fillna("#888888"), "conf": num(t["conf"]).astype("Int64"), "d1": t["d1"]})


def games_frame(sc, by_id):
    when = pd.to_datetime(sc["game_date_time"], utc=True).dt.tz_convert(ET)
    h = sc["home_linescores"].map(halves)
    a = sc["away_linescores"].map(halves)
    rank = lambda s: num(s).where(num(s).between(1, 25))
    g = pd.DataFrame({
        "game_id": sc["game_id"].astype(str), "season": sc["season"].astype(int),
        "gameday": when.dt.strftime("%Y-%m-%d"), "gametime": np.where(sc["time_valid"].fillna(True), when.dt.strftime("%H:%M"), ""),
        "away_team": sc["away_id"].map(by_id), "home_team": sc["home_id"].map(by_id),
        "away_rank": rank(sc["away_current_rank"]), "home_rank": rank(sc["home_current_rank"]),
        "status": np.where(sc["status_type_completed"].fillna(False), "final", "scheduled"),
        "away_score": num(sc["away_score"]), "home_score": num(sc["home_score"]),
        "away_h1": [x[0] for x in a], "home_h1": [x[0] for x in h], "ot": [max(x[2], y[2]) for x, y in zip(a, h)],
        "neutral": sc["neutral_site"].fillna(False).astype(int), "conf_game": sc["conference_competition"].fillna(False).astype(int),
        "postseason": (sc["season_type"] == 3).astype(int), "note": sc["notes_headline"].fillna(""),
        "away_record": sc["away_records"].map(record), "home_record": sc["home_records"].map(record),
    })
    nf = g["status"] != "final"
    g.loc[nf, ["away_score", "home_score", "away_h1", "home_h1", "ot"]] = np.nan
    return g.dropna(subset=["away_team", "home_team"]).sort_values(["gameday", "gametime", "game_id"])


# ---------------------------------------------------------------- lines from ESPN's scoreboard
def american(v):
    if v in (None, ""):
        return None
    if str(v).upper() in ("EVEN", "EV"):
        return 100
    try:
        return int(float(str(v).replace("+", "")))
    except (TypeError, ValueError):
        return None


def espn_day(day):
    """{game_id: {line cols}} for one date. Best effort: {} on any failure."""
    url = ("https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
           f"?dates={day:%Y%m%d}&groups=50&limit=500")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25) as r:
            sb = json.loads(r.read().decode())
    except Exception as err:
        print(f"cbb: ESPN scoreboard unavailable for {day} ({err})")
        return None
    out = {}
    for ev in sb.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        odds = (comp.get("odds") or [None])[0]
        if not odds:
            continue
        ab = {c.get("homeAway"): c.get("team", {}).get("abbreviation") for c in comp.get("competitors", [])}
        row = {}
        det = str(odds.get("details") or "").split()
        if len(det) == 2:
            try:
                pts = abs(float(det[1]))
                row["spread_line"] = pts if det[0] == ab.get("home") else -pts if det[0] == ab.get("away") else None
            except ValueError:
                pass
        elif str(odds.get("details") or "").upper() in ("EVEN", "PK", "PICK"):
            row["spread_line"] = 0.0
        if row.get("spread_line") is None and odds.get("spread") is not None:  # some feeds give the home spread as a number
            try:
                row["spread_line"] = -float(odds["spread"])
            except (TypeError, ValueError):
                pass
        if odds.get("overUnder") is not None:
            try:
                row["total_line"] = float(odds["overUnder"])
            except (TypeError, ValueError):
                pass
        for side in ("home", "away"):
            t = odds.get(f"{side}TeamOdds") or {}
            ml = american(t.get("moneyLine"))
            so = american(t.get("spreadOdds"))
            if ml is None:
                ml = american((((odds.get("moneyline") or {}).get(side) or {}).get("close") or {}).get("odds"))
            if so is None:
                so = american((((odds.get("pointSpread") or {}).get(side) or {}).get("close") or {}).get("odds"))
            row[f"{side}_moneyline"], row[f"{side}_spread_odds"] = ml, so
        tot = odds.get("total") or {}
        row["over_odds"] = american(((tot.get("over") or {}).get("close") or {}).get("odds")) or american(odds.get("overOdds"))
        row["under_odds"] = american(((tot.get("under") or {}).get("close") or {}).get("odds")) or american(odds.get("underOdds"))
        if row.get("spread_line") is not None or row.get("total_line") is not None:
            out[str(ev.get("id"))] = row
    return out


def core_odds(gid):
    """Closing line for one game from ESPN's odds feed, which keeps lines after the game is over."""
    url = (f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/events/{gid}/competitions/{gid}/odds")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as r:
            items = json.loads(r.read().decode()).get("items") or []
    except Exception:
        return gid, None
    items = sorted(items, key=lambda x: (x.get("provider") or {}).get("priority", 99))
    for it in items:
        row = {}
        try:
            if it.get("spread") is not None:
                row["spread_line"] = -float(it["spread"])
            if it.get("overUnder") is not None:
                row["total_line"] = float(it["overUnder"])
        except (TypeError, ValueError):
            pass
        for side in ("home", "away"):
            t = it.get(f"{side}TeamOdds") or {}
            row[f"{side}_moneyline"], row[f"{side}_spread_odds"] = american(t.get("moneyLine")), american(t.get("spreadOdds"))
        row["over_odds"], row["under_odds"] = american(it.get("overOdds")), american(it.get("underOdds"))
        try:  # opening total, when the feed has it ("o146.5")
            ot = ((it.get("open") or {}).get("total") or {}).get("alternateDisplayValue")
            row["open_total"] = float(str(ot).lstrip("ouOU")) if ot not in (None, "") else None
        except ValueError:
            pass
        if row.get("total_line") is not None or row.get("spread_line") is not None:
            return gid, row
    return gid, {}


def update_lines(out, all_games):
    """Keep a running file of lines. Upcoming days are refreshed every run (lines move until tip),
    finished days are pulled once (closing line), and older days are backfilled a batch at a time."""
    path, done_path = f"{out}/lines.csv", f"{out}/lines_days.txt"
    lines = pd.read_csv(path, dtype={"game_id": str}) if os.path.exists(path) else pd.DataFrame(columns=["game_id"] + LINE_COLS)
    done = set(open(done_path).read().split()) if os.path.exists(done_path) else set()
    today = dt.datetime.now(ET).date()
    days = sorted({dt.date.fromisoformat(d) for d in all_games["gameday"]})
    fresh = [d for d in days if today - dt.timedelta(days=1) <= d <= today + dt.timedelta(days=2)]
    old = [d for d in reversed(days) if d < today - dt.timedelta(days=1) and d.isoformat() not in done][:MAX_LINE_DAYS]
    found, pulled = {}, 0
    for d in old + fresh:
        got = espn_day(d)
        if got is None:
            continue
        pulled += 1
        found.update(got)
        if d < today - dt.timedelta(days=1):
            done.add(d.isoformat())
    # finished games: ask ESPN's odds feed for the closing line game by game (newest first, a batch per run)
    tried_path = f"{out}/lines_tried.txt"
    tried = set(open(tried_path).read().split()) if os.path.exists(tried_path) else set()
    # (also finished games whose line was saved before tip, to swap in the closing line)
    todo = all_games.loc[(all_games["status"] == "final") & ~all_games["game_id"].isin(tried)]
    todo = todo.sort_values("gameday", ascending=False)["game_id"].tolist()[:MAX_CORE_GAMES]
    n_core = 0
    if todo:
        with ThreadPoolExecutor(max_workers=12) as ex:
            for gid, row in ex.map(core_odds, todo):
                if row is None:
                    continue  # network trouble: try again next run
                tried.add(gid)
                if row:
                    found[gid] = row
                    n_core += 1
        with open(tried_path, "w") as f:
            f.write("\n".join(sorted(tried)) + "\n")
    print(f"cbb: looked up {len(todo)} finished games one by one, {n_core} had lines")
    if found:
        new = pd.DataFrame.from_dict(found, orient="index").rename_axis("game_id").reset_index()
        lines = pd.concat([lines[~lines["game_id"].isin(new["game_id"])], new], ignore_index=True)
    for c in LINE_COLS:
        if c not in lines.columns:
            lines[c] = np.nan
    lines = lines[["game_id"] + LINE_COLS]
    lines.to_csv(path, index=False)
    with open(done_path, "w") as f:
        f.write("\n".join(sorted(done)) + "\n")
    print(f"cbb: pulled lines for {pulled} days ({len(found)} games), {len(lines)} games with lines on file")
    return lines


# ---------------------------------------------------------------- team games: pace, efficiency, totals
def team_games(season, by_id, games):
    tb = load("team_boxscores", f"team_box_{season}")
    if tb.empty:
        return pd.DataFrame()
    tb = tb[tb["season_type"].isin([2, 3])].copy()
    tb["team"], tb["opp"] = tb["team_id"].astype(str).map(by_id), tb["opponent_team_id"].astype(str).map(by_id)
    tb["game_id"] = tb["game_id"].astype(str)
    for c in ["field_goals_attempted", "offensive_rebounds", "total_turnovers", "turnovers", "free_throws_attempted",
              "three_point_field_goals_attempted", "three_point_field_goals_made", "field_goals_made", "free_throws_made", "team_score"]:
        tb[c] = num(tb[c])
    tov = tb["total_turnovers"].fillna(tb["turnovers"])
    tb["poss_est"] = tb["field_goals_attempted"] - tb["offensive_rebounds"] + tov + 0.475 * tb["free_throws_attempted"]
    t = pd.DataFrame({"game_id": tb["game_id"], "team": tb["team"], "opp": tb["opp"], "fga": tb["field_goals_attempted"],
                      "fg3a": tb["three_point_field_goals_attempted"], "fg3m": tb["three_point_field_goals_made"], "fgm": tb["field_goals_made"],
                      "fta": tb["free_throws_attempted"], "ftm": tb["free_throws_made"], "orb": tb["offensive_rebounds"], "tov": tov,
                      "poss_est": tb["poss_est"]}).dropna(subset=["team", "opp"]).drop_duplicates(["game_id", "team"])
    o = t[["game_id", "team", "poss_est"]].rename(columns={"team": "opp", "poss_est": "opp_poss"})
    t = t.merge(o, on=["game_id", "opp"], how="left")
    t["poss"] = t[["poss_est", "opp_poss"]].mean(axis=1)
    g = games[games["status"] == "final"]
    rows = []
    for side, oth in (("home", "away"), ("away", "home")):
        rows.append(pd.DataFrame({"game_id": g["game_id"], "team": g[f"{side}_team"], "season": g["season"], "date": g["gameday"],
                                  "site": np.where(g["neutral"] == 1, "N", "H" if side == "home" else "A"), "conf_game": g["conf_game"],
                                  "postseason": g["postseason"], "pf": g[f"{side}_score"], "pa": g[f"{oth}_score"],
                                  "h1_pf": g[f"{side}_h1"], "h1_pa": g[f"{oth}_h1"], "ot": g["ot"],
                                  "rank": g[f"{side}_rank"], "opp_rank": g[f"{oth}_rank"],
                                  "spread": (-g["spread_line"] if side == "home" else g["spread_line"]) if "spread_line" in g else np.nan,
                                  "total_line": g["total_line"] if "total_line" in g else np.nan}))
    r = pd.concat(rows, ignore_index=True).merge(t, on=["game_id", "team"], how="inner")
    r["total"] = r["pf"] + r["pa"]
    r["h1_total"] = r["h1_pf"] + r["h1_pa"]
    r["h2_total"] = np.where(r["ot"] > 0, np.nan, r["total"] - r["h1_total"])  # 2nd half incl. OT is skewed, so leave it out
    r["minutes"] = 40 + 5 * r["ot"].fillna(0)
    r["tempo"] = r["poss"] * 40 / r["minutes"]  # possessions per 40 minutes
    r["off_eff"] = r["pf"] / r["poss"] * 100
    r["def_eff"] = r["pa"] / r["poss"] * 100
    r["ou_margin"] = r["total"] - r["total_line"]
    r["ou"] = np.select([r["ou_margin"] > 0, r["ou_margin"] < 0, r["ou_margin"] == 0], ["O", "U", "P"], "")
    r["ats_margin"] = r["pf"] - r["pa"] + r["spread"]
    return r


# ---------------------------------------------------------------- adjusted tempo / efficiency
def ratings(tg, d1):
    """KenPom-style ratings from D1-vs-D1 games: each team's tempo and points per 100 possessions on
    offense and defense, adjusted for the strength of the opponents and for home court."""
    x = tg[tg["team"].isin(d1) & tg["opp"].isin(d1) & tg["poss"].gt(40)].copy()
    if x.empty:
        return pd.DataFrame(), {}
    loc = x["site"].map({"H": 1, "A": -1, "N": 0})
    x["o"] = x["off_eff"] - HCA * loc
    x["d"] = x["def_eff"] + HCA * loc
    lgE, lgT = x["off_eff"].mean(), x["tempo"].mean()
    teams = sorted(set(x["team"]))
    O = pd.Series(x.groupby("team")["o"].mean()).reindex(teams)
    D = pd.Series(x.groupby("team")["d"].mean()).reindex(teams)
    T = pd.Series(x.groupby("team")["tempo"].mean()).reindex(teams)
    for _ in range(20):
        x["ao"] = x["o"] - (x["opp"].map(D) - lgE)
        x["ad"] = x["d"] - (x["opp"].map(O) - lgE)
        x["at"] = x["tempo"] - (x["opp"].map(T) - lgT)
        O, D, T = x.groupby("team")["ao"].mean(), x.groupby("team")["ad"].mean(), x.groupby("team")["at"].mean()
    out = pd.DataFrame({"team": teams, "games": x.groupby("team").size().reindex(teams).values,
                        "adj_o": O.reindex(teams).values, "adj_d": D.reindex(teams).values, "adj_t": T.reindex(teams).values})
    return out, {"eff": lgE, "tempo": lgT}


def blended(cur, prev, lg_cur, lg_prev, d1):
    """This season's ratings, leaning on last season (pulled 30% back to average) until a team has played a few games."""
    base = pd.DataFrame({"team": sorted(d1)})
    lg = lg_cur or lg_prev or {"eff": 105.0, "tempo": 68.0}
    if not prev.empty:
        p = prev.set_index("team")
        for c, k in (("adj_o", "eff"), ("adj_d", "eff"), ("adj_t", "tempo")):
            base[f"p_{c}"] = base["team"].map(p[c]) * 0.7 + lg[k] * 0.3
    for c, k in (("adj_o", "eff"), ("adj_d", "eff"), ("adj_t", "tempo")):
        if f"p_{c}" not in base:
            base[f"p_{c}"] = lg[k]
        base[f"p_{c}"] = base[f"p_{c}"].fillna(lg[k])
    c = cur.set_index("team") if not cur.empty else pd.DataFrame(columns=["games", "adj_o", "adj_d", "adj_t"])
    n = base["team"].map(c["games"]).fillna(0) if len(c) else pd.Series(0, index=base.index)
    w = n / (n + PRIOR_GAMES)
    for col in ("adj_o", "adj_d", "adj_t"):
        now = base["team"].map(c[col]) if len(c) else pd.Series(np.nan, index=base.index)
        base[col] = (w * now.fillna(0) + (1 - w) * base[f"p_{col}"]).where(n > 0, base[f"p_{col}"])
    base["games"] = n.astype(int)
    base["adj_em"] = base["adj_o"] - base["adj_d"]
    return base[["team", "games", "adj_o", "adj_d", "adj_t", "adj_em"]], lg


def calibration(tg, R, lg):
    """How far the model's totals ran from the real totals over a full season (projected with that season's
    own ratings). Added back to every projection so the model isn't systematically high or low."""
    if R.empty:
        return 0.0
    r = R.set_index("team")
    h = tg[(tg["site"] != "A") & tg["team"].isin(r.index) & tg["opp"].isin(r.index)].drop_duplicates("game_id")
    if h.empty:
        return 0.0
    loc = np.where(h["site"] == "N", 0, 1)
    T = h["team"].map(r["adj_t"]) + h["opp"].map(r["adj_t"]) - lg["tempo"]
    pt = (h["team"].map(r["adj_o"]) + h["opp"].map(r["adj_d"]) - lg["eff"] + HCA * loc) * T / 100
    po = (h["opp"].map(r["adj_o"]) + h["team"].map(r["adj_d"]) - lg["eff"] - HCA * loc) * T / 100
    return float((h["total"] - pt - po).mean())


def project(games, R, lg, adj=0.0):
    """Projected score for each game not played yet: tempo = both teams' adjusted tempos combined,
    points = offense rating vs the other side's defense rating, scaled to that tempo, with home court."""
    r = R.set_index("team")
    g = games.copy()
    for c in ("proj_tempo", "proj_away", "proj_home", "proj_total"):
        g[c] = np.nan
    m = (g["status"] != "final") & g["away_team"].isin(r.index) & g["home_team"].isin(r.index)
    a, h = g.loc[m, "away_team"], g.loc[m, "home_team"]
    loc = np.where(g.loc[m, "neutral"] == 1, 0, 1)
    T = a.map(r["adj_t"]).values + h.map(r["adj_t"]).values - lg["tempo"]
    ph = (h.map(r["adj_o"]).values + a.map(r["adj_d"]).values - lg["eff"] + HCA * loc) * T / 100
    pa = (a.map(r["adj_o"]).values + h.map(r["adj_d"]).values - lg["eff"] - HCA * loc) * T / 100
    pa, ph = pa + adj / 2, ph + adj / 2
    g.loc[m, "proj_tempo"], g.loc[m, "proj_away"], g.loc[m, "proj_home"] = T.round(1), pa.round(1), ph.round(1)
    g.loc[m, "proj_total"] = (pa + ph).round(1)
    return g


# ---------------------------------------------------------------- player logs + defense vs position
def player_logs(season, by_id):
    pb = load("player_boxscores", f"player_box_{season}")
    if pb.empty:
        return pd.DataFrame()
    pb = pb[pb["season_type"].isin([2, 3]) & ~pb["did_not_play"].fillna(False) & num(pb["minutes"]).fillna(0).gt(0)].copy()
    out = pd.DataFrame({
        "player_id": num(pb["athlete_id"]).astype("Int64").astype(str), "player": pb["athlete_display_name"],
        "position": pb["athlete_position_abbreviation"].fillna("").map(POS_MAP).fillna("F"),
        "season": pb["season"].astype(int), "date": pd.to_datetime(pb["game_date"]).dt.strftime("%Y-%m-%d"),
        "game_id": pb["game_id"].astype(str), "team": pb["team_id"].astype(str).map(by_id),
        "opp": pb["opponent_team_id"].astype(str).map(by_id), "home": (pb["home_away"] == "home").astype(int),
        "starter": pb["starter"].fillna(False).astype(int),
    })
    for src, dst in STATS.items():
        out[dst] = num(pb[src]).fillna(0).round(0).astype(int)
    return out.dropna(subset=["team", "opp"])


def build(season, out):
    os.makedirs(out, exist_ok=True)
    sc, sc_prev = schedule(season), schedule(season - 1)
    if sc.empty:
        raise SystemExit("cbb: no schedule for this season yet")
    tm = team_table([s for s in (sc_prev, sc) if not s.empty])
    by_id = dict(zip(tm["id"], tm["team"]))
    d1 = set(tm.loc[tm["d1"] == 1, "team"])
    tm.drop(columns="id").sort_values("team").to_csv(f"{out}/teams.csv", index=False)

    # ---------- schedule (games with at least one D1 team) + lines ----------
    games = games_frame(sc, by_id)
    prev_games = games_frame(sc_prev, by_id) if not sc_prev.empty else games.iloc[0:0]
    games = games[games["away_team"].isin(d1) | games["home_team"].isin(d1)]
    prev_games = prev_games[prev_games["away_team"].isin(d1) | prev_games["home_team"].isin(d1)]
    lines = update_lines(out, pd.concat([prev_games, games]))
    lk = lines.set_index("game_id")
    for gdf in (games, prev_games):
        for c in LINE_COLS:
            gdf[c] = gdf["game_id"].map(lk[c]) if len(lk) else np.nan

    # ---------- the totals dataset: one row per team per game, both seasons ----------
    tg = pd.concat([team_games(season - 1, by_id, prev_games), team_games(season, by_id, games)], ignore_index=True)
    tg = tg[tg["team"].isin(d1)].sort_values(["date", "game_id", "site"])

    # ---------- ratings + projected scores ----------
    tg_prev, tg_cur = tg[tg["season"] == season - 1], tg[tg["season"] == season]
    r_prev, lg_prev = ratings(tg_prev, d1)
    r_cur, lg_cur = ratings(tg_cur, d1)
    R, lg = blended(r_cur, r_prev, lg_cur, lg_prev, d1)
    raw = tg_cur[tg_cur["opp"].isin(d1)].groupby("team").agg(raw_tempo=("tempo", "mean"), raw_o=("off_eff", "mean"), raw_d=("def_eff", "mean"))
    R = R.join(raw, on="team")
    if not r_prev.empty:
        R = R.merge(r_prev.rename(columns={"games": "prev_games", "adj_o": "prev_adj_o", "adj_d": "prev_adj_d", "adj_t": "prev_adj_t"}), on="team", how="left")
    for c, asc in (("adj_o", False), ("adj_d", True), ("adj_t", False), ("adj_em", False)):
        R[f"{c}_rk"] = R[c].rank(method="min", ascending=asc).astype(int)
    R.round(2).to_csv(f"{out}/ratings.csv", index=False)
    calib = calibration(tg_prev, r_prev, lg_prev) if not r_prev.empty else 0.0
    games = project(games, R, lg, calib)
    # keep the pre-game projection for games that have finished since the last run (the model's track record)
    old_path = f"{out}/games.csv"
    if os.path.exists(old_path):
        old = pd.read_csv(old_path, dtype={"game_id": str})
        fin = games["status"] == "final"
        for c in ("proj_tempo", "proj_away", "proj_home", "proj_total"):
            if c in old.columns:
                games.loc[fin, c] = games.loc[fin, "game_id"].map(dict(zip(old["game_id"], old[c])))
    games.drop(columns=["season"]).to_csv(old_path, index=False)

    keep = ["season", "date", "game_id", "team", "opp", "site", "conf_game", "postseason", "rank", "opp_rank", "pf", "pa", "total",
            "total_line", "ou", "ou_margin", "spread", "ats_margin", "h1_pf", "h1_pa", "h1_total", "h2_total", "ot", "poss", "tempo",
            "off_eff", "def_eff", "fga", "fgm", "fg3a", "fg3m", "fta", "ftm", "orb", "tov"]
    tg[keep].round(2).to_csv(f"{out}/totals.csv", index=False)

    # ---------- player logs ----------
    cur = player_logs(season, by_id)
    prev = player_logs(season - 1, by_id)
    if not cur.empty:
        prev = prev[prev["player_id"].isin(set(cur["player_id"]))]  # last season only for players still around
    logs = pd.concat([cur, prev], ignore_index=True)
    logs = logs[logs["team"].isin(d1)].sort_values(["date", "game_id"])
    logs.to_csv(f"{out}/logs.csv", index=False)

    # ---------- defense vs position (D1 defenses, this season; last season until games are played) ----------
    dv_season = season if not cur.empty and cur["game_id"].nunique() >= 200 else season - 1
    c = logs[(logs["season"] == dv_season) & logs["opp"].isin(d1)].copy() if dv_season == season else player_logs(season - 1, by_id)
    c = c[c["opp"].isin(d1)].copy()
    for k, parts in COMBOS.items():
        c[k] = c[parts].sum(axis=1)
    rows = []
    if not c.empty:
        per = c.groupby(["game_id", "opp", "position"])[PROP_STATS].sum().reset_index()
        gp = c.groupby("opp")["game_id"].nunique().rename("games")
        for pos in ["G", "F", "C"]:
            sub = per[per["position"] == pos].groupby("opp")[PROP_STATS].sum().reindex(gp.index).fillna(0).div(gp, axis=0)
            for st in PROP_STATS:
                rk = sub[st].rank(method="min", ascending=True).astype(int)
                for d in sub.index:
                    rows.append({"defense": d, "position": pos, "stat": st, "games": int(gp[d]), "per_game": round(sub.at[d, st], 2), "rank": int(rk[d])})
    pd.DataFrame(rows, columns=["defense", "position", "stat", "games", "per_game", "rank"]).to_csv(f"{out}/dvp.csv", index=False)

    thru = games.loc[games["status"] == "final", "gameday"].max() if (games["status"] == "final").any() else ""
    with open(f"{out}/meta.txt", "w") as f:
        f.write(f"season={season}\nseason_label={season - 1}-{str(season)[2:]}\nthrough_date={thru}\nd1_teams={len(d1)}\n"
                f"dvp_season={dv_season}\ncalibration={calib:.2f}\nlg_eff={lg['eff']:.2f}\nlg_tempo={lg['tempo']:.2f}\n"
                f"built_at={dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}\n")
    n_lines = int(tg["total_line"].notna().sum() // 2)
    print(f"cbb: {len(logs)} player games, {len(games)} games this season, {len(tg) // 2} team games in the totals file "
          f"({n_lines} with a closing total), {int(games['proj_total'].notna().sum())} projections, through {thru}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    today = dt.date.today()
    # hoopR names a season by the year it ends: 2026-27 = 2027
    ap.add_argument("--season", type=int, default=today.year + 1 if today.month >= 10 else today.year)
    ap.add_argument("--out", default="data/cbb")
    a = ap.parse_args()
    build(a.season, a.out)
