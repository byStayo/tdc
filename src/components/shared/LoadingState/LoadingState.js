import React from 'react';
import PropTypes from 'prop-types';
import { Box, CircularProgress, Typography, Skeleton } from '@mui/material';
import './LoadingState.css';

const LoadingState = ({ 
  variant = 'circular',
  message = 'Loading...',
  size = 'medium',
  rows = 3,
  height,
  width,
  animation = 'wave'
}) => {
  const getSize = (size) => {
    switch (size) {
      case 'small':
        return { spinner: 24, text: '0.875rem' };
      case 'large':
        return { spinner: 48, text: '1rem' };
      default:
        return { spinner: 32, text: '0.875rem' };
    }
  };

  const sizeConfig = getSize(size);

  if (variant === 'skeleton') {
    return (
      <div className="loading-skeleton">
        {[...Array(rows)].map((_, index) => (
          <Skeleton
            key={index}
            variant="rectangular"
            height={height || 60}
            width={width || '100%'}
            animation={animation}
            className="loading-skeleton-item"
          />
        ))}
      </div>
    );
  }

  return (
    <Box className="loading-state">
      <CircularProgress
        size={sizeConfig.spinner}
        className="loading-spinner"
      />
      {message && (
        <Typography
          variant="body2"
          className="loading-text"
          sx={{ fontSize: sizeConfig.text }}
        >
          {message}
        </Typography>
      )}
    </Box>
  );
};

LoadingState.propTypes = {
  variant: PropTypes.oneOf(['circular', 'skeleton']),
  message: PropTypes.string,
  size: PropTypes.oneOf(['small', 'medium', 'large']),
  rows: PropTypes.number,
  height: PropTypes.number,
  width: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  animation: PropTypes.oneOf(['pulse', 'wave'])
};

// Preset configurations
LoadingState.Table = () => (
  <LoadingState
    variant="skeleton"
    rows={5}
    height={52}
    animation="wave"
  />
);

LoadingState.Card = () => (
  <LoadingState
    variant="skeleton"
    rows={1}
    height={200}
    animation="pulse"
  />
);

LoadingState.Text = () => (
  <LoadingState
    variant="skeleton"
    rows={3}
    height={24}
    animation="wave"
  />
);

LoadingState.Chart = () => (
  <LoadingState
    variant="skeleton"
    rows={1}
    height={300}
    animation="pulse"
  />
);

export default LoadingState; 