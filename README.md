# NFL Matchup Lab

Betting research for the NFL: game lines with against-the-spread and over/under records, player prop hit rates, stat-by-stat defense vs position rankings, and team efficiency stats (EPA/play, success rate, pace, red zone). Fantasy points are available behind a toggle. Free NFL data from [nflverse](https://github.com/nflverse/nflverse-data), rebuilt automatically every Tuesday.

## What's in here

| File | What it does |
|---|---|
| `index.html` | The whole website: layout, styles, charts and tables. Edit this to change how it looks or what it shows. |
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
- Betting lines are the closing lines in the nflverse schedule, not live odds.
- Players who changed teams show their most recent team.
- The season is detected automatically from the date (from August onward it uses the new season).
