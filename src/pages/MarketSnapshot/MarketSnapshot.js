import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Grid,
  TextField,
  IconButton,
  Typography,
  useTheme,
  alpha,
  Chip,
  Fade,
  Tooltip,
  InputAdornment,
  Divider,
  Paper
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  Refresh as RefreshIcon,
  Search as SearchIcon,
  Info as InfoIcon,
  ErrorOutline as ErrorOutlineIcon
} from '@mui/icons-material';
import { Card, Button, LoadingState, ErrorState } from '../../components/shared';
import polygonService from '../../services/polygonService';
import './MarketSnapshot.css';

const DEFAULT_TICKERS = [
  'AAPL',                    // Stocks
  'O:SPY250321C00380000',   // Options
  'I:SPX',                  // Indices
  'C:EURUSD',              // Forex
  'X:BTCUSD'               // Crypto
];

const ASSET_TYPE_INFO = {
  STOCKS: 'Regular stocks (e.g., AAPL)',
  OPTIONS: 'Options with format O:SYMBOL (e.g., O:SPY250321C00380000)',
  INDICES: 'Market indices with format I:SYMBOL (e.g., I:SPX)',
  FOREX: 'Forex pairs with format C:SYMBOL (e.g., C:EURUSD)',
  CRYPTO: 'Cryptocurrencies with format X:SYMBOL (e.g., X:BTCUSD)'
};

function MarketSnapshot() {
  const theme = useTheme();
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tickers, setTickers] = useState(DEFAULT_TICKERS);
  const [newTicker, setNewTicker] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const fetchSnapshots = useCallback(async () => {
    try {
      setRefreshing(true);
      setError(null);
      const data = await polygonService.getUniversalSnapshot(tickers);
      setSnapshots(data);
    } catch (err) {
      setError('Failed to fetch market snapshots. Please try again.');
      console.error('Error:', err);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [tickers]);

  useEffect(() => {
    fetchSnapshots();
    const interval = setInterval(fetchSnapshots, 60000); // Update every minute
    return () => clearInterval(interval);
  }, [fetchSnapshots]);

  const handleAddTicker = (e) => {
    e.preventDefault();
    if (newTicker && !tickers.includes(newTicker)) {
      setTickers([...tickers, newTicker.toUpperCase()]);
      setNewTicker('');
    }
  };

  const handleRemoveTicker = (tickerToRemove) => {
    setTickers(tickers.filter(t => t !== tickerToRemove));
  };

  const formatChange = (change, changePercent) => {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)} (${sign}${changePercent.toFixed(2)}%)`;
  };

  const renderSnapshot = (snapshot) => {
    const { type, ticker, name, market_status, session } = snapshot;
    const isPositive = session.change >= 0;
    
    return (
      <Grid item xs={12} sm={6} md={4} key={ticker}>
        <Card
          className={`snapshot-card ${type.toLowerCase()}`}
          sx={{
            position: 'relative',
            height: '100%'
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" component="h3">
                {name}
              </Typography>
              <Tooltip title={`${type} - ${ASSET_TYPE_INFO[type.toUpperCase()]}`}>
                <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
              </Tooltip>
            </Box>
            <Chip
              label={market_status}
              color={market_status === 'open' ? 'success' : 'default'}
              size="small"
              sx={{ textTransform: 'capitalize' }}
            />
          </Box>

          <Box sx={{ mb: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="h5" component="span" sx={{ fontWeight: 600 }}>
                {ticker}
              </Typography>
              <Chip
                label={type}
                variant="outlined"
                size="small"
                sx={{ textTransform: 'uppercase' }}
              />
            </Box>
            
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="h4" component="div" sx={{ fontWeight: 700 }}>
                {session.price || session.close}
              </Typography>
              <Typography
                variant="body1"
                sx={{
                  color: isPositive ? 'success.main' : 'error.main',
                  fontWeight: 600,
                  bgcolor: isPositive ? alpha(theme.palette.success.main, 0.1) : alpha(theme.palette.error.main, 0.1),
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  display: 'inline-block'
                }}
              >
                {formatChange(session.change, session.change_percent)}
              </Typography>
            </Box>
          </Box>

          <Divider sx={{ my: 2 }} />

          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Typography variant="body2" color="text.secondary">Open</Typography>
              <Typography variant="body1" sx={{ fontWeight: 500 }}>{session.open}</Typography>
            </Grid>
            <Grid item xs={6}>
              <Typography variant="body2" color="text.secondary">High</Typography>
              <Typography variant="body1" sx={{ fontWeight: 500 }}>{session.high}</Typography>
            </Grid>
            <Grid item xs={6}>
              <Typography variant="body2" color="text.secondary">Low</Typography>
              <Typography variant="body1" sx={{ fontWeight: 500 }}>{session.low}</Typography>
            </Grid>
            <Grid item xs={6}>
              <Typography variant="body2" color="text.secondary">Volume</Typography>
              <Typography variant="body1" sx={{ fontWeight: 500 }}>
                {session.volume?.toLocaleString() || 'N/A'}
              </Typography>
            </Grid>
          </Grid>

          <IconButton
            size="small"
            onClick={() => handleRemoveTicker(ticker)}
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              color: 'text.secondary',
              '&:hover': {
                color: 'error.main',
                bgcolor: alpha(theme.palette.error.main, 0.1),
              },
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Card>
      </Grid>
    );
  };

  return (
    <Box className="market-snapshot-page">
      <Box sx={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        mb: 4,
        gap: 2
      }}>
        <Typography variant="h4" component="h1" sx={{ 
          fontWeight: 700,
          color: 'text.primary'
        }}>
          Market Snapshot
        </Typography>
        <Tooltip title="Refresh data">
          <IconButton
            onClick={fetchSnapshots}
            disabled={loading || refreshing}
            sx={{ 
              bgcolor: alpha(theme.palette.primary.main, 0.1),
              color: 'primary.main',
              '&:hover': { 
                bgcolor: alpha(theme.palette.primary.main, 0.2)
              },
              '&:disabled': {
                bgcolor: alpha(theme.palette.action.disabled, 0.1),
                color: 'action.disabled'
              }
            }}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Paper 
        elevation={0} 
        className="search-section"
      >
        <form onSubmit={handleAddTicker}>
          <Box sx={{ 
            display: 'flex', 
            gap: 2,
            alignItems: 'center'
          }}>
            <TextField
              fullWidth
              id="newTicker"
              label="Add Asset"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
              placeholder="Enter ticker (e.g., AAPL, X:BTCUSD)"
              size="small"
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  '&:hover fieldset': {
                    borderColor: 'primary.main',
                  },
                },
              }}
            />
            <Button
              type="submit"
              variant="contained"
              startIcon={<AddIcon />}
              disabled={!newTicker || loading}
              sx={{
                minWidth: '100px',
                height: '40px',
                textTransform: 'none',
                fontWeight: 600
              }}
            >
              Add
            </Button>
          </Box>
        </form>
      </Paper>

      {loading ? (
        <Box className="loading-container">
          <LoadingState />
        </Box>
      ) : error ? (
        <Box className="error-container">
          <ErrorState 
            message={error}
            retryable={true}
            onRetry={fetchSnapshots}
          />
        </Box>
      ) : (
        <Fade in={true}>
          <Grid container spacing={3} sx={{ mt: 1 }}>
            {snapshots.map(renderSnapshot)}
          </Grid>
        </Fade>
      )}
    </Box>
  );
}

export default MarketSnapshot; 