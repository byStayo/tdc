import { OPTIONS_CONFIG, AI_CONFIG } from '../config/options';
import { POLYGON_CONFIG } from '../config/polygon';

class OptionsService {
  constructor() {
    this.apiKey = POLYGON_CONFIG.API_KEY;
  }

  // Fetch options chain for a given ticker
  async getOptionsChain(ticker) {
    try {
      const response = await fetch(
        `${OPTIONS_CONFIG.endpoints.optionsChain}/${ticker}`,
        POLYGON_CONFIG.requestOptions
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(POLYGON_CONFIG.errors.UNAUTHORIZED);
        } else if (response.status === 429) {
          throw new Error(POLYGON_CONFIG.errors.RATE_LIMIT);
        } else if (response.status === 404) {
          throw new Error(POLYGON_CONFIG.errors.NOT_FOUND);
        } else {
          throw new Error(POLYGON_CONFIG.errors.SERVER_ERROR);
        }
      }

      const data = await response.json();
      
      if (!data.results || !Array.isArray(data.results)) {
        throw new Error('Invalid data format received from API');
      }

      return this.processOptionsChain(data.results);
    } catch (error) {
      console.error('Error fetching options chain:', error);
      throw error;
    }
  }

  // Process options chain data
  processOptionsChain(data) {
    return data.map(option => ({
      symbol: option.ticker,
      type: option.ticker.includes('C') ? 'call' : 'put',
      strike: option.strike_price,
      expiry: option.expiration_date,
      lastPrice: option.day.close,
      change: option.day.change_percent,
      volume: option.day.volume,
      openInterest: option.open_interest,
      bid: option.day.bid,
      ask: option.day.ask,
      impliedVolatility: option.implied_volatility,
      delta: option.greeks?.delta || 0,
      gamma: option.greeks?.gamma || 0,
      theta: option.greeks?.theta || 0,
      vega: option.greeks?.vega || 0,
    }));
  }

  // Filter options based on criteria
  filterOptions(options, filters) {
    return options.filter(option => {
      const meetsOpenInterest = option.openInterest >= (filters.minOpenInterest || OPTIONS_CONFIG.defaultFilters.minOpenInterest);
      const meetsVolume = option.volume >= (filters.minVolume || OPTIONS_CONFIG.defaultFilters.minVolume);
      const meetsDelta = 
        Math.abs(option.delta) >= (filters.minDelta || OPTIONS_CONFIG.defaultFilters.minDelta) &&
        Math.abs(option.delta) <= (filters.maxDelta || OPTIONS_CONFIG.defaultFilters.maxDelta);
      const meetsDaysToExpiry = this.calculateDaysToExpiry(option.expiry) <= 
        (filters.maxDaysToExpiry || OPTIONS_CONFIG.defaultFilters.maxDaysToExpiry);

      return meetsOpenInterest && meetsVolume && meetsDelta && meetsDaysToExpiry;
    });
  }

  // Calculate days until expiration
  calculateDaysToExpiry(expiryDate) {
    const expiry = new Date(expiryDate);
    const today = new Date();
    const diffTime = Math.abs(expiry - today);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  // Get AI-driven recommendations
  getRecommendations(options, preferences = {}) {
    const { riskLevel = 'MEDIUM', strategy = 'GROWTH' } = preferences;
    const riskParams = AI_CONFIG.riskLevels[riskLevel];
    const preferredStrategies = AI_CONFIG.preferences[strategy];

    // Score each option based on weights and preferences
    const scoredOptions = options.map(option => {
      let score = 0;
      score += option.volume * AI_CONFIG.weights.volume;
      score += option.openInterest * AI_CONFIG.weights.openInterest;
      score += (1 - Math.abs(option.impliedVolatility)) * AI_CONFIG.weights.volatility;
      score += (1 - Math.abs(option.delta)) * AI_CONFIG.weights.delta;
      score += (1 - Math.abs(option.theta)) * AI_CONFIG.weights.theta;

      // Adjust score based on risk parameters
      if (Math.abs(option.delta) > riskParams.maxDelta) score *= 0.5;
      const maxLoss = option.type === 'call' 
        ? option.lastPrice * 100 
        : (option.strike - option.lastPrice) * 100;
      if (maxLoss > riskParams.maxLoss) score *= 0.5;

      // Boost score for preferred strategies
      if (preferredStrategies.includes(option.type === 'call' ? 'LONG_CALL' : 'LONG_PUT')) {
        score *= 1.2;
      }

      return { ...option, score };
    });

    // Sort by score and return top recommendations
    return scoredOptions
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // Calculate strategy payoff points
  calculatePayoff(option, strategy, priceRange) {
    const points = [];
    const currentPrice = option.strike;
    const step = currentPrice * 0.01; // 1% steps
    const contractMultiplier = 100;

    for (let price = currentPrice * 0.8; price <= currentPrice * 1.2; price += step) {
      let payoff = 0;
      const premium = option.lastPrice * contractMultiplier;

      switch (strategy) {
        case 'LONG_CALL':
          payoff = Math.max(0, price - option.strike) * contractMultiplier - premium;
          break;
        case 'LONG_PUT':
          payoff = Math.max(0, option.strike - price) * contractMultiplier - premium;
          break;
        case 'SHORT_CALL':
          payoff = Math.min(0, option.strike - price) * contractMultiplier + premium;
          break;
        case 'SHORT_PUT':
          payoff = Math.min(0, price - option.strike) * contractMultiplier + premium;
          break;
        case 'BULL_CALL_SPREAD':
          // Buy lower strike call, sell higher strike call
          const lowerStrike = option.strike;
          const higherStrike = option.strike * 1.05; // 5% higher
          payoff = (Math.max(0, Math.min(price - lowerStrike, higherStrike - lowerStrike)) 
            - option.lastPrice + (option.lastPrice * 0.5)) * contractMultiplier;
          break;
        case 'BEAR_PUT_SPREAD':
          // Buy higher strike put, sell lower strike put
          const putHigherStrike = option.strike;
          const putLowerStrike = option.strike * 0.95; // 5% lower
          payoff = (Math.max(0, Math.min(putHigherStrike - price, putHigherStrike - putLowerStrike)) 
            - option.lastPrice + (option.lastPrice * 0.5)) * contractMultiplier;
          break;
        case 'IRON_CONDOR':
          // Combination of bull put spread and bear call spread
          const width = option.strike * 0.05; // 5% width
          const putSpread = Math.max(0, (option.strike - width) - price) - 
            Math.max(0, (option.strike - width * 2) - price);
          const callSpread = Math.max(0, price - (option.strike + width)) - 
            Math.max(0, price - (option.strike + width * 2));
          payoff = (putSpread + callSpread - option.lastPrice + (option.lastPrice * 0.8)) * contractMultiplier;
          break;
        case 'BUTTERFLY':
          // Buy one lower strike call, sell two middle strike calls, buy one higher strike call
          const butterflyWidth = option.strike * 0.05; // 5% width
          const lowerPayoff = Math.max(0, price - (option.strike - butterflyWidth));
          const middlePayoff = -2 * Math.max(0, price - option.strike);
          const higherPayoff = Math.max(0, price - (option.strike + butterflyWidth));
          payoff = (lowerPayoff + middlePayoff + higherPayoff - option.lastPrice) * contractMultiplier;
          break;
        default:
          payoff = 0;
          break;
      }
      points.push({ price, payoff });
    }
    return points;
  }

  // Format option details for display
  formatOptionDetails(option) {
    return {
      ...option,
      lastPrice: option.lastPrice.toFixed(2),
      change: `${option.change.toFixed(2)}%`,
      impliedVolatility: `${(option.impliedVolatility * 100).toFixed(2)}%`,
      delta: option.delta.toFixed(3),
      gamma: option.gamma.toFixed(3),
      theta: option.theta.toFixed(3),
      vega: option.vega.toFixed(3),
    };
  }
}

export default OptionsService; 