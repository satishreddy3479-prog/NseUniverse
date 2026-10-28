# Known limitations and risks

1. **No training data yet.** The project holds no NIFTY price history; a source needs your approval. No model, metric or claim exists.
2. **Predictability is uncertain.** Daily and weekly index returns may be only weakly predictable; a model may not beat simple baselines, and a small edge may vanish after costs. This project does not trade.
3. **Short history for new data types.** Option-chain observations start on 2026-10-28; news and FII/DII features without verified publication times cannot be backtested honestly.
4. **Licensing.** NSE terms prohibit systematic automated collection and redistribution. Manual download for private research is the clearest reading; automated downloads and any multi-user display of NSE-derived numbers carry risk. Reuters and Moneycontrol cannot be ingested automatically on current evidence; Economic Times RSS terms are unverified.
5. **Consensus forecasts unavailable.** Event "surprise" features cannot be built lawfully for history.
6. **Survivorship bias.** No free point-in-time NIFTY constituent history was found; stock-level breadth for old periods must carry this warning.
7. **Timing assumptions.** Several publication times (FII/DII, participant data, bhavcopy) are unverified; features using them stay disabled for backtests.
8. **Calendar coverage.** Only 2026 NSE holidays are loaded; other years are refused until a circular is added. Exceptional closures or special sessions can appear by circular at short notice.
9. **Small effective samples.** Overlapping five-session labels and serial dependence limit what can be concluded; statistical claims will be withheld when unsupported.
10. **Server limits.** 1 GB RAM: training happens off-server.
11. **External services.** No paid or account-based service is added without approval; no credentials appear in code, logs or reports.

Nothing in this system is financial advice or a guarantee.
