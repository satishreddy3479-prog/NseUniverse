# Data sources: inventory, reliability and licensing

Checked 2026-10-28. "Verified" = read from the official page or document on that date. "Unverified" = reported by a secondary source or inferred; do not build on it without checking. Nothing here is legal advice. Licensing is the main risk: **NSE's website terms ban systematic or automated data collection and redistribution without written permission** ([NSE Terms of Use](https://www.nseindia.com/nse-terms-of-use)), and NSE's [Data Sharing and Usage Policy](https://nsearchives.nseindia.com/web/sites/default/files/inline-files/NSE_Data_Sharing%26Usage_Policy.pdf) restricts redistribution. Private, single-user, non-redistributed research is the safest reading; a multi-user hosted dashboard is the riskiest.

## 1. Price history (needed for every model)
**Chosen 2026-10-28: Yahoo Finance via yfinance.** Implemented in `app/prediction/sources/yahoo.py`, stored in `data/market_history.sqlite3` (first-seen values kept, disagreements logged), downloaded automatically on first start and once a day after 18:30 IST. Yahoo ticker names for the NSE sector indices and the global series are **unverified until data arrives**; the Settings page shows which series have data.
| Series | Candidate source | Status | Notes |
|---|---|---|---|
| NIFTY 50 daily OHLC | Manual CSV download from NSE / niftyindices.com | Download pages exist; the historical endpoints sit behind Cloudflare, so automation is fragile (community report) | Manual download for personal research is the cleanest legal reading; CSV column layout **unverified** until a file is loaded |
| | Kite Connect "Connect" plan | Rs 500/month, historical candles included, per [Zerodha support](https://support.zerodha.com/category/trading-and-markets/kite-api/articles/what-are-the-charges-for-kite-apis). Index history coverage unverified | Costs money: needs approval |
| | `yfinance` (^NSEI) | Unofficial, "personal use only" per its README; known corporate-action errors for single stocks (anecdotal) | Index levels are less affected; still a ToU grey zone |
| | Kotak Neo | **No official historical candles found** (a GitHub issue reply says none) | Live option chain only |
| India VIX, sector indices | niftyindices / NSE `ind_close_all_DDMMYYYY.csv` | Community-documented pattern, unverified | One file gives many index closes |

## 2. Indian market structure
| Data | Source | Timing / history | Status |
|---|---|---|---|
| Breadth (advances/declines, % above averages) | Derived from NSE EOD cash bhavcopy of the whole universe | Files usually up by about 18:00 IST (community); formats changed repeatedly (UDiFF; new .DAT additions effective 12 Oct 2026 per [NSE circular](https://nsearchives.nseindia.com/content/circulars/MSD75910.pdf)) | Raw archive untouched + one parser per format version |
| Constituent membership (point in time) | None free found | | Today's constituents must not be applied to history (survivorship bias) |
| FII/DII cash flows | NSE reports page `/reports/fii-dii` | Daily; **publication time unverified**; only third-party historical series found | Unusable for backtests until publication times are known |
| Participant-wise F&O OI / volume | NSE `fao_participant_oi_*.csv` (exact URL unverified), BSE page | End of day; time unverified | Same restriction |
| NIFTY option-chain features | Our own observation store | **Starts 2026-10-28**; weeks, not years | Prospective only; no backtest claim until months exist |
| Corporate announcements, circulars | NSE / BSE | Event-driven | Used as news items (primary sources) |

## 2b. Exchange segment names (verified from the live feed, 2026-10-28)
The Kotak feed reports market status per segment: `nse_cm`, `nse_fo`, `bse_cm`, `bse_fo`, `bse_cd`, `bse_co`, `cde_fo`, `ncd_co`, `nse_com`, `mcx_fo`. After the NSE close `nse_cm` and `nse_fo` report closed (code 2) while the commodity and currency segments report open (code 1). The app uses `nse_fo`, then `nse_cm`.

## 3. Global markets and cross-assets
| Data | Source options | Notes |
|---|---|---|
| US indices, VIX, Asian and European indices, gold, Brent, USD/INR, DXY | Yahoo via `yfinance` (convenience, personal use) | One free aggregator must not be the only source for critical series; futures, spot and ETF series are not interchangeable and must be labelled |
| US 2y/10y yields, Brent (EIA), USD/INR (H.10), others | FRED API: free but needs a registered key; some series carry third-party copyright | Account creation needs approval; daily series are published with a lag, so the **publication timestamp** drives availability, not the observation date |
| Overnight India cue (GIFT Nifty) | No clean free history found | Excluded from backtests |

Session timing: India closes 15:30 IST; the US cash close is 01:30 IST (during US daylight time) or 02:30 IST (after it ends); at 08:30 IST the US close is known and the Asian markets have already opened. A feature using a market still open at the cutoff must use its observed value at the cutoff, not its later close.

## 4. Scheduled events (calendar)
| Event | Source | Status |
|---|---|---|
| NSE trading holidays 2026 | NSE circulars NSE/CMTR/71775 (12 Dec 2025) and NSE/CMTR/72260 (12 Jan 2026) | **Verified**, loaded in `app/prediction/reference/nse_cm_holidays.json` |
| RBI MPC decisions | [RBI press release 2026-2027](https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=62422): 6-8 Apr, 3-5 Jun, 3-5 Aug, 5-7 Oct, 2-4 Dec 2026, 3-5 Feb 2027 | **Verified** (decision on the last day) |
| FOMC | federalreserve.gov calendar; 2026 meetings per a secondary summary: 27-28 Jan, 17-18 Mar, 28-29 Apr, 16-17 Jun, 28-29 Jul, 15-16 Sep, 27-28 Oct, 8-9 Dec | Decision 14:00 ET: **re-read from the official page before loading** |
| India CPI / IIP / GDP | MoSPI [Advance Release Calendar 2026-27](https://www.mospi.gov.in/uploads/documents/releaseCalender/1779709510470-ADVANCE%20RELEASE%20CALENDAR%202026-27%20Updated%2025.05.2026.pdf): CPI on the 12th, IIP on the 28th (next working day if a holiday); next CPI 12 Nov 2026 per MoSPI's October press release | **Verified**, but release clock time unverified (embargo "4:00 PM" seen in the CPI release) |
| US CPI, jobs, GDP, PCE; ECB, BoJ | BLS/BEA/ECB/BoJ calendars | Not yet read |
| Consensus forecasts, "surprise" | No lawful free source found | Surprise features are **not backtestable**; only event proximity is |

## 5. News
| Source | Finding | Suitability |
|---|---|---|
| Reuters | No public RSS since June 2020 (reuters.com feeds dead; Google News workaround only); robots.txt asks automated tools to stay away | Read-only; **not for automated ingestion** |
| Economic Times Markets | RSS feeds exist (for example `/markets/rssfeeds/1977021501.cms`); Times Internet terms could not be fetched (site blocked for the tool), so permitted use is **unverified** | Candidate only after the terms are read by you |
| Moneycontrol | No official RSS/API found; only unofficial scrapers | Not suitable |
| Official announcements (NSE, BSE, RBI, PIB, MoSPI) | Primary, free, event-timestamped | Recommended |
| GDELT DOC 2.0 API | Free, no key; its terms allow unrestricted use with citation ([GDELT](https://www.gdeltproject.org/about.html)); metadata index (title, URL, seen-time, domain, language, tone), not full text; reported limit 1 request per 5 s; the DOC API window is limited (about 3 months by default, a year with a timespan), sources disagree | Recommended starting source for headline metadata. Deep history needs GDELT bulk files (not yet evaluated) |
| Bloomberg, FT, licensed Reuters | Paid; no free API | Not recommended without approval of cost |

**Recommended Indian trio (evidence-based, pending your approval):** (1) official announcements from NSE/BSE/RBI/PIB/MoSPI, (2) GDELT filtered to India and global markets, (3) Economic Times RSS only if its terms permit. Reuters and Moneycontrol are valuable to read but cannot be ingested automatically on current evidence.

News history cannot be reconstructed lawfully for training beyond what GDELT archives hold, so news features are **prospective** and are tested by ablation only once months of data exist.

## 6. Per-source documentation required before ingestion
For each adopted source: history, frequency, publication delay, missingness, revision behaviour, access limits, storage format, update procedure. Until a row of this table is verified, the feature that needs it is marked **unavailable for leakage-safe backtesting**.
