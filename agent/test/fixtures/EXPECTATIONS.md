These fixtures were fetched once from the public endpoints by `npm run record-fixtures` at the `recordedAt` timestamps in the asset files. Tests never fetch live data.

`expected-signals.json` contains fixed numeric assertions and calculation checkpoints. Returns were checked as `100 * (latest - earlier) / earlier`. RSI was independently checked using exact integer price changes (prices times 10^8): sum the first 14 gains and losses, divide each by 14, then apply Wilder's `(13 * previous + new) / 14` smoothing to each remaining change. RSI equals `100 * averageGain / (averageGain + averageLoss)`. This check uses rational integer arithmetic rather than importing the implementation under test.

| Asset | Latest hourly | Prior hour | Prior 24 hours | RSI final gain average | RSI final loss average | RSI |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 83438.67 | 83582.68 | 83181.03 | 103.0382226606 | 114.0505275194 | 47.463640 |
| ETH | 2678.23 | 2688.44 | 2673.16 | 4.5973380805 | 5.5151727058 | 45.461886 |
| SOL | 118.71 | 119.02 | 117.67 | 0.2975303724 | 0.3232845803 | 47.925774 |

If fixtures are deliberately refreshed, review and update these fixed expectations from the new data using independent calculations. Unavailable sources must remain marked unavailable, rather than being replaced with invented data.
