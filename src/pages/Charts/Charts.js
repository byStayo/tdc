import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Grid,
  Typography,
  TextField,
  Select,
  MenuItem,
  useTheme,
  alpha,
  InputAdornment,
  IconButton,
  Tooltip,
  Fade,
  Stack,
  Chip,
  Divider
} from '@mui/material';
import {
  Search as SearchIcon,
  ShowChart as ShowChartIcon,
  Timeline as TimelineIcon,
  FilterList as FilterListIcon,
  Refresh as RefreshIcon,
  Info as InfoIcon
} from '@mui/icons-material';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer
} from 'recharts';
import { Card, LoadingState, ErrorState } from '../../components/shared';
import polygonService from '../../services/polygonService';
import { CHART_TIMEFRAMES, CHART_TYPES, TECHNICAL_INDICATORS } from '../../config/polygon';
import './Charts.css';

function Charts() {
  const theme = useTheme();
  const [ticker, setTicker] = useState('AAPL');
  const [timeframe, setTimeframe] = useState(CHART_TIMEFRAMES[2]); // Default to 1M
  const [chartType, setChartType] = useState(CHART_TYPES[1]); // Default to Line
  const [indicators, setIndicators] = useState([]);
  const [stockData, setStockData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [websocket, setWebsocket] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStockData = useCallback(async () => {
    try {
      setRefreshing(true);
      setError(null);

      const now = new Date();
      const past = new Date(now.setDate(now.getDate() - parseInt(timeframe.value)));
      
      const data = await polygonService.getAggregates(
        ticker,
        1,
        'day',
        past.toISOString().split('T')[0],
        new Date().toISOString().split('T')[0]
      );

      // Transform data for charts
      const transformedData = data.results.map(bar => ({
        date: new Date(bar.t).toLocaleDateString(),
        price: bar.c,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        volume: bar.v
      }));

      // Calculate technical indicators
      if (indicators.includes('ma')) {
        addMovingAverage(transformedData, 20);
      }
      if (indicators.includes('bb')) {
        addBollingerBands(transformedData, 20);
      }
      if (indicators.includes('rsi')) {
        addRSI(transformedData, 14);
      }

      setStockData(transformedData);
    } catch (err) {
      setError('Failed to fetch stock data. Please try again.');
      console.error('Error fetching stock data:', err);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [ticker, timeframe, indicators]);

  // WebSocket setup
  useEffect(() => {
    const ws = polygonService.initWebSocket((data) => {
      if (data.ev === 'T' && data.sym === ticker) {
        setLastPrice(data.p);
        
        setStockData(prevData => {
          const newData = [...prevData];
          const lastPoint = newData[newData.length - 1];
          
          if (lastPoint) {
            lastPoint.price = data.p;
            if (data.p > lastPoint.high) lastPoint.high = data.p;
            if (data.p < lastPoint.low) lastPoint.low = data.p;
          }
          
          return newData;
        });
      }
    });

    setWebsocket(ws);

    return () => {
      if (ws) {
        ws();
      }
    };
  }, [ticker]);

  // Subscribe to ticker updates
  useEffect(() => {
    if (websocket) {
      polygonService.subscribeToTicker(ticker);
    }
    return () => {
      if (websocket) {
        polygonService.unsubscribeFromTicker(ticker);
      }
    };
  }, [websocket, ticker]);

  // Fetch historical data
  useEffect(() => {
    fetchStockData();
  }, [fetchStockData]);

  // Technical Indicators Calculations
  const addMovingAverage = (data, period) => {
    for (let i = period - 1; i < data.length; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const sum = slice.reduce((acc, val) => acc + val.price, 0);
      data[i].ma = sum / period;
    }
  };

  const addBollingerBands = (data, period) => {
    for (let i = period - 1; i < data.length; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const ma = slice.reduce((acc, val) => acc + val.price, 0) / period;
      
      const squaredDiffs = slice.map(val => Math.pow(val.price - ma, 2));
      const standardDev = Math.sqrt(squaredDiffs.reduce((acc, val) => acc + val, 0) / period);
      
      data[i].upperBB = ma + (2 * standardDev);
      data[i].lowerBB = ma - (2 * standardDev);
    }
  };

  const addRSI = (data, period) => {
    let gains = [], losses = [];
    
    // Calculate price changes
    for (let i = 1; i < data.length; i++) {
      const change = data[i].price - data[i - 1].price;
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
      
      if (i >= period) {
        const avgGain = gains.slice(-period).reduce((a, b) => a + b) / period;
        const avgLoss = losses.slice(-period).reduce((a, b) => a + b) / period;
        const rs = avgGain / avgLoss;
        data[i].rsi = 100 - (100 / (1 + rs));
      }
    }
  };

  const handleTickerChange = (event) => {
    setTicker(event.target.value.toUpperCase());
  };

  const handleTimeframeChange = (event) => {
    const selected = CHART_TIMEFRAMES.find(tf => tf.value === event.target.value);
    setTimeframe(selected);
  };

  const handleChartTypeChange = (event) => {
    const selected = CHART_TYPES.find(ct => ct.value === event.target.value);
    setChartType(selected);
  };

  const handleIndicatorChange = (event) => {
    const value = event.target.value;
    setIndicators(prev => 
      prev.includes(value)
        ? prev.filter(i => i !== value)
        : [...prev, value]
    );
  };

  return (
    <Box className="charts-page" sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" component="h1">
          Advanced Charts
        </Typography>
        <Tooltip title="Refresh data">
          <IconButton
            onClick={fetchStockData}
            disabled={loading || refreshing}
            sx={{ 
              bgcolor: theme.palette.action.hover,
              '&:hover': { bgcolor: theme.palette.action.selected }
            }}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Card sx={{ mb: 3 }}>
        <Grid container spacing={3} alignItems="center">
          <Grid item xs={12} sm={4}>
            <Stack spacing={1}>
              <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                Symbol
                <Tooltip title="Enter a stock symbol (e.g., AAPL, GOOGL)">
                  <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
                </Tooltip>
              </Typography>
              <TextField
                fullWidth
                value={ticker}
                onChange={handleTickerChange}
                placeholder="Enter ticker symbol"
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  )
                }}
                size="small"
              />
            </Stack>
          </Grid>
          
          <Grid item xs={12} sm={4}>
            <Stack spacing={1}>
              <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                Timeframe
                <Tooltip title="Select the time period for the chart">
                  <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
                </Tooltip>
              </Typography>
              <Select
                fullWidth
                value={timeframe.value}
                onChange={handleTimeframeChange}
                size="small"
              >
                {CHART_TIMEFRAMES.map(tf => (
                  <MenuItem key={tf.value} value={tf.value}>
                    {tf.label}
                  </MenuItem>
                ))}
              </Select>
            </Stack>
          </Grid>
          
          <Grid item xs={12} sm={4}>
            <Stack spacing={1}>
              <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                Chart Type
                <Tooltip title="Select the type of chart to display">
                  <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
                </Tooltip>
              </Typography>
              <Select
                fullWidth
                value={chartType.value}
                onChange={handleChartTypeChange}
                size="small"
              >
                {CHART_TYPES.map(ct => (
                  <MenuItem key={ct.value} value={ct.value}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {ct.value === 'line' ? <ShowChartIcon fontSize="small" /> : <TimelineIcon fontSize="small" />}
                      {ct.label}
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </Stack>
          </Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            Technical Indicators
            <Tooltip title="Add technical indicators to your chart">
              <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
            </Tooltip>
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
            {TECHNICAL_INDICATORS.map(indicator => (
              <Chip
                key={indicator.value}
                label={indicator.label}
                icon={<FilterListIcon />}
                onClick={() => handleIndicatorChange({ target: { value: indicator.value } })}
                color={indicators.includes(indicator.value) ? 'primary' : 'default'}
                variant={indicators.includes(indicator.value) ? 'filled' : 'outlined'}
              />
            ))}
          </Stack>
        </Box>
      </Card>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
          <LoadingState message="Loading chart data..." />
        </Box>
      ) : error ? (
        <Box sx={{ maxWidth: 600, mx: 'auto' }}>
          <ErrorState
            message={error}
            retryable
            onRetry={fetchStockData}
          />
        </Box>
      ) : (
        <Fade in={!loading}>
          <Card>
            <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography variant="h6">
                {ticker}
              </Typography>
              {lastPrice && (
                <Typography
                  variant="h6"
                  color={lastPrice > stockData[0]?.price ? 'success.main' : 'error.main'}
                  sx={{ 
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1,
                    py: 0.5,
                    borderRadius: 1,
                    bgcolor: lastPrice > stockData[0]?.price 
                      ? alpha(theme.palette.success.main, 0.1)
                      : alpha(theme.palette.error.main, 0.1)
                  }}
                >
                  ${lastPrice.toFixed(2)}
                </Typography>
              )}
            </Box>
            
            <Box sx={{ height: 500, width: '100%' }}>
              <ResponsiveContainer>
                <AreaChart data={stockData}>
                  <defs>
                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={theme.palette.primary.main} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={theme.palette.primary.main} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <RechartsTooltip />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke={theme.palette.primary.main}
                    fillOpacity={1}
                    fill="url(#colorPrice)"
                  />
                  {indicators.includes('ma') && (
                    <Area
                      type="monotone"
                      dataKey="ma"
                      stroke={theme.palette.secondary.main}
                      fill="none"
                      dot={false}
                    />
                  )}
                  {indicators.includes('bb') && (
                    <>
                      <Area
                        type="monotone"
                        dataKey="upperBB"
                        stroke={theme.palette.success.main}
                        fill="none"
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="lowerBB"
                        stroke={theme.palette.error.main}
                        fill="none"
                        dot={false}
                      />
                    </>
                  )}
                  {indicators.includes('rsi') && (
                    <Area
                      type="monotone"
                      dataKey="rsi"
                      stroke={theme.palette.warning.main}
                      fill="none"
                      dot={false}
                      yAxisId={1}
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </Card>
        </Fade>
      )}
    </Box>
  );
}

export default Charts; 