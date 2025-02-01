import React from 'react';
import { Card as MuiCard, CardContent, Typography, Box, useTheme, alpha } from '@mui/material';
import PropTypes from 'prop-types';

const Card = ({ 
  title,
  subtitle,
  children,
  elevation = 0,
  className = '',
  contentClassName = '',
  headerClassName = '',
  noPadding = false,
  onClick,
  variant = 'default',
  loading = false,
  error = false,
  ...props 
}) => {
  const theme = useTheme();

  const getVariantStyles = () => {
    switch (variant) {
      case 'outlined':
        return {
          border: `1px solid ${theme.palette.divider}`,
          '&:hover': onClick && {
            borderColor: theme.palette.primary.main,
            backgroundColor: alpha(theme.palette.primary.main, 0.02),
          },
        };
      case 'elevated':
        return {
          backgroundColor: theme.palette.background.elevated,
          boxShadow: theme.shadows[elevation],
        };
      case 'gradient':
        return {
          background: `linear-gradient(45deg, ${alpha(theme.palette.primary.main, 0.05)}, ${alpha(theme.palette.secondary.main, 0.05)})`,
          '&:hover': onClick && {
            background: `linear-gradient(45deg, ${alpha(theme.palette.primary.main, 0.08)}, ${alpha(theme.palette.secondary.main, 0.08)})`,
          },
        };
      default:
        return {
          backgroundColor: theme.palette.background.card,
        };
    }
  };

  return (
    <MuiCard
      elevation={elevation}
      className={`shared-card ${className}`}
      onClick={onClick}
      sx={{
        position: 'relative',
        borderRadius: 2,
        overflow: 'hidden',
        ...getVariantStyles(),
        transition: theme.transitions.create([
          'box-shadow',
          'transform',
          'background-color',
          'border-color'
        ], {
          duration: theme.transitions.duration.short
        }),
        '&:hover': onClick && {
          transform: 'translateY(-2px)',
          boxShadow: variant === 'elevated' ? theme.shadows[elevation + 2] : 'none',
        },
        ...(error && {
          borderColor: theme.palette.error.main,
          backgroundColor: alpha(theme.palette.error.main, 0.02),
        }),
        ...(loading && {
          '&::after': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: `linear-gradient(90deg, transparent 25%, ${alpha(theme.palette.primary.main, 0.05)} 50%, transparent 75%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 2s infinite',
            '@keyframes shimmer': {
              '0%': {
                backgroundPosition: '200% 0',
              },
              '100%': {
                backgroundPosition: '-200% 0',
              },
            },
          },
        }),
      }}
      {...props}
    >
      {(title || subtitle) && (
        <Box 
          className={`shared-card-header ${headerClassName}`}
          sx={{ 
            p: 2.5,
            pb: subtitle ? 2 : noPadding ? 2.5 : 0,
            borderBottom: subtitle ? `1px solid ${theme.palette.divider}` : 'none'
          }}
        >
          {title && (
            <Typography 
              variant="h6" 
              component="h2" 
              gutterBottom={!!subtitle}
              sx={{
                fontWeight: 600,
                color: error ? theme.palette.error.main : 'text.primary',
                transition: theme.transitions.create('color'),
              }}
            >
              {title}
            </Typography>
          )}
          {subtitle && (
            <Typography 
              variant="body2" 
              color={error ? 'error' : 'text.secondary'}
              sx={{
                transition: theme.transitions.create('color'),
                opacity: loading ? 0.7 : 1,
              }}
            >
              {subtitle}
            </Typography>
          )}
        </Box>
      )}
      
      <CardContent 
        className={`shared-card-content ${contentClassName}`}
        sx={{ 
          p: noPadding ? '0 !important' : 2.5,
          '&:last-child': {
            pb: noPadding ? '0 !important' : 2.5
          },
          opacity: loading ? 0.7 : 1,
          transition: theme.transitions.create('opacity'),
        }}
      >
        {children}
      </CardContent>
    </MuiCard>
  );
};

Card.propTypes = {
  title: PropTypes.node,
  subtitle: PropTypes.node,
  children: PropTypes.node.isRequired,
  elevation: PropTypes.number,
  className: PropTypes.string,
  contentClassName: PropTypes.string,
  headerClassName: PropTypes.string,
  noPadding: PropTypes.bool,
  onClick: PropTypes.func,
  variant: PropTypes.oneOf(['default', 'outlined', 'elevated', 'gradient']),
  loading: PropTypes.bool,
  error: PropTypes.bool,
};

export default Card; 