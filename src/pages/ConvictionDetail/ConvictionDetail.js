import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Grid,
  Typography,
  Button,
  Card,
  CardContent,
  CardHeader,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  useTheme,
  alpha,
  Divider
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import TimelineIcon from '@mui/icons-material/Timeline';
import InfoIcon from '@mui/icons-material/Info';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import PeopleIcon from '@mui/icons-material/People';
import './ConvictionDetail.css';

// Dummy data for demonstration
const convictionData = {
  'high': {
    title: 'High Conviction',
    description: 'Signals with the highest probability of success based on multiple confirming factors including technical, fundamental, and institutional analysis.',
    historicalPerformance: {
      winRate: 85,
      avgReturn: 12.5,
      totalTrades: 245,
      successStreak: 12
    },
    expertInsights: [
      {
        expert: 'John Smith',
        position: 'Senior Market Analyst',
        comment: 'High conviction setups consistently show the best risk-reward ratios across all market conditions.',
        date: '2024-03-15'
      },
      {
        expert: 'Sarah Johnson',
        position: 'Head of Technical Analysis',
        comment: 'These signals typically align with major institutional positioning and key technical levels.',
        date: '2024-03-14'
      }
    ]
  },
  'medium': {
    title: 'Medium Conviction',
    description: 'Signals with strong potential based on a combination of technical and fundamental factors, though with fewer confirming signals than high conviction setups.',
    historicalPerformance: {
      winRate: 72,
      avgReturn: 8.3,
      totalTrades: 386,
      successStreak: 8
    },
    expertInsights: [
      {
        expert: 'Mike Wilson',
        position: 'Market Strategist',
        comment: 'Medium conviction trades offer a good balance of frequency and reliability.',
        date: '2024-03-15'
      }
    ]
  },
  'low': {
    title: 'Low Conviction',
    description: 'Early-stage signals that show potential but require additional confirmation. These often serve as watchlist candidates for higher conviction setups.',
    historicalPerformance: {
      winRate: 58,
      avgReturn: 5.2,
      totalTrades: 524,
      successStreak: 5
    },
    expertInsights: [
      {
        expert: 'Lisa Chen',
        position: 'Quantitative Analyst',
        comment: 'Low conviction signals can develop into higher probability setups with patience and confirmation.',
        date: '2024-03-13'
      }
    ]
  }
};

function ConvictionDetail() {
  const theme = useTheme();
  const { level } = useParams();
  const navigate = useNavigate();
  const [timeframe, setTimeframe] = useState('1M');

  const data = convictionData[level?.toLowerCase()] || {};
  const timeframes = ['1W', '1M', '3M', '6M', '1Y', 'ALL'];

  const handleTimeframeChange = (event, newTimeframe) => {
    if (newTimeframe !== null) {
      setTimeframe(newTimeframe);
      console.log(`Timeframe changed to: ${newTimeframe}`);
    }
  };

  const getStatColor = (value, type) => {
    switch (type) {
      case 'winRate':
        return value >= 80 ? theme.palette.success.main : 
               value >= 60 ? theme.palette.warning.main : 
               theme.palette.error.main;
      case 'avgReturn':
        return value >= 10 ? theme.palette.success.main :
               value >= 5 ? theme.palette.warning.main :
               theme.palette.error.main;
      default:
        return theme.palette.text.primary;
    }
  };

  return (
    <Box className="conviction-detail" sx={{ p: 3 }}>
      <Box sx={{ mb: 4 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/dashboard')}
          sx={{ mb: 2 }}
        >
          Back to Overview
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          {data.title}
        </Typography>
      </Box>

      <Grid container spacing={3}>
        {/* Overview Section */}
        <Grid item xs={12}>
          <Card>
            <CardHeader
              title="Overview"
              action={
                <IconButton>
                  <InfoIcon />
                </IconButton>
              }
            />
            <CardContent>
              <Typography paragraph>
                {data.description}
              </Typography>
              <Box sx={{ mt: 2 }}>
                <ToggleButtonGroup
                  value={timeframe}
                  exclusive
                  onChange={handleTimeframeChange}
                  aria-label="timeframe selection"
                >
                  {timeframes.map((tf) => (
                    <ToggleButton key={tf} value={tf}>
                      {tf}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Historical Performance */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardHeader
              title="Historical Performance"
              action={
                <IconButton>
                  <TimelineIcon />
                </IconButton>
              }
            />
            <CardContent>
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Tooltip title="Percentage of profitable trades">
                    <Card variant="outlined">
                      <CardContent>
                        <Typography variant="caption" color="textSecondary">
                          Win Rate
                        </Typography>
                        <Typography 
                          variant="h5"
                          sx={{ color: getStatColor(data.historicalPerformance?.winRate, 'winRate') }}
                        >
                          {data.historicalPerformance?.winRate}%
                        </Typography>
                      </CardContent>
                    </Card>
                  </Tooltip>
                </Grid>
                <Grid item xs={6}>
                  <Tooltip title="Average return per trade">
                    <Card variant="outlined">
                      <CardContent>
                        <Typography variant="caption" color="textSecondary">
                          Avg. Return
                        </Typography>
                        <Typography 
                          variant="h5"
                          sx={{ color: getStatColor(data.historicalPerformance?.avgReturn, 'avgReturn') }}
                        >
                          {data.historicalPerformance?.avgReturn}%
                        </Typography>
                      </CardContent>
                    </Card>
                  </Tooltip>
                </Grid>
                <Grid item xs={6}>
                  <Tooltip title="Total number of trades taken">
                    <Card variant="outlined">
                      <CardContent>
                        <Typography variant="caption" color="textSecondary">
                          Total Trades
                        </Typography>
                        <Typography variant="h5">
                          {data.historicalPerformance?.totalTrades}
                        </Typography>
                      </CardContent>
                    </Card>
                  </Tooltip>
                </Grid>
                <Grid item xs={6}>
                  <Tooltip title="Current streak of successful trades">
                    <Card variant="outlined">
                      <CardContent>
                        <Typography variant="caption" color="textSecondary">
                          Success Streak
                        </Typography>
                        <Typography variant="h5">
                          {data.historicalPerformance?.successStreak}
                        </Typography>
                      </CardContent>
                    </Card>
                  </Tooltip>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        {/* Performance Chart */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardHeader
              title="Performance Chart"
              action={
                <IconButton>
                  <TrendingUpIcon />
                </IconButton>
              }
            />
            <CardContent>
              <Box sx={{ height: 300 }}>
                {/* TradingView chart will be integrated here */}
                <div id="conviction_chart"></div>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Expert Insights */}
        <Grid item xs={12}>
          <Card>
            <CardHeader
              title="Expert Insights"
              action={
                <IconButton>
                  <PeopleIcon />
                </IconButton>
              }
            />
            <CardContent>
              <Grid container spacing={2}>
                {data.expertInsights?.map((insight, index) => (
                  <Grid item xs={12} key={index}>
                    <Card variant="outlined">
                      <CardContent>
                        <Box sx={{ 
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          mb: 1
                        }}>
                          <Box>
                            <Typography variant="subtitle1">
                              {insight.expert}
                            </Typography>
                            <Typography variant="caption" color="textSecondary">
                              {insight.position}
                            </Typography>
                          </Box>
                          <Typography variant="caption" color="textSecondary">
                            {insight.date}
                          </Typography>
                        </Box>
                        <Divider sx={{ my: 1 }} />
                        <Typography variant="body2">
                          {insight.comment}
                        </Typography>
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}

export default ConvictionDetail; 