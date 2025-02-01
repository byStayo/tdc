import { POLYGON_CONFIG } from '../config/polygon';

class PolygonService {
  constructor() {
    this.baseUrl = POLYGON_CONFIG.BASE_URL;
    this.apiKey = POLYGON_CONFIG.API_KEY;
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.lastRequestTime = 0;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.ws = null;
    this.wsReconnectAttempts = 0;

    // Enhanced cache management
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.pendingRequests = new Map();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    
    // Endpoint categories
    this.stockEndpoints = new Set([
      POLYGON_CONFIG.ENDPOINTS.AGGREGATES,
      POLYGON_CONFIG.ENDPOINTS.TICKER_DETAILS,
      POLYGON_CONFIG.ENDPOINTS.TICKER_NEWS,
      POLYGON_CONFIG.ENDPOINTS.SNAPSHOTS,
      POLYGON_CONFIG.ENDPOINTS.RELATED_TICKERS
    ]);
    
    // Rate limits by category
    this.rateLimits = {
      stock: {
        requestsPerMinute: Infinity,
        delay: 0
      },
      other: {
        requestsPerMinute: 5,
        delay: 12000 // 12 seconds between requests
      }
    };
    
    // Usage tracking by category
    this.usage = {
      stock: {
        requestsThisMinute: 0,
        minuteStartTime: Date.now()
      },
      other: {
        requestsThisMinute: 0,
        minuteStartTime: Date.now()
      }
    };

    // Initialize other features
    this.initializeLocalStorage();
    this.warmupCache();
    this.prefetchQueue = new Set();
    this.isPrefetching = false;
    
    // Start maintenance intervals
    setInterval(() => this.resetUsageTracking(), 60000);
    setInterval(() => this.logUsageStats(), 300000);
    setInterval(() => this.maintainCache(), 300000);
    setInterval(() => this.processPrefetchQueue(), 5000); // Faster prefetch for unlimited stock data
  }

  // Reset API usage tracking
  resetUsageTracking() {
    Object.keys(this.usage).forEach(category => {
      this.usage[category] = {
        requestsThisMinute: 0,
        minuteStartTime: Date.now()
      };
    });
  }

  // Get endpoint category
  getEndpointCategory(endpoint) {
    return this.stockEndpoints.has(endpoint) ? 'stock' : 'other';
  }

  // Check if we can make a request
  canMakeRequest(endpoint) {
    const category = this.getEndpointCategory(endpoint);
    const { requestsThisMinute, minuteStartTime } = this.usage[category];
    const { requestsPerMinute } = this.rateLimits[category];

    const now = Date.now();
    if (now - minuteStartTime >= 60000) {
      this.usage[category] = {
        requestsThisMinute: 0,
        minuteStartTime: now
      };
      return true;
    }

    return requestsThisMinute < requestsPerMinute;
  }

  // Enhanced cache TTLs with optimized timeouts
  getCacheTTL(endpoint) {
    const category = this.getEndpointCategory(endpoint);
    
    if (category === 'stock') {
      const TTLs = {
        [POLYGON_CONFIG.ENDPOINTS.TICKER_DETAILS]: 24 * 60 * 60 * 1000,    // 24 hours
        [POLYGON_CONFIG.ENDPOINTS.RELATED_TICKERS]: 12 * 60 * 60 * 1000,   // 12 hours
        [POLYGON_CONFIG.ENDPOINTS.TICKER_NEWS]: 30 * 1000,                 // 30 seconds
        [POLYGON_CONFIG.ENDPOINTS.AGGREGATES]: 15 * 1000,                  // 15 seconds
        [POLYGON_CONFIG.ENDPOINTS.SNAPSHOTS]: 10 * 1000,                   // 10 seconds
      };
      return TTLs[endpoint] || 60 * 1000;
    } else {
      // More aggressive caching for rate-limited endpoints
      return 5 * 60 * 1000; // 5 minutes default for non-stock endpoints
    }
  }

  // Process queue with category-based rate limiting
  async processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) return;
    
    this.isProcessingQueue = true;
    
    while (this.requestQueue.length > 0) {
      const { endpoint, params, resolve, reject, cacheKey } = this.requestQueue[0];
      const category = this.getEndpointCategory(endpoint);
      
      if (!this.canMakeRequest(endpoint)) {
        const waitTime = 60000 - (Date.now() - this.usage[category].minuteStartTime);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      try {
        // Check cache first
        const cachedData = this.getCachedData(cacheKey);
        if (cachedData) {
          resolve(cachedData);
          this.requestQueue.shift();
          continue;
        }

        // Check for pending requests
        if (this.pendingRequests.has(cacheKey)) {
          const result = await this.pendingRequests.get(cacheKey);
          resolve(result);
          this.requestQueue.shift();
          continue;
        }

        // Apply rate limiting delay if needed
        const delay = this.rateLimits[category].delay;
        if (delay > 0) {
          const timeSinceLastRequest = Date.now() - this.lastRequestTime;
          if (timeSinceLastRequest < delay) {
            await new Promise(r => setTimeout(r, delay - timeSinceLastRequest));
          }
        }

        // Make the request
        const requestPromise = this._makeRequest(endpoint, params);
        this.pendingRequests.set(cacheKey, requestPromise);
        
        const data = await requestPromise;
        this.usage[category].requestsThisMinute++;
        this.lastRequestTime = Date.now();
        
        // Cache the result
        this.setCachedData(cacheKey, data, this.getCacheTTL(endpoint));
        
        resolve(data);
        this.pendingRequests.delete(cacheKey);
      } catch (error) {
        reject(error);
        this.pendingRequests.delete(cacheKey);
      } finally {
        this.requestQueue.shift();
      }
    }
    
    this.isProcessingQueue = false;
  }

  // Enhanced batch prefetching for stock data
  async processPrefetchQueue() {
    if (this.isPrefetching || this.prefetchQueue.size === 0) return;
    
    this.isPrefetching = true;
    const batchSize = 20; // Increased batch size for unlimited stock data
    
    try {
      const tickers = Array.from(this.prefetchQueue).slice(0, batchSize);
      
      // Parallel batch fetching
      await Promise.all([
        this.getSnapshots(tickers),
        this.getTickerDetails(tickers),
        ...tickers.map(ticker => this.getTickerNews(ticker, 5))
      ]);
      
      // Remove processed tickers
      tickers.forEach(ticker => this.prefetchQueue.delete(ticker));
    } catch (error) {
      console.error('Error processing prefetch queue:', error);
    } finally {
      this.isPrefetching = false;
    }
  }

  // Cache management
  getCacheKey(endpoint, params) {
    return `${endpoint}?${new URLSearchParams(params).toString()}`;
  }

  getCachedData(cacheKey) {
    if (!this.cache.has(cacheKey)) {
      this.cacheMisses++;
      return null;
    }
    
    if (Date.now() > this.cacheExpiry.get(cacheKey)) {
      this.cache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
      this.cacheMisses++;
      return null;
    }
    
    this.cacheHits++;
    return this.cache.get(cacheKey);
  }

  setCachedData(cacheKey, data, ttl = 60000) {
    try {
      // Compress large data objects
      if (JSON.stringify(data).length > 100000) {
        data = this.compressData(data);
      }
      
      this.cache.set(cacheKey, data);
      this.cacheExpiry.set(cacheKey, Date.now() + ttl);
      
      // Update localStorage periodically
      if (Math.random() < 0.1) { // 10% chance to trigger save
        this.saveToLocalStorage();
      }
    } catch (error) {
      console.error('Error setting cache data:', error);
    }
  }

  // Initialize localStorage cache
  initializeLocalStorage() {
    try {
      const savedCache = localStorage.getItem('polygon_cache');
      if (savedCache) {
        const { cache, expiry } = JSON.parse(savedCache);
        Object.entries(cache).forEach(([key, value]) => {
          if (Date.now() < expiry[key]) {
            this.cache.set(key, value);
            this.cacheExpiry.set(key, expiry[key]);
          }
        });
      }
    } catch (error) {
      console.error('Error loading cache from localStorage:', error);
    }
  }

  // Save cache to localStorage
  saveToLocalStorage() {
    try {
      const cacheObject = {};
      const expiryObject = {};
      
      this.cache.forEach((value, key) => {
        if (Date.now() < this.cacheExpiry.get(key)) {
          cacheObject[key] = value;
          expiryObject[key] = this.cacheExpiry.get(key);
        }
      });
      
      localStorage.setItem('polygon_cache', JSON.stringify({
        cache: cacheObject,
        expiry: expiryObject
      }));
    } catch (error) {
      console.error('Error saving cache to localStorage:', error);
    }
  }

  // Cache maintenance
  maintainCache() {
    const now = Date.now();
    let cleanedEntries = 0;
    
    // Clean expired entries
    this.cacheExpiry.forEach((expiry, key) => {
      if (now > expiry) {
        this.cache.delete(key);
        this.cacheExpiry.delete(key);
        cleanedEntries++;
      }
    });
    
    // Save to localStorage
    this.saveToLocalStorage();
    
    console.log(`Cache maintenance complete. Cleaned ${cleanedEntries} entries.`);
    this.logUsageStats();
  }

  // Warm up cache with frequently accessed data
  async warmupCache() {
    try {
      // Cache market status
      await this.getMarketStatus();
      
      // Cache major indices
      const majorIndices = ['^GSPC', '^DJI', '^IXIC', '^RUT'];
      await this.getSnapshots(majorIndices);
      
      // Cache most active stocks (can be customized)
      const activeStocks = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'];
      await this.getSnapshots(activeStocks);
      
      console.log('Cache warmup complete');
    } catch (error) {
      console.error('Error during cache warmup:', error);
    }
  }

  // Enhanced prefetching
  async prefetchRelatedData(ticker) {
    // Add to prefetch queue instead of immediate fetching
    this.prefetchQueue.add(ticker);
    
    try {
      // Immediately fetch critical data
      const [tickerDetails, relatedTickers] = await Promise.all([
        this.getTickerDetails(ticker),
        this.getRelatedTickers(ticker)
      ]);
      
      // Queue related tickers for prefetching
      if (relatedTickers.results) {
        relatedTickers.results.forEach(related => {
          this.prefetchQueue.add(related.ticker);
        });
      }
      
      return tickerDetails;
    } catch (error) {
      console.error(`Error prefetching data for ${ticker}:`, error);
    }
  }

  // Enhanced fetch with retries and error handling
  async _makeRequest(endpoint, params = {}) {
    this.trackEndpointUsage(endpoint);
    this.totalRequests++;

    const queryParams = new URLSearchParams({
      apiKey: this.apiKey,
      ...params,
    });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}?${queryParams}`);
        
        if (response.status === 429) {
          this.rateLimitHits++;
          const retryAfter = response.headers.get('retry-after') || 60;
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        
        if (!response.ok) {
          const stats = this.endpointStats.get(endpoint);
          stats.errors++;
          this.endpointStats.set(endpoint, stats);
          throw new Error(`API call failed: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        this.retryCount = 0;
        return data;
      } catch (error) {
        this.failedRequests++;
        if (attempt === this.maxRetries) throw error;
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  // Stock Data Methods
  async getAggregates(ticker, multiplier, timespan, from, to) {
    const endpoint = `${POLYGON_CONFIG.ENDPOINTS.AGGREGATES}/${ticker}/range/${multiplier}/${timespan}/${from}/${to}`;
    return this.fetchData(endpoint);
  }

  async getTickerNews(ticker, limit = POLYGON_CONFIG.NEWS_CONFIG.DEFAULT_LIMIT) {
    const params = {
      ticker,
      limit: Math.min(limit, POLYGON_CONFIG.NEWS_CONFIG.MAX_LIMIT),
      order: 'desc',
      sort: 'published_utc'
    };
    
    const response = await this.fetchData(POLYGON_CONFIG.ENDPOINTS.TICKER_NEWS, params);
    
    if (response.results) {
      response.results = response.results.map(article => this.processNewsArticle(article));
    }
    
    return response;
  }

  // Process a single news article
  processNewsArticle(article) {
    const processedArticle = {
      ...article,
      sentiment: this.calculateSentiment(article.sentiment_scores),
      impact: this.calculateImpact(article),
      processed_date: new Date().toISOString(),
      keywords: this.extractKeywords(article),
      publisher_weight: this.getPublisherWeight(article.publisher?.name)
    };

    // Add confidence level
    if (article.sentiment_scores) {
      const maxScore = Math.max(
        article.sentiment_scores.positive,
        article.sentiment_scores.negative
      );
      const { HIGH, MEDIUM, LOW } = POLYGON_CONFIG.NEWS_CONFIG.SENTIMENT.CONFIDENCE_LEVELS;
      
      if (maxScore >= HIGH) processedArticle.confidence = 'high';
      else if (maxScore >= MEDIUM) processedArticle.confidence = 'medium';
      else if (maxScore >= LOW) processedArticle.confidence = 'low';
      else processedArticle.confidence = 'uncertain';
    }

    return processedArticle;
  }

  // Get publisher weight based on tier
  getPublisherWeight(publisherName) {
    if (!publisherName) return 0.4; // Default weight for unknown publishers
    
    const { TIER_1, TIER_2, TIER_3 } = POLYGON_CONFIG.NEWS_CONFIG.PUBLISHERS;
    
    if (TIER_1.NAMES.includes(publisherName)) return TIER_1.WEIGHT;
    if (TIER_2.NAMES.includes(publisherName)) return TIER_2.WEIGHT;
    if (TIER_3.NAMES.includes(publisherName)) return TIER_3.WEIGHT;
    
    return 0.4; // Default weight
  }

  // Enhanced impact calculation with publisher weighting
  calculateImpact(article) {
    const { HIGH, MEDIUM, LOW } = POLYGON_CONFIG.NEWS_CONFIG.IMPACT_LEVELS;
    
    // Check for high-impact indicators
    const hasHighImpactKeywords = HIGH.KEYWORDS.some(
      keyword => article.title?.toLowerCase().includes(keyword) || 
                 article.description?.toLowerCase().includes(keyword)
    );
    
    const hasMediumImpactKeywords = MEDIUM.KEYWORDS.some(
      keyword => article.title?.toLowerCase().includes(keyword) || 
                 article.description?.toLowerCase().includes(keyword)
    );

    const hasLowImpactKeywords = LOW.KEYWORDS.some(
      keyword => article.title?.toLowerCase().includes(keyword) || 
                 article.description?.toLowerCase().includes(keyword)
    );
    
    const publisherWeight = this.getPublisherWeight(article.publisher?.name);
    
    const sentimentStrength = article.sentiment_scores ? 
      Math.max(
        article.sentiment_scores.positive,
        article.sentiment_scores.negative
      ) : 0;

    // Calculate weighted impact score
    let impactScore = 0;
    if (hasHighImpactKeywords) impactScore += 0.4;
    else if (hasMediumImpactKeywords) impactScore += 0.2;
    else if (hasLowImpactKeywords) impactScore += 0.1;

    impactScore += publisherWeight * 0.3;
    
    if (sentimentStrength >= HIGH.SENTIMENT_THRESHOLD) impactScore += 0.3;
    else if (sentimentStrength >= MEDIUM.SENTIMENT_THRESHOLD) impactScore += 0.2;
    else if (sentimentStrength >= LOW.SENTIMENT_THRESHOLD) impactScore += 0.1;

    // Determine impact level with confidence
    const result = {
      level: impactScore >= 0.7 ? 'high' : impactScore >= 0.4 ? 'medium' : 'low',
      score: impactScore,
      confidence: impactScore >= 0.8 ? 'high' : impactScore >= 0.6 ? 'medium' : 'low'
    };

    // Add factors that contributed to the impact
    result.factors = [];
    if (hasHighImpactKeywords) result.factors.push('high_impact_keywords');
    if (hasMediumImpactKeywords) result.factors.push('medium_impact_keywords');
    if (publisherWeight >= 0.8) result.factors.push('tier1_publisher');
    if (sentimentStrength >= HIGH.SENTIMENT_THRESHOLD) result.factors.push('strong_sentiment');

    return result;
  }

  // Extract keywords from article
  extractKeywords(article) {
    const keywords = new Set();
    
    // Add existing keywords if available
    if (article.keywords) {
      article.keywords.forEach(keyword => keywords.add(keyword.toLowerCase()));
    }
    
    // Extract additional keywords from title and description
    const text = `${article.title} ${article.description}`.toLowerCase();
    POLYGON_CONFIG.NEWS_CONFIG.IMPACT_LEVELS.HIGH.KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) {
        keywords.add(keyword);
      }
    });
    
    return Array.from(keywords);
  }

  // Fetch historical news with sentiment analysis
  async getHistoricalNews(ticker, days = POLYGON_CONFIG.NEWS_CONFIG.HISTORY.DEFAULT_DAYS) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.min(days, POLYGON_CONFIG.NEWS_CONFIG.HISTORY.MAX_DAYS));

    const params = {
      ticker,
      'published_utc.gte': startDate.toISOString().split('T')[0],
      'published_utc.lte': endDate.toISOString().split('T')[0],
      limit: POLYGON_CONFIG.NEWS_CONFIG.MAX_LIMIT,
      order: 'desc',
      sort: 'published_utc'
    };

    const response = await this.fetchData(POLYGON_CONFIG.ENDPOINTS.TICKER_NEWS, params);
    return this.processHistoricalNews(response.results || [], ticker);
  }

  // Process historical news data
  processHistoricalNews(articles, ticker) {
    const dateMap = new Map();
    const sentimentTrend = [];
    let totalSentiment = 0;
    let sampleCount = 0;

    articles.forEach(article => {
      const date = article.published_utc.split('T')[0];
      const processedArticle = this.processNewsArticle(article);
      
      if (!dateMap.has(date)) {
        dateMap.set(date, {
          date,
          sentiment: { positive: 0, negative: 0, neutral: 0 },
          impact: { high: 0, medium: 0, low: 0 },
          articles: []
        });
      }

      const dayData = dateMap.get(date);
      dayData.sentiment[processedArticle.sentiment]++;
      dayData.impact[processedArticle.impact]++;
      dayData.articles.push(processedArticle);

      // Calculate running sentiment average
      if (processedArticle.sentiment_scores) {
        totalSentiment += (processedArticle.sentiment_scores.positive - processedArticle.sentiment_scores.negative);
        sampleCount++;
        
        if (sampleCount >= POLYGON_CONFIG.NEWS_CONFIG.HISTORY.MIN_SAMPLES) {
          sentimentTrend.push({
            date,
            sentiment: totalSentiment / sampleCount
          });
        }
      }
    });

    return {
      ticker,
      dailyData: Array.from(dateMap.values()).sort((a, b) => new Date(a.date) - new Date(b.date)),
      sentimentTrend,
      summary: {
        totalArticles: articles.length,
        averageSentiment: sampleCount > 0 ? totalSentiment / sampleCount : 0,
        impactDistribution: this.calculateImpactDistribution(dateMap)
      }
    };
  }

  // Calculate impact distribution
  calculateImpactDistribution(dateMap) {
    const totals = { high: 0, medium: 0, low: 0 };
    
    dateMap.forEach(dayData => {
      totals.high += dayData.impact.high;
      totals.medium += dayData.impact.medium;
      totals.low += dayData.impact.low;
    });
    
    const total = totals.high + totals.medium + totals.low;
    return {
      high: total > 0 ? totals.high / total : 0,
      medium: total > 0 ? totals.medium / total : 0,
      low: total > 0 ? totals.low / total : 0
    };
  }

  async getTickerDetails(ticker) {
    return this.fetchData(`${POLYGON_CONFIG.ENDPOINTS.TICKER_DETAILS}/${ticker}`);
  }

  async getRelatedTickers(ticker) {
    const endpoint = `${POLYGON_CONFIG.ENDPOINTS.RELATED_TICKERS}/${ticker}`;
    const response = await this.fetchData(endpoint);
    
    // Transform and sort the results by relationship score
    if (response.results) {
      response.results = response.results
        .map(company => ({
          ticker: company.ticker,
          name: company.name || company.ticker,
          relationship_score: company.score || 0
        }))
        .sort((a, b) => b.relationship_score - a.relationship_score)
        .slice(0, 10); // Limit to top 10 related companies
    }
    
    return response;
  }

  async getMarketStatus() {
    return this.fetchData(POLYGON_CONFIG.ENDPOINTS.MARKET_STATUS);
  }

  async getSnapshots(tickers) {
    return this.fetchData(POLYGON_CONFIG.ENDPOINTS.SNAPSHOTS, {
      tickers: tickers.join(','),
    });
  }

  // WebSocket with reconnection logic
  initWebSocket(onMessage) {
    if (this.ws) {
      this.ws.close();
    }

    this.ws = new WebSocket(POLYGON_CONFIG.WS_URL);
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.wsReconnectAttempts = 0;
      
      // Authenticate
      this.ws.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
      
      // Subscribe to news stream with delayed execution
      setTimeout(() => {
        this.ws.send(JSON.stringify({
          action: 'subscribe',
          params: 'N.*'  // Subscribe to all news
        }));
      }, 1000); // Wait 1 second after auth
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle different message types
        if (Array.isArray(data)) {
          data.forEach(msg => {
            if (msg.ev === 'N') {
              const newsItem = this._processNewsMessage(msg);
              onMessage(newsItem);
            }
          });
        }
      } catch (error) {
        console.error('WebSocket message processing error:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onclose = () => {
      console.log('WebSocket closed');
      
      // Implement reconnection with exponential backoff
      if (this.wsReconnectAttempts < POLYGON_CONFIG.webSocket.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
        this.wsReconnectAttempts++;
        
        setTimeout(() => {
          console.log(`Attempting to reconnect (${this.wsReconnectAttempts})`);
          this.initWebSocket(onMessage);
        }, delay);
      }
    };

    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, POLYGON_CONFIG.webSocket.pingInterval);

    return () => {
      clearInterval(pingInterval);
      if (this.ws) {
        this.ws.close();
      }
    };
  }

  _processNewsMessage(msg) {
    const newsItem = {
      type: 'news',
      id: msg.id,
      title: msg.title,
      description: msg.description || '',
      published_utc: msg.timestamp,
      article_url: msg.url,
      tickers: msg.symbols,
      source: msg.source,
      keywords: msg.keywords || [],
      image_url: msg.image_url
    };

    // Add sentiment analysis if available
    if (msg.sentiment_scores) {
      const sentiment = this.calculateSentiment(msg.sentiment_scores);
      newsItem.sentiment = sentiment;
      newsItem.sentiment_scores = msg.sentiment_scores;
      newsItem.impact = this.calculateImpact({
        title: msg.title,
        description: msg.description,
        publisher: { name: msg.source },
        sentiment_scores: msg.sentiment_scores,
        sentiment,
        keywords: msg.keywords
      });
    } else {
      newsItem.sentiment = 'neutral';
      newsItem.impact = this.calculateImpact({
        title: msg.title,
        description: msg.description,
        publisher: { name: msg.source },
        keywords: msg.keywords
      });
    }

    // Add market context if available
    if (msg.market_type) {
      newsItem.market_context = {
        type: msg.market_type,
        sector: msg.sector,
        industry: msg.industry
      };
    }

    return newsItem;
  }

  subscribeToTicker(ticker) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'subscribe',
        params: `T.${ticker}`,
      }));
    }
  }

  unsubscribeFromTicker(ticker) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'unsubscribe',
        params: `T.${ticker}`,
      }));
    }
  }

  // Anomaly Detection Methods
  async detectAnomalies(ticker, days = POLYGON_CONFIG.ANOMALY_DETECTION.LOOKBACK_DAYS) {
    const now = new Date();
    const past = new Date(now.setDate(now.getDate() - days));
    
    const data = await this.getAggregates(
      ticker,
      1,
      'day',
      past.toISOString().split('T')[0],
      new Date().toISOString().split('T')[0]
    );

    const results = data.results || [];
    if (results.length < POLYGON_CONFIG.ANOMALY_DETECTION.MIN_SAMPLES) {
      return [];
    }

    // Calculate rolling statistics for trades and volume
    const rollingStats = this.calculateRollingStats(results, 5);

    // Detect anomalies
    const anomalies = results.map((bar, index) => {
      const stats = rollingStats[index];
      if (!stats) return null;

      const volumeZScore = (bar.v - stats.avgVolume) / stats.stdVolume;
      const tradesZScore = (bar.n - stats.avgTrades) / stats.stdTrades;
      const priceChange = ((bar.c - bar.o) / bar.o) * 100;

      const anomalyTypes = [];
      if (Math.abs(volumeZScore) > POLYGON_CONFIG.ANOMALY_DETECTION.VOLUME_THRESHOLD) {
        anomalyTypes.push('volume');
      }
      if (Math.abs(tradesZScore) > POLYGON_CONFIG.ANOMALY_DETECTION.VOLUME_THRESHOLD) {
        anomalyTypes.push('trades');
      }
      if (Math.abs(priceChange) > POLYGON_CONFIG.ANOMALY_DETECTION.PRICE_THRESHOLD) {
        anomalyTypes.push('price');
      }

      if (anomalyTypes.length === 0) return null;

      return {
        timestamp: bar.t,
        date: new Date(bar.t).toLocaleDateString(),
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
        trades: bar.n,
        volumeZScore,
        tradesZScore,
        priceChange,
        anomalyTypes,
        stats: {
          avgVolume: stats.avgVolume,
          stdVolume: stats.stdVolume,
          avgTrades: stats.avgTrades,
          stdTrades: stats.stdTrades
        }
      };
    }).filter(Boolean);

    return anomalies;
  }

  calculateRollingStats(data, window) {
    const stats = [];
    
    for (let i = window; i < data.length; i++) {
      const windowData = data.slice(i - window, i);
      
      const volumes = windowData.map(d => d.v);
      const trades = windowData.map(d => d.n);
      
      stats[i] = {
        avgVolume: this.mean(volumes),
        stdVolume: this.standardDeviation(volumes),
        avgTrades: this.mean(trades),
        stdTrades: this.standardDeviation(trades)
      };
    }
    
    return stats;
  }

  mean(array) {
    return array.reduce((a, b) => a + b) / array.length;
  }

  standardDeviation(array) {
    const avg = this.mean(array);
    const squareDiffs = array.map(value => Math.pow(value - avg, 2));
    const variance = this.mean(squareDiffs);
    return Math.sqrt(variance);
  }

  // Sentiment Analysis Methods
  async analyzeSentiment(ticker, days) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const params = {
      ticker,
      'published_utc.gte': startDate.toISOString().split('T')[0],
      'published_utc.lte': endDate.toISOString().split('T')[0],
      limit: 1000,
      order: 'desc',
      sort: 'published_utc'
    };

    const response = await this.fetchData(POLYGON_CONFIG.ENDPOINTS.TICKER_NEWS, params);
    const dateMap = new Map();

    if (response.results) {
      response.results.forEach(article => {
        const date = article.published_utc.split('T')[0];
        
        if (!dateMap.has(date)) {
          dateMap.set(date, {
            date,
            sentiment: {
              positive: 0,
              negative: 0,
              neutral: 0
            },
            articles: []
          });
        }

        const dayData = dateMap.get(date);
        
        if (article.insights && article.insights.length > 0) {
          article.insights.forEach(insight => {
            if (insight.ticker === ticker) {
              dayData.sentiment[insight.sentiment]++;
            }
          });
        }

        dayData.articles.push({
          title: article.title,
          description: article.description,
          published_utc: article.published_utc,
          article_url: article.article_url,
          publisher: article.publisher,
          sentiment_score: article.insights?.[0]?.sentiment_score || 0,
          sentiment: article.insights?.[0]?.sentiment || 'neutral',
          sentiment_reasoning: article.insights?.[0]?.sentiment_reasoning || ''
        });
      });
    }

    // Convert the Map to an array and sort by date
    return Array.from(dateMap.values())
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // Helper Methods
  calculateStats(array) {
    const mean = array.reduce((a, b) => a + b) / array.length;
    const variance = array.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / array.length;
    return {
      mean,
      std: Math.sqrt(variance),
    };
  }

  analyzeSingleArticle(article) {
    const { sentiment_score } = article;
    
    if (!sentiment_score) return 'neutral';
    
    if (sentiment_score >= POLYGON_CONFIG.SENTIMENT_ANALYSIS.SENTIMENT_THRESHOLDS.POSITIVE) {
      return 'positive';
    } else if (sentiment_score <= POLYGON_CONFIG.SENTIMENT_ANALYSIS.SENTIMENT_THRESHOLDS.NEGATIVE) {
      return 'negative';
    }
    return 'neutral';
  }

  async getUniversalSnapshot(tickers) {
    const tickersString = Array.isArray(tickers) ? tickers.join(',') : tickers;
    const endpoint = `${this.baseUrl}/v3/snapshot?ticker.any_of=${tickersString}&apiKey=${this.apiKey}`;
    
    try {
      const response = await this.fetchData(endpoint);
      const results = response.results || [];

      // Add sentiment data
      return await Promise.all(
        results.map(async (result) => {
          const news = await this.getTickerNews(result.ticker, 1);
          return {
            ...result,
            sentiment: news.results?.[0]?.sentiment || 'neutral',
            sentiment_score: news.results?.[0]?.sentiment_scores?.compound || 0
          };
        })
      );
    } catch (error) {
      console.error('Error fetching universal snapshot:', error);
      throw error;
    }
  }

  // Track endpoint usage
  trackEndpointUsage(endpoint) {
    if (!this.endpointStats.has(endpoint)) {
      this.endpointStats.set(endpoint, {
        calls: 0,
        cacheHits: 0,
        errors: 0,
        lastCall: null
      });
    }
    
    const stats = this.endpointStats.get(endpoint);
    stats.calls++;
    stats.lastCall = new Date();
    this.endpointStats.set(endpoint, stats);
  }

  // Log usage statistics to console
  logUsageStats() {
    console.log('\n=== Polygon.io API Usage Statistics ===');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Total Requests: ${this.totalRequests}`);
    console.log(`Requests This Minute: ${this.requestsThisMinute}/${this.maxRequestsPerMinute}`);
    console.log(`Failed Requests: ${this.failedRequests}`);
    console.log(`Rate Limit Hits: ${this.rateLimitHits}`);
    console.log(`Cache Hits: ${this.cacheHits}`);
    console.log(`Cache Misses: ${this.cacheMisses}`);
    console.log(`Cache Hit Ratio: ${(this.cacheHits / (this.cacheHits + this.cacheMisses) * 100).toFixed(2)}%`);
    
    console.log('\nEndpoint Usage:');
    this.endpointStats.forEach((stats, endpoint) => {
      console.log(`\n${endpoint}:`);
      console.log(`  Calls: ${stats.calls}`);
      console.log(`  Cache Hits: ${stats.cacheHits}`);
      console.log(`  Errors: ${stats.errors}`);
      console.log(`  Last Call: ${stats.lastCall ? stats.lastCall.toISOString() : 'Never'}`);
    });
    
    console.log('\nCache Status:');
    console.log(`Active Cache Entries: ${this.cache.size}`);
    console.log('=================================\n');
  }

  // Compress large data objects
  compressData(data) {
    // Simple compression by removing null/undefined values and empty arrays
    const compress = (obj) => {
      if (Array.isArray(obj)) {
        return obj.filter(item => item != null).map(compress);
      }
      if (typeof obj === 'object' && obj !== null) {
        const compressed = {};
        for (const [key, value] of Object.entries(obj)) {
          if (value != null && 
              !(Array.isArray(value) && value.length === 0) &&
              !(typeof value === 'object' && Object.keys(value).length === 0)) {
            compressed[key] = compress(value);
          }
        }
        return compressed;
      }
      return obj;
    };
    
    return compress(data);
  }

  // Get Fair Market Value for a ticker
  async getFMV(ticker) {
    const cacheKey = `fmv_${ticker}`;
    const cachedData = this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const endpoint = POLYGON_CONFIG.FMV_CONFIG.ENDPOINTS.FMV;
    const response = await this.fetchData(endpoint, { ticker });
    
    if (response.fmv) {
      const data = {
        ticker,
        fmv: response.fmv,
        timestamp: response.t,
        deviation: this.calculateFMVDeviation(response.fmv, ticker)
      };
      
      this.setCachedData(cacheKey, data, POLYGON_CONFIG.FMV_CONFIG.CACHE_TTL);
      return data;
    }
    
    return null;
  }

  // Get historical FMV data
  async getHistoricalFMV(ticker, from, to) {
    const endpoint = POLYGON_CONFIG.FMV_CONFIG.ENDPOINTS.HISTORICAL_FMV;
    return this.fetchData(endpoint, {
      ticker,
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0]
    });
  }

  // Calculate deviation between FMV and current price
  async calculateFMVDeviation(fmv, ticker) {
    try {
      const snapshot = await this.getSnapshots([ticker]);
      if (snapshot.results && snapshot.results[0]) {
        const currentPrice = snapshot.results[0].day.close;
        return {
          absolute: fmv - currentPrice,
          percentage: ((fmv - currentPrice) / currentPrice) * 100,
          isSignificant: Math.abs((fmv - currentPrice) / currentPrice) >= POLYGON_CONFIG.FMV_CONFIG.THRESHOLDS.DEVIATION
        };
      }
    } catch (error) {
      console.error('Error calculating FMV deviation:', error);
    }
    return null;
  }
}

// Create and export a singleton instance
const polygonService = new PolygonService();
export default polygonService; 