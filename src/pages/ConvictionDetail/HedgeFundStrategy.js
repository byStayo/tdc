import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import TimelineIcon from '@mui/icons-material/Timeline';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import BarChartIcon from '@mui/icons-material/BarChart';
import './ConvictionDetail.css';

const HedgeFundStrategy = () => {
  const navigate = useNavigate();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const timeframes = ['1H', '4H', '1D', '1W', '1M'];

  const analysisData = {
    conviction: {
      value: 92.50,
      signal: 'Strong Buy',
      type: 'buy',
      lastUpdated: '2024-02-20 14:30 EST'
    },
    hedgeFundActivity: {
      netFlow: '+$2.8B',
      majorPlayers: [
        {
          name: 'Renaissance Technologies',
          action: 'Accumulating',
          position: '+850,000 shares',
          avgPrice: '$3,920',
          impact: 'High'
        },
        {
          name: 'Citadel Advisors',
          action: 'Holding',
          position: '1.2M shares',
          avgPrice: '$3,850',
          impact: 'Medium'
        },
        {
          name: 'Two Sigma',
          action: 'Accumulating',
          position: '+450,000 shares',
          avgPrice: '$3,890',
          impact: 'Medium'
        }
      ],
      sectorFlow: {
        technology: '+$1.2B',
        financials: '+$800M',
        healthcare: '-$300M',
        energy: '+$400M',
        materials: '-$100M'
      }
    },
    strategyAnalysis: {
      currentStrategy: {
        type: 'Momentum-Based',
        confidence: 95,
        timeframe: 'Short-term',
        keyFactors: [
          'Strong institutional buying',
          'Positive momentum indicators',
          'Favorable market structure',
          'Low selling pressure'
        ]
      },
      riskMetrics: {
        volatility: 'Low',
        leverage: 'Moderate',
        exposure: 'Long-biased',
        concentration: 'Diversified'
      }
    },
    performanceMetrics: {
      returns: {
        daily: '+2.5%',
        weekly: '+5.8%',
        monthly: '+12.3%',
        ytd: '+18.5%'
      },
      accuracy: {
        overall: '88%',
        longPositions: '92%',
        shortPositions: '84%'
      },
      riskAdjusted: {
        sharpeRatio: '2.8',
        sortinoRatio: '3.2',
        maxDrawdown: '-4.5%'
      }
    },
    marketConditions: {
      sentiment: {
        institutional: 'Bullish',
        retail: 'Neutral',
        overall: 'Positive'
      },
      liquidity: {
        level: 'High',
        trend: 'Improving',
        impact: 'Positive'
      },
      positioning: {
        netLong: '65%',
        netShort: '35%',
        leverage: '1.8x'
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
        <h1>Hedge Fund Strategy</h1>
        <div className={`conviction-badge ${analysisData.conviction.type}`}>
          <span className="value">{analysisData.conviction.value.toFixed(2)}%</span>
          <span className="signal">{analysisData.conviction.signal}</span>
        </div>
      </div>

      <div className="detail-grid">
        {/* Hedge Fund Activity */}
        <div className="detail-panel large">
          <div className="panel-header">
            <h2>Hedge Fund Activity</h2>
            <AccountBalanceIcon />
          </div>
          <div className="activity-container">
            <div className="net-flow">
              <h3>Net Flow</h3>
              <div className="flow-value">{analysisData.hedgeFundActivity.netFlow}</div>
            </div>
            <div className="major-players">
              <h3>Major Players</h3>
              <div className="players-grid">
                {analysisData.hedgeFundActivity.majorPlayers.map((player, index) => (
                  <div key={index} className="player-card">
                    <div className="player-header">
                      <span className="name">{player.name}</span>
                      <span className={`impact ${player.impact.toLowerCase()}`}>{player.impact}</span>
                    </div>
                    <div className="player-details">
                      <div className="detail-row">
                        <span className="label">Action</span>
                        <span className="value">{player.action}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Position</span>
                        <span className="value">{player.position}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Avg Price</span>
                        <span className="value">{player.avgPrice}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="sector-flow">
              <h3>Sector Flow</h3>
              <div className="flow-grid">
                {Object.entries(analysisData.hedgeFundActivity.sectorFlow).map(([sector, flow]) => (
                  <div key={sector} className="flow-card">
                    <span className="sector">{sector.charAt(0).toUpperCase() + sector.slice(1)}</span>
                    <span className={`flow ${parseFloat(flow) > 0 ? 'positive' : 'negative'}`}>{flow}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Strategy Analysis */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Strategy Analysis</h2>
            <TimelineIcon />
          </div>
          <div className="strategy-container">
            <div className="current-strategy">
              <h3>Current Strategy</h3>
              <div className="strategy-details">
                <div className="detail-row">
                  <span className="label">Type</span>
                  <span className="value">{analysisData.strategyAnalysis.currentStrategy.type}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Confidence</span>
                  <span className="value">{analysisData.strategyAnalysis.currentStrategy.confidence}%</span>
                </div>
                <div className="detail-row">
                  <span className="label">Timeframe</span>
                  <span className="value">{analysisData.strategyAnalysis.currentStrategy.timeframe}</span>
                </div>
              </div>
              <div className="key-factors">
                <h4>Key Factors</h4>
                <ul>
                  {analysisData.strategyAnalysis.currentStrategy.keyFactors.map((factor, index) => (
                    <li key={index}>{factor}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="risk-metrics">
              <h3>Risk Metrics</h3>
              <div className="metrics-grid">
                {Object.entries(analysisData.strategyAnalysis.riskMetrics).map(([metric, value]) => (
                  <div key={metric} className="metric-card">
                    <span className="label">{metric.charAt(0).toUpperCase() + metric.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Performance Metrics */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Performance Metrics</h2>
            <TrendingUpIcon />
          </div>
          <div className="performance-container">
            <div className="returns-section">
              <h3>Returns</h3>
              <div className="returns-grid">
                {Object.entries(analysisData.performanceMetrics.returns).map(([period, value]) => (
                  <div key={period} className="return-card">
                    <span className="label">{period.toUpperCase()}</span>
                    <span className={`value ${parseFloat(value) > 0 ? 'positive' : 'negative'}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="accuracy-section">
              <h3>Accuracy</h3>
              <div className="accuracy-grid">
                {Object.entries(analysisData.performanceMetrics.accuracy).map(([type, value]) => (
                  <div key={type} className="accuracy-card">
                    <span className="label">
                      {type.replace(/([A-Z])/g, ' $1').trim().charAt(0).toUpperCase() + 
                       type.replace(/([A-Z])/g, ' $1').trim().slice(1)}
                    </span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="risk-adjusted">
              <h3>Risk-Adjusted Metrics</h3>
              <div className="metrics-grid">
                {Object.entries(analysisData.performanceMetrics.riskAdjusted).map(([metric, value]) => (
                  <div key={metric} className="metric-card">
                    <span className="label">
                      {metric.replace(/([A-Z])/g, ' $1').trim().charAt(0).toUpperCase() + 
                       metric.replace(/([A-Z])/g, ' $1').trim().slice(1)}
                    </span>
                    <span className="value">{value}</span>
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
          <div className="conditions-container">
            <div className="sentiment-section">
              <h3>Sentiment</h3>
              <div className="sentiment-grid">
                {Object.entries(analysisData.marketConditions.sentiment).map(([type, value]) => (
                  <div key={type} className="sentiment-card">
                    <span className="label">{type.charAt(0).toUpperCase() + type.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="liquidity-section">
              <h3>Liquidity</h3>
              <div className="liquidity-details">
                {Object.entries(analysisData.marketConditions.liquidity).map(([metric, value]) => (
                  <div key={metric} className="detail-row">
                    <span className="label">{metric.charAt(0).toUpperCase() + metric.slice(1)}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="positioning-section">
              <h3>Positioning</h3>
              <div className="positioning-grid">
                {Object.entries(analysisData.marketConditions.positioning).map(([metric, value]) => (
                  <div key={metric} className="position-card">
                    <span className="label">
                      {metric.replace(/([A-Z])/g, ' $1').trim().charAt(0).toUpperCase() + 
                       metric.replace(/([A-Z])/g, ' $1').trim().slice(1)}
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

export default HedgeFundStrategy; 