"""Independent decimal oracle for two consecutive RTH bars around an ex-distribution."""
from decimal import Decimal, localcontext
import json
import sys


def dividend_check(prior_open, prior_close, ex_open, ex_close, gross_cash):
    with localcontext() as ctx:
        ctx.prec = 50
        p, c, o, e, d = map(Decimal, (prior_open, prior_close, ex_open, ex_close, gross_cash))
        if not all(x.is_finite() and x > 0 for x in (p, c, o, e, d)) or d >= c:
            raise ValueError("Invalid prices or distribution")
        factor = (c - d) / c
        native = e / c - 1
        backward = e / (c - d) - 1
        cash_held = (e + d) / c - 1
        return {
            "adjusted": [{"open": str(p * factor), "close": str(c - d)}, {"open": str(o), "close": str(e)}],
            "bps": {name: float(value * 10000) for name, value in {
                "priceChangeBps": native, "backwardAdjustedBps": backward, "oneSharePlusReceivableBps": cash_held,
                "differenceBps": backward - cash_held, "exDayOpenCloseBps": e / o - 1,
            }.items()},
        }


if __name__ == "__main__":
    if len(sys.argv) != 6:
        sys.exit("Pass prior open/close, ex-date open/close and issuer gross cash")
    print(json.dumps(dividend_check(*sys.argv[1:])))
