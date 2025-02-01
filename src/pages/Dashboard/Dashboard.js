import React, { useState, useEffect, useMemo } from 'react';
import { Grid, Card, Typography, Divider, IconButton, Tooltip, CircularProgress, TableContainer, Table, TableHead, TableBody, TableRow, TableCell, Paper, Chip, LinearProgress } from '@mui/material';
import { 
  TrendingUp, 
  ShowChart, 
  Assessment, 
  SignalCellularAlt,
  Timeline,
  Insights,
  TrendingDown,
  BarChart,
  PieChart,
  CompareArrows,
  Refresh,
  Info,
  ArrowUpward,
  ArrowDownward,
  Speed,
  Visibility,
  TrendingFlat,
  AttachMoney,
  ShowChartOutlined,
  StackedLineChart,
  CallMade,
  CallReceived,
  MonetizationOn,
  TrendingNeutral,
  Analytics,
  BubbleChart
} from '@mui/icons-material';
import './Dashboard.css';

function Dashboard() {
  const [timeframe, setTimeframe] = useState('1D');
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [marketHealth, setMarketHealth] = useState({
    overall: 78,
    momentum: 82,
    volatility: 45,
    trend: 65,
    volume: 72
  });
  const [data, setData] = useState({
    marketSentiment: { value: 75, change: 12.5 },
    smartMoneyFlow: { value: -15, change: -3.2 },
    technicalScore: { value: 92, change: 5.3 },
    signalStrength: { value: 'Strong Buy', change: 8.7 }
  });

  const [trendAnalysis, setTrendAnalysis] = useState({
    shortTerm: { direction: 'up', strength: 85, momentum: 78 },
    mediumTerm: { direction: 'up', strength: 72, momentum: 65 },
    longTerm: { direction: 'neutral', strength: 45, momentum: 52 }
  });

  const [optionsFlow, setOptionsFlow] = useState({
    callVolume: 1250000,
    putVolume: 850000,
    putCallRatio: 0.68,
    unusualActivity: [
      { strike: '430', type: 'CALL', volume: '15.2K', premium: '$2.1M' },
      { strike: '425', type: 'PUT', volume: '12.8K', premium: '$1.8M' },
      { strike: '435', type: 'CALL', volume: '10.5K', premium: '$1.5M' },
      { strike: '420', type: 'PUT', volume: '9.7K', premium: '$1.2M' }
    ]
  });

  const [correlations, setCorrelations] = useState({
    pairs: [
      { pair: 'SPY/QQQ', value: 0.85, strength: 'Strong', trend: 'increasing' },
      { pair: 'SPY/IWM', value: 0.72, strength: 'Moderate', trend: 'stable' },
      { pair: 'SPY/GLD', value: -0.45, strength: 'Moderate', trend: 'decreasing' },
      { pair: 'SPY/TLT', value: -0.68, strength: 'Strong', trend: 'stable' },
      { pair: 'QQQ/IWM', value: 0.65, strength: 'Moderate', trend: 'increasing' }
    ]
  });

  const [sectorPerformance, setSectorPerformance] = useState({
    sectors: [
      { name: 'Technology', performance: 2.8, momentum: 75, volume: '125M', trend: 'up' },
      { name: 'Healthcare', performance: -0.5, momentum: 45, volume: '82M', trend: 'down' },
      { name: 'Financials', performance: 1.2, momentum: 62, volume: '95M', trend: 'up' },
      { name: 'Energy', performance: -1.5, momentum: 35, volume: '78M', trend: 'down' },
      { name: 'Consumer', performance: 0.8, momentum: 58, volume: '88M', trend: 'up' }
    ]
  });

  const [marketBreadth, setMarketBreadth] = useState({
    advanceDecline: { advancing: 285, declining: 215, unchanged: 12 },
    newHighsLows: { newHighs: 45, newLows: 28 },
    volumeStats: {
      upVolume: '2.8B',
      downVolume: '1.5B',
      totalVolume: '4.3B',
      avgVolume: '3.9B'
    },
    breadthIndicators: [
      { name: 'McClellan Oscillator', value: 35.8, trend: 'rising' },
      { name: 'Arms Index', value: 0.85, trend: 'stable' },
      { name: 'Advance/Decline Line', value: 1250, trend: 'rising' },
      { name: 'High/Low Index', value: 65, trend: 'falling' }
    ]
  });

  const [riskMetrics, setRiskMetrics] = useState({
    volatilityGauge: {
      current: 18.5,
      historical: 22.3,
      implied: 20.1
    },
    riskIndicators: {
      marketRisk: 65,
      sectorRisk: 48,
      systematicRisk: 72
    },
    sentimentMetrics: {
      fearGreedIndex: 58,
      putCallRatio: 0.85,
      volatilitySkew: 125
    },
    keyLevels: {
      support: ['4280', '4250', '4225'],
      resistance: ['4320', '4350', '4380']
    }
  });

  const [marketInternals, setMarketInternals] = useState({
    tickData: {
      upticks: 285,
      downticks: 215,
      tickRatio: 1.32
    },
    volumeAnalysis: {
      upVolume: '3.2B',
      downVolume: '2.1B',
      volumeRatio: 1.52,
      averageVolume: '2.8B'
    },
    marketBreadth: {
      advanceDecline: 1.45,
      newHighsLows: 0.85,
      trendStrength: 72
    },
    sectorInternals: [
      { name: 'Technology', breadth: 1.25, volume: '1.2B', momentum: 78 },
      { name: 'Financials', breadth: 0.95, volume: '850M', momentum: 62 },
      { name: 'Healthcare', breadth: 1.15, volume: '750M', momentum: 68 },
      { name: 'Energy', breadth: 0.85, volume: '620M', momentum: 45 }
    ]
  });

  const [technicalSignals, setTechnicalSignals] = useState({
    primaryTrends: {
      shortTerm: { signal: 'bullish', strength: 75, momentum: 82 },
      mediumTerm: { signal: 'neutral', strength: 55, momentum: 48 },
      longTerm: { signal: 'bullish', strength: 68, momentum: 72 }
    },
    keyIndicators: [
      { name: 'RSI', value: 62, signal: 'neutral', trend: 'rising' },
      { name: 'MACD', value: 0.85, signal: 'bullish', trend: 'rising' },
      { name: 'Stochastic', value: 75, signal: 'overbought', trend: 'stable' },
      { name: 'ADX', value: 28, signal: 'strengthening', trend: 'rising' }
    ],
    pricePatterns: [
      { pattern: 'Bull Flag', probability: 85, timeframe: '4H' },
      { pattern: 'Cup & Handle', probability: 72, timeframe: '1D' },
      { pattern: 'Rising Wedge', probability: 68, timeframe: '1W' }
    ],
    supportResistance: {
      strongResistance: ['4320', '4350', '4380'],
      strongSupport: ['4250', '4225', '4200'],
      breakoutLevels: ['4400', '4180']
    }
  });

  const [marketSentiment, setMarketSentiment] = useState({
    fearGreedIndex: {
      value: 65,
      interpretation: 'Greed',
      change: 5
    },
    sentimentIndicators: [
      { name: 'Retail Sentiment', value: 72, bias: 'bullish', confidence: 85 },
      { name: 'Institutional Flow', value: 58, bias: 'neutral', confidence: 65 },
      { name: 'Options Sentiment', value: 82, bias: 'bullish', confidence: 78 },
      { name: 'Social Media Buzz', value: 68, bias: 'bullish', confidence: 62 }
    ],
    marketMood: {
      shortTerm: { mood: 'optimistic', strength: 75 },
      mediumTerm: { mood: 'cautious', strength: 55 },
      longTerm: { mood: 'bullish', strength: 82 }
    },
    newsAnalysis: [
      { source: 'Major News', sentiment: 0.65, impact: 'high', relevance: 85 },
      { source: 'Social Media', sentiment: 0.78, impact: 'medium', relevance: 72 },
      { source: 'Financial Blogs', sentiment: 0.55, impact: 'medium', relevance: 68 },
      { source: 'Analyst Reports', sentiment: 0.82, impact: 'high', relevance: 88 }
    ]
  });

  const [volumeProfile, setVolumeProfile] = useState({
    volumeByPrice: [
      { price: '432.50', volume: '2.5M', type: 'resistance' },
      { price: '430.00', volume: '3.8M', type: 'current' },
      { price: '428.50', volume: '1.8M', type: 'support' },
      { price: '425.00', volume: '2.2M', type: 'support' }
    ],
    valueAreas: {
      high: { price: '432.50', volume: '2.5M' },
      low: { price: '425.00', volume: '2.2M' },
      poc: { price: '430.00', volume: '3.8M' }
    },
    volumePatterns: [
      { pattern: 'Volume Climax', probability: 85, significance: 'high' },
      { pattern: 'Volume Divergence', probability: 72, significance: 'medium' },
      { pattern: 'Accumulation', probability: 68, significance: 'medium' }
    ],
    timeAnalysis: {
      peak: { time: '10:30 AM', volume: '1.2M' },
      low: { time: '12:30 PM', volume: '450K' },
      current: { time: '2:30 PM', volume: '850K' }
    }
  });

  const [marketMomentum, setMarketMomentum] = useState({
    momentumScores: {
      shortTerm: { score: 82, strength: 'Strong', direction: 'up' },
      mediumTerm: { score: 65, strength: 'Moderate', direction: 'up' },
      longTerm: { score: 75, strength: 'Strong', direction: 'up' }
    },
    momentumIndicators: [
      { name: 'RSI Momentum', value: 68, trend: 'rising', signal: 'bullish' },
      { name: 'Price Momentum', value: 75, trend: 'rising', signal: 'bullish' },
      { name: 'Volume Momentum', value: 62, trend: 'stable', signal: 'neutral' },
      { name: 'Volatility Momentum', value: 55, trend: 'falling', signal: 'neutral' }
    ],
    keyLevels: {
      resistance: [
        { price: '435.50', strength: 85, type: 'major' },
        { price: '432.25', strength: 72, type: 'minor' }
      ],
      support: [
        { price: '428.75', strength: 78, type: 'major' },
        { price: '425.50', strength: 65, type: 'minor' }
      ]
    },
    momentumDivergences: [
      { type: 'Bullish', probability: 82, timeframe: '4H', confidence: 'high' },
      { type: 'Hidden Bullish', probability: 68, timeframe: '1D', confidence: 'medium' }
    ]
  });

  const [smartMoneyFlow, setSmartMoneyFlow] = useState({
    institutionalActivity: {
      netFlow: 850000000,
      buyVolume: 2500000000,
      sellVolume: 1650000000,
      flowStrength: 75
    },
    darkpoolActivity: {
      totalVolume: '3.2B',
      significantLevels: [
        { price: '430.25', volume: '450M', type: 'accumulation' },
        { price: '428.50', volume: '380M', type: 'distribution' }
      ],
      sentiment: 'bullish',
      unusualActivity: true
    },
    optionsActivity: {
      putCallRatio: 0.75,
      largeBlockTrades: [
        { strike: '435', type: 'CALL', volume: '25000', premium: '$3.2M' },
        { strike: '425', type: 'PUT', volume: '18000', premium: '$2.8M' }
      ],
      impliedVolatility: {
        current: 22.5,
        trend: 'decreasing',
        skew: 'neutral'
      }
    },
    whaleActivity: {
      recentMoves: [
        { type: 'buy', amount: '$15.2M', time: '10:30 AM', impact: 'high' },
        { type: 'sell', amount: '$8.5M', time: '11:45 AM', impact: 'medium' }
      ],
      netPosition: 'accumulating',
      confidence: 85
    }
  });

  const timeframes = ['1H', '4H', '1D', '1W', '1M'];

  const handleRefresh = async () => {
    setIsLoading(true);
    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Update data with random changes
      setData(prev => ({
        marketSentiment: { 
          value: Math.min(100, Math.max(0, prev.marketSentiment.value + (Math.random() - 0.5) * 10)),
          change: (Math.random() - 0.5) * 5 
        },
        smartMoneyFlow: { 
          value: Math.min(100, Math.max(-100, prev.smartMoneyFlow.value + (Math.random() - 0.5) * 10)),
          change: (Math.random() - 0.5) * 5 
        },
        technicalScore: { 
          value: Math.min(100, Math.max(0, prev.technicalScore.value + (Math.random() - 0.5) * 10)),
          change: (Math.random() - 0.5) * 5 
        },
        signalStrength: { 
          value: prev.signalStrength.value,
          change: (Math.random() - 0.5) * 5 
        }
      }));

      // Update market health
      setMarketHealth(prev => ({
        overall: Math.min(100, Math.max(0, prev.overall + (Math.random() - 0.5) * 10)),
        momentum: Math.min(100, Math.max(0, prev.momentum + (Math.random() - 0.5) * 10)),
        volatility: Math.min(100, Math.max(0, prev.volatility + (Math.random() - 0.5) * 10)),
        trend: Math.min(100, Math.max(0, prev.trend + (Math.random() - 0.5) * 10)),
        volume: Math.min(100, Math.max(0, prev.volume + (Math.random() - 0.5) * 10))
      }));
      
      // Update trend analysis
      setTrendAnalysis(prev => ({
        shortTerm: {
          direction: Math.random() > 0.3 ? 'up' : Math.random() > 0.5 ? 'down' : 'neutral',
          strength: Math.min(100, Math.max(0, prev.shortTerm.strength + (Math.random() - 0.5) * 10)),
          momentum: Math.min(100, Math.max(0, prev.shortTerm.momentum + (Math.random() - 0.5) * 10))
        },
        mediumTerm: {
          direction: Math.random() > 0.3 ? 'up' : Math.random() > 0.5 ? 'down' : 'neutral',
          strength: Math.min(100, Math.max(0, prev.mediumTerm.strength + (Math.random() - 0.5) * 10)),
          momentum: Math.min(100, Math.max(0, prev.mediumTerm.momentum + (Math.random() - 0.5) * 10))
        },
        longTerm: {
          direction: Math.random() > 0.3 ? 'up' : Math.random() > 0.5 ? 'down' : 'neutral',
          strength: Math.min(100, Math.max(0, prev.longTerm.strength + (Math.random() - 0.5) * 10)),
          momentum: Math.min(100, Math.max(0, prev.longTerm.momentum + (Math.random() - 0.5) * 10))
        }
      }));

      // Update options flow
      setOptionsFlow(prev => ({
        callVolume: prev.callVolume + (Math.random() - 0.5) * 100000,
        putVolume: prev.putVolume + (Math.random() - 0.5) * 100000,
        putCallRatio: Math.max(0.1, Math.min(2, prev.putCallRatio + (Math.random() - 0.5) * 0.1)),
        unusualActivity: prev.unusualActivity
      }));
      
      // Update correlations
      setCorrelations(prev => ({
        pairs: prev.pairs.map(pair => ({
          ...pair,
          value: Math.max(-1, Math.min(1, pair.value + (Math.random() - 0.5) * 0.1)),
          trend: Math.random() > 0.7 ? 
            (Math.random() > 0.5 ? 'increasing' : 'decreasing') : 
            pair.trend
        }))
      }));

      // Update sector performance
      setSectorPerformance(prev => ({
        sectors: prev.sectors.map(sector => ({
          ...sector,
          performance: sector.performance + (Math.random() - 0.5) * 0.5,
          momentum: Math.max(0, Math.min(100, sector.momentum + (Math.random() - 0.5) * 5)),
          volume: `${Math.floor(parseInt(sector.volume) + (Math.random() - 0.5) * 10)}M`,
          trend: Math.random() > 0.7 ? (Math.random() > 0.5 ? 'up' : 'down') : sector.trend
        }))
      }));
      
      // Update market breadth
      setMarketBreadth(prev => ({
        ...prev,
        advanceDecline: {
          advancing: Math.floor(Math.random() * 100) + 250,
          declining: Math.floor(Math.random() * 100) + 150,
          unchanged: Math.floor(Math.random() * 20)
        },
        newHighsLows: {
          newHighs: Math.floor(Math.random() * 20) + 35,
          newLows: Math.floor(Math.random() * 15) + 20
        },
        breadthIndicators: prev.breadthIndicators.map(indicator => ({
          ...indicator,
          value: indicator.name === 'Arms Index' ? 
            Math.max(0.5, Math.min(1.5, indicator.value + (Math.random() - 0.5) * 0.1)) :
            indicator.value + (Math.random() - 0.5) * 10,
          trend: Math.random() > 0.7 ? 
            (Math.random() > 0.5 ? 'rising' : 'falling') : 
            indicator.trend
        }))
      }));
      
      // Update risk metrics
      setRiskMetrics(prev => ({
        ...prev,
        volatilityGauge: {
          current: Math.max(10, Math.min(30, prev.volatilityGauge.current + (Math.random() - 0.5) * 2)),
          historical: prev.volatilityGauge.historical,
          implied: Math.max(10, Math.min(30, prev.volatilityGauge.implied + (Math.random() - 0.5) * 2))
        },
        riskIndicators: {
          marketRisk: Math.min(100, Math.max(0, prev.riskIndicators.marketRisk + (Math.random() - 0.5) * 5)),
          sectorRisk: Math.min(100, Math.max(0, prev.riskIndicators.sectorRisk + (Math.random() - 0.5) * 5)),
          systematicRisk: Math.min(100, Math.max(0, prev.riskIndicators.systematicRisk + (Math.random() - 0.5) * 5))
        },
        sentimentMetrics: {
          fearGreedIndex: Math.min(100, Math.max(0, prev.sentimentMetrics.fearGreedIndex + (Math.random() - 0.5) * 5)),
          putCallRatio: Math.max(0.5, Math.min(1.5, prev.sentimentMetrics.putCallRatio + (Math.random() - 0.5) * 0.1)),
          volatilitySkew: Math.max(100, Math.min(150, prev.sentimentMetrics.volatilitySkew + (Math.random() - 0.5) * 5))
        }
      }));
      
      // Update market internals
      setMarketInternals(prev => ({
        ...prev,
        tickData: {
          upticks: Math.floor(Math.random() * 100) + 200,
          downticks: Math.floor(Math.random() * 100) + 150,
          tickRatio: (Math.random() * 0.5 + 1).toFixed(2)
        },
        volumeAnalysis: {
          upVolume: `${(Math.random() * 2 + 2).toFixed(1)}B`,
          downVolume: `${(Math.random() * 1.5 + 1).toFixed(1)}B`,
          volumeRatio: (Math.random() * 0.5 + 1).toFixed(2),
          averageVolume: prev.volumeAnalysis.averageVolume
        },
        marketBreadth: {
          advanceDecline: Math.max(0.5, Math.min(2, prev.marketBreadth.advanceDecline + (Math.random() - 0.5) * 0.2)),
          newHighsLows: Math.max(0.2, Math.min(1.5, prev.marketBreadth.newHighsLows + (Math.random() - 0.5) * 0.1)),
          trendStrength: Math.min(100, Math.max(0, prev.marketBreadth.trendStrength + (Math.random() - 0.5) * 5))
        },
        sectorInternals: prev.sectorInternals.map(sector => ({
          ...sector,
          breadth: Math.max(0.5, Math.min(1.5, sector.breadth + (Math.random() - 0.5) * 0.1)),
          volume: `${(Math.random() * 0.5 + 0.5).toFixed(1)}B`,
          momentum: Math.min(100, Math.max(0, sector.momentum + (Math.random() - 0.5) * 5))
        }))
      }));

      // Update technical signals
      setTechnicalSignals(prev => ({
        ...prev,
        primaryTrends: {
          shortTerm: {
            ...prev.primaryTrends.shortTerm,
            strength: Math.min(100, Math.max(0, prev.primaryTrends.shortTerm.strength + (Math.random() - 0.5) * 5)),
            momentum: Math.min(100, Math.max(0, prev.primaryTrends.shortTerm.momentum + (Math.random() - 0.5) * 5))
          },
          mediumTerm: {
            ...prev.primaryTrends.mediumTerm,
            strength: Math.min(100, Math.max(0, prev.primaryTrends.mediumTerm.strength + (Math.random() - 0.5) * 5)),
            momentum: Math.min(100, Math.max(0, prev.primaryTrends.mediumTerm.momentum + (Math.random() - 0.5) * 5))
          },
          longTerm: {
            ...prev.primaryTrends.longTerm,
            strength: Math.min(100, Math.max(0, prev.primaryTrends.longTerm.strength + (Math.random() - 0.5) * 5)),
            momentum: Math.min(100, Math.max(0, prev.primaryTrends.longTerm.momentum + (Math.random() - 0.5) * 5))
          }
        },
        keyIndicators: prev.keyIndicators.map(indicator => ({
          ...indicator,
          value: indicator.name === 'RSI' ? 
            Math.min(100, Math.max(0, indicator.value + (Math.random() - 0.5) * 5)) :
            indicator.name === 'MACD' ?
            Math.max(-2, Math.min(2, indicator.value + (Math.random() - 0.5) * 0.2)) :
            indicator.name === 'ADX' ?
            Math.min(100, Math.max(0, indicator.value + (Math.random() - 0.5) * 3)) :
            Math.min(100, Math.max(0, indicator.value + (Math.random() - 0.5) * 5)),
          trend: Math.random() > 0.7 ? 
            (Math.random() > 0.5 ? 'rising' : 'falling') : 
            indicator.trend
        }))
      }));
      
      setMarketSentiment(prev => ({
        ...prev,
        fearGreedIndex: {
          value: Math.min(100, Math.max(0, prev.fearGreedIndex.value + (Math.random() - 0.5) * 10)),
          interpretation: prev.fearGreedIndex.value > 70 ? 'Extreme Greed' : 
                         prev.fearGreedIndex.value > 50 ? 'Greed' :
                         prev.fearGreedIndex.value > 30 ? 'Fear' : 'Extreme Fear',
          change: (Math.random() - 0.5) * 8
        },
        sentimentIndicators: prev.sentimentIndicators.map(indicator => ({
          ...indicator,
          value: Math.min(100, Math.max(0, indicator.value + (Math.random() - 0.5) * 10)),
          bias: Math.random() > 0.7 ? 
            (Math.random() > 0.5 ? 'bullish' : 'bearish') : 
            indicator.bias,
          confidence: Math.min(100, Math.max(0, indicator.confidence + (Math.random() - 0.5) * 5))
        })),
        marketMood: {
          shortTerm: {
            mood: Math.random() > 0.6 ? 'optimistic' : Math.random() > 0.5 ? 'cautious' : 'pessimistic',
            strength: Math.min(100, Math.max(0, prev.marketMood.shortTerm.strength + (Math.random() - 0.5) * 10))
          },
          mediumTerm: {
            mood: Math.random() > 0.6 ? 'optimistic' : Math.random() > 0.5 ? 'cautious' : 'pessimistic',
            strength: Math.min(100, Math.max(0, prev.marketMood.mediumTerm.strength + (Math.random() - 0.5) * 10))
          },
          longTerm: {
            mood: Math.random() > 0.6 ? 'optimistic' : Math.random() > 0.5 ? 'cautious' : 'pessimistic',
            strength: Math.min(100, Math.max(0, prev.marketMood.longTerm.strength + (Math.random() - 0.5) * 10))
          }
        },
        newsAnalysis: prev.newsAnalysis.map(news => ({
          ...news,
          sentiment: Math.max(-1, Math.min(1, news.sentiment + (Math.random() - 0.5) * 0.2)),
          relevance: Math.min(100, Math.max(0, news.relevance + (Math.random() - 0.5) * 5))
        }))
      }));

      setVolumeProfile(prev => ({
        ...prev,
        volumeByPrice: prev.volumeByPrice.map(level => ({
          ...level,
          volume: `${(parseFloat(level.volume) + (Math.random() - 0.5) * 0.5).toFixed(1)}M`
        })),
        valueAreas: {
          high: { ...prev.valueAreas.high, volume: `${(parseFloat(prev.valueAreas.high.volume) + (Math.random() - 0.5) * 0.3).toFixed(1)}M` },
          low: { ...prev.valueAreas.low, volume: `${(parseFloat(prev.valueAreas.low.volume) + (Math.random() - 0.5) * 0.3).toFixed(1)}M` },
          poc: { ...prev.valueAreas.poc, volume: `${(parseFloat(prev.valueAreas.poc.volume) + (Math.random() - 0.5) * 0.3).toFixed(1)}M` }
        },
        volumePatterns: prev.volumePatterns.map(pattern => ({
          ...pattern,
          probability: Math.min(100, Math.max(0, pattern.probability + (Math.random() - 0.5) * 5))
        })),
        timeAnalysis: {
          ...prev.timeAnalysis,
          current: { 
            time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            volume: `${(Math.random() * 0.5 + 0.5).toFixed(1)}M`
          }
        }
      }));

      setMarketMomentum(prev => ({
        ...prev,
        momentumScores: {
          shortTerm: {
            score: Math.min(100, Math.max(0, prev.momentumScores.shortTerm.score + (Math.random() - 0.5) * 10)),
            strength: prev.momentumScores.shortTerm.score > 70 ? 'Strong' : prev.momentumScores.shortTerm.score > 40 ? 'Moderate' : 'Weak',
            direction: Math.random() > 0.7 ? (Math.random() > 0.5 ? 'up' : 'down') : prev.momentumScores.shortTerm.direction
          },
          mediumTerm: {
            score: Math.min(100, Math.max(0, prev.momentumScores.mediumTerm.score + (Math.random() - 0.5) * 10)),
            strength: prev.momentumScores.mediumTerm.score > 70 ? 'Strong' : prev.momentumScores.mediumTerm.score > 40 ? 'Moderate' : 'Weak',
            direction: Math.random() > 0.7 ? (Math.random() > 0.5 ? 'up' : 'down') : prev.momentumScores.mediumTerm.direction
          },
          longTerm: {
            score: Math.min(100, Math.max(0, prev.momentumScores.longTerm.score + (Math.random() - 0.5) * 10)),
            strength: prev.momentumScores.longTerm.score > 70 ? 'Strong' : prev.momentumScores.longTerm.score > 40 ? 'Moderate' : 'Weak',
            direction: Math.random() > 0.7 ? (Math.random() > 0.5 ? 'up' : 'down') : prev.momentumScores.longTerm.direction
          }
        },
        momentumIndicators: prev.momentumIndicators.map(indicator => ({
          ...indicator,
          value: Math.min(100, Math.max(0, indicator.value + (Math.random() - 0.5) * 8)),
          trend: Math.random() > 0.7 ? 
            (Math.random() > 0.5 ? 'rising' : Math.random() > 0.5 ? 'falling' : 'stable') : 
            indicator.trend,
          signal: Math.random() > 0.7 ?
            (Math.random() > 0.5 ? 'bullish' : Math.random() > 0.5 ? 'bearish' : 'neutral') :
            indicator.signal
        })),
        momentumDivergences: prev.momentumDivergences.map(divergence => ({
          ...divergence,
          probability: Math.min(100, Math.max(0, divergence.probability + (Math.random() - 0.5) * 5))
        }))
      }));

      setSmartMoneyFlow(prev => ({
        ...prev,
        institutionalActivity: {
          netFlow: prev.institutionalActivity.netFlow + (Math.random() - 0.5) * 200000000,
          buyVolume: prev.institutionalActivity.buyVolume + (Math.random() - 0.5) * 300000000,
          sellVolume: prev.institutionalActivity.sellVolume + (Math.random() - 0.5) * 300000000,
          flowStrength: Math.min(100, Math.max(0, prev.institutionalActivity.flowStrength + (Math.random() - 0.5) * 5))
        },
        darkpoolActivity: {
          ...prev.darkpoolActivity,
          totalVolume: `${(parseFloat(prev.darkpoolActivity.totalVolume) + (Math.random() - 0.5) * 0.5).toFixed(1)}B`,
          sentiment: Math.random() > 0.7 ? 
            (Math.random() > 0.5 ? 'bullish' : 'bearish') : 
            prev.darkpoolActivity.sentiment,
          unusualActivity: Math.random() > 0.8 ? !prev.darkpoolActivity.unusualActivity : prev.darkpoolActivity.unusualActivity
        },
        optionsActivity: {
          ...prev.optionsActivity,
          putCallRatio: Math.max(0.5, Math.min(1.5, prev.optionsActivity.putCallRatio + (Math.random() - 0.5) * 0.1)),
          impliedVolatility: {
            ...prev.optionsActivity.impliedVolatility,
            current: Math.max(10, Math.min(40, prev.optionsActivity.impliedVolatility.current + (Math.random() - 0.5) * 2)),
            trend: Math.random() > 0.7 ?
              (Math.random() > 0.5 ? 'increasing' : 'decreasing') :
              prev.optionsActivity.impliedVolatility.trend
          }
        },
        whaleActivity: {
          ...prev.whaleActivity,
          netPosition: Math.random() > 0.7 ?
            (Math.random() > 0.5 ? 'accumulating' : 'distributing') :
            prev.whaleActivity.netPosition,
          confidence: Math.min(100, Math.max(0, prev.whaleActivity.confidence + (Math.random() - 0.5) * 5))
        }
      }));

      setLastUpdate(new Date());
    } catch (error) {
      console.error('Failed to refresh data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    handleRefresh();
    const interval = setInterval(handleRefresh, 300000); // 5 minutes
    return () => clearInterval(interval);
  }, []);

  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const analysisData = useMemo(() => [
    { name: 'Professional Analysis', signal: 'Sell', conviction: 93.00 },
    { name: 'A.I. Analysis', signal: 'Buy', conviction: 81.00 },
    { name: 'Darkpool Analysis', signal: 'Sell', conviction: 58.00 },
    { name: 'Williams AD', signal: 'Sell', conviction: 100.00 },
    { name: 'Hedge Fund Strategy', signal: 'Sell', conviction: 77.00 },
    { name: 'Technical Analysis', signal: 'Sell', conviction: 68.00 },
    { name: 'Inverse Twitter Bias', signal: 'Sell', conviction: 48.00 }
  ], []);

  const renderConvictionBar = (conviction, signal) => {
    const barColor = signal === 'Buy' ? 'var(--success-main)' : 'var(--error-main)';
    return (
      <div className="conviction-bar-container">
        <div 
          className="conviction-bar" 
          style={{ 
            width: `${conviction}%`,
            backgroundColor: barColor
          }} 
        />
      </div>
    );
  };

  const renderValueWithTrend = (value, change) => {
    const isPositive = change >= 0;
    return (
      <div className="value-with-trend">
        <Typography 
          className={`card-value ${isPositive ? 'positive' : 'negative'}`}
        >
          {typeof value === 'number' ? `${value.toFixed(1)}%` : value}
        </Typography>
        <div className={`card-detail ${isPositive ? 'positive' : 'negative'}`}>
          {isPositive ? <ArrowUpward fontSize="small" /> : <ArrowDownward fontSize="small" />}
          {Math.abs(change).toFixed(1)}% today
        </div>
      </div>
    );
  };

  const indexStrength = [
    { name: 'S&P 500 (SPX)', signal: 'Sell', conviction: 80.00 },
    { name: 'Volitilty (VIX)', signal: 'Buy', conviction: 86.00 },
    { name: 'US Dollar (DXY)', signal: 'Buy', conviction: 98.00 }
  ];

  const supportResistance = {
    keyResistance: ['3950', '3970', '3978', '3990', '4004'],
    keySupport: ['3869', '3880', '3895', '3908', '3918'],
    inflectionPoint: '3970 - 3980'
  };

  const gammaLevels = {
    gammaFlip: '3975',
    gammaTotal: '-478.9M',
    gammaMagnet: '3800 -62M'
  };

  const volumeLevels = {
    highestOI: '4000',
    volumeM: ['4000', '4100'],
    volumeW: ['3940', '3960']
  };

  const renderHealthIndicator = (value, label, icon) => (
    <div className="health-indicator">
      <div className="health-header">
        <Typography className="health-label">{label}</Typography>
        {icon}
      </div>
      <LinearProgress 
        variant="determinate" 
        value={value} 
        className={`health-progress ${value >= 70 ? 'high' : value >= 40 ? 'medium' : 'low'}`}
      />
      <Typography className="health-value">{value}%</Typography>
    </div>
  );

  const marketStats = useMemo(() => [
    { label: 'SPY', value: '$428.50', change: '+1.2%', volume: '125M' },
    { label: 'QQQ', value: '$352.30', change: '+1.8%', volume: '98M' },
    { label: 'IWM', value: '$182.75', change: '-0.5%', volume: '45M' },
    { label: 'VIX', value: '18.25', change: '-5.2%', volume: '250M' }
  ], []);

  const renderTrendIndicator = (trend) => {
    const getIcon = (direction) => {
      switch (direction) {
        case 'up': return <TrendingUp className="trend-icon up" />;
        case 'down': return <TrendingDown className="trend-icon down" />;
        default: return <TrendingFlat className="trend-icon neutral" />;
      }
    };

    return (
      <div className="trend-indicator">
        <div className="trend-header">
          {getIcon(trend.direction)}
          <div className="trend-metrics">
            <div className="trend-metric">
              <span className="metric-label">Strength</span>
              <LinearProgress 
                variant="determinate" 
                value={trend.strength}
                className={`trend-progress ${trend.strength >= 70 ? 'high' : trend.strength >= 40 ? 'medium' : 'low'}`}
              />
              <span className="metric-value">{trend.strength}%</span>
            </div>
            <div className="trend-metric">
              <span className="metric-label">Momentum</span>
              <LinearProgress 
                variant="determinate" 
                value={trend.momentum}
                className={`trend-progress ${trend.momentum >= 70 ? 'high' : trend.momentum >= 40 ? 'medium' : 'low'}`}
              />
              <span className="metric-value">{trend.momentum}%</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const formatVolume = (volume) => {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(volume);
  };

  const renderCorrelationStrength = (value) => {
    const absValue = Math.abs(value);
    let color = 'neutral';
    if (absValue >= 0.7) color = 'strong';
    else if (absValue >= 0.4) color = 'moderate';
    else color = 'weak';

    return (
      <div className={`correlation-indicator ${color}`}>
        <div className="correlation-bar" style={{ width: `${absValue * 100}%` }} />
        <span className="correlation-value">{(value * 100).toFixed(1)}%</span>
      </div>
    );
  };

  const renderSectorIndicator = (sector) => {
    const trendIcon = sector.trend === 'up' ? 
      <TrendingUp className="sector-trend up" /> : 
      <TrendingDown className="sector-trend down" />;

    return (
      <div className="sector-indicator">
        <div className="sector-header">
          <Typography className="sector-name">{sector.name}</Typography>
          {trendIcon}
        </div>
        <div className="sector-metrics">
          <div className="sector-performance">
            <Typography 
              className={`performance-value ${sector.performance >= 0 ? 'positive' : 'negative'}`}
            >
              {sector.performance >= 0 ? '+' : ''}{sector.performance.toFixed(1)}%
            </Typography>
          </div>
          <div className="sector-momentum">
            <LinearProgress 
              variant="determinate" 
              value={sector.momentum}
              className={`momentum-progress ${
                sector.momentum >= 70 ? 'high' : 
                sector.momentum >= 40 ? 'medium' : 'low'
              }`}
            />
          </div>
        </div>
        <Typography className="sector-volume">Vol: {sector.volume}</Typography>
      </div>
    );
  };

  const renderBreadthIndicator = (indicator) => {
    const getTrendIcon = (trend) => {
      switch (trend) {
        case 'rising': return <TrendingUp className="breadth-trend rising" />;
        case 'falling': return <TrendingDown className="breadth-trend falling" />;
        default: return <TrendingFlat className="breadth-trend stable" />;
      }
    };

    return (
      <div className="breadth-indicator">
        <div className="breadth-header">
          <Typography className="breadth-name">{indicator.name}</Typography>
          {getTrendIcon(indicator.trend)}
        </div>
        <Typography className="breadth-value">
          {typeof indicator.value === 'number' ? indicator.value.toFixed(1) : indicator.value}
        </Typography>
      </div>
    );
  };

  const renderRiskGauge = (value, type) => (
    <div className="risk-gauge">
      <div className="gauge-header">
        <Typography className="gauge-label">{type}</Typography>
        <Typography className="gauge-value">{value.toFixed(1)}</Typography>
      </div>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, (value / 30) * 100)}
        className={`gauge-progress ${
          value >= 25 ? 'high' : value >= 15 ? 'medium' : 'low'
        }`}
      />
    </div>
  );

  const renderInternalMetric = (label, value, type = 'number') => (
    <div className="internal-metric">
      <Typography className="metric-label">{label}</Typography>
      <Typography className={`metric-value ${
        type === 'ratio' ? 
          (parseFloat(value) > 1 ? 'positive' : parseFloat(value) < 1 ? 'negative' : 'neutral') :
          (parseFloat(value) > 0 ? 'positive' : parseFloat(value) < 0 ? 'negative' : 'neutral')
      }`}>
        {typeof value === 'number' ? value.toFixed(2) : value}
      </Typography>
    </div>
  );

  const renderTechnicalIndicator = (indicator) => {
    const getSignalColor = (signal) => {
      switch (signal.toLowerCase()) {
        case 'bullish': return 'success';
        case 'bearish': return 'error';
        default: return 'warning';
      }
    };

    const getTrendIcon = (trend) => {
      switch (trend) {
        case 'rising': return <TrendingUp className="trend-icon rising" />;
        case 'falling': return <TrendingDown className="trend-icon falling" />;
        default: return <TrendingFlat className="trend-icon stable" />;
      }
    };

    return (
      <div className="technical-indicator">
        <div className="indicator-header">
          <Typography className="indicator-name">{indicator.name}</Typography>
          <Chip 
            label={indicator.signal}
            size="small"
            color={getSignalColor(indicator.signal)}
          />
        </div>
        <div className="indicator-details">
          <Typography className="indicator-value">
            {indicator.value.toFixed(1)}
          </Typography>
          {getTrendIcon(indicator.trend)}
        </div>
      </div>
    );
  };

  const renderSentimentIndicator = (indicator) => (
    <div className="sentiment-indicator">
      <div className="indicator-header">
        <Typography className="indicator-name">{indicator.name}</Typography>
        <Chip 
          label={indicator.bias}
          size="small"
          color={indicator.bias === 'bullish' ? 'success' : indicator.bias === 'bearish' ? 'error' : 'warning'}
        />
      </div>
      <LinearProgress
        variant="determinate"
        value={indicator.value}
        className={`sentiment-progress ${
          indicator.value >= 70 ? 'high' :
          indicator.value >= 40 ? 'medium' : 'low'
        }`}
      />
      <div className="indicator-details">
        <Typography className="sentiment-value">{indicator.value}%</Typography>
        <Typography className="confidence-value">
          Confidence: {indicator.confidence}%
        </Typography>
      </div>
    </div>
  );

  const renderVolumeLevel = (level) => (
    <div className={`volume-level ${level.type}`}>
      <div className="level-header">
        <Typography className="price-label">${level.price}</Typography>
        <Typography className="volume-value">{level.volume}</Typography>
      </div>
      <LinearProgress
        variant="determinate"
        value={(parseFloat(level.volume) / 5) * 100}
        className={`volume-progress ${level.type}`}
      />
    </div>
  );

  const renderMomentumScore = (timeframe, data) => (
    <div className="momentum-score">
      <div className="score-header">
        <Typography className="timeframe-label">{timeframe}</Typography>
        <Chip
          label={data.strength}
          size="small"
          color={data.strength === 'Strong' ? 'success' : data.strength === 'Moderate' ? 'warning' : 'error'}
        />
      </div>
      <LinearProgress
        variant="determinate"
        value={data.score}
        className={`momentum-progress ${
          data.score >= 70 ? 'high' :
          data.score >= 40 ? 'medium' : 'low'
        }`}
      />
      <div className="score-details">
        <Typography className="score-value">{data.score}%</Typography>
        {data.direction === 'up' ? 
          <TrendingUp className="direction-icon up" /> :
          <TrendingDown className="direction-icon down" />
        }
      </div>
    </div>
  );

  const renderSmartMoneyMetric = (label, value, type = 'number') => (
    <div className="smart-money-metric">
      <Typography className="metric-label">{label}</Typography>
      <Typography className={`metric-value ${
        type === 'flow' ? 
          (value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral') :
          ''
      }`}>
        {type === 'flow' ? 
          `${value >= 0 ? '+' : ''}${(value / 1000000).toFixed(1)}M` :
          value
        }
      </Typography>
    </div>
  );

  return (
    <div className="dashboard-page">
      <div className="dashboard-content">
        <div className="dashboard-header">
          <div className="timeframe-selector">
            {timeframes.map((tf) => (
              <button
                key={tf}
                className={`timeframe-btn ${timeframe === tf ? 'active' : ''}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
          <div className="dashboard-actions">
            <Typography variant="caption" color="textSecondary" sx={{ mr: 2 }}>
              Last update: {formatTime(lastUpdate)}
            </Typography>
            <Tooltip title="Refresh data">
              <IconButton 
                onClick={handleRefresh} 
                disabled={isLoading}
                className="refresh-button"
              >
                {isLoading ? (
                  <CircularProgress size={20} />
                ) : (
                  <Refresh />
                )}
              </IconButton>
            </Tooltip>
          </div>
        </div>

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6} lg={3}>
            <Card className="dashboard-card">
              <div className="card-header">
                <div>
                  <Typography className="card-title">
                    Market Sentiment
                    <Tooltip title="Overall market mood based on social media, news, and analyst ratings">
                      <Info fontSize="small" sx={{ opacity: 0.7 }} />
                    </Tooltip>
                  </Typography>
                  <Typography className="card-description">
                    Overall market mood based on analysis
                  </Typography>
                </div>
              </div>
              {renderValueWithTrend(data.marketSentiment.value, data.marketSentiment.change)}
              <Divider sx={{ my: 2 }} />
              <div className="card-details">
                <div className="detail-item">
                  <Typography className="detail-label">Social</Typography>
                  <Typography className="detail-value positive">+82%</Typography>
                </div>
                <div className="detail-item">
                  <Typography className="detail-label">News</Typography>
                  <Typography className="detail-value positive">+68%</Typography>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} sm={6} lg={3}>
            <Card className="dashboard-card">
              <div className="card-header">
                <div>
                  <Typography className="card-title">
                    Smart Money Flow
                    <Tooltip title="Tracks institutional trading patterns and dark pool activity">
                      <Info fontSize="small" sx={{ opacity: 0.7 }} />
                    </Tooltip>
                  </Typography>
                  <Typography className="card-description">
                    Institutional trading activity
                  </Typography>
                </div>
              </div>
              {renderValueWithTrend(data.smartMoneyFlow.value, data.smartMoneyFlow.change)}
              <Divider sx={{ my: 2 }} />
              <div className="card-details">
                <div className="detail-item">
                  <Typography className="detail-label">Volume</Typography>
                  <Typography className="detail-value negative">-8%</Typography>
                </div>
                <div className="detail-item">
                  <Typography className="detail-label">Options</Typography>
                  <Typography className="detail-value negative">-22%</Typography>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} sm={6} lg={3}>
            <Card className="dashboard-card">
              <div className="card-header">
                <div>
                  <Typography className="card-title">
                    Technical Score
                    <Tooltip title="Aggregate score based on multiple technical indicators">
                      <Info fontSize="small" sx={{ opacity: 0.7 }} />
                    </Tooltip>
                  </Typography>
                  <Typography className="card-description">
                    Overall technical analysis score
                  </Typography>
                </div>
              </div>
              {renderValueWithTrend(data.technicalScore.value, data.technicalScore.change)}
              <Divider sx={{ my: 2 }} />
              <div className="card-details">
                <div className="detail-item">
                  <Typography className="detail-label">RSI</Typography>
                  <Typography className="detail-value positive">65</Typography>
                </div>
                <div className="detail-item">
                  <Typography className="detail-label">MACD</Typography>
                  <Typography className="detail-value positive">Bullish</Typography>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} sm={6} lg={3}>
            <Card className="dashboard-card">
              <div className="card-header">
                <div>
                  <Typography className="card-title">
                    Signal Strength
                    <Tooltip title="Overall trading signal confidence based on multiple factors">
                      <Info fontSize="small" sx={{ opacity: 0.7 }} />
                    </Tooltip>
                  </Typography>
                  <Typography className="card-description">
                    Overall trading signal power
                  </Typography>
                </div>
              </div>
              {renderValueWithTrend(data.signalStrength.value, data.signalStrength.change)}
              <Divider sx={{ my: 2 }} />
              <div className="card-details">
                <div className="detail-item">
                  <Typography className="detail-label">Confidence</Typography>
                  <Typography className="detail-value positive">High</Typography>
                </div>
                <div className="detail-item">
                  <Typography className="detail-label">Trend</Typography>
                  <Typography className="detail-value positive">Strong</Typography>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card className="dashboard-card">
              <div className="card-header">
                <Typography className="card-title">
                  Analysis Overview
                  <Tooltip title="Comprehensive analysis from multiple sources">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Analysis Type</TableCell>
                      <TableCell align="center">Signal</TableCell>
                      <TableCell>Conviction</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {analysisData.map((row) => (
                      <TableRow key={row.name}>
                        <TableCell>{row.name}</TableCell>
                        <TableCell align="center">
                          <Chip 
                            label={row.signal}
                            color={row.signal === 'Buy' ? 'success' : 'error'}
                            size="small"
                          />
                        </TableCell>
                        <TableCell style={{ width: '40%' }}>
                          {renderConvictionBar(row.conviction, row.signal)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card className="dashboard-card market-health-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Health Overview
                  <Tooltip title="Comprehensive market health indicators">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="health-indicators-grid">
                {renderHealthIndicator(marketHealth.overall, 'Overall Health', <Speed />)}
                {renderHealthIndicator(marketHealth.momentum, 'Momentum', <TrendingUp />)}
                {renderHealthIndicator(marketHealth.volatility, 'Volatility', <ShowChartOutlined />)}
                {renderHealthIndicator(marketHealth.trend, 'Trend Strength', <StackedLineChart />)}
                {renderHealthIndicator(marketHealth.volume, 'Volume Rating', <BarChart />)}
              </div>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card className="dashboard-card market-stats-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Statistics
                  <Tooltip title="Real-time market statistics">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="market-stats-grid">
                {marketStats.map((stat, index) => (
                  <div key={index} className="market-stat-item">
                    <div className="stat-header">
                      <Typography className="stat-label">{stat.label}</Typography>
                      <AttachMoney className="stat-icon" />
                    </div>
                    <Typography className="stat-value">{stat.value}</Typography>
                    <div className="stat-details">
                      <Typography 
                        className={`stat-change ${stat.change.startsWith('+') ? 'positive' : 'negative'}`}
                      >
                        {stat.change}
                      </Typography>
                      <Typography className="stat-volume">Vol: {stat.volume}</Typography>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card className="dashboard-card trend-analysis-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Trend Analysis
                  <Tooltip title="Multi-timeframe trend analysis with strength and momentum indicators">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="trends-grid">
                <div className="trend-section">
                  <Typography className="trend-title">Short Term (1-3 Days)</Typography>
                  {renderTrendIndicator(trendAnalysis.shortTerm)}
                </div>
                <div className="trend-section">
                  <Typography className="trend-title">Medium Term (1-2 Weeks)</Typography>
                  {renderTrendIndicator(trendAnalysis.mediumTerm)}
                </div>
                <div className="trend-section">
                  <Typography className="trend-title">Long Term (1-3 Months)</Typography>
                  {renderTrendIndicator(trendAnalysis.longTerm)}
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card className="dashboard-card options-flow-card">
              <div className="card-header">
                <Typography className="card-title">
                  Options Flow Analysis
                  <Tooltip title="Real-time options flow and unusual activity">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="options-content">
                <div className="options-summary">
                  <div className="summary-item">
                    <div className="summary-header">
                      <CallMade className="summary-icon call" />
                      <Typography className="summary-label">Call Volume</Typography>
                    </div>
                    <Typography className="summary-value call">
                      {formatVolume(optionsFlow.callVolume)}
                    </Typography>
                  </div>
                  <div className="summary-item">
                    <div className="summary-header">
                      <CallReceived className="summary-icon put" />
                      <Typography className="summary-label">Put Volume</Typography>
                    </div>
                    <Typography className="summary-value put">
                      {formatVolume(optionsFlow.putVolume)}
                    </Typography>
                  </div>
                  <div className="summary-item">
                    <div className="summary-header">
                      <MonetizationOn className="summary-icon" />
                      <Typography className="summary-label">Put/Call Ratio</Typography>
                    </div>
                    <Typography className="summary-value">
                      {optionsFlow.putCallRatio.toFixed(2)}
                    </Typography>
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="unusual-activity">
                  <Typography className="section-subtitle">
                    Unusual Options Activity
                  </Typography>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Strike</TableCell>
                          <TableCell>Type</TableCell>
                          <TableCell>Volume</TableCell>
                          <TableCell>Premium</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {optionsFlow.unusualActivity.map((activity, index) => (
                          <TableRow key={index}>
                            <TableCell>{activity.strike}</TableCell>
                            <TableCell>
                              <Chip 
                                label={activity.type}
                                color={activity.type === 'CALL' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell>{activity.volume}</TableCell>
                            <TableCell>{activity.premium}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card correlation-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Correlations
                  <Tooltip title="Real-time correlation analysis between major assets">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="correlations-content">
                {correlations.pairs.map((pair, index) => (
                  <div key={index} className="correlation-item">
                    <div className="correlation-pair">
                      <Typography className="pair-label">{pair.pair}</Typography>
                      <Chip 
                        label={pair.trend}
                        size="small"
                        className={`trend-chip ${pair.trend}`}
                      />
                    </div>
                    {renderCorrelationStrength(pair.value)}
                  </div>
                ))}
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card sector-card">
              <div className="card-header">
                <Typography className="card-title">
                  Sector Performance
                  <Tooltip title="Real-time sector performance and momentum">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="sectors-grid">
                {sectorPerformance.sectors.map((sector, index) => (
                  <div key={index} className="sector-item">
                    {renderSectorIndicator(sector)}
                  </div>
                ))}
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card breadth-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Breadth Analysis
                  <Tooltip title="Comprehensive market breadth indicators and statistics">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="breadth-content">
                <div className="breadth-summary">
                  <div className="summary-row">
                    <div className="summary-item">
                      <Typography className="summary-label">Advancing</Typography>
                      <Typography className="summary-value positive">
                        {marketBreadth.advanceDecline.advancing}
                      </Typography>
                    </div>
                    <div className="summary-item">
                      <Typography className="summary-label">Declining</Typography>
                      <Typography className="summary-value negative">
                        {marketBreadth.advanceDecline.declining}
                      </Typography>
                    </div>
                    <div className="summary-item">
                      <Typography className="summary-label">Unchanged</Typography>
                      <Typography className="summary-value">
                        {marketBreadth.advanceDecline.unchanged}
                      </Typography>
                    </div>
                  </div>
                  <div className="summary-row">
                    <div className="summary-item">
                      <Typography className="summary-label">New Highs</Typography>
                      <Typography className="summary-value positive">
                        {marketBreadth.newHighsLows.newHighs}
                      </Typography>
                    </div>
                    <div className="summary-item">
                      <Typography className="summary-label">New Lows</Typography>
                      <Typography className="summary-value negative">
                        {marketBreadth.newHighsLows.newLows}
                      </Typography>
                    </div>
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="breadth-indicators">
                  {marketBreadth.breadthIndicators.map((indicator, index) => (
                    <div key={index} className="indicator-item">
                      {renderBreadthIndicator(indicator)}
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card risk-metrics-card">
              <div className="card-header">
                <Typography className="card-title">
                  Risk Metrics Overview
                  <Tooltip title="Comprehensive risk analysis and volatility metrics">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="risk-content">
                <div className="volatility-section">
                  <Typography className="section-subtitle">Volatility Gauge</Typography>
                  <div className="volatility-gauges">
                    {renderRiskGauge(riskMetrics.volatilityGauge.current, 'Current')}
                    {renderRiskGauge(riskMetrics.volatilityGauge.implied, 'Implied')}
                    {renderRiskGauge(riskMetrics.volatilityGauge.historical, 'Historical')}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="risk-indicators">
                  <Typography className="section-subtitle">Risk Indicators</Typography>
                  <div className="indicators-grid">
                    <div className="risk-item">
                      <Typography className="risk-label">Market Risk</Typography>
                      <LinearProgress
                        variant="determinate"
                        value={riskMetrics.riskIndicators.marketRisk}
                        className={`risk-progress ${
                          riskMetrics.riskIndicators.marketRisk >= 70 ? 'high' :
                          riskMetrics.riskIndicators.marketRisk >= 40 ? 'medium' : 'low'
                        }`}
                      />
                      <Typography className="risk-value">
                        {riskMetrics.riskIndicators.marketRisk}%
                      </Typography>
                    </div>
                    <div className="risk-item">
                      <Typography className="risk-label">Sector Risk</Typography>
                      <LinearProgress
                        variant="determinate"
                        value={riskMetrics.riskIndicators.sectorRisk}
                        className={`risk-progress ${
                          riskMetrics.riskIndicators.sectorRisk >= 70 ? 'high' :
                          riskMetrics.riskIndicators.sectorRisk >= 40 ? 'medium' : 'low'
                        }`}
                      />
                      <Typography className="risk-value">
                        {riskMetrics.riskIndicators.sectorRisk}%
                      </Typography>
                    </div>
                    <div className="risk-item">
                      <Typography className="risk-label">Systematic Risk</Typography>
                      <LinearProgress
                        variant="determinate"
                        value={riskMetrics.riskIndicators.systematicRisk}
                        className={`risk-progress ${
                          riskMetrics.riskIndicators.systematicRisk >= 70 ? 'high' :
                          riskMetrics.riskIndicators.systematicRisk >= 40 ? 'medium' : 'low'
                        }`}
                      />
                      <Typography className="risk-value">
                        {riskMetrics.riskIndicators.systematicRisk}%
                      </Typography>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card internals-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Internals Analysis
                  <Tooltip title="Detailed market internals and breadth analysis">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="internals-content">
                <div className="internals-section">
                  <Typography className="section-subtitle">Tick Analysis</Typography>
                  <div className="metrics-grid">
                    {renderInternalMetric('Upticks', marketInternals.tickData.upticks)}
                    {renderInternalMetric('Downticks', marketInternals.tickData.downticks)}
                    {renderInternalMetric('Tick Ratio', marketInternals.tickData.tickRatio, 'ratio')}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="internals-section">
                  <Typography className="section-subtitle">Volume Analysis</Typography>
                  <div className="metrics-grid">
                    {renderInternalMetric('Up Volume', marketInternals.volumeAnalysis.upVolume)}
                    {renderInternalMetric('Down Volume', marketInternals.volumeAnalysis.downVolume)}
                    {renderInternalMetric('Volume Ratio', marketInternals.volumeAnalysis.volumeRatio, 'ratio')}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="internals-section">
                  <Typography className="section-subtitle">Sector Internals</Typography>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Sector</TableCell>
                          <TableCell>Breadth</TableCell>
                          <TableCell>Volume</TableCell>
                          <TableCell>Momentum</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {marketInternals.sectorInternals.map((sector, index) => (
                          <TableRow key={index}>
                            <TableCell>{sector.name}</TableCell>
                            <TableCell>
                              <Typography className={`table-value ${
                                sector.breadth > 1 ? 'positive' : 'negative'
                              }`}>
                                {sector.breadth.toFixed(2)}
                              </Typography>
                            </TableCell>
                            <TableCell>{sector.volume}</TableCell>
                            <TableCell>
                              <LinearProgress
                                variant="determinate"
                                value={sector.momentum}
                                className={`momentum-progress ${
                                  sector.momentum >= 70 ? 'high' :
                                  sector.momentum >= 40 ? 'medium' : 'low'
                                }`}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card technical-signals-card">
              <div className="card-header">
                <Typography className="card-title">
                  Technical Signals Overview
                  <Tooltip title="Comprehensive technical analysis signals and patterns">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="technical-content">
                <div className="technical-section">
                  <Typography className="section-subtitle">Primary Trends</Typography>
                  <div className="trends-grid">
                    {Object.entries(technicalSignals.primaryTrends).map(([timeframe, data]) => (
                      <div key={timeframe} className="trend-item">
                        <Typography className="trend-timeframe">
                          {timeframe.replace(/([A-Z])/g, ' $1').trim()}
                        </Typography>
                        <Chip 
                          label={data.signal}
                          size="small"
                          color={data.signal === 'bullish' ? 'success' : data.signal === 'bearish' ? 'error' : 'warning'}
                          className="trend-signal"
                        />
                        <div className="trend-metrics">
                          <div className="trend-metric">
                            <Typography className="metric-label">Strength</Typography>
                            <LinearProgress
                              variant="determinate"
                              value={data.strength}
                              className={`trend-progress ${
                                data.strength >= 70 ? 'high' :
                                data.strength >= 40 ? 'medium' : 'low'
                              }`}
                            />
                          </div>
                          <div className="trend-metric">
                            <Typography className="metric-label">Momentum</Typography>
                            <LinearProgress
                              variant="determinate"
                              value={data.momentum}
                              className={`trend-progress ${
                                data.momentum >= 70 ? 'high' :
                                data.momentum >= 40 ? 'medium' : 'low'
                              }`}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="technical-section">
                  <Typography className="section-subtitle">Key Indicators</Typography>
                  <div className="indicators-grid">
                    {technicalSignals.keyIndicators.map((indicator, index) => (
                      <div key={index} className="indicator-item">
                        {renderTechnicalIndicator(indicator)}
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="technical-section">
                  <Typography className="section-subtitle">Price Patterns</Typography>
                  <div className="patterns-grid">
                    {technicalSignals.pricePatterns.map((pattern, index) => (
                      <div key={index} className="pattern-item">
                        <div className="pattern-header">
                          <Typography className="pattern-name">{pattern.pattern}</Typography>
                          <Chip 
                            label={pattern.timeframe}
                            size="small"
                            className="pattern-timeframe"
                          />
                        </div>
                        <LinearProgress
                          variant="determinate"
                          value={pattern.probability}
                          className={`pattern-progress ${
                            pattern.probability >= 70 ? 'high' :
                            pattern.probability >= 40 ? 'medium' : 'low'
                          }`}
                        />
                        <Typography className="pattern-probability">
                          {pattern.probability}% Probability
                        </Typography>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card sentiment-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Sentiment Analysis
                  <Tooltip title="Comprehensive market sentiment indicators and analysis">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="sentiment-content">
                <div className="fear-greed-section">
                  <Typography className="section-subtitle">Fear & Greed Index</Typography>
                  <div className="fear-greed-indicator">
                    <div className="gauge-container">
                      <CircularProgress
                        variant="determinate"
                        value={marketSentiment.fearGreedIndex.value}
                        className={`fear-greed-gauge ${
                          marketSentiment.fearGreedIndex.value >= 70 ? 'extreme-greed' :
                          marketSentiment.fearGreedIndex.value >= 50 ? 'greed' :
                          marketSentiment.fearGreedIndex.value >= 30 ? 'fear' : 'extreme-fear'
                        }`}
                      />
                      <Typography className="gauge-value">
                        {marketSentiment.fearGreedIndex.value}
                      </Typography>
                    </div>
                    <div className="gauge-details">
                      <Typography className="interpretation">
                        {marketSentiment.fearGreedIndex.interpretation}
                      </Typography>
                      <Typography className={`change-value ${
                        marketSentiment.fearGreedIndex.change >= 0 ? 'positive' : 'negative'
                      }`}>
                        {marketSentiment.fearGreedIndex.change >= 0 ? '+' : ''}
                        {marketSentiment.fearGreedIndex.change.toFixed(1)}
                      </Typography>
                    </div>
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="sentiment-indicators">
                  <Typography className="section-subtitle">Sentiment Indicators</Typography>
                  <div className="indicators-grid">
                    {marketSentiment.sentimentIndicators.map((indicator, index) => (
                      <div key={index} className="indicator-item">
                        {renderSentimentIndicator(indicator)}
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="news-sentiment">
                  <Typography className="section-subtitle">News Sentiment Analysis</Typography>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Source</TableCell>
                          <TableCell>Sentiment</TableCell>
                          <TableCell>Impact</TableCell>
                          <TableCell>Relevance</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {marketSentiment.newsAnalysis.map((news, index) => (
                          <TableRow key={index}>
                            <TableCell>{news.source}</TableCell>
                            <TableCell>
                              <Typography className={`sentiment-value ${
                                news.sentiment > 0.6 ? 'positive' :
                                news.sentiment < 0.4 ? 'negative' : 'neutral'
                              }`}>
                                {(news.sentiment * 100).toFixed(0)}%
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Chip
                                label={news.impact}
                                size="small"
                                className={`impact-chip ${news.impact}`}
                              />
                            </TableCell>
                            <TableCell>
                              <LinearProgress
                                variant="determinate"
                                value={news.relevance}
                                className={`relevance-progress ${
                                  news.relevance >= 70 ? 'high' :
                                  news.relevance >= 40 ? 'medium' : 'low'
                                }`}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card volume-profile-card">
              <div className="card-header">
                <Typography className="card-title">
                  Volume Profile Overview
                  <Tooltip title="Detailed volume analysis and price levels">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="volume-content">
                <div className="volume-levels">
                  <Typography className="section-subtitle">Volume by Price</Typography>
                  <div className="levels-container">
                    {volumeProfile.volumeByPrice.map((level, index) => (
                      <div key={index} className="level-item">
                        {renderVolumeLevel(level)}
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="value-areas">
                  <Typography className="section-subtitle">Value Areas</Typography>
                  <div className="areas-grid">
                    <div className="area-item">
                      <Typography className="area-label">Value Area High</Typography>
                      <Typography className="area-price">${volumeProfile.valueAreas.high.price}</Typography>
                      <Typography className="area-volume">{volumeProfile.valueAreas.high.volume}</Typography>
                    </div>
                    <div className="area-item">
                      <Typography className="area-label">Point of Control</Typography>
                      <Typography className="area-price">${volumeProfile.valueAreas.poc.price}</Typography>
                      <Typography className="area-volume">{volumeProfile.valueAreas.poc.volume}</Typography>
                    </div>
                    <div className="area-item">
                      <Typography className="area-label">Value Area Low</Typography>
                      <Typography className="area-price">${volumeProfile.valueAreas.low.price}</Typography>
                      <Typography className="area-volume">{volumeProfile.valueAreas.low.volume}</Typography>
                    </div>
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="volume-patterns">
                  <Typography className="section-subtitle">Volume Patterns</Typography>
                  <div className="patterns-grid">
                    {volumeProfile.volumePatterns.map((pattern, index) => (
                      <div key={index} className="pattern-item">
                        <div className="pattern-header">
                          <Typography className="pattern-name">{pattern.pattern}</Typography>
                          <Chip
                            label={pattern.significance}
                            size="small"
                            className={`significance-chip ${pattern.significance}`}
                          />
                        </div>
                        <LinearProgress
                          variant="determinate"
                          value={pattern.probability}
                          className={`pattern-progress ${
                            pattern.probability >= 70 ? 'high' :
                            pattern.probability >= 40 ? 'medium' : 'low'
                          }`}
                        />
                        <Typography className="pattern-probability">
                          {pattern.probability}% Probability
                        </Typography>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card momentum-card">
              <div className="card-header">
                <Typography className="card-title">
                  Market Momentum Analysis
                  <Tooltip title="Multi-timeframe momentum analysis with key levels and divergences">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="momentum-content">
                <div className="momentum-scores">
                  <Typography className="section-subtitle">Momentum Scores</Typography>
                  <div className="scores-grid">
                    {Object.entries(marketMomentum.momentumScores).map(([timeframe, data]) => (
                      <div key={timeframe} className="score-item">
                        {renderMomentumScore(
                          timeframe.replace(/([A-Z])/g, ' $1').trim(),
                          data
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="momentum-indicators">
                  <Typography className="section-subtitle">Momentum Indicators</Typography>
                  <div className="indicators-grid">
                    {marketMomentum.momentumIndicators.map((indicator, index) => (
                      <div key={index} className="indicator-item">
                        <div className="indicator-header">
                          <Typography className="indicator-name">{indicator.name}</Typography>
                          <Chip
                            label={indicator.signal}
                            size="small"
                            color={indicator.signal === 'bullish' ? 'success' : indicator.signal === 'bearish' ? 'error' : 'warning'}
                          />
                        </div>
                        <LinearProgress
                          variant="determinate"
                          value={indicator.value}
                          className={`momentum-progress ${
                            indicator.value >= 70 ? 'high' :
                            indicator.value >= 40 ? 'medium' : 'low'
                          }`}
                        />
                        <div className="indicator-details">
                          <Typography className="indicator-value">{indicator.value}%</Typography>
                          <Typography className={`trend-label ${indicator.trend}`}>
                            {indicator.trend}
                          </Typography>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="momentum-divergences">
                  <Typography className="section-subtitle">Momentum Divergences</Typography>
                  <div className="divergences-grid">
                    {marketMomentum.momentumDivergences.map((divergence, index) => (
                      <div key={index} className="divergence-item">
                        <div className="divergence-header">
                          <Typography className="divergence-type">{divergence.type}</Typography>
                          <Chip
                            label={divergence.timeframe}
                            size="small"
                            className="timeframe-chip"
                          />
                        </div>
                        <LinearProgress
                          variant="determinate"
                          value={divergence.probability}
                          className={`divergence-progress ${
                            divergence.probability >= 70 ? 'high' :
                            divergence.probability >= 40 ? 'medium' : 'low'
                          }`}
                        />
                        <div className="divergence-details">
                          <Typography className="probability-value">
                            {divergence.probability}% Probability
                          </Typography>
                          <Chip
                            label={divergence.confidence}
                            size="small"
                            className={`confidence-chip ${divergence.confidence}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card className="dashboard-card smart-money-card">
              <div className="card-header">
                <Typography className="card-title">
                  Smart Money Flow Overview
                  <Tooltip title="Analysis of institutional activity, dark pool trading, and whale movements">
                    <Info fontSize="small" sx={{ opacity: 0.7 }} />
                  </Tooltip>
                </Typography>
              </div>
              <div className="smart-money-content">
                <div className="institutional-activity">
                  <Typography className="section-subtitle">Institutional Activity</Typography>
                  <div className="metrics-grid">
                    {renderSmartMoneyMetric('Net Flow', smartMoneyFlow.institutionalActivity.netFlow, 'flow')}
                    {renderSmartMoneyMetric('Buy Volume', formatVolume(smartMoneyFlow.institutionalActivity.buyVolume))}
                    {renderSmartMoneyMetric('Sell Volume', formatVolume(smartMoneyFlow.institutionalActivity.sellVolume))}
                  </div>
                  <LinearProgress
                    variant="determinate"
                    value={smartMoneyFlow.institutionalActivity.flowStrength}
                    className={`flow-strength-progress ${
                      smartMoneyFlow.institutionalActivity.flowStrength >= 70 ? 'high' :
                      smartMoneyFlow.institutionalActivity.flowStrength >= 40 ? 'medium' : 'low'
                    }`}
                  />
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="darkpool-activity">
                  <Typography className="section-subtitle">Dark Pool Activity</Typography>
                  <div className="darkpool-header">
                    <div className="volume-info">
                      <Typography className="volume-label">Total Volume</Typography>
                      <Typography className="volume-value">{smartMoneyFlow.darkpoolActivity.totalVolume}</Typography>
                    </div>
                    <div className="sentiment-info">
                      <Chip
                        label={smartMoneyFlow.darkpoolActivity.sentiment}
                        size="small"
                        color={smartMoneyFlow.darkpoolActivity.sentiment === 'bullish' ? 'success' : 'error'}
                        className="sentiment-chip"
                      />
                      {smartMoneyFlow.darkpoolActivity.unusualActivity && (
                        <Chip
                          label="Unusual Activity"
                          size="small"
                          color="warning"
                          className="activity-chip"
                        />
                      )}
                    </div>
                  </div>
                  <div className="significant-levels">
                    {smartMoneyFlow.darkpoolActivity.significantLevels.map((level, index) => (
                      <div key={index} className="level-item">
                        <div className="level-header">
                          <Typography className="price-label">${level.price}</Typography>
                          <Typography className="volume-label">{level.volume}</Typography>
                        </div>
                        <LinearProgress
                          variant="determinate"
                          value={(parseFloat(level.volume) / 500) * 100}
                          className={`level-progress ${level.type}`}
                        />
                        <Typography className="level-type">
                          {level.type.charAt(0).toUpperCase() + level.type.slice(1)}
                        </Typography>
                      </div>
                    ))}
                  </div>
                </div>
                <Divider sx={{ my: 2 }} />
                <div className="whale-activity">
                  <Typography className="section-subtitle">Whale Activity</Typography>
                  <div className="whale-header">
                    <div className="position-info">
                      <Typography className="position-label">Net Position</Typography>
                      <Chip
                        label={smartMoneyFlow.whaleActivity.netPosition}
                        size="small"
                        color={smartMoneyFlow.whaleActivity.netPosition === 'accumulating' ? 'success' : 'error'}
                        className="position-chip"
                      />
                    </div>
                    <div className="confidence-info">
                      <Typography className="confidence-label">Confidence</Typography>
                      <LinearProgress
                        variant="determinate"
                        value={smartMoneyFlow.whaleActivity.confidence}
                        className={`confidence-progress ${
                          smartMoneyFlow.whaleActivity.confidence >= 70 ? 'high' :
                          smartMoneyFlow.whaleActivity.confidence >= 40 ? 'medium' : 'low'
                        }`}
                      />
                    </div>
                  </div>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Type</TableCell>
                          <TableCell>Amount</TableCell>
                          <TableCell>Time</TableCell>
                          <TableCell>Impact</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {smartMoneyFlow.whaleActivity.recentMoves.map((move, index) => (
                          <TableRow key={index}>
                            <TableCell>
                              <Typography className={`move-type ${move.type}`}>
                                {move.type.toUpperCase()}
                              </Typography>
                            </TableCell>
                            <TableCell>{move.amount}</TableCell>
                            <TableCell>{move.time}</TableCell>
                            <TableCell>
                              <Chip
                                label={move.impact}
                                size="small"
                                className={`impact-chip ${move.impact}`}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </div>
              </div>
            </Card>
          </Grid>
        </Grid>

        <div className="dashboard-grid">
          <div className="dashboard-panel large glow-effect">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Market Overview</h2>
                <Tooltip title="Real-time market overview across major indices">
                  <Info fontSize="small" sx={{ ml: 1, opacity: 0.7 }} />
                </Tooltip>
              </div>
              <Timeline />
            </div>
            <div className="conviction-bars">
              <div className="conviction-bar-container">
                <div className="conviction-header">
                  <h3>SPY</h3>
                  <span className="conviction-value positive">+2.45%</span>
                </div>
                <div className="conviction-bar positive" style={{ width: '75%' }}></div>
              </div>
              <div className="conviction-bar-container">
                <div className="conviction-header">
                  <h3>QQQ</h3>
                  <span className="conviction-value positive">+3.12%</span>
                </div>
                <div className="conviction-bar positive" style={{ width: '82%' }}></div>
              </div>
              <div className="conviction-bar-container">
                <div className="conviction-header">
                  <h3>IWM</h3>
                  <span className="conviction-value negative">-1.23%</span>
                </div>
                <div className="conviction-bar negative" style={{ width: '45%' }}></div>
              </div>
            </div>
          </div>

          <div className="dashboard-panel medium glow-effect">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Smart Money Flow</h2>
                <Tooltip title="Track institutional trading patterns and dark pool activity">
                  <Info fontSize="small" sx={{ ml: 1, opacity: 0.7 }} />
                </Tooltip>
              </div>
              <Insights />
            </div>
            <div className="flow-indicators">
              <div className="flow-indicator positive">
                <span className="flow-label">Dark Pool</span>
                <span className="flow-value">+$2.8B</span>
              </div>
              <div className="flow-indicator negative">
                <span className="flow-label">Options Flow</span>
                <span className="flow-value">-$1.2B</span>
              </div>
              <div className="flow-indicator positive">
                <span className="flow-label">Block Trades</span>
                <span className="flow-value">+$4.5B</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-panel large glow-effect">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Market Bias</h2>
                <Tooltip title="Current market sentiment distribution">
                  <Info fontSize="small" sx={{ ml: 1, opacity: 0.7 }} />
                </Tooltip>
              </div>
              <PieChart />
            </div>
            <div className="bias-content">
              <div className="bias-stats">
                <div className="stat-item">
                  <span className="label">Bullish</span>
                  <span className="value positive">65%</span>
                </div>
                <div className="stat-item">
                  <span className="label">Bearish</span>
                  <span className="value negative">35%</span>
                </div>
                <div className="stat-item">
                  <span className="label">Neutral</span>
                  <span className="value">15%</span>
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-panel medium glow-effect">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Volume Analysis</h2>
                <Tooltip title="Key volume levels and VWAP analysis">
                  <Info fontSize="small" sx={{ ml: 1, opacity: 0.7 }} />
                </Tooltip>
              </div>
              <BarChart />
            </div>
            <div className="volume-levels">
              <div className="volume-item">
                <span className="label">VWAP Levels</span>
                <div className="value-group">
                  <span className="value">$425.50</span>
                  <span className="value">$427.80</span>
                </div>
              </div>
              <div className="volume-item">
                <span className="label">Volume Profile</span>
                <div className="value-group">
                  <span className="value positive">Above Avg</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-panel large glow-effect">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Key Levels</h2>
                <Tooltip title="Important support and resistance levels">
                  <Info fontSize="small" sx={{ ml: 1, opacity: 0.7 }} />
                </Tooltip>
              </div>
              <CompareArrows />
            </div>
            <div className="levels-content">
              <div className="level-group">
                <h3>Resistance Levels</h3>
                <div className="level-values">
                  <span className="level resistance">$428.50</span>
                  <span className="level resistance">$432.75</span>
                  <span className="level resistance">$435.20</span>
                </div>
              </div>
              <div className="level-group">
                <h3>Support Levels</h3>
                <div className="level-values">
                  <span className="level support">$422.30</span>
                  <span className="level support">$419.85</span>
                  <span className="level support">$417.40</span>
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-panel medium glow-effect">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Gamma Exposure</h2>
                <Tooltip title="Options market gamma exposure and key levels">
                  <Info fontSize="small" sx={{ ml: 1, opacity: 0.7 }} />
                </Tooltip>
              </div>
              <TrendingDown />
            </div>
            <div className="gamma-levels">
              <div className="gamma-item">
                <span className="label">Net Gamma</span>
                <span className="value negative">-$1.2B</span>
              </div>
              <div className="gamma-item">
                <span className="label">Gamma Flip</span>
                <span className="value">$424.50</span>
              </div>
              <div className="gamma-item">
                <span className="label">Zero Gamma</span>
                <span className="value">$426.75</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-section conviction-section">
          <Typography variant="h6" className="section-title">CONVICTION LEVELS</Typography>
          <div className="conviction-chart">
            {analysisData.map((item, index) => (
              <div key={index} className="conviction-bar-container">
                <div className="conviction-header">
                  <Typography className="conviction-name">{item.name}</Typography>
                  <Typography className={`conviction-value ${item.conviction >= 50 ? 'positive' : 'negative'}`}>
                    {item.conviction.toFixed(2)}%
                  </Typography>
                </div>
                <div 
                  className={`conviction-bar ${item.conviction >= 50 ? 'positive' : 'negative'}`} 
                  style={{ width: `${item.conviction}%` }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-panel">
            <TableContainer component={Paper}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Signal</TableCell>
                    <TableCell>Conviction</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {analysisData.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className={row.signal.toLowerCase()}>
                        {row.signal}
                      </TableCell>
                      <TableCell>{row.conviction.toFixed(2)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </div>

          <div className="dashboard-panel">
            <Typography variant="h6">Major Support / Resistance Levels</Typography>
            <div className="levels-content">
              <div className="level-group">
                <Typography variant="subtitle2">Key Resistance</Typography>
                <div className="level-values">
                  {supportResistance.keyResistance.map((level, index) => (
                    <span key={index} className="level resistance">{level}</span>
                  ))}
                </div>
              </div>
              <div className="level-group">
                <Typography variant="subtitle2">Key Support</Typography>
                <div className="level-values">
                  {supportResistance.keySupport.map((level, index) => (
                    <span key={index} className="level support">{level}</span>
                  ))}
                </div>
              </div>
              <div className="level-group">
                <Typography variant="subtitle2">Inflection Point</Typography>
                <span className="level neutral">{supportResistance.inflectionPoint}</span>
              </div>
            </div>
          </div>

          <div className="dashboard-panel">
            <Typography variant="h6">Gamma Levels</Typography>
            <div className="gamma-content">
              <div className="gamma-item">
                <span className="label">Gamma Flip</span>
                <span className="value">{gammaLevels.gammaFlip}</span>
              </div>
              <div className="gamma-item">
                <span className="label">Gamma Total</span>
                <span className="value negative">{gammaLevels.gammaTotal}</span>
              </div>
              <div className="gamma-item">
                <span className="label">Gamma Magnet</span>
                <span className="value">{gammaLevels.gammaMagnet}</span>
              </div>
            </div>
          </div>

          <div className="dashboard-panel">
            <Typography variant="h6">OI / Volume Levels</Typography>
            <div className="volume-content">
              <div className="volume-item">
                <span className="label">Highest OI</span>
                <span className="value">{volumeLevels.highestOI}</span>
              </div>
              <div className="volume-item">
                <span className="label">Volume M</span>
                <div className="value-group">
                  {volumeLevels.volumeM.map((level, index) => (
                    <span key={index} className="value">{level}</span>
                  ))}
                </div>
              </div>
              <div className="volume-item">
                <span className="label">Volume W</span>
                <div className="value-group">
                  {volumeLevels.volumeW.map((level, index) => (
                    <span key={index} className="value">{level}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-section">
          <Typography variant="h6" className="section-title">Index Strength</Typography>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Signal</TableCell>
                  <TableCell>Conviction</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {indexStrength.map((row, index) => (
                  <TableRow key={index}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell className={row.signal.toLowerCase()}>
                      {row.signal}
                    </TableCell>
                    <TableCell>{row.conviction.toFixed(2)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </div>
      </div>
    </div>
  );
}

export default Dashboard; 