import React from 'react';
import PropTypes from 'prop-types';
import { Paper, Typography, Button } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { useTheme } from '../../hooks/useTheme';

export const ERROR_TYPES = {
  FETCH: {
    title: 'Failed to fetch data',
    message: 'There was an error retrieving the data. Please try again.',
  },
  NETWORK: {
    title: 'Network Error',
    message: 'Please check your internet connection and try again.',
  },
  NOT_FOUND: {
    title: 'Not Found',
    message: 'The requested resource was not found.',
  },
  SERVER: {
    title: 'Server Error',
    message: 'An unexpected server error occurred. Please try again later.',
  },
};

const ErrorState = ({ 
  title = ERROR_TYPES.FETCH.title,
  message = ERROR_TYPES.FETCH.message,
  onRetry,
  size = 'medium'
}) => {
  const { mode } = useTheme();

  const getSize = (size) => {
    switch (size) {
      case 'small':
        return { icon: 32, title: '1rem', message: '0.875rem' };
      case 'large':
        return { icon: 64, title: '1.5rem', message: '1rem' };
      default:
        return { icon: 48, title: '1.25rem', message: '0.875rem' };
    }
  };

  const sizeConfig = getSize(size);

  return (
    <Paper
      elevation={0}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 3,
        backgroundColor: 'transparent',
        minHeight: 200,
        textAlign: 'center',
      }}
    >
      <ErrorOutlineIcon
        sx={{
          fontSize: sizeConfig.icon,
          color: 'error.main',
          marginBottom: 2,
        }}
      />
      <Typography
        variant="h6"
        sx={{
          fontSize: sizeConfig.title,
          fontWeight: 600,
          marginBottom: 1,
          color: mode === 'dark' ? 'error.light' : 'error.dark',
        }}
      >
        {title}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          fontSize: sizeConfig.message,
          color: mode === 'dark' ? 'error.light' : 'error.dark',
          marginBottom: onRetry ? 2 : 0,
          maxWidth: 400,
        }}
      >
        {message}
      </Typography>
      {onRetry && (
        <Button
          variant="contained"
          color="error"
          onClick={onRetry}
          sx={{
            borderRadius: 2,
            textTransform: 'none',
            minWidth: 120,
          }}
        >
          Try Again
        </Button>
      )}
    </Paper>
  );
};

ErrorState.propTypes = {
  title: PropTypes.string,
  message: PropTypes.string,
  onRetry: PropTypes.func,
  size: PropTypes.oneOf(['small', 'medium', 'large']),
};

export default ErrorState; 