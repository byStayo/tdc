// Options Screener Configuration
import { POLYGON_CONFIG } from './polygon';

export const OPTIONS_CONFIG = {
  // API Endpoints
  endpoints: {
    optionsChain: `${POLYGON_CONFIG.BASE_URL}/v3/snapshot/options`,
    aggregates: `${POLYGON_CONFIG.BASE_URL}/v2/aggs`,
    tickers: `${POLYGON_CONFIG.BASE_URL}/v3/reference/tickers`,
  },

  // Modes
  modes: {
    BEGINNER: 'beginner',
    EXPERT: 'expert',
  },

  // Default Filters
  defaultFilters: {
    minDelta: 0.2,
    maxDelta: 0.8,
    minOpenInterest: 100,
    minVolume: 50,
    maxDaysToExpiry: 45,
  },

  // Timeframes for historical data
  timeframes: [
    { label: '1 Day', value: '1' },
    { label: '1 Week', value: '7' },
    { label: '1 Month', value: '30' },
    { label: '3 Months', value: '90' },
  ],

  // Strategy Types
  strategies: {
    SINGLE: {
      LONG_CALL: 'Long Call',
      LONG_PUT: 'Long Put',
      SHORT_CALL: 'Short Call',
      SHORT_PUT: 'Short Put',
    },
    MULTI: {
      BULL_CALL_SPREAD: 'Bull Call Spread',
      BEAR_PUT_SPREAD: 'Bear Put Spread',
      IRON_CONDOR: 'Iron Condor',
      BUTTERFLY: 'Butterfly',
    },
  },

  // Greek Thresholds
  greekThresholds: {
    delta: { min: -1, max: 1, step: 0.1 },
    gamma: { min: 0, max: 0.5, step: 0.01 },
    theta: { min: -1, max: 0, step: 0.1 },
    vega: { min: 0, max: 1, step: 0.1 },
  },

  // Chart Types
  chartTypes: {
    PAYOFF: 'payoff',
    VOLATILITY_SURFACE: 'volatility-surface',
    GREEK_ANALYSIS: 'greek-analysis',
  },

  // Refresh Intervals (in milliseconds)
  refreshIntervals: {
    optionsChain: 5000,
    greeks: 10000,
    charts: 15000,
  },
};

// AI Model Settings
export const AI_CONFIG = {
  // Recommendation Weights
  weights: {
    volatility: 0.3,
    openInterest: 0.2,
    volume: 0.2,
    delta: 0.15,
    theta: 0.15,
  },

  // Risk Levels
  riskLevels: {
    LOW: { maxLoss: 500, maxDelta: 0.3 },
    MEDIUM: { maxLoss: 1000, maxDelta: 0.5 },
    HIGH: { maxLoss: 2000, maxDelta: 0.8 },
  },

  // Strategy Preferences
  preferences: {
    INCOME: ['SHORT_PUT', 'IRON_CONDOR'],
    GROWTH: ['LONG_CALL', 'BULL_CALL_SPREAD'],
    HEDGING: ['LONG_PUT', 'BEAR_PUT_SPREAD'],
  },
}; 