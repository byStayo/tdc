// Polygon.io API Configuration
export const POLYGON_CONFIG = {
  API_KEY: process.env.REACT_APP_POLYGON_API_KEY,
  BASE_URL: 'https://api.polygon.io',
  
  // Endpoints
  ENDPOINTS: {
    AGGREGATES: '/v2/aggs/ticker',
    TICKER_NEWS: '/v2/reference/news',
    TICKER_DETAILS: '/v3/reference/tickers',
    RELATED_TICKERS: '/v1/reference/tickers/related',
    MARKET_STATUS: '/v1/marketstatus/now',
    SNAPSHOTS: '/v2/snapshot/locale/us/markets/stocks/tickers',
  },

  // WebSocket
  WS_URL: 'wss://socket.polygon.io',
  
  // Anomaly detection settings
  ANOMALY_DETECTION: {
    VOLUME_THRESHOLD: 2.5, // Standard deviations above mean
    PRICE_THRESHOLD: 2.0,  // Standard deviations above mean
    MIN_SAMPLES: 20,       // Minimum samples needed for detection
    LOOKBACK_DAYS: 30,     // Days to look back for pattern analysis
  },

  // Sentiment analysis settings
  SENTIMENT_ANALYSIS: {
    UPDATE_INTERVAL: 300000, // 5 minutes in milliseconds
    SENTIMENT_THRESHOLDS: {
      POSITIVE: 0.6,
      NEGATIVE: 0.4,
    },
    MAX_NEWS_ITEMS: 100,
  },

  // Related companies settings
  RELATED_COMPANIES: {
    MAX_NODES: 20,        // Maximum number of related companies to show
    MIN_RELATIONSHIP: 0.5, // Minimum relationship strength (0-1)
    UPDATE_INTERVAL: 86400000, // 24 hours in milliseconds
  },

  // Headers for all requests
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.REACT_APP_POLYGON_API_KEY}`
  },

  // Error messages
  errors: {
    UNAUTHORIZED: 'Invalid API key. Please check your Polygon.io API key.',
    RATE_LIMIT: 'Rate limit exceeded. Please try again later.',
    NOT_FOUND: 'Data not found for the requested symbol.',
    SERVER_ERROR: 'Server error. Please try again later.',
  },

  // Request options
  requestOptions: {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.REACT_APP_POLYGON_API_KEY}`
    }
  },

  // WebSocket settings
  webSocket: {
    reconnectInterval: 5000,    // Reconnect every 5 seconds
    maxReconnectAttempts: 5,    // Maximum number of reconnection attempts
    pingInterval: 30000,        // Send ping every 30 seconds to keep connection alive
    subscriptionBatchSize: 100  // Maximum number of symbols to subscribe in one batch
  },

  // News API Configuration
  NEWS_CONFIG: {
    DEFAULT_LIMIT: 100,
    MAX_LIMIT: 1000,
    UPDATE_INTERVAL: 5000,
    AUTO_DISMISS_DELAY: 7000,
    PREFETCH_LIMIT: 10,
    CACHE_TTL: 30000,
    
    // News endpoints
    ENDPOINTS: {
      NEWS: '/v2/reference/news',
      NEWS_DETAILS: '/v2/reference/news/details'
    },

    // News parameters
    PARAMS: {
      SORT_BY: ['published_utc'],
      ORDER: ['asc', 'desc'],
      TICKER_TYPES: ['stocks', 'crypto', 'fx', 'indices'],
      MARKET_TYPE: ['stocks', 'crypto', 'fx', 'indices']
    },

    // Sentiment thresholds with enhanced granularity
    SENTIMENT: {
      POSITIVE_THRESHOLD: 0.6,
      NEGATIVE_THRESHOLD: 0.4,
      NEUTRAL_ZONE: 0.1,
      CONFIDENCE_LEVELS: {
        HIGH: 0.8,
        MEDIUM: 0.6,
        LOW: 0.4
      }
    },

    // Enhanced impact levels for news classification
    IMPACT_LEVELS: {
      HIGH: {
        KEYWORDS: [
          'merger', 'acquisition', 'earnings', 'guidance', 
          'fed', 'lawsuit', 'bankruptcy', 'investigation',
          'sec', 'delisting', 'ceo', 'executive', 'patent'
        ],
        PUBLISHERS: [
          'Reuters', 'Bloomberg', 'Wall Street Journal', 
          'CNBC', 'Financial Times', 'MarketWatch',
          'Seeking Alpha', 'Barron\'s', 'The Motley Fool'
        ],
        SENTIMENT_THRESHOLD: 0.7
      },
      MEDIUM: {
        KEYWORDS: [
          'partnership', 'contract', 'expansion', 'investment',
          'product', 'launch', 'market', 'share', 'revenue'
        ],
        SENTIMENT_THRESHOLD: 0.5
      },
      LOW: {
        KEYWORDS: [
          'update', 'announcement', 'presentation', 'conference',
          'interview', 'report', 'analysis'
        ],
        SENTIMENT_THRESHOLD: 0.3
      }
    },

    // WebSocket configuration for real-time news
    WEBSOCKET: {
      RECONNECT_DELAY: 5000,
      MAX_RECONNECT_ATTEMPTS: 5,
      SUBSCRIPTION_TYPES: {
        ALL_NEWS: 'N.*',
        TICKER_NEWS: 'N.',
        MARKET_NEWS: 'NM.'
      },
      CHANNELS: {
        NEWS: 'N',
        MARKET_NEWS: 'NM',
        SENTIMENT: 'NS'
      }
    },

    // History and analytics settings
    HISTORY: {
      MAX_DAYS: 30,
      DEFAULT_DAYS: 7,
      CHART_INTERVALS: ['1D', '1W', '1M', '3M'],
      MIN_SAMPLES: 10,
      AGGREGATION: {
        TIME_WINDOWS: ['1h', '4h', '1d', '1w'],
        METRICS: ['sentiment', 'impact', 'volume']
      }
    },

    // Publisher verification and weighting
    PUBLISHERS: {
      TIER_1: {
        NAMES: ['Reuters', 'Bloomberg', 'Wall Street Journal'],
        WEIGHT: 1.0
      },
      TIER_2: {
        NAMES: ['CNBC', 'Financial Times', 'MarketWatch'],
        WEIGHT: 0.8
      },
      TIER_3: {
        NAMES: ['Seeking Alpha', 'Barron\'s', 'The Motley Fool'],
        WEIGHT: 0.6
      }
    }
  },

  // Fair Market Value (FMV) Configuration
  FMV_CONFIG: {
    ENDPOINTS: {
      FMV: '/v1/fmv',
      HISTORICAL_FMV: '/v1/fmv/historical'
    },
    UPDATE_INTERVAL: 60000, // 1 minute
    CACHE_TTL: 300000,     // 5 minutes
    THRESHOLDS: {
      DEVIATION: 0.02,     // 2% deviation from current price
      VOLUME: 1.5         // 1.5x average volume
    }
  }
};

// Chart timeframes
export const CHART_TIMEFRAMES = [
  { label: '1D', value: '1', multiplier: 1, timespan: 'minute' },
  { label: '1W', value: '7', multiplier: 30, timespan: 'minute' },
  { label: '1M', value: '30', multiplier: 1, timespan: 'hour' },
  { label: '3M', value: '90', multiplier: 1, timespan: 'day' },
  { label: '1Y', value: '365', multiplier: 1, timespan: 'day' },
];

// Chart types
export const CHART_TYPES = [
  { label: 'Line', value: 'line' },
  { label: 'Candlestick', value: 'candlestick' },
  { label: 'Area', value: 'area' },
];

// Technical indicators
export const TECHNICAL_INDICATORS = [
  { label: 'Moving Average (20)', value: 'ma' },
  { label: 'Bollinger Bands', value: 'bb' },
  { label: 'RSI (14)', value: 'rsi' },
]; 