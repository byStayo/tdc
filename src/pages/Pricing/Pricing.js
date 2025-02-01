import React from 'react';
import {
  Box,
  Grid,
  Typography,
  useTheme,
  Chip,
  Divider,
  Container
} from '@mui/material';
import {
  Check as CheckIcon,
  Security as SecurityIcon,
  Update as UpdateIcon,
  ExitToApp as ExitToAppIcon
} from '@mui/icons-material';
import { Card, Button } from '../../components/shared';
import './Pricing.css';

function Pricing() {
  const theme = useTheme();

  const features = [
    'Daily Consensus Report',
    'Major Index Buy/Sell Signals',
    '7 Individual Bias Reports',
    'Institutional Trader & AI Analytics',
    'Smart Money Flows',
    'Darkpool Positioning',
    'Technical Analysis',
    'Media Bias Analysis',
    'Major Support/Resistance Levels',
    'Gamma Levels',
    'Conviction Levels',
    'Education Resources'
  ];

  const plans = [
    {
      name: 'Weekly',
      price: 19,
      period: 'week',
      discount: null,
      features: features
    },
    {
      name: 'Monthly',
      price: 38,
      period: 'month',
      discount: '50% OFF',
      features: features,
      popular: true
    },
    {
      name: 'Yearly',
      price: 349,
      period: 'year',
      discount: '60% OFF',
      features: features
    }
  ];

  const guarantees = [
    {
      title: '1-Month ROI Guarantee',
      description: 'See positive returns in your first month or get your money back',
      icon: SecurityIcon
    },
    {
      title: 'Continuous Updates',
      description: 'New features and improvements added regularly at no extra cost',
      icon: UpdateIcon
    },
    {
      title: 'Cancel Anytime',
      description: 'No long-term commitment required - cancel your subscription whenever you want',
      icon: ExitToAppIcon
    }
  ];

  return (
    <Box sx={{ py: 8, backgroundColor: theme.palette.background.default }}>
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', mb: 8 }}>
          <Typography variant="h3" component="h1" sx={{ mb: 2, fontWeight: 600 }}>
            Choose Your Trading Edge
          </Typography>
          <Typography variant="h6" color="text.secondary">
            All plans include our ROI guarantee - see results or get your money back
          </Typography>
        </Box>

        <Grid container spacing={4} sx={{ mb: 8 }}>
          {plans.map((plan, index) => (
            <Grid item xs={12} md={4} key={index}>
              <Card
                sx={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  position: 'relative',
                  ...(plan.popular && {
                    borderColor: theme.palette.primary.main,
                    boxShadow: `0 0 0 2px ${theme.palette.primary.main}`
                  })
                }}
              >
                {plan.popular && (
                  <Chip
                    label="Most Popular"
                    color="primary"
                    sx={{
                      position: 'absolute',
                      top: -12,
                      right: 24,
                      height: 24
                    }}
                  />
                )}

                <Box sx={{ p: 3 }}>
                  <Typography variant="h5" component="h2" sx={{ mb: 2, fontWeight: 600 }}>
                    {plan.name}
                  </Typography>

                  <Box sx={{ display: 'flex', alignItems: 'baseline', mb: 2 }}>
                    <Typography variant="h3" component="span" sx={{ fontWeight: 700 }}>
                      ${plan.price}
                    </Typography>
                    <Typography variant="subtitle1" color="text.secondary" sx={{ ml: 1 }}>
                      /{plan.period}
                    </Typography>
                  </Box>

                  {plan.discount && (
                    <Chip
                      label={plan.discount}
                      color="success"
                      variant="outlined"
                      size="small"
                      sx={{ mb: 2 }}
                    />
                  )}

                  <Divider sx={{ my: 3 }} />

                  <Box sx={{ mb: 3 }}>
                    {features.map((feature, featureIndex) => (
                      <Box
                        key={featureIndex}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          mb: 1.5
                        }}
                      >
                        <CheckIcon
                          sx={{
                            mr: 1.5,
                            color: theme.palette.success.main,
                            fontSize: 20
                          }}
                        />
                        <Typography variant="body2">{feature}</Typography>
                      </Box>
                    ))}
                  </Box>

                  <Box sx={{ mt: 'auto' }}>
                    <Button
                      variant="contained"
                      fullWidth
                      size="large"
                      color={plan.popular ? 'primary' : 'inherit'}
                    >
                      Get Started
                    </Button>
                  </Box>
                </Box>
              </Card>
            </Grid>
          ))}
        </Grid>

        <Box sx={{ textAlign: 'center', mb: 6 }}>
          <Typography variant="h4" component="h2" sx={{ mb: 4, fontWeight: 600 }}>
            Our Guarantees
          </Typography>
          <Grid container spacing={4}>
            {guarantees.map((guarantee, index) => {
              const GuaranteeIcon = guarantee.icon;
              return (
                <Grid item xs={12} md={4} key={index}>
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      textAlign: 'center'
                    }}
                  >
                    <Box
                      sx={{
                        width: 64,
                        height: 64,
                        borderRadius: '50%',
                        backgroundColor: theme.palette.primary.main + '20',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        mb: 2
                      }}
                    >
                      <GuaranteeIcon
                        sx={{
                          fontSize: 32,
                          color: theme.palette.primary.main
                        }}
                      />
                    </Box>
                    <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
                      {guarantee.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {guarantee.description}
                    </Typography>
                  </Box>
                </Grid>
              );
            })}
          </Grid>
        </Box>
      </Container>
    </Box>
  );
}

export default Pricing; 