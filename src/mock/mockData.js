// Mock data states
export const DATA_STATES = {
  LOADING: 'loading',
  ERROR: 'error',
  SUCCESS: 'success',
  PARTIAL: 'partial'
};

// Mock loading delays
export const LOADING_DELAYS = {
  SHORT: 500,
  MEDIUM: 1500,
  LONG: 3000
};

export const getRandomDelay = () => {
  const delays = Object.values(LOADING_DELAYS);
  return delays[Math.floor(Math.random() * delays.length)];
};

// Mock news data
export const mockNews = [
  {
    id: 1,
    title: "Fed Signals Potential Rate Cuts in 2024",
    description: "Federal Reserve officials indicated they expect to cut interest rates three times in 2024, marking a pivot in monetary policy.",
    published_utc: "2024-01-26T14:30:00Z",
    article_url: "https://example.com/fed-rate-cuts",
    tickers: ["SPY", "QQQ", "DIA"],
    keywords: ["Federal Reserve", "Interest Rates", "Monetary Policy"],
    sentiment_score: 0.75,
    publisher: {
      name: "Financial Times",
      homepage_url: "https://ft.com",
      logo_url: "https://example.com/ft-logo.png",
      favicon_url: "https://example.com/ft-favicon.ico"
    }
  },
  {
    id: 'news-2',
    title: 'Market Alert: Major Shift in Trading Patterns',
    description: 'Analysts observe significant changes in market behavior as institutional investors adjust their positions.',
    published_utc: new Date(Date.now() - 1000 * 60 * 15).toISOString(), // 15 minutes ago
    article_url: '#',
    tickers: ['SPY', 'QQQ', 'IWM'],
    keywords: ['Market Analysis', 'Trading', 'Institutional'],
    sentiment_score: -0.6,
    publisher: {
      name: 'Bloomberg',
      homepage_url: 'https://bloomberg.com',
      favicon_url: 'https://bloomberg.com/favicon.ico'
    }
  },
  {
    id: 'news-3',
    title: 'Emerging Market Opportunities in Clean Energy',
    description: 'New report highlights promising investment opportunities in renewable energy sectors across emerging markets.',
    published_utc: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 minutes ago
    article_url: '#',
    tickers: ['ICLN', 'TAN', 'ENPH'],
    keywords: ['Clean Energy', 'Emerging Markets', 'Investment'],
    sentiment_score: 0.5,
    publisher: {
      name: 'Reuters',
      homepage_url: 'https://reuters.com',
      favicon_url: 'https://reuters.com/favicon.ico'
    }
  },
  {
    id: 'news-4',
    title: 'BREAKING: Major Market Disruption',
    description: 'Critical market event requiring immediate attention. Multiple sectors affected.',
    published_utc: new Date(Date.now() - 1000 * 30).toISOString(), // 30 seconds ago
    article_url: '#',
    tickers: ['SPY', 'VIX', 'GLD'],
    keywords: ['Market Crash', 'Volatility', 'Safe Haven'],
    sentiment_score: -0.9,
    impact_score: 0.95,
    publisher: {
      name: 'Wall Street Journal',
      homepage_url: 'https://wsj.com',
      favicon_url: 'https://wsj.com/favicon.ico'
    },
    priority: 'urgent'
  },
  {
    id: 'news-5',
    title: '', // Edge case: Empty title
    description: 'Test case for missing title handling',
    published_utc: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    article_url: '#',
    tickers: [],
    keywords: ['Test'],
    sentiment_score: 0,
    publisher: null // Edge case: Missing publisher
  }
];

// Mock market data
export const mockMarketData = {
  indices: {
    "S&P 500": { price: 4780.94, change: 1.23, changePercent: 0.026 },
    "Nasdaq": { price: 15055.65, change: 45.23, changePercent: 0.003 },
    "Dow Jones": { price: 37468.61, change: -23.45, changePercent: -0.001 }
  },
  sectors: {
    "Technology": { performance: 2.3, momentum: "positive", strength: 0.85 },
    "Healthcare": { performance: -0.8, momentum: "negative", strength: 0.45 },
    "Finance": { performance: 1.1, momentum: "positive", strength: 0.65 }
  },
  marketBreadth: {
    advanceDecline: { advancing: 285, declining: 215 },
    newHighsLows: { newHighs: 45, newLows: 12 },
    volumeRatio: 1.25
  },
  extremes: {
    topGainers: [
      { symbol: "AAPL", name: "Apple Inc.", change: 3.45, volume: 12500000 },
      { symbol: "MSFT", name: "Microsoft Corp.", change: 2.89, volume: 9800000 }
    ],
    topLosers: [
      { symbol: "META", name: "Meta Platforms", change: -2.34, volume: 8900000 },
      { symbol: "NFLX", name: "Netflix Inc.", change: -1.98, volume: 5600000 }
    ]
  }
};

// Mock trading signals
export const mockSignals = [
  {
    id: "sig_001",
    type: "breakout",
    symbol: "AAPL",
    price: 185.45,
    timestamp: "2024-01-26T15:30:00Z",
    confidence: 0.85,
    direction: "bullish",
    timeframe: "4h",
    indicators: {
      rsi: 65,
      macd: { line: 0.45, signal: 0.32, histogram: 0.13 },
      volume: 1250000
    }
  },
  {
    id: "sig_002",
    type: "support",
    symbol: "MSFT",
    price: 390.20,
    timestamp: "2024-01-26T15:45:00Z",
    confidence: 0.78,
    direction: "neutral",
    timeframe: "1d",
    indicators: {
      rsi: 48,
      macd: { line: -0.12, signal: -0.08, histogram: -0.04 },
      volume: 980000
    }
  },
  {
    id: 'signal-3',
    type: 'volatility_alert',
    ticker: 'VIX',
    price: 25.45,
    confidence: 0.95,
    timestamp: new Date(Date.now()).toISOString(),
    indicators: {
      rsi: 75.8,
      macd: 'extremely_bullish',
      volume: '300% above average',
      volatility: 'extreme'
    },
    alert_type: 'critical'
  },
  {
    id: 'signal-4',
    type: 'error_case',
    ticker: 'ERROR',
    timestamp: new Date(Date.now()).toISOString(),
    error: 'Data fetch failed',
    retry_count: 3
  }
];

// Mock options data
export const mockOptionsData = {
  underlying: {
    symbol: "SPY",
    price: 478.90,
    change: 1.25,
    iv: 0.15
  },
  calls: [
    {
      strike: 480,
      expiry: "2024-02-16",
      bid: 3.45,
      ask: 3.55,
      volume: 15000,
      openInterest: 45000,
      iv: 0.18,
      delta: 0.45,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.15
    }
  ],
  puts: [
    {
      strike: 475,
      expiry: "2024-02-16",
      bid: 2.85,
      ask: 2.95,
      volume: 12000,
      openInterest: 38000,
      iv: 0.19,
      delta: -0.40,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.14
    }
  ]
};

// Mock darkpool data
export const mockDarkpoolData = {
  aggregates: {
    totalVolume: 850000000,
    darkpoolPercent: 0.35,
    largestTrades: [
      {
        symbol: "AAPL",
        price: 185.45,
        size: 250000,
        time: "2024-01-26T14:30:00Z",
        exchange: "XDARK"
      }
    ]
  },
  bySymbol: {
    "AAPL": {
      totalVolume: 12500000,
      darkpoolVolume: 4375000,
      darkpoolPercent: 0.35,
      averagePrice: 185.67,
      vwap: 185.45
    }
  }
};

// Mock correlation data
export const mockCorrelationData = {
  matrix: [
    { symbol: "SPY", correlations: { "QQQ": 0.85, "DIA": 0.78, "IWM": 0.72 } },
    { symbol: "QQQ", correlations: { "SPY": 0.85, "DIA": 0.65, "IWM": 0.68 } }
  ],
  topCorrelated: [
    { pair: ["SPY", "QQQ"], correlation: 0.85, strength: "strong", trend: "stable" }
  ],
  sectorCorrelations: {
    "Technology": { "Healthcare": 0.45, "Finance": 0.65 }
  }
};

// Mock technical analysis data
export const mockTechnicalData = {
  trends: {
    primary: "bullish",
    secondary: "neutral",
    strength: 0.75
  },
  indicators: {
    rsi: { value: 58, signal: "neutral" },
    macd: { 
      line: 0.45,
      signal: 0.32,
      histogram: 0.13,
      trend: "bullish"
    },
    bollinger: {
      upper: 482.45,
      middle: 478.90,
      lower: 475.35,
      width: 7.10
    }
  },
  supportResistance: {
    supports: [475.50, 472.80, 470.20],
    resistances: [480.30, 482.50, 485.70]
  },
  patterns: [
    {
      type: "bullish flag",
      confidence: 0.82,
      priceTarget: 485.50,
      timeframe: "4h"
    }
  ]
};

// Mock sentiment data
export const mockSentimentData = {
  overall: {
    score: 0.65,
    trend: "bullish",
    confidence: 0.78
  },
  sources: {
    social: { score: 0.72, volume: 15000, trend: "very bullish" },
    news: { score: 0.58, volume: 850, trend: "neutral" },
    analyst: { score: 0.65, coverage: 35, consensus: "buy" }
  },
  bySymbol: {
    "AAPL": {
      score: 0.75,
      trend: "bullish",
      mentions: 12500,
      sentiment: {
        positive: 0.65,
        neutral: 0.25,
        negative: 0.10
      }
    }
  }
};

// Mock user preferences
export const mockUserPreferences = {
  watchlists: [
    {
      id: "wl_001",
      name: "Tech Leaders",
      symbols: ["AAPL", "MSFT", "GOOGL", "AMZN"]
    }
  ],
  newsFilters: {
    keywords: ["Federal Reserve", "Earnings", "IPO"],
    excludedSources: ["unreliable-news.com"],
    minSentiment: 0.3
  },
  theme: "dark",
  alerts: {
    priceTargets: true,
    technicalSignals: true,
    newsImpact: true
  },
  display: {
    defaultTimeframe: "1d",
    chartType: "candlestick",
    showVolume: true
  }
};

// Mock error states
export const mockErrors = {
  network: {
    type: "NetworkError",
    message: "Failed to fetch data. Please check your connection.",
    code: "ERR_NETWORK"
  },
  auth: {
    type: "AuthError",
    message: "Session expired. Please log in again.",
    code: "ERR_AUTH"
  },
  validation: {
    type: "ValidationError",
    message: "Invalid input parameters.",
    code: "ERR_VALIDATION"
  }
};

// Mock WebSocket messages
export const createMockWebSocketMessage = (type) => {
  const baseMessage = {
    timestamp: new Date().toISOString(),
    type
  };

  switch (type) {
    case 'price':
      return {
        ...baseMessage,
        symbol: "AAPL",
        price: 185.45,
        volume: 1000
      };
    case 'signal':
      return {
        ...baseMessage,
        signal: "breakout",
        symbol: "MSFT",
        direction: "bullish"
      };
    default:
      return baseMessage;
  }
};

// Mock chart data
export const mockChartData = {
  ohlcv: [
    {
      timestamp: "2024-01-26T14:30:00Z",
      open: 478.90,
      high: 479.45,
      low: 478.35,
      close: 478.90,
      volume: 1250000
    }
  ],
  indicators: {
    sma: [
      { period: 20, values: [478.45, 478.90, 479.15] },
      { period: 50, values: [475.80, 476.20, 476.45] }
    ],
    volume: [1250000, 980000, 1100000]
  }
};

// Mock market anomalies
export const mockAnomalies = [
  {
    id: "anom_001",
    type: "volume_spike",
    symbol: "AAPL",
    severity: 0.85,
    timestamp: "2024-01-26T14:30:00Z",
    details: {
      normalVolume: 1000000,
      spikeVolume: 5000000,
      priceImpact: 0.025
    }
  }
];

// Mock related companies
export const mockRelatedCompanies = {
  "AAPL": {
    competitors: [
      {
        symbol: "MSFT",
        name: "Microsoft Corp.",
        correlation: 0.75,
        marketCap: 2800000000000,
        sector: "Technology"
      }
    ],
    suppliers: [
      {
        symbol: "TSM",
        name: "Taiwan Semiconductor",
        relationship: "chip supplier",
        dependencyScore: 0.85
      }
    ],
    customers: [
      {
        symbol: "VZ",
        name: "Verizon",
        relationship: "device retailer",
        dependencyScore: 0.45
      }
    ]
  }
}; 