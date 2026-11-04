# Taiwan equity context

The connected source is Taiwan Stock Exchange (TWSE) end-of-day index data. It supplies Taiwan context, not US ETF prices or complete global equity coverage. Both series remain nonvoting across all instruments and horizons. The original US price, premarket, options and outcome requirements remain open.

## Source and reuse

The government catalogue identifies [TAIEX price-index history](https://data.gov.tw/en/datasets/11755) and the [TAIEX total-return index](https://data.gov.tw/dataset/11871) as free daily datasets under [Open Government Data License 1.0](https://data.gov.tw/en/license). Both point to TWSE's [official OpenAPI schema](https://openapi.twse.com.tw/v1/swagger.json). The licence permits retention, public reuse and derived analysis with attribution; it grants no trademark or endorsement rights. TWSE's [general website terms, section 8](https://www.twse.com.tw/zh/terms/use.html) recognize the separate government open-data licence.

Two documented no-key endpoints:

- `https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST`: latest-month opening, high, low and closing price-index levels.
- `https://openapi.twse.com.tw/v1/indicesReport/MFI94U`: latest-month total-return index, with distributions reinvested as defined by TWSE.

Original responses retrieved on November 4, 2026 each contained three observations, November 2–4. Source hashes and retrieval timestamps are captured. The saved source date is the observation date, converted from the ROC calendar. HTTP modification dates and catalogue update dates are not substituted for a release timestamp. No exact release clock time is supplied.

## Contracts

The two source series retain separate identities, hashes, observation dates and index-point units. They are related measures of one market, never two independent votes. Displayed percentage change is between the last two returned sessions; it is not an annualized return or a US price response. A one-session month has a known level and no percentage comparison. Sparklines have independent scales and state their actual sample window.

The parser bounds response size and rows, requires the documented fields, validates real dates and numeric values, rejects duplicate or mixed-month dates, and checks the OHLC range. Validation failures withhold the source. Only transport failures can retain earlier verified observations, preserving their original age and displaying the existing refresh notice. Seven-day stale limits still apply.

Full morning collection includes both endpoints. `npm run consensus:taiwan` makes a bounded two-endpoint draft; append `-- --publish` for the normal immutable publication path. It preserves unrelated observations and reports, while changing the existing international gap wording to reflect partial regional coverage. A repeated retrieval with identical observations does not create an edition. Neither command scores outcomes, fits models or republishes a social sample.

Old editions contain only their stored data and do not acquire the Taiwan panel. Earlier archives are never rewritten. Future month rollover creates a new dated window; this endpoint does not promise complete historical backfill.

## UI decisions

Live Jev 1.14.0 chose paired rows. Its first placement decision requested expanded candidates; a second bounded request chose a full-width panel below the currencies/rates group. Both requests, answer probabilities and usage are recorded in `jev-taiwan-*.json`. The combination preserves the existing source drawer and 44px controls. Implementation maps the state description's color names to the actual `--positive`/`--negative` tokens and uses the existing `--font-display`. Confidence is a choice distribution, not evidence of visual quality; rendered checks are recorded separately in the root build ledger.
