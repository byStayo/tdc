import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Paper,
  Grid,
} from '@mui/material';
import {
  TrendingUp,
  ShowChart,
  Assessment,
  Info as InfoIcon,
  ArrowUpward,
  ArrowDownward,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { DataTable, LoadingState } from '../../components/shared';
import { useTheme } from '../../hooks/useTheme';
import './MarketOverview.css';

const MarketOverview = () => {
  const { mode } = useTheme();
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const convictionLevels = [
    {
      level: 'Strong Buy',
      score: 0.9,
      description: 'Based on technical and fundamental analysis',
      className: 'conviction-strong-buy'
    },
    {
      level: 'Buy',
      score: 0.7,
      description: 'Momentum indicators suggest upward trend',
      className: 'conviction-buy'
    },
    {
      level: 'Hold',
      score: 0.5,
      description: 'Market conditions are neutral',
      className: 'conviction-hold'
    },
    {
      level: 'Sell',
      score: 0.3,
      description: 'Risk factors indicate caution',
      className: 'conviction-sell'
    },
    {
      level: 'Strong Sell',
      score: 0.1,
      description: 'Multiple indicators suggest downward pressure',
      className: 'conviction-strong-sell'
    }
  ];

  const marketStats = [
    {
      title: 'Market Trend',
      value: '+2.3%',
      trend: 'up',
      icon: <TrendingUp />,
      description: '30-day moving average'
    },
    {
      title: 'Volatility Index',
      value: '18.5',
      trend: 'down',
      icon: <ShowChart />,
      description: 'Current VIX level'
    },
    {
      title: 'Sentiment Score',
      value: '0.75',
      trend: 'up',
      icon: <Assessment />,
      description: 'Aggregated market sentiment'
    }
  ];

  const columns = [
    {
      field: 'level',
      label: 'Conviction Level',
      render: (value, row) => (
        <Typography className={row.className} sx={{ fontWeight: 600 }}>
          {value}
        </Typography>
      )
    },
    {
      field: 'score',
      label: 'Score',
      render: (value) => (
        <Box className="score-cell">
          {value.toFixed(1)}
        </Box>
      )
    },
    {
      field: 'description',
      label: 'Description',
      render: (value) => (
        <Typography className="description-cell">
          {value}
        </Typography>
      )
    }
  ];

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setStatsLoading(true);
      // Simulate API calls
      await new Promise(resolve => setTimeout(resolve, 1500));
      setLoading(false);
      setStatsLoading(false);
      setLastUpdated(new Date());
    } catch (err) {
      setError('Failed to load market data');
      setLoading(false);
      setStatsLoading(false);
    }
  };

  const handleRefresh = () => {
    loadData();
  };

  const formatLastUpdated = (date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: true
    }).format(date);
  };

  return (
    <div className="market-overview">
      <div className="market-overview-header">
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h4" className="market-overview-title">
            Market Overview
            <Tooltip title="Real-time market analysis and conviction levels" arrow>
              <IconButton size="small" className="info-tooltip">
                <InfoIcon />
              </IconButton>
            </Tooltip>
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Last updated: {formatLastUpdated(lastUpdated)}
            </Typography>
            <Tooltip title="Refresh data" arrow>
              <IconButton 
                onClick={handleRefresh} 
                disabled={loading || statsLoading}
                className="refresh-button"
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        <Typography className="market-overview-subtitle">
          Comprehensive market analysis combining technical indicators, sentiment analysis, and institutional flows.
        </Typography>
      </div>

      <div className="market-overview-grid">
        {statsLoading ? (
          <>
            <LoadingState.Card />
            <LoadingState.Card />
            <LoadingState.Card />
          </>
        ) : (
          marketStats.map((stat, index) => (
            <Paper key={index} className="market-overview-card">
              <div className="card-header">
                <Typography className="card-title">
                  {stat.title}
                </Typography>
                <span className="card-icon">{stat.icon}</span>
              </div>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography variant="h4" sx={{ fontWeight: 700 }}>
                  {stat.value}
                </Typography>
                {stat.trend === 'up' ? (
                  <ArrowUpward sx={{ color: 'success.main' }} />
                ) : (
                  <ArrowDownward sx={{ color: 'error.main' }} />
                )}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {stat.description}
              </Typography>
            </Paper>
          ))
        )}
      </div>

      <div className="conviction-section">
        <div className="conviction-header">
          <Typography className="conviction-title">
            Conviction Levels
            <Tooltip title="Our proprietary scoring system for market signals" arrow>
              <IconButton size="small" className="info-tooltip">
                <InfoIcon />
              </IconButton>
            </Tooltip>
          </Typography>
          <Typography className="conviction-subtitle">
            Signals are updated every 15 minutes based on real-time market data
          </Typography>
        </div>
        {loading ? (
          <LoadingState.Table />
        ) : (
          <DataTable
            data={convictionLevels}
            columns={columns}
            defaultRowsPerPage={5}
            stickyHeader
          />
        )}
      </div>
    </div>
  );
};

export default MarketOverview; 