# FINRA public-data connection

Implementation is ready for private verification; no live FINRA query has succeeded yet. Public dashboard coverage remains missing until real data and the distribution conditions are verified.

The [Public credential costs $0/month](https://developer.finra.org/fees). Create an **Individual** account through the [FINRA developer console instructions](https://developer.finra.org/docs), then create a credential of type **Public**, not Firm/Organization. Check the displayed fee is $0. A test/mock credential returns synthetic data and does not satisfy this requirement. The user must set the account password and API client secret in FINRA's own forms and review its terms.

## What the owner needs to do

1. Open the [FINRA API Console](https://gateway.finra.org/app/dfo-console). Sign in, or use **Create Account Here** for an Individual account. Complete the account email promptly; its initial password link lasts one hour.
2. In **My Credentials**, choose **ADD API CREDENTIAL**. Name it `Daily Consensus`, choose **Public**, and check **Total Fee Per Month = $0**. Review the terms yourself and create the credential. Do not select Mock or a paid Firm/Organization credential.
3. FINRA sends two emails. **Important Information** supplies the API Client ID; **Action Required** has **Create API Client Secret**. Open the latter within 24 hours. On the reset form, User ID means the **API Client ID**, not your personal Gateway username. Choose the secret and save it.
4. On this Mac, run the following command yourself in Terminal. It asks for the API Client ID and secret with input hidden, then confirms the secret. Never put the values in chat, a shell command, source control or browser code.

   ```sh
   python3 "/Users/stelios/Documents/The Daily Consensus/app/web/scripts/setup-finra.py"
   ```

5. After the command reports **Saved privately**, tell Codex **FINRA configured**. That confirms local setup, not successful API access. Codex can then run the existing private collector and verify the response without exposing credentials or publishing data.

The setup tool writes only `~/.config/the-daily-consensus/finra.json`, outside this repository and Vercel, with a private directory (0700) and file (0600). It sends no requests. It rejects piped input, unsafe file permissions, linked files and accidental replacement. Credential rotation uses the same command with `--replace`; the API secret expires after a year. The user also retains a copy in their own password manager if desired.

## Publisher verification

Run `npm run consensus:finra-private` from `web` after the owner completes setup. The collector reads the private local file or a complete explicit `FINRA_CLIENT_ID` / `FINRA_CLIENT_SECRET` environment pair. It never mixes a partial environment pair with the file. Missing or unsafe credentials stop before any request. Only the private result `.consensus/finra-private/latest.json` is written; it is excluded from Git and deployment. A successful summary contains counts, symbols and the latest week, never a key or token. Authentication failure does not print a provider response body.

**Correction to the earlier setup instructions:** Vercel now calls sensitive values **Secret**. A Secret can be used by deployments, but cannot be retrieved by a member or pulled back into the local publisher after saving. The earlier suggestion that the subscription publisher could retrieve these values was incorrect. The local setup above is the working path for this Mac. A future hosted collector would need its own Vercel Secret configuration; it is not necessary for this private local verification. [Vercel's August 24, 2026 change](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types).

The collector uses the documented FINRA OAuth token endpoint and one bounded weeklySummary Query API request for SPY, QQQ, IWM, DIA and TLT. It selects only ATS_W_SMBL and OTC_W_SMBL totals, preserves their distinction, matches the week, rejects future/revised-after-cutoff observations and incomplete pairs, checks truncation, and never logs tokens or server error bodies. The query covers 90 days and at most500 rows. It does not enroll in a paid plan or perform retries after rate limits.

Before public release, comply with [FINRA's specific Equity Data terms](https://developer.finra.org/specific-terms-equity-data): FINRA attribution, no end-user data fee, non-commercial personal/professional use, no further redistribution, and reasonable end-user compliance measures. The raw or derivative FINRA data must not be committed to this public Git repository or the unrestricted downloadable snapshot archive. An appropriately separated, terms-governed display must be implemented and checked before publication. A credential alone is insufficient.

Weekly off-exchange volume is delayed, not live dark-pool buying pressure. ATS/non-ATS totals do not identify buyer/seller direction, named institutions, short interest or dealer inventory. These observations will be context with no directional vote unless a separately validated interpretation is developed.

Verified documentation on November 3, 2026: [metadata](https://api.finra.org/metadata/group/otcMarket/name/weeklySummary), [account/credential/OAuth instructions](https://developer.finra.org/docs), [fees](https://developer.finra.org/fees), [equity terms](https://developer.finra.org/specific-terms-equity-data). Unit tests use explicitly synthetic fixtures; they are not live-source evidence.
