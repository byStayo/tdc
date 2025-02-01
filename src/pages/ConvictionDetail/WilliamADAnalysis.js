import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import TimelineIcon from '@mui/icons-material/Timeline';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import BarChartIcon from '@mui/icons-material/BarChart';
import './ConvictionDetail.css';

const WilliamADAnalysis = () => {
  const navigate = useNavigate();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const timeframes = ['1H', '4H', '1D', '1W', '1M'];

  const analysisData = {
    conviction: {
      value: 87.50,
      signal: 'Strong Buy',
      type: 'buy',
      lastUpdated: '2024-02-20 14:30 EST'
    },
    williamAD: {
      currentValue: 0.85,
      previousValue: 0.72,
      change: '+0.13',
      trend: 'Bullish',
      strength: 'Strong',
      divergence: 'None',
      keyLevels: [
        { value: 0.85, type: 'Current', significance: 'Overbought Zone' },
        { value: 0.72, type: 'Previous', significance: 'Neutral Zone' },
        { value: 0.20, type: 'Support', significance: 'Oversold Zone' }
      ]
    },
    marketConditions: {
      accumulation: {
        status: 'Active',
        strength: 'High',
        duration: '5 days',
        volume: '+15% vs Avg'
      },
      distribution: {
        status: 'Minimal',
        strength: 'Low',
        duration: '2 days',
        volume: '-5% vs Avg'
      }
    },
    signals: {
      primary: [
        {
          type: 'Accumulation',
          strength: 'Strong',
          timeframe: 'Short-term',
          confidence: 92
        },
        {
          type: 'Trend',
          strength: 'Moderate',
          timeframe: 'Medium-term',
          confidence: 85
        }
      ],
      secondary: [
        {
          type: 'Volume',
          signal: 'Increasing',
          impact: 'Positive',
          confidence: 88
        },
        {
          type: 'Momentum',
          signal: 'Rising',
          impact: 'Positive',
          confidence: 90
        }
      ]
    },
    historicalPerformance: {
      accuracy: {
        overall: '85%',
        bullish: '88%',
        bearish: '82%'
      },
      recentCalls: [
        {
          date: '2024-02-19',
          signal: 'Buy',
          entry: '3,890',
          current: '3,950',
          return: '+1.54%'
        },
        {
          date: '2024-02-15',
          signal: 'Sell',
          entry: '3,960',
          current: '3,920',
          return: '+1.01%'
        },
        {
          date: '2024-02-12',
          signal: 'Buy',
          entry: '3,880',
          current: '3,950',
          return: '+1.80%'
        }
      ]
    },
    volumeProfile: {
      distribution: {
        buying: '65%',
        selling: '35%',
        neutral: '10%'
      },
      trends: {
        shortTerm: 'Increasing',
        mediumTerm: 'Stable',
        longTerm: 'Upward'
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
        <h1>William AD Analysis</h1>
        <div className={`conviction-badge ${analysisData.conviction.type}`}>
          <span className="value">{analysisData.conviction.value.toFixed(2)}%</span>
          <span className="signal">{analysisData.conviction.signal}</span>
        </div>
      </div>

      <div className="detail-grid">
        {/* William AD Metrics */}
        <div className="detail-panel large">
          <div className="panel-header">
            <h2>William AD Metrics</h2>
            <ShowChartIcon />
          </div>
          <div className="william-metrics">
            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">Current Value</span>
                <span className="metric-value">{analysisData.williamAD.currentValue}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Previous Value</span>
                <span className="metric-value">{analysisData.williamAD.previousValue}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Change</span>
                <span className={`metric-value ${parseFloat(analysisData.williamAD.change) > 0 ? 'positive' : 'negative'}`}>
                  {analysisData.williamAD.change}
                </span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Trend</span>
                <span className="metric-value">{analysisData.williamAD.trend}</span>
              </div>
            </div>
            <div className="key-levels">
              <h3>Key Levels</h3>
              <div className="levels-grid">
                {analysisData.williamAD.keyLevels.map((level, index) => (
                  <div key={index} className="level-card">
                    <div className="level-header">
                      <span className="value">{level.value}</span>
                      <span className="type">{level.type}</span>
                    </div>
                    <span className="significance">{level.significance}</span>
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
            <BarChartIcon />
          </div>
          <div className="market-conditions">
            <div className="condition-section">
              <h3>Accumulation</h3>
              <div className="condition-details">
                {Object.entries(analysisData.marketConditions.accumulation).map(([key, value]) => (
                  <div key={key} className="detail-row">
                    <span className="label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="condition-section">
              <h3>Distribution</h3>
              <div className="condition-details">
                {Object.entries(analysisData.marketConditions.distribution).map(([key, value]) => (
                  <div key={key} className="detail-row">
                    <span className="label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Signals */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Signals</h2>
            <TimelineIcon />
          </div>
          <div className="signals-container">
            <div className="signals-section">
              <h3>Primary Signals</h3>
              <div className="signals-grid">
                {analysisData.signals.primary.map((signal, index) => (
                  <div key={index} className="signal-card">
                    <div className="signal-header">
                      <span className="type">{signal.type}</span>
                      <span className="confidence">{signal.confidence}%</span>
                    </div>
                    <div className="signal-details">
                      <div className="detail-row">
                        <span className="label">Strength</span>
                        <span className="value">{signal.strength}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Timeframe</span>
                        <span className="value">{signal.timeframe}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="signals-section">
              <h3>Secondary Signals</h3>
              <div className="signals-grid">
                {analysisData.signals.secondary.map((signal, index) => (
                  <div key={index} className="signal-card">
                    <div className="signal-header">
                      <span className="type">{signal.type}</span>
                      <span className="confidence">{signal.confidence}%</span>
                    </div>
                    <div className="signal-details">
                      <div className="detail-row">
                        <span className="label">Signal</span>
                        <span className="value">{signal.signal}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Impact</span>
                        <span className="value">{signal.impact}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Historical Performance */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Historical Performance</h2>
            <TrendingUpIcon />
          </div>
          <div className="performance-container">
            <div className="accuracy-section">
              <h3>Accuracy</h3>
              <div className="accuracy-grid">
                {Object.entries(analysisData.historicalPerformance.accuracy).map(([key, value]) => (
                  <div key={key} className="accuracy-card">
                    <span className="label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="recent-calls">
              <h3>Recent Calls</h3>
              <div className="calls-list">
                {analysisData.historicalPerformance.recentCalls.map((call, index) => (
                  <div key={index} className="call-card">
                    <div className="call-header">
                      <span className="date">{call.date}</span>
                      <span className={`signal ${call.signal.toLowerCase()}`}>{call.signal}</span>
                    </div>
                    <div className="call-details">
                      <div className="detail-row">
                        <span className="label">Entry</span>
                        <span className="value">${call.entry}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Current</span>
                        <span className="value">${call.current}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Return</span>
                        <span className={`value ${parseFloat(call.return) > 0 ? 'positive' : 'negative'}`}>
                          {call.return}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Volume Profile */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Volume Profile</h2>
            <BarChartIcon />
          </div>
          <div className="volume-profile">
            <div className="distribution-section">
              <h3>Distribution</h3>
              <div className="distribution-grid">
                {Object.entries(analysisData.volumeProfile.distribution).map(([key, value]) => (
                  <div key={key} className="distribution-card">
                    <span className="label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="trends-section">
              <h3>Trends</h3>
              <div className="trends-grid">
                {Object.entries(analysisData.volumeProfile.trends).map(([key, value]) => (
                  <div key={key} className="trend-card">
                    <span className="label">
                      {key.replace(/([A-Z])/g, ' $1').trim().charAt(0).toUpperCase() + 
                       key.replace(/([A-Z])/g, ' $1').trim().slice(1)}
                    </span>
                    <span className="value">{value}</span>
                  </div>
                ))}
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

export default WilliamADAnalysis; 