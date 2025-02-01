import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TimelineIcon from '@mui/icons-material/Timeline';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import BarChartIcon from '@mui/icons-material/BarChart';
import './ConvictionDetail.css';

const AIAnalysis = () => {
  const navigate = useNavigate();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const timeframes = ['1H', '4H', '1D', '1W', '1M'];

  const analysisData = {
    conviction: {
      value: 88.50,
      signal: 'Strong Buy',
      type: 'buy',
      lastUpdated: '2024-02-20 14:30 EST'
    },
    models: [
      {
        name: 'Deep Learning Model',
        type: 'Neural Network',
        confidence: 92.5,
        signal: 'Strong Buy',
        features: [
          'Price Action Patterns',
          'Volume Analysis',
          'Market Sentiment',
          'Technical Indicators'
        ],
        prediction: {
          target: '4150',
          timeframe: '5-7 trading days',
          probability: '85%'
        }
      },
      {
        name: 'Statistical Model',
        type: 'Time Series Analysis',
        confidence: 84.5,
        signal: 'Buy',
        features: [
          'Mean Reversion',
          'Momentum Factors',
          'Volatility Patterns',
          'Correlation Analysis'
        ],
        prediction: {
          target: '4100',
          timeframe: '3-5 trading days',
          probability: '78%'
        }
      }
    ],
    indicators: {
      technical: [
        { name: 'RSI', value: '32.5', signal: 'Oversold' },
        { name: 'MACD', value: '-2.3', signal: 'Bullish Crossover' },
        { name: 'MA Cross', value: '200/50', signal: 'Golden Cross' },
        { name: 'Bollinger', value: 'Lower Band', signal: 'Bounce' }
      ],
      sentiment: [
        { name: 'Fear & Greed', value: '25', signal: 'Extreme Fear' },
        { name: 'Put/Call', value: '0.85', signal: 'Bullish' },
        { name: 'VIX', value: '18.5', signal: 'Low Volatility' },
        { name: 'News Sentiment', value: '65%', signal: 'Positive' }
      ]
    },
    performance: {
      accuracy: {
        daily: '92.5%',
        weekly: '88.7%',
        monthly: '85.3%',
        yearly: '83.9%'
      },
      recentPredictions: [
        {
          date: '2024-02-15',
          prediction: 'Buy',
          target: '3920',
          actual: '3935',
          accuracy: '98.5%',
          return: '+2.1%'
        },
        {
          date: '2024-02-10',
          prediction: 'Sell',
          target: '3850',
          actual: '3842',
          accuracy: '97.8%',
          return: '+1.8%'
        },
        {
          date: '2024-02-05',
          prediction: 'Buy',
          target: '3880',
          actual: '3895',
          accuracy: '96.2%',
          return: '+1.5%'
        }
      ]
    },
    marketConditions: {
      current: 'Oversold Bounce',
      volatility: 'Decreasing',
      trend: 'Short-term Bullish',
      volume: 'Above Average',
      keyLevels: {
        support: ['3850', '3820', '3780'],
        resistance: ['3950', '3975', '4000']
      }
    }
  };

  return (
    <div className="conviction-detail">
      <div className="detail-header">
        <button className="back-button" onClick={() => navigate(-1)}>
          <ArrowBackIcon />
          <span>Back to Dashboard</span>
        </button>
        <div className="timeframe-selector">
          {timeframes.map((tf) => (
            <button
              key={tf}
              className={`timeframe-btn ${selectedTimeframe === tf ? 'active' : ''}`}
              onClick={() => setSelectedTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div className="detail-title">
        <h1>A.I. Analysis</h1>
        <div className={`conviction-badge ${analysisData.conviction.type}`}>
          <span className="value">{analysisData.conviction.value.toFixed(2)}%</span>
          <span className="signal">{analysisData.conviction.signal}</span>
        </div>
      </div>

      <div className="detail-grid">
        {/* AI Models Analysis */}
        <div className="detail-panel large">
          <div className="panel-header">
            <h2>AI Models Analysis</h2>
            <SmartToyIcon />
          </div>
          <div className="models-grid">
            {analysisData.models.map((model, index) => (
              <div key={index} className="model-card">
                <div className="model-header">
                  <h3>{model.name}</h3>
                  <span className="model-type">{model.type}</span>
                </div>
                <div className="model-confidence">
                  <span className={`signal ${model.signal.toLowerCase().replace(' ', '-')}`}>
                    {model.signal} ({model.confidence.toFixed(1)}%)
                  </span>
                </div>
                <div className="model-features">
                  <h4>Key Features</h4>
                  <ul>
                    {model.features.map((feature, i) => (
                      <li key={i}>{feature}</li>
                    ))}
                  </ul>
                </div>
                <div className="model-prediction">
                  <h4>Price Prediction</h4>
                  <div className="prediction-details">
                    <div className="detail-item">
                      <span className="label">Target</span>
                      <span className="value">{model.prediction.target}</span>
                    </div>
                    <div className="detail-item">
                      <span className="label">Timeframe</span>
                      <span className="value">{model.prediction.timeframe}</span>
                    </div>
                    <div className="detail-item">
                      <span className="label">Probability</span>
                      <span className="value">{model.prediction.probability}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Technical & Sentiment Indicators */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Model Indicators</h2>
            <ShowChartIcon />
          </div>
          <div className="indicators-container">
            <div className="indicators-section">
              <h3>Technical Indicators</h3>
              <div className="indicators-grid">
                {analysisData.indicators.technical.map((indicator, index) => (
                  <div key={index} className="indicator-card">
                    <span className="indicator-name">{indicator.name}</span>
                    <span className="indicator-value">{indicator.value}</span>
                    <span className="indicator-signal">{indicator.signal}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="indicators-section">
              <h3>Sentiment Indicators</h3>
              <div className="indicators-grid">
                {analysisData.indicators.sentiment.map((indicator, index) => (
                  <div key={index} className="indicator-card">
                    <span className="indicator-name">{indicator.name}</span>
                    <span className="indicator-value">{indicator.value}</span>
                    <span className="indicator-signal">{indicator.signal}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Performance Metrics */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Model Performance</h2>
            <BarChartIcon />
          </div>
          <div className="performance-container">
            <div className="accuracy-metrics">
              <h3>Prediction Accuracy</h3>
              <div className="metrics-grid">
                {Object.entries(analysisData.performance.accuracy).map(([period, value]) => (
                  <div key={period} className="metric-card">
                    <span className="metric-label">{period.charAt(0).toUpperCase() + period.slice(1)}</span>
                    <span className="metric-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="recent-predictions">
              <h3>Recent Predictions</h3>
              <div className="predictions-list">
                {analysisData.performance.recentPredictions.map((prediction, index) => (
                  <div key={index} className="prediction-card">
                    <div className="prediction-header">
                      <span className="date">{prediction.date}</span>
                      <span className={`signal ${prediction.prediction.toLowerCase()}`}>
                        {prediction.prediction}
                      </span>
                    </div>
                    <div className="prediction-details">
                      <div className="detail-row">
                        <span className="label">Target</span>
                        <span className="value">{prediction.target}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Actual</span>
                        <span className="value">{prediction.actual}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Accuracy</span>
                        <span className="value">{prediction.accuracy}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Return</span>
                        <span className={`value ${parseFloat(prediction.return) > 0 ? 'positive' : 'negative'}`}>
                          {prediction.return}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Market Conditions */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Market Conditions</h2>
            <TimelineIcon />
          </div>
          <div className="market-conditions">
            <div className="conditions-grid">
              <div className="condition-item">
                <span className="label">Current State</span>
                <span className="value">{analysisData.marketConditions.current}</span>
              </div>
              <div className="condition-item">
                <span className="label">Volatility</span>
                <span className="value">{analysisData.marketConditions.volatility}</span>
              </div>
              <div className="condition-item">
                <span className="label">Trend</span>
                <span className="value">{analysisData.marketConditions.trend}</span>
              </div>
              <div className="condition-item">
                <span className="label">Volume</span>
                <span className="value">{analysisData.marketConditions.volume}</span>
              </div>
            </div>
            <div className="key-levels">
              <div className="levels-section">
                <h3>Support Levels</h3>
                <div className="levels-list">
                  {analysisData.marketConditions.keyLevels.support.map((level, index) => (
                    <span key={index} className="level-tag">{level}</span>
                  ))}
                </div>
              </div>
              <div className="levels-section">
                <h3>Resistance Levels</h3>
                <div className="levels-list">
                  {analysisData.marketConditions.keyLevels.resistance.map((level, index) => (
                    <span key={index} className="level-tag">{level}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="last-updated">
        Last Updated: {analysisData.conviction.lastUpdated}
      </div>
    </div>
  );
};

export default AIAnalysis; 