// Dedicated synthetic data, never used by a publication or model.
export function fixture() {
  const fund = (ticker: string, flowUsd: number) => ({ ticker, name: `${ticker} synthetic fund`, issuer: 'Synthetic',
    flowUsd, roundTripUsd: 0, startNetAssetsUsd: 10_000_000_000, startNetAssetsDate: '2026-11-05',
    flowPctOfStartNetAssets: flowUsd / 100_000_000, navDate: '2026-11-05', basis: 'daily', held: false, status: 'ok', why: null,
    page: `https://etfiq.com/funds/${ticker.toLowerCase()}` });
  return { schemaVersion: 1, asOf: '2026-11-06', basis: 'daily', window: {from:'2026-11-06',to:'2026-11-06',days:1,opens:'2026-11-05'},
    cite: {publisher:'ETFIQ', page:'https://etfiq.com/flows/', as_of:'2026-11-06', class:'ETFIQ-computed', license:'https://etfiq.com/license/'},
    total: { funds:3, heldFunds:1, flowUsd:60_000_000, roundTripUsd:0 },
    funds: [fund('QQQ',100_000_000),fund('IWM',-40_000_000),fund('TLT',0),
      {...fund('SPY',0),held:true,status:'held',why:'Synthetic review hold',flowUsd:null,roundTripUsd:null,flowPctOfStartNetAssets:null}] };
}
