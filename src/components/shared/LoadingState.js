import React from 'react';
import PropTypes from 'prop-types';
import {
  Box,
  CircularProgress,
  Typography,
  useTheme,
} from '@mui/material';
import './shared.css';

const LoadingState = ({ message = 'Loading...', size = 'medium' }) => {
  const theme = useTheme();

  const getSize = () => {
    switch (size) {
      case 'small':
        return {
          spinner: 24,
          text: 'body2',
          spacing: 1,
        };
      case 'large':
        return {
          spinner: 48,
          text: 'h6',
          spacing: 3,
        };
      default:
        return {
          spinner: 36,
          text: 'body1',
          spacing: 2,
        };
    }
  };

  const sizeConfig = getSize();

  return (
    <Box
      className="loading-state"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 200,
        p: 3,
      }}
    >
      <CircularProgress
        size={sizeConfig.spinner}
        thickness={4}
        sx={{
          color: theme.palette.primary.main,
          mb: sizeConfig.spacing,
        }}
      />
      <Typography
        variant={sizeConfig.text}
        color="text.secondary"
        align="center"
      >
        {message}
      </Typography>
    </Box>
  );
};

LoadingState.propTypes = {
  message: PropTypes.string,
  size: PropTypes.oneOf(['small', 'medium', 'large']),
};

export default LoadingState; 