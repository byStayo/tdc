import React, { useState } from 'react';
import { Grid, Box, Typography, useTheme, Fade, Tooltip, IconButton } from '@mui/material';
import { InfoOutlined as InfoIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { Card, Chart, DataTable, LoadingState, ErrorState } from '../../components/shared';
import './Overview.css';

function Overview() {
  const theme = useTheme();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [convictionData] = useState([
    { id: 1, type: 'Strong Buy', strength: 0.9, description: 'Based on technical and fundamental analysis' },
    { id: 2, type: 'Buy', strength: 0.7, description: 'Momentum indicators suggest upward trend' },
    { id: 3, type: 'Hold', strength: 0.5, description: 'Market conditions are neutral' },
    { id: 4, type: 'Sell', strength: 0.3, description: 'Risk factors indicate caution' },
    { id: 5, type: 'Strong Sell', strength: 0.1, description: 'Multiple indicators suggest downward pressure' }
  ]);

  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    // Simulate data fetching
    setTimeout(() => {
      setLoading(false);
    }, 1000);
  };

  const convictionColumns = [
    { field: 'type', headerName: 'Signal Type', flex: 1 },
    { field: 'strength', headerName: 'Conviction', flex: 1,
      renderCell: (params) => (
        <Box sx={{ width: '100%', display: 'flex', alignItems: 'center' }}>
          <Box
            sx={{
              width: `${params.value * 100}%`,
              height: 8,
              bgcolor: theme.palette.primary.main,
              borderRadius: 1
            }}
          />
          <Typography variant="body2" sx={{ ml: 1 }}>
            {(params.value * 100).toFixed(0)}%
          </Typography>
        </Box>
      )
    },
    { field: 'description', headerName: 'Description', flex: 2 }
  ];

  return (
    <Box className="overview-page">
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" component="h1">
          Market Overview
        </Typography>
        <Tooltip title="Refresh data">
          <IconButton
            onClick={handleRefresh}
            disabled={loading}
            sx={{ 
              bgcolor: theme.palette.action.hover,
              '&:hover': { bgcolor: theme.palette.action.selected }
            }}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      {loading ? (
        <LoadingState message="Loading market data..." />
      ) : error ? (
        <ErrorState message={error} retryable onRetry={handleRefresh} />
      ) : (
        <Fade in={!loading}>
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <Card>
                <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  Conviction Levels
                  <Tooltip title="Signals from institutional traders with 38+ years of experience">
                    <InfoIcon fontSize="small" sx={{ opacity: 0.5 }} />
                  </Tooltip>
                </Typography>
                <DataTable
                  data={convictionData}
                  columns={convictionColumns}
                  pageSize={5}
                  autoHeight
                />
              </Card>
            </Grid>
          </Grid>
        </Fade>
      )}
    </Box>
  );
}

export default Overview; 