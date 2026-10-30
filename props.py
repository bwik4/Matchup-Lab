"""
NFL Matchup Lab - sportsbook player props
=========================================
Pulls real player prop lines and odds from The Odds API (https://the-odds-api.com) and
writes data/props.csv, which the Trends tab uses for its book lines, odds and Edge.

It needs a free API key in the ODDS_API_KEY environment variable (a GitHub repo secret
when it runs in the daily update). With no key it does nothing and the site falls back
to estimated lines.

The free plan has 500 credits a month. One pull of every game costs about
(games x markets) credits, so this pulls the whole week once, on the morning of the
week's first game (usually Thursday), and checks the credits left before it spends any.

  props.csv  one row per player per stat: the main line, over/under odds and the book

Usage:
  ODDS_API_KEY=xxxx python props.py --out data          # pulls once per week
  ODDS_API_KEY=xxxx python props.py --out data --force  # pull now anyway
"""
import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("ODDS_API_BASE", "https://api.the-odds-api.com/v4")
SPORT = "americanfootball_nfl"
BOOKS = ["draftkings", "fanduel"]  # first one that has the line wins
# Odds API market -> the stat name the site uses
MARKETS = {
    "player_pass_yds": "passing_yards",
    "player_pass_tds": "passing_tds",
    "player_rush_yds": "rushing_yards",
    "player_rush_attempts": "carries",
    "player_receptions": "receptions",
    "player_reception_yds": "receiving_yards",
    "player_rush_reception_yds": "rush_rec_yds",
    "player_anytime_td": "anytime_td",
}
COLS = ["week", "game_id", "player_id", "player", "team", "stat", "line", "over_price", "under_price", "book", "fetched_at"]


def get(path, **params):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        left = r.headers.get("x-requests-remaining")
        return json.loads(r.read().decode()), (float(left) if left not in (None, "") else None)


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def norm(name):
    n = re.sub(r"[^a-z ]", "", str(name).lower().replace("-", " "))
    return " ".join(w for w in n.split() if w not in {"jr", "sr", "ii", "iii", "iv", "v"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--force", action="store_true", help="pull now even if this week was already pulled")
    a = ap.parse_args()
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        print("props: no ODDS_API_KEY set, skipping (the site uses estimated lines)")
        return

    meta = dict(l.strip().split("=", 1) for l in open(os.path.join(a.out, "meta.txt")) if "=" in l)
    week = int(meta["upcoming_week"])
    games = [g for g in read_csv(os.path.join(a.out, "games.csv")) if int(float(g["week"])) == week]
    if not games:
        print(f"props: no games found for week {week}")
        return
    path = os.path.join(a.out, "props.csv")
    old = read_csv(path) if os.path.exists(path) else []
    first_day = min(dt.date.fromisoformat(g["gameday"]) for g in games)
    today = dt.datetime.now(dt.timezone.utc).date()
    if not a.force:
        if any(int(float(r["week"])) == week for r in old):
            print(f"props: week {week} already pulled, skipping")
            return
        if today < first_day:
            print(f"props: week {week} starts {first_day}, waiting until then to pull")
            return

    names = {r["name"]: r["team"] for r in read_csv(os.path.join(a.out, "team_info.csv"))}
    players = read_csv(os.path.join(a.out, "players.csv"))
    gid = {(g["away_team"], g["home_team"]): g["game_id"] for g in games}

    events, left = get(f"/sports/{SPORT}/events", apiKey=key)
    todo = []
    for e in events:
        away, home = names.get(e["away_team"]), names.get(e["home_team"])
        if (away, home) in gid:
            todo.append((e, gid[(away, home)], away, home))
    cost = len(todo) * len(MARKETS)  # credits: markets x regions (2 books = 1 region) per game
    print(f"props: {len(todo)} games for week {week}, about {cost} credits, {left} left")
    if left is not None and left < cost:
        print("props: not enough credits left this month, skipping")
        return

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    rows, missed = [], set()
    for e, game_id, away, home in todo:
        try:
            odds, left = get(f"/sports/{SPORT}/events/{e['id']}/odds", apiKey=key, bookmakers=",".join(BOOKS),
                             markets=",".join(MARKETS), oddsFormat="american")
        except Exception as err:  # one bad game shouldn't sink the rest
            print(f"props: {game_id} failed: {err}")
            continue
        roster = [p for p in players if p["team"] in (away, home)]
        by_name = {}
        for p in roster:
            by_name.setdefault(norm(p["player"]), []).append(p)
        best = {}  # (player_id, stat) -> row from the first book in BOOKS that has it
        books = sorted(odds.get("bookmakers", []), key=lambda b: BOOKS.index(b["key"]) if b["key"] in BOOKS else 99)
        for b in books:
            for m in b.get("markets", []):
                stat = MARKETS.get(m["key"])
                if not stat:
                    continue
                sides = {}
                for o in m.get("outcomes", []):
                    who = o.get("description") or ""
                    side = "over" if o.get("name") in ("Over", "Yes") else "under" if o.get("name") in ("Under", "No") else None
                    if side:
                        sides.setdefault(who, {})[side] = o
                for who, s in sides.items():
                    hits = by_name.get(norm(who), [])
                    if len(hits) != 1:
                        missed.add(who)
                        continue
                    p = hits[0]
                    k = (p["player_id"], stat)
                    if k in best:
                        continue
                    o, u = s.get("over"), s.get("under")
                    line = (o or u).get("point", 0.5)
                    best[k] = {"week": week, "game_id": game_id, "player_id": p["player_id"], "player": p["player"], "team": p["team"],
                               "stat": stat, "line": line, "over_price": o["price"] if o else "", "under_price": u["price"] if u else "",
                               "book": b["key"], "fetched_at": now}
        rows += best.values()
    if not rows:
        print("props: the books returned no lines yet, keeping the old file")
        return
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print(f"props: wrote {len(rows)} lines, {left} credits left" + (f", {len(missed)} names not matched" if missed else ""))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # never fail the daily data update over props
        print(f"props: skipped after an error: {err}", file=sys.stderr)
