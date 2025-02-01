import React, { useState, useEffect } from 'react';
import {
  Box,
  Grid,
  Typography,
  Select,
  MenuItem,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  useTheme,
  alpha,
} from '@mui/material';
import {
  ShowChart as ShowChartIcon,
  Timeline as TimelineIcon,
  FilterList as FilterListIcon,
} from '@mui/icons-material';
import { Card, Button, LoadingState, ErrorState } from '../../components/shared';
import './TechnicalAnalysis.css';

let tvScriptLoadingPromise;

function TechnicalAnalysis() {
  const theme = useTheme();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedStock, setSelectedStock] = useState('SPX');
  const [selectedIndicators, setSelectedIndicators] = useState(['RSI', 'MACD']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const timeframes = ['1H', '4H', '1D', '1W', '1M'];
  const stockOptions = [
    { symbol: 'SPX', name: 'S&P 500' },
    { symbol: 'NDX', name: 'Nasdaq 100' },
    { symbol: 'DJI', name: 'Dow Jones' },
    { symbol: 'AAPL', name: 'Apple Inc.' },
    { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'GOOGL', name: 'Google' },
    { symbol: 'AMZN', name: 'Amazon' }
  ];

  const technicalIndicators = [
    {
      name: 'RSI',
      value: 42.5,
      signal: 'Neutral',
      description: 'Approaching oversold conditions'
    },
    {
      name: 'MACD',
      value: -0.35,
      signal: 'Bearish',
      description: 'Below signal line, momentum weakening'
    },
    {
      name: 'Moving Average',
      value: '200 SMA',
      signal: 'Bullish',
      description: 'Price above major moving averages'
    },
    {
      name: 'Stochastic',
      value: '25/35',
      signal: 'Bearish',
      description: 'Trending lower in oversold territory'
    }
  ];

  const patterns = [
    {
      name: 'Head and Shoulders',
      timeframe: '4H',
      confidence: 85,
      target: 3950,
      status: 'Forming'
    },
    {
      name: 'Bull Flag',
      timeframe: '1D',
      confidence: 75,
      target: 4050,
      status: 'Confirmed'
    },
    {
      name: 'Double Bottom',
      timeframe: '1W',
      confidence: 90,
      target: 4100,
      status: 'Completed'
    }
  ];

  const volumeProfile = {
    poc: 3975,
    valueAreaHigh: 4025,
    valueAreaLow: 3925,
    distribution: 'Normal'
  };

  // Load TradingView widget
  useEffect(() => {
    const loadTradingViewScript = () => {
      if (!tvScriptLoadingPromise) {
        tvScriptLoadingPromise = new Promise((resolve) => {
          const script = document.createElement('script');
          script.id = 'tradingview-widget-loading-script';
          script.src = 'https://s3.tradingview.com/tv.js';
          script.type = 'text/javascript';
          script.onload = resolve;
          document.head.appendChild(script);
        });
      }
      return tvScriptLoadingPromise;
    };

    setLoading(true);
    loadTradingViewScript()
      .then(() => {
        if (document.getElementById('tradingview_chart') && window.TradingView) {
          new window.TradingView.widget({
            width: '100%',
            height: '100%',
            symbol: selectedStock,
            interval: selectedTimeframe,
            timezone: 'Etc/UTC',
            theme: theme.palette.mode,
            style: '1',
            locale: 'en',
            toolbar_bg: theme.palette.background.paper,
            enable_publishing: false,
            hide_top_toolbar: true,
            hide_legend: true,
            save_image: false,
            container_id: 'tradingview_chart',
            disabled_features: [
              'header_widget',
              'left_toolbar',
              'volume_force_overlay',
              'timeframes_toolbar',
              'header_saveload',
              'header_settings',
              'header_compare',
              'header_undo_redo',
              'header_screenshot',
              'header_symbol_search'
            ],
            enabled_features: [
              'hide_left_toolbar_by_default',
              'use_localstorage_for_settings',
              'save_chart_properties_to_local_storage'
            ],
            overrides: {
              'paneProperties.background': theme.palette.background.paper,
              'paneProperties.vertGridProperties.color': alpha(theme.palette.divider, 0.1),
              'paneProperties.horzGridProperties.color': alpha(theme.palette.divider, 0.1),
              'scalesProperties.textColor': theme.palette.text.secondary,
              'mainSeriesProperties.candleStyle.wickUpColor': theme.palette.success.main,
              'mainSeriesProperties.candleStyle.wickDownColor': theme.palette.error.main,
              'mainSeriesProperties.candleStyle.drawBorder': true,
              'paneProperties.topMargin': 15,
              'paneProperties.bottomMargin': 15
            }
          });
          setLoading(false);
        }
      })
      .catch((err) => {
        setError('Failed to load TradingView widget');
        setLoading(false);
      });

    return () => {
      // Cleanup if needed
    };
  }, [selectedStock, selectedTimeframe, theme]);

  // Handlers
  const handleTimeframeChange = (timeframe) => {
    setSelectedTimeframe(timeframe);
    console.log(`Timeframe changed to: ${timeframe}`);
  };

  const handleFilterToggle = () => {
    setShowFilters(!showFilters);
    console.log('Filters toggled');
  };

  const handleStockChange = (stock) => {
    setSelectedStock(stock);
    console.log(`Stock changed to: ${stock}`);
  };

  const handleIndicatorSelect = (indicator) => {
    const newSelection = selectedIndicators.includes(indicator)
      ? selectedIndicators.filter(i => i !== indicator)
      : [...selectedIndicators, indicator];
    setSelectedIndicators(newSelection);
    console.log(`Indicator selection updated: ${newSelection.join(', ')}`);
  };

  const handlePatternClick = (pattern) => {
    console.log('Pattern clicked:', pattern);
  };

  const keyLevels = [
    {
      type: 'resistance',
      price: '480.25',
      strength: 'Strong',
      confluence: ['Daily R1', 'Weekly Pivot', 'Round Number']
    },
    {
      type: 'support',
      price: '475.50',
      strength: 'Moderate',
      confluence: ['Daily S1', 'VWAP']
    },
    {
      type: 'resistance',
      price: '482.75',
      strength: 'Weak',
      confluence: ['Previous High']
    }
  ];

  return (
    <Box className="technical-analysis" sx={{ p: 3, maxWidth: 1800, mx: 'auto' }}>
      <Card sx={{ mb: 3 }}>
        <Box sx={{ mb: 3 }}>
          <Typography variant="h4" gutterBottom>
            Technical Analysis
          </Typography>
          
          <Grid container spacing={3} alignItems="center">
            <Grid item xs={12} sm={4}>
              <Select
                fullWidth
                value={selectedStock}
                onChange={(e) => handleStockChange(e.target.value)}
                size="small"
              >
                {stockOptions.map((stock) => (
                  <MenuItem key={stock.symbol} value={stock.symbol}>
                    {stock.name} ({stock.symbol})
                  </MenuItem>
                ))}
              </Select>
            </Grid>
            
            <Grid item xs={12} sm={6}>
              <ToggleButtonGroup
                value={selectedTimeframe}
                exclusive
                onChange={(e, value) => value && handleTimeframeChange(value)}
                size="small"
              >
                {timeframes.map((timeframe) => (
                  <ToggleButton key={timeframe} value={timeframe}>
                    {timeframe}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Grid>
            
            <Grid item xs={12} sm={2}>
              <Button
                fullWidth
                variant="outlined"
                startIcon={<FilterListIcon />}
                onClick={handleFilterToggle}
              >
                Indicators
              </Button>
            </Grid>
          </Grid>
        </Box>

        <Grid container spacing={3}>
          {/* Main Chart Panel */}
          <Grid item xs={12} lg={8}>
            <Card>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                mb: 2 
              }}>
                <Typography variant="h6">
                  Price Action
                </Typography>
                <ShowChartIcon color="primary" />
              </Box>
              
              {loading && <LoadingState />}
              
              {error && (
                <ErrorState
                  message={error}
                  onRetry={() => {
                    setError(null);
                    setLoading(true);
                  }}
                />
              )}
              
              {!loading && !error && (
                <Box 
                  sx={{ 
                    height: 800,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    overflow: 'hidden'
                  }}
                >
                  <div id="tradingview_chart" className="tradingview-chart"></div>
                </Box>
              )}
            </Card>
          </Grid>

          {/* Side Panels */}
          <Grid item xs={12} lg={4}>
            <Grid container spacing={3}>
              {/* Technical Indicators Panel */}
              <Grid item xs={12}>
                <Card>
                  <Box sx={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    mb: 2 
                  }}>
                    <Typography variant="h6">
                      Technical Indicators
                    </Typography>
                    <TimelineIcon color="primary" />
                  </Box>
                  
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {technicalIndicators.map((indicator) => (
                      <Card 
                        key={indicator.name}
                        sx={{ 
                          p: 2,
                          '&:hover': {
                            bgcolor: 'action.hover'
                          }
                        }}
                      >
                        <Grid container spacing={2} alignItems="center">
                          <Grid item xs>
                            <Typography variant="subtitle1" fontWeight="medium">
                              {indicator.name}
                            </Typography>
                          </Grid>
                          <Grid item>
                            <Typography variant="body2" color="text.secondary">
                              {indicator.value}
                            </Typography>
                          </Grid>
                          <Grid item>
                            <Typography
                              variant="caption"
                              sx={{
                                px: 1,
                                py: 0.5,
                                borderRadius: 1,
                                bgcolor: (() => {
                                  switch (indicator.signal.toLowerCase()) {
                                    case 'bullish':
                                      return alpha(theme.palette.success.main, 0.1);
                                    case 'bearish':
                                      return alpha(theme.palette.error.main, 0.1);
                                    default:
                                      return alpha(theme.palette.warning.main, 0.1);
                                  }
                                })(),
                                color: (() => {
                                  switch (indicator.signal.toLowerCase()) {
                                    case 'bullish':
                                      return theme.palette.success.main;
                                    case 'bearish':
                                      return theme.palette.error.main;
                                    default:
                                      return theme.palette.warning.main;
                                  }
                                })(),
                              }}
                            >
                              {indicator.signal}
                            </Typography>
                          </Grid>
                        </Grid>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          {indicator.description}
                        </Typography>
                      </Card>
                    ))}
                  </Box>
                </Card>
              </Grid>

              {/* Key Levels Panel */}
              <Grid item xs={12}>
                <Card>
                  <Box sx={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    mb: 2 
                  }}>
                    <Typography variant="h6">
                      Key Levels
                    </Typography>
                    <ShowChartIcon color="primary" />
                  </Box>
                  
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {keyLevels.map((level, index) => (
                      <Card 
                        key={index}
                        sx={{ 
                          p: 2,
                          '&:hover': {
                            bgcolor: 'action.hover'
                          }
                        }}
                      >
                        <Grid container spacing={2} alignItems="center">
                          <Grid item xs>
                            <Typography variant="subtitle1" fontWeight="medium">
                              {level.type}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {level.confluence.join(', ')}
                            </Typography>
                          </Grid>
                          <Grid item>
                            <Typography 
                              variant="h6" 
                              fontFamily="monospace"
                              color="text.primary"
                            >
                              {level.price}
                            </Typography>
                          </Grid>
                          <Grid item>
                            <Typography
                              variant="caption"
                              sx={{
                                px: 1,
                                py: 0.5,
                                borderRadius: 1,
                                bgcolor: (() => {
                                  switch (level.strength.toLowerCase()) {
                                    case 'strong':
                                      return alpha(theme.palette.success.main, 0.1);
                                    case 'moderate':
                                      return alpha(theme.palette.warning.main, 0.1);
                                    default:
                                      return alpha(theme.palette.error.main, 0.1);
                                  }
                                })(),
                                color: (() => {
                                  switch (level.strength.toLowerCase()) {
                                    case 'strong':
                                      return theme.palette.success.main;
                                    case 'moderate':
                                      return theme.palette.warning.main;
                                    default:
                                      return theme.palette.error.main;
                                  }
                                })(),
                              }}
                            >
                              {level.strength}
                            </Typography>
                          </Grid>
                        </Grid>
                      </Card>
                    ))}
                  </Box>
                </Card>
              </Grid>

              {/* Chart Patterns Panel */}
              <Grid item xs={12}>
                <Card>
                  <Box sx={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    mb: 2 
                  }}>
                    <Typography variant="h6">
                      Chart Patterns
                    </Typography>
                    <TimelineIcon color="primary" />
                  </Box>
                  
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {patterns.map((pattern, index) => (
                      <Card 
                        key={index}
                        sx={{ 
                          p: 2,
                          cursor: 'pointer',
                          '&:hover': {
                            bgcolor: 'action.hover'
                          }
                        }}
                        onClick={() => handlePatternClick(pattern)}
                      >
                        <Grid container spacing={2}>
                          <Grid item xs={12}>
                            <Box sx={{ 
                              display: 'flex', 
                              justifyContent: 'space-between', 
                              alignItems: 'center',
                              mb: 1
                            }}>
                              <Typography variant="subtitle1" fontWeight="medium">
                                {pattern.name}
                              </Typography>
                              <Typography
                                variant="caption"
                                sx={{
                                  px: 1,
                                  py: 0.5,
                                  borderRadius: 1,
                                  bgcolor: (() => {
                                    switch (pattern.status.toLowerCase()) {
                                      case 'forming':
                                        return alpha(theme.palette.warning.main, 0.1);
                                      case 'confirmed':
                                        return alpha(theme.palette.success.main, 0.1);
                                      default:
                                        return alpha(theme.palette.info.main, 0.1);
                                    }
                                  })(),
                                  color: (() => {
                                    switch (pattern.status.toLowerCase()) {
                                      case 'forming':
                                        return theme.palette.warning.main;
                                      case 'confirmed':
                                        return theme.palette.success.main;
                                      default:
                                        return theme.palette.info.main;
                                    }
                                  })(),
                                }}
                              >
                                {pattern.status}
                              </Typography>
                            </Box>
                          </Grid>
                          
                          <Grid item xs={4}>
                            <Typography variant="caption" color="text.secondary">
                              Timeframe
                            </Typography>
                            <Typography variant="body2">
                              {pattern.timeframe}
                            </Typography>
                          </Grid>
                          
                          <Grid item xs={4}>
                            <Typography variant="caption" color="text.secondary">
                              Confidence
                            </Typography>
                            <Typography variant="body2">
                              {pattern.confidence}%
                            </Typography>
                          </Grid>
                          
                          <Grid item xs={4}>
                            <Typography variant="caption" color="text.secondary">
                              Target
                            </Typography>
                            <Typography variant="body2" fontFamily="monospace">
                              {pattern.target}
                            </Typography>
                          </Grid>
                        </Grid>
                      </Card>
                    ))}
                  </Box>
                </Card>
              </Grid>

              {/* Volume Profile Panel */}
              <Grid item xs={12}>
                <Card>
                  <Box sx={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    mb: 2 
                  }}>
                    <Typography variant="h6">
                      Volume Profile
                    </Typography>
                    <TimelineIcon color="primary" />
                  </Box>
                  
                  <Box sx={{ p: 2 }}>
                    <Grid container spacing={3}>
                      <Grid item xs={12} sm={6}>
                        <Box sx={{ 
                          display: 'flex', 
                          flexDirection: 'column',
                          gap: 2
                        }}>
                          <Box>
                            <Typography variant="caption" color="text.secondary">
                              Point of Control
                            </Typography>
                            <Typography variant="h6" fontFamily="monospace">
                              {volumeProfile.poc}
                            </Typography>
                          </Box>
                          
                          <Box>
                            <Typography variant="caption" color="text.secondary">
                              Value Area High
                            </Typography>
                            <Typography variant="h6" fontFamily="monospace">
                              {volumeProfile.valueAreaHigh}
                            </Typography>
                          </Box>
                          
                          <Box>
                            <Typography variant="caption" color="text.secondary">
                              Value Area Low
                            </Typography>
                            <Typography variant="h6" fontFamily="monospace">
                              {volumeProfile.valueAreaLow}
                            </Typography>
                          </Box>
                        </Box>
                      </Grid>
                      
                      <Grid item xs={12} sm={6}>
                        <Box sx={{ 
                          display: 'flex', 
                          flexDirection: 'column',
                          height: '100%',
                          justifyContent: 'center',
                          alignItems: 'center',
                          gap: 1
                        }}>
                          <Typography variant="caption" color="text.secondary">
                            Distribution
                          </Typography>
                          <Typography 
                            variant="h5" 
                            color="primary"
                            fontWeight="medium"
                          >
                            {volumeProfile.distribution}
                          </Typography>
                        </Box>
                      </Grid>
                    </Grid>
                  </Box>
                </Card>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </Card>
    </Box>
  );
}

export default TechnicalAnalysis; 