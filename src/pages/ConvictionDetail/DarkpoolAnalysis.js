import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import TimelineIcon from '@mui/icons-material/Timeline';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import BarChartIcon from '@mui/icons-material/BarChart';
import './ConvictionDetail.css';

const DarkpoolAnalysis = () => {
  const navigate = useNavigate();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const timeframes = ['1H', '4H', '1D', '1W', '1M'];

  const analysisData = {
    conviction: {
      value: 91.50,
      signal: 'Strong Buy',
      type: 'buy',
      lastUpdated: '2024-02-20 14:30 EST'
    },
    darkpoolActivity: {
      summary: {
        totalVolume: '2.8M',
        averagePrice: '$3,925',
        sentiment: 'Bullish',
        largestBlock: '450K @ $3,918'
      },
      significantLevels: [
        {
          price: '3,920',
          volume: '850K',
          type: 'Support',
          strength: 'Strong',
          timeframe: 'Intraday'
        },
        {
          price: '3,950',
          volume: '1.2M',
          type: 'Resistance',
          strength: 'Very Strong',
          timeframe: 'Daily'
        },
        {
          price: '3,880',
          volume: '650K',
          type: 'Support',
          strength: 'Moderate',
          timeframe: 'Weekly'
        }
      ],
      recentBlocks: [
        {
          time: '14:15 EST',
          size: '250K',
          price: '$3,922',
          type: 'Buy',
          premium: '+0.15%'
        },
        {
          time: '13:45 EST',
          size: '180K',
          price: '$3,918',
          type: 'Buy',
          premium: '+0.08%'
        },
        {
          time: '13:20 EST',
          size: '320K',
          price: '$3,915',
          type: 'Buy',
          premium: '+0.12%'
        }
      ]
    },
    volumeAnalysis: {
      distribution: {
        darkpool: '38%',
        lit: '62%',
        trend: 'Increasing Dark Pool',
        analysis: 'Above average dark pool participation indicating institutional interest'
      },
      priceImpact: {
        current: 'Medium',
        trend: 'Increasing',
        analysis: 'Growing buy-side pressure with minimal price impact suggesting accumulation'
      },
      vwap: {
        current: '$3,921',
        deviation: '+0.18%',
        analysis: 'Trading above VWAP with strong buy flows'
      }
    },
    institutionalActivity: {
      netFlow: {
        daily: '+$580M',
        weekly: '+$2.1B',
        monthly: '+$5.8B'
      },
      majorPlayers: [
        {
          name: 'Large Investment Bank',
          action: 'Accumulating',
          timeframe: '5 days',
          impact: 'High'
        },
        {
          name: 'Hedge Fund Group',
          action: 'Position Building',
          timeframe: '2 weeks',
          impact: 'Medium'
        }
      ],
      sectorRotation: {
        from: 'Defensive',
        to: 'Cyclical',
        strength: 'Strong',
        implication: 'Bullish market sentiment'
      }
    },
    marketStructure: {
      liquidityLevels: [
        { price: '3,950-3,960', type: 'Resistance', volume: '2.1M' },
        { price: '3,920-3,930', type: 'Support', volume: '1.8M' },
        { price: '3,880-3,890', type: 'Support', volume: '1.5M' }
      ],
      orderFlow: {
        buySide: '65%',
        sellSide: '35%',
        imbalance: 'Strong Buy',
        momentum: 'Increasing'
      },
      volatilityProfile: {
        current: 'Low',
        trend: 'Decreasing',
        implication: 'Favorable for position building'
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
        <h1>Darkpool Analysis</h1>
        <div className={`conviction-badge ${analysisData.conviction.type}`}>
          <span className="value">{analysisData.conviction.value.toFixed(2)}%</span>
          <span className="signal">{analysisData.conviction.signal}</span>
        </div>
      </div>

      <div className="detail-grid">
        {/* Darkpool Activity Summary */}
        <div className="detail-panel large">
          <div className="panel-header">
            <h2>Darkpool Activity</h2>
            <AccountBalanceIcon />
          </div>
          <div className="darkpool-summary">
            <div className="summary-metrics">
              {Object.entries(analysisData.darkpoolActivity.summary).map(([key, value]) => (
                <div key={key} className="metric-card">
                  <span className="metric-label">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span className="metric-value">{value}</span>
                </div>
              ))}
            </div>
            <div className="significant-levels">
              <h3>Significant Levels</h3>
              <div className="levels-grid">
                {analysisData.darkpoolActivity.significantLevels.map((level, index) => (
                  <div key={index} className="level-card">
                    <div className="level-header">
                      <span className="price">${level.price}</span>
                      <span className={`type ${level.type.toLowerCase()}`}>{level.type}</span>
                    </div>
                    <div className="level-details">
                      <div className="detail-row">
                        <span className="label">Volume</span>
                        <span className="value">{level.volume}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Strength</span>
                        <span className="value">{level.strength}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Timeframe</span>
                        <span className="value">{level.timeframe}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Recent Blocks */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Recent Blocks</h2>
            <BarChartIcon />
          </div>
          <div className="blocks-list">
            {analysisData.darkpoolActivity.recentBlocks.map((block, index) => (
              <div key={index} className="block-card">
                <div className="block-header">
                  <span className="time">{block.time}</span>
                  <span className={`type ${block.type.toLowerCase()}`}>{block.type}</span>
                </div>
                <div className="block-details">
                  <div className="detail-row">
                    <span className="label">Size</span>
                    <span className="value">{block.size}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Price</span>
                    <span className="value">{block.price}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Premium</span>
                    <span className={`value ${parseFloat(block.premium) > 0 ? 'positive' : 'negative'}`}>
                      {block.premium}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Volume Analysis */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Volume Analysis</h2>
            <ShowChartIcon />
          </div>
          <div className="volume-analysis">
            <div className="distribution-section">
              <h3>Volume Distribution</h3>
              <div className="distribution-details">
                <div className="detail-row">
                  <span className="label">Dark Pool</span>
                  <span className="value">{analysisData.volumeAnalysis.distribution.darkpool}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Lit Exchange</span>
                  <span className="value">{analysisData.volumeAnalysis.distribution.lit}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Trend</span>
                  <span className="value">{analysisData.volumeAnalysis.distribution.trend}</span>
                </div>
              </div>
              <p className="analysis-text">{analysisData.volumeAnalysis.distribution.analysis}</p>
            </div>
            <div className="impact-section">
              <h3>Price Impact</h3>
              <div className="impact-details">
                <div className="detail-row">
                  <span className="label">Current</span>
                  <span className="value">{analysisData.volumeAnalysis.priceImpact.current}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Trend</span>
                  <span className="value">{analysisData.volumeAnalysis.priceImpact.trend}</span>
                </div>
              </div>
              <p className="analysis-text">{analysisData.volumeAnalysis.priceImpact.analysis}</p>
            </div>
          </div>
        </div>

        {/* Institutional Activity */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Institutional Activity</h2>
            <TimelineIcon />
          </div>
          <div className="institutional-activity">
            <div className="net-flow">
              <h3>Net Flow</h3>
              <div className="flow-metrics">
                {Object.entries(analysisData.institutionalActivity.netFlow).map(([period, value]) => (
                  <div key={period} className="metric-card">
                    <span className="metric-label">{period.charAt(0).toUpperCase() + period.slice(1)}</span>
                    <span className={`metric-value ${parseFloat(value) > 0 ? 'positive' : 'negative'}`}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="major-players">
              <h3>Major Players</h3>
              <div className="players-list">
                {analysisData.institutionalActivity.majorPlayers.map((player, index) => (
                  <div key={index} className="player-card">
                    <div className="player-header">
                      <span className="name">{player.name}</span>
                      <span className={`impact ${player.impact.toLowerCase()}`}>{player.impact} Impact</span>
                    </div>
                    <div className="player-details">
                      <div className="detail-row">
                        <span className="label">Action</span>
                        <span className="value">{player.action}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Timeframe</span>
                        <span className="value">{player.timeframe}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Market Structure */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Market Structure</h2>
            <TrendingUpIcon />
          </div>
          <div className="market-structure">
            <div className="liquidity-levels">
              <h3>Liquidity Levels</h3>
              <div className="levels-list">
                {analysisData.marketStructure.liquidityLevels.map((level, index) => (
                  <div key={index} className="level-card">
                    <div className="level-header">
                      <span className="price">{level.price}</span>
                      <span className={`type ${level.type.toLowerCase()}`}>{level.type}</span>
                    </div>
                    <div className="level-volume">
                      <span className="label">Volume</span>
                      <span className="value">{level.volume}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="order-flow">
              <h3>Order Flow</h3>
              <div className="flow-details">
                <div className="detail-row">
                  <span className="label">Buy Side</span>
                  <span className="value positive">{analysisData.marketStructure.orderFlow.buySide}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Sell Side</span>
                  <span className="value negative">{analysisData.marketStructure.orderFlow.sellSide}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Imbalance</span>
                  <span className="value">{analysisData.marketStructure.orderFlow.imbalance}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Momentum</span>
                  <span className="value">{analysisData.marketStructure.orderFlow.momentum}</span>
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

export default DarkpoolAnalysis; 