import React, { useState } from 'react';
import {
  Box,
  Typography,
  Grid,
  TextField,
  Slider,
  InputAdornment,
  IconButton,
  Tooltip,
  Stack,
  Chip
} from '@mui/material';
import {
  Search as SearchIcon,
  FilterList as FilterListIcon,
  Info as InfoIcon,
  Refresh as RefreshIcon
} from '@mui/icons-material';
import { Card, LoadingState, ErrorState } from '../../components/shared';
import './OptionsScreener.css';

function OptionsScreener() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ticker, setTicker] = useState('');
  const [filters, setFilters] = useState({
    maxStrike: 100,
    minDelta: 0.3,
    maxTheta: -0.1,
    minVolume: 100
  });

  const handleTickerChange = (event) => {
    setTicker(event.target.value.toUpperCase());
  };

  const handleFilterChange = (filter) => (event, value) => {
    setFilters(prev => ({
      ...prev,
      [filter]: value
    }));
  };

  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    // Simulate data fetching
    setTimeout(() => {
      setLoading(false);
    }, 1000);
  };

  return (
    <Box className="options-screener-page">
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" component="h1">
          Options Screener
        </Typography>
        <Tooltip title="Refresh data">
          <IconButton
            onClick={handleRefresh}
            disabled={loading}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Card>
        <Grid container spacing={3}>
          <Grid item xs={12} sm={6}>
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

          <Grid item xs={12}>
            <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              Filters
              <Tooltip title="Adjust filters to find options matching your criteria">
                <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
              </Tooltip>
            </Typography>
            <Grid container spacing={3}>
              <Grid item xs={12} sm={6}>
                <Typography variant="body2" gutterBottom>
                  Maximum Strike Price
                </Typography>
                <Slider
                  value={filters.maxStrike}
                  onChange={handleFilterChange('maxStrike')}
                  min={0}
                  max={500}
                  step={10}
                  valueLabelDisplay="auto"
                  marks={[
                    { value: 0, label: '$0' },
                    { value: 250, label: '$250' },
                    { value: 500, label: '$500' }
                  ]}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <Typography variant="body2" gutterBottom>
                  Minimum Delta
                </Typography>
                <Slider
                  value={filters.minDelta}
                  onChange={handleFilterChange('minDelta')}
                  min={0}
                  max={1}
                  step={0.1}
                  valueLabelDisplay="auto"
                  marks={[
                    { value: 0, label: '0' },
                    { value: 0.5, label: '0.5' },
                    { value: 1, label: '1' }
                  ]}
                />
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </Card>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
          <LoadingState message="Loading options data..." />
        </Box>
      ) : error ? (
        <Box sx={{ maxWidth: 600, mx: 'auto' }}>
          <ErrorState
            message={error}
            retryable
            onRetry={handleRefresh}
          />
        </Box>
      ) : (
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" gutterBottom>
            No options found. Enter a ticker symbol to start screening.
          </Typography>
        </Box>
      )}
    </Box>
  );
}

export default OptionsScreener; 