import type { Workspace } from "@/lib/contracts";
import { dateLabel, number } from "./ui";

export default function ObservedMarketContext({
  workspace,
}: {
  workspace: Workspace;
}) {
  const quote = workspace.quotes.data.find(
    (item) => item.symbol === workspace.symbol,
  );
  const average = workspace.indicators.find((item) => item.id === "sma-20");
  const rsi = workspace.indicators.find((item) => item.id === "rsi-14");
  const hasAverage = average?.value != null && Number.isFinite(average.value);
  const hasRsi = rsi?.value != null && Number.isFinite(rsi.value);
  const hasChange = quote?.change != null && Number.isFinite(quote.change);
  const hasPercent =
    quote?.changePercent != null && Number.isFinite(quote.changePercent);

  return (
    <div className="observed-context">
      <div className="observed-context-heading">
        <h3>Observed market context</h3>
        <span>Calculated from source data</span>
      </div>
      <dl>
        <div>
          <dt>Completed close</dt>
          <dd>
            {quote ? (
              <>
                <strong>
                  {quote.symbol} ${number(quote.close)}
                </strong>
                {hasChange ? (
                  <>
                    {" "}
                    · {quote.change! >= 0 ? "+" : "−"}$
                    {number(Math.abs(quote.change!))}
                    {hasPercent
                      ? ` (${quote.changePercent! >= 0 ? "+" : ""}${number(quote.changePercent)}%)`
                      : ""}{" "}
                    vs prior close
                  </>
                ) : (
                  " · Change unavailable"
                )}
                <span className="observed-date">{dateLabel(quote.asOf)}</span>
              </>
            ) : (
              "No completed-session quote is available."
            )}
          </dd>
        </div>
        <div>
          <dt>20-session average</dt>
          <dd>
            {hasAverage ? (
              <>
                <strong>${number(average.value)}</strong> ·{" "}
                {average.interpretation}
              </>
            ) : (
              "Unavailable; requires 20 completed sessions."
            )}
          </dd>
        </div>
        <div>
          <dt>14-session RSI</dt>
          <dd>
            {hasRsi ? (
              <strong>{number(rsi.value)} / 100</strong>
            ) : (
              "Unavailable; requires 15 completed sessions."
            )}
          </dd>
        </div>
      </dl>
      <p className="observed-source">
        {workspace.history.source}
        {workspace.history.asOf
          ? ` · Technical observations through ${dateLabel(workspace.history.asOf)}`
          : " · No technical observation date supplied"}
      </p>
    </div>
  );
}
