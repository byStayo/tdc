import React from 'react';
import { Link } from 'react-router-dom';
import {
  Box,
  Container,
  Grid,
  Typography,
  useTheme,
  alpha
} from '@mui/material';
import {
  ShowChart as ShowChartIcon,
  Newspaper as NewspaperIcon,
  SmartToy as SmartToyIcon,
  TrendingUp as TrendingUpIcon,
  AccountBalance as AccountBalanceIcon,
  BarChart as BarChartIcon,
  Security as SecurityIcon,
  MonetizationOn as MonetizationOnIcon,
  AssignmentTurnedIn as AssignmentTurnedInIcon
} from '@mui/icons-material';
import { Card, Button } from '../../components/shared';
import './Home.css';

function Home() {
  const theme = useTheme();

  const features = [
    {
      icon: ShowChartIcon,
      title: 'Professional Trader Analysis',
      description: 'Get insights from institutional traders with 38+ years of experience'
    },
    {
      icon: NewspaperIcon,
      title: 'Media Analysis',
      description: 'Track FinTwit, Jim Cramer, Nancy Pelosi trades, and more'
    },
    {
      icon: SmartToyIcon,
      title: 'A.I. Analysis',
      description: 'Unbiased, math-based predictions powered by advanced algorithms'
    },
    {
      icon: TrendingUpIcon,
      title: 'Support/Resistance Levels',
      description: 'Key price levels from technical patterns and derivatives market'
    },
    {
      icon: AccountBalanceIcon,
      title: 'Smart Money Analysis',
      description: 'Track Darkpool activity and Gamma levels'
    },
    {
      icon: BarChartIcon,
      title: 'Technical Analysis',
      description: 'TPO, Market Profile, Elliott Waves, MMA, Williams AD, and more'
    }
  ];

  const guarantees = [
    {
      icon: MonetizationOnIcon,
      title: 'Pays for Itself',
      description: 'Our analysis and signals provide value that exceeds your investment'
    },
    {
      icon: SecurityIcon,
      title: '1-Month ROI Guarantee',
      description: 'See positive returns in your first month or get your money back'
    },
    {
      icon: AssignmentTurnedInIcon,
      title: 'Money Back Guarantee',
      description: 'Not satisfied? Get a full refund, no questions asked'
    }
  ];

  return (
    <div className="home">
      {/* Hero Section */}
      <Box
        className="home-hero"
        sx={{
          background: `linear-gradient(45deg, ${theme.palette.primary.dark}, ${theme.palette.primary.main})`,
          color: 'white',
          position: 'relative',
          overflow: 'hidden',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: `radial-gradient(circle at 20% 150%, ${alpha(theme.palette.common.white, 0.1)} 0%, transparent 50%)`,
          }
        }}
      >
        <Container maxWidth="lg">
          <Typography
            variant="h2"
            component="h1"
            sx={{
              fontWeight: 700,
              fontSize: { xs: '2.5rem', md: '3.75rem' },
              lineHeight: 1.2
            }}
          >
            Stop Guessing and Start Trading with Certainty
          </Typography>
          <Typography
            variant="h5"
            sx={{
              color: alpha(theme.palette.common.white, 0.8),
              fontWeight: 400,
              mb: 4
            }}
          >
            Your Trade Conviction is a Few Clicks Away
          </Typography>
          <Button
            component={Link}
            to="/pricing"
            variant="contained"
            color="secondary"
            size="large"
            sx={{
              py: 2,
              px: 4,
              fontSize: '1.125rem',
              fontWeight: 600,
              textTransform: 'none'
            }}
          >
            Start Trading Confidently
          </Button>
        </Container>
      </Box>

      {/* Features Section */}
      <Box className="home-features" sx={{ backgroundColor: theme.palette.background.default }}>
        <Container maxWidth="lg">
          <Typography
            variant="h3"
            component="h2"
            sx={{
              textAlign: 'center',
              mb: 8,
              fontWeight: 600
            }}
          >
            Why Choose The Daily Consensus
          </Typography>
          <Grid container spacing={4}>
            {features.map((feature, index) => {
              const FeatureIcon = feature.icon;
              return (
                <Grid item xs={12} sm={6} md={4} key={index}>
                  <Card className="home-feature">
                    <Box
                      sx={{
                        width: 80,
                        height: 80,
                        borderRadius: '50%',
                        backgroundColor: theme.palette.primary.main + '20',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        mb: 3
                      }}
                    >
                      <FeatureIcon
                        sx={{
                          fontSize: 40,
                          color: theme.palette.primary.main
                        }}
                      />
                    </Box>
                    <Typography
                      variant="h5"
                      component="h3"
                      sx={{ fontWeight: 600 }}
                    >
                      {feature.title}
                    </Typography>
                    <Typography
                      variant="body1"
                      color="text.secondary"
                    >
                      {feature.description}
                    </Typography>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        </Container>
      </Box>

      {/* Guarantees Section */}
      <Box
        className="home-cta"
        sx={{
          backgroundColor: alpha(theme.palette.primary.main, 0.04)
        }}
      >
        <Container maxWidth="lg">
          <Typography
            variant="h3"
            component="h2"
            sx={{
              textAlign: 'center',
              mb: 8,
              fontWeight: 600
            }}
          >
            Our Guarantees
          </Typography>
          <Grid container spacing={4}>
            {guarantees.map((guarantee, index) => {
              const GuaranteeIcon = guarantee.icon;
              return (
                <Grid item xs={12} sm={6} md={4} key={index}>
                  <Card className="home-feature">
                    <Box
                      sx={{
                        width: 80,
                        height: 80,
                        borderRadius: '50%',
                        backgroundColor: theme.palette.secondary.main + '20',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        mb: 3
                      }}
                    >
                      <GuaranteeIcon
                        sx={{
                          fontSize: 40,
                          color: theme.palette.secondary.main
                        }}
                      />
                    </Box>
                    <Typography
                      variant="h5"
                      component="h3"
                      sx={{ fontWeight: 600 }}
                    >
                      {guarantee.title}
                    </Typography>
                    <Typography
                      variant="body1"
                      color="text.secondary"
                    >
                      {guarantee.description}
                    </Typography>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        </Container>
      </Box>
    </div>
  );
}

export default Home; 