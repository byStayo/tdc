import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import TimelineIcon from '@mui/icons-material/Timeline';
import PersonIcon from '@mui/icons-material/Person';
import './ConvictionDetail.css';

const ProfessionalAnalysis = () => {
  const navigate = useNavigate();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const timeframes = ['1H', '4H', '1D', '1W', '1M'];

  const analysisData = {
    conviction: {
      value: 93.00,
      signal: 'Strong Sell',
      type: 'sell',
      lastUpdated: '2024-02-20 14:30 EST'
    },
    analysts: [
      {
        name: 'John Smith',
        experience: '42 years',
        focus: 'Technical Analysis',
        conviction: 95.00,
        signal: 'Strong Sell',
        commentary: 'Major distribution pattern forming, expecting significant downside movement.',
        keyLevels: ['3950', '3880', '3750']
      },
      {
        name: 'Sarah Johnson',
        experience: '38 years',
        focus: 'Market Structure',
        conviction: 91.00,
        signal: 'Strong Sell',
        commentary: 'Institutional positioning indicates defensive rotation.',
        keyLevels: ['3975', '3890', '3800']
      }
    ],
    historicalAccuracy: {
      overall: '87.5%',
      lastMonth: '92.3%',
      lastQuarter: '85.7%',
      yearToDate: '88.9%'
    },
    recentCalls: [
      {
        date: '2024-02-15',
        signal: 'Buy',
        entry: '3850',
        exit: '3920',
        return: '+1.82%',
        timeframe: '2 days'
      },
      {
        date: '2024-02-10',
        signal: 'Sell',
        entry: '3980',
        exit: '3850',
        return: '+3.27%',
        timeframe: '5 days'
      },
      {
        date: '2024-02-01',
        signal: 'Buy',
        entry: '3750',
        exit: '3890',
        return: '+3.73%',
        timeframe: '7 days'
      }
    ],
    currentAnalysis: {
      summary: 'Multiple technical and fundamental factors indicating a significant market top.',
      keyPoints: [
        'Distribution pattern on higher timeframes',
        'Defensive sector rotation accelerating',
        'Put/Call ratio at extreme levels',
        'Major resistance confluence at 3975-4000'
      ],
      risks: [
        'Potential short squeeze above 4000',
        'Fed policy shift could invalidate thesis',
        'Oversold conditions on lower timeframes'
      ]
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
        <h1>Professional Analysis</h1>
        <div className={`conviction-badge ${analysisData.conviction.type}`}>
          <span className="value">{analysisData.conviction.value.toFixed(2)}%</span>
          <span className="signal">{analysisData.conviction.signal}</span>
        </div>
      </div>

      <div className="detail-grid">
        {/* Current Analysis Summary */}
        <div className="detail-panel large">
          <div className="panel-header">
            <h2>Current Analysis</h2>
            <ShowChartIcon />
          </div>
          <div className="analysis-summary">
            <p className="summary-text">{analysisData.currentAnalysis.summary}</p>
            <div className="key-points">
              <h3>Key Points</h3>
              <ul>
                {analysisData.currentAnalysis.keyPoints.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </div>
            <div className="risk-factors">
              <h3>Risk Factors</h3>
              <ul>
                {analysisData.currentAnalysis.risks.map((risk, index) => (
                  <li key={index}>{risk}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Analyst Profiles */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Lead Analysts</h2>
            <PersonIcon />
          </div>
          <div className="analyst-profiles">
            {analysisData.analysts.map((analyst, index) => (
              <div key={index} className="analyst-card">
                <div className="analyst-header">
                  <h3>{analyst.name}</h3>
                  <span className="experience">{analyst.experience} Experience</span>
                </div>
                <div className="analyst-focus">
                  <span className="label">Focus:</span>
                  <span className="value">{analyst.focus}</span>
                </div>
                <div className="analyst-conviction">
                  <span className={`signal ${analyst.signal.toLowerCase().replace(' ', '-')}`}>
                    {analyst.signal} ({analyst.conviction.toFixed(2)}%)
                  </span>
                </div>
                <p className="analyst-commentary">{analyst.commentary}</p>
                <div className="analyst-levels">
                  <span className="label">Key Levels:</span>
                  <div className="level-tags">
                    {analyst.keyLevels.map((level, i) => (
                      <span key={i} className="level-tag">{level}</span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Historical Performance */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Historical Accuracy</h2>
            <TimelineIcon />
          </div>
          <div className="performance-stats">
            <div className="stat-card">
              <span className="stat-label">Overall</span>
              <span className="stat-value">{analysisData.historicalAccuracy.overall}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Last Month</span>
              <span className="stat-value">{analysisData.historicalAccuracy.lastMonth}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Last Quarter</span>
              <span className="stat-value">{analysisData.historicalAccuracy.lastQuarter}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Year to Date</span>
              <span className="stat-value">{analysisData.historicalAccuracy.yearToDate}</span>
            </div>
          </div>
        </div>

        {/* Recent Calls */}
        <div className="detail-panel medium">
          <div className="panel-header">
            <h2>Recent Calls</h2>
            <TrendingUpIcon />
          </div>
          <div className="recent-calls">
            {analysisData.recentCalls.map((call, index) => (
              <div key={index} className="call-card">
                <div className="call-header">
                  <span className="date">{call.date}</span>
                  <span className={`signal ${call.signal.toLowerCase()}`}>{call.signal}</span>
                </div>
                <div className="call-details">
                  <div className="detail-item">
                    <span className="label">Entry</span>
                    <span className="value">{call.entry}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Exit</span>
                    <span className="value">{call.exit}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Return</span>
                    <span className={`value ${parseFloat(call.return) > 0 ? 'positive' : 'negative'}`}>
                      {call.return}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Timeframe</span>
                    <span className="value">{call.timeframe}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="last-updated">
        Last Updated: {analysisData.conviction.lastUpdated}
      </div>
    </div>
  );
};

export default ProfessionalAnalysis; 