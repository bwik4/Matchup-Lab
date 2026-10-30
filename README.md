# Matchup Lab

Betting and fantasy research for the NFL, laid out like an app with a sidebar (a bottom tab bar on phones):

- **Home**: every game for the week, grouped by day, with spread, moneyline and total. Tap a game for its research page: **Odds**, **Matchup** (offense vs defense ranks over the last 3, last 5 or full season), **Players** (starting QBs and top receivers/rushers with matchup grades), **Usage share** (target and carry share, overall or red zone) and **Game lines** (each team's ATS and over/under history, plus head to head).
- **Stats**: team stats and betting records, defense vs position, and player prop cards with hit rates.
- **Fantasy**: fantasy points each defense allows to QB/RB/WR/TE with every game log against it, and a player outlook with rest-of-season strength of schedule, week-by-week matchup difficulty, past players at his position vs each opponent, and weekly projections. Free NFL data from [nflverse](https://github.com/nflverse/nflverse-data), rebuilt automatically every Tuesday.

## What's in here

| File | What it does |
|---|---|
| `index.html` | The whole website: layout, styles, charts and tables. Edit this to change how it looks or what it shows. Pages are linked with addresses like `#home`, `#game/2026_08_TEN_CIN/odds`, `#stats/players`, `#fantasy` and `#trends`. |
| `pipeline.py` | Downloads the raw nflverse data and calculates everything (points allowed, ranks, averages). Edit this to add new stats. |
| `data/` | The CSV files the pipeline creates. The website reads these. |
| `.github/workflows/update-data.yml` | Tells GitHub to rerun the pipeline every Tuesday and save the new data. |

## Put it online (free, one time, about 10 minutes)

1. Make a free account at [github.com](https://github.com).
2. Click **+** (top right) → **New repository**. Name it `nfl-matchup-lab`, set it to **Public**, and click **Create repository**.
3. On the next page click **uploading an existing file**. Drag in everything from this folder **except** the `.github` folder (the web uploader skips hidden folders). Click **Commit changes**.
4. Add the auto-update file: click **Add file → Create new file**. For the name, type `.github/workflows/update-data.yml` (the slashes create the folders). Paste in the contents of that file from this folder, then **Commit changes**.
5. Turn on the website: **Settings → Pages**. Under "Branch" pick `main` and `/ (root)`, then **Save**. After a minute your site is live at `https://YOUR-USERNAME.github.io/nfl-matchup-lab/`.
6. Let the updater save data: **Settings → Actions → General → Workflow permissions** → choose **Read and write permissions** → **Save**.

## Updating the data

- **Automatic:** every Tuesday morning.
- **Manual:** go to the **Actions** tab → **Update NFL data** → **Run workflow**. The site updates a minute or two after it finishes.

## Editing

- **Small changes** (wording, colors, column names): open the file on GitHub, click the pencil icon, edit and commit. Colors are all at the top of `index.html` under `:root`.
- **Bigger changes:** use [VS Code](https://code.visualstudio.com) on your computer (or GitHub Desktop to sync files back and forth).

### Testing on your computer

Double-clicking `index.html` won't load the data (browsers block local file reads). Instead:

- **Easiest:** in VS Code install the **Live Server** extension, right-click `index.html` → **Open with Live Server**.
- **Or** with Python installed, run `python -m http.server` in this folder and open http://localhost:8000.

To rebuild the data yourself: install Python from [python.org](https://www.python.org/downloads/), then run `pip install pandas` and `python pipeline.py`.

## Notes

- Fantasy points come straight from nflverse. Half PPR = the average of standard and PPR.
- Rank 1 = the defense that allows the most points to that position (best matchup to target).
- Betting lines come from the nflverse schedule (consensus lines, refreshed with each daily update), not live odds from your book.
- Fantasy projections = the player's points per game (65% season average, 35% last 5 games, leaning on last season early on) × how much each opponent allows to his position vs the league average, with a small home/road bump. They don't account for injuries or role changes.
- Players who changed teams show their most recent team.
- The season is detected automatically from the date (from August onward it uses the new season).

- Trends = hit rates for the standard sportsbook line steps closest to each player's median over his last 10 games, over and under, across H2H, last 3/5/10 and both seasons. Matchup grade comes from how much the opponent allows for that stat (A = easiest for the bet). No live odds, so check your book for the exact line and price.

## Sportsbook lines and odds (optional)

`props.py` pulls real player prop lines and odds from [The Odds API](https://the-odds-api.com) into `data/props.csv`, which the Trends tab uses for book lines, odds and the Edge sort. It only runs when the repo secret `ODDS_API_KEY` is set, and it pulls the whole week once, on the morning of the week's first game, to stay inside the free plan's 500 credits a month. To pull right away, run the "Update NFL data" workflow by hand with "Pull sportsbook props now" checked.

## NBA

Use the NFL / NBA buttons at the top of Home or Trends. `nba_pipeline.py` builds `data/nba/` every morning from SportsDataverse's free hoopR data (ESPN box scores and schedule): player game logs for this season and last, the schedule with records, defense vs position ranks for guards, forwards and centers, and team colors. Spreads, totals and moneylines come from ESPN's scoreboard when it has them. NBA Trends uses estimated lines (the half-point steps around each player's L10 median) for points, rebounds, assists, threes and the common combos.
