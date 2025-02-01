import React from 'react';
import { 
  Button as MuiButton, 
  CircularProgress, 
  useTheme, 
  alpha 
} from '@mui/material';
import PropTypes from 'prop-types';

const Button = ({ 
  children,
  variant = 'contained',
  color = 'primary',
  size = 'medium',
  fullWidth = false,
  loading = false,
  disabled = false,
  startIcon,
  endIcon,
  className = '',
  onClick,
  ...props 
}) => {
  const theme = useTheme();

  // Determine button styles based on variant and color
  const getButtonStyles = () => {
    const baseStyles = {
      textTransform: 'none',
      fontWeight: 500,
      transition: theme.transitions.create([
        'background-color',
        'box-shadow',
        'border-color',
        'color'
      ], {
        duration: theme.transitions.duration.short
      }),
    };

    if (variant === 'contained') {
      return {
        ...baseStyles,
        boxShadow: 'none',
        '&:hover': {
          boxShadow: `0 2px 4px ${alpha(theme.palette[color].main, 0.2)}`,
        },
      };
    }

    if (variant === 'outlined') {
      return {
        ...baseStyles,
        borderWidth: '1.5px',
        '&:hover': {
          borderWidth: '1.5px',
          backgroundColor: alpha(theme.palette[color].main, 0.08),
        },
      };
    }

    return {
      ...baseStyles,
      '&:hover': {
        backgroundColor: alpha(theme.palette[color].main, 0.08),
      },
    };
  };

  // Size-specific styles
  const getSizeStyles = () => {
    switch (size) {
      case 'small':
        return {
          padding: '4px 10px',
          fontSize: '0.8125rem',
        };
      case 'large':
        return {
          padding: '10px 22px',
          fontSize: '1rem',
        };
      default:
        return {
          padding: '6px 16px',
          fontSize: '0.875rem',
        };
    }
  };

  // Loading spinner size based on button size
  const getSpinnerSize = () => {
    switch (size) {
      case 'small':
        return 16;
      case 'large':
        return 24;
      default:
        return 20;
    }
  };

  return (
    <MuiButton
      variant={variant}
      color={color}
      size={size}
      fullWidth={fullWidth}
      disabled={disabled || loading}
      startIcon={!loading && startIcon}
      endIcon={!loading && endIcon}
      className={`shared-button ${className}`}
      onClick={!loading && !disabled ? onClick : undefined}
      sx={{
        ...getButtonStyles(),
        ...getSizeStyles(),
        position: 'relative',
        ...(loading && {
          '& .MuiButton-startIcon, & .MuiButton-endIcon': {
            opacity: 0,
          },
        }),
      }}
      {...props}
    >
      {loading && (
        <CircularProgress
          size={getSpinnerSize()}
          color="inherit"
          sx={{
            position: 'absolute',
            left: '50%',
            marginLeft: -(getSpinnerSize() / 2),
          }}
        />
      )}
      <span style={{ opacity: loading ? 0 : 1 }}>
        {children}
      </span>
    </MuiButton>
  );
};

Button.propTypes = {
  children: PropTypes.node.isRequired,
  variant: PropTypes.oneOf(['contained', 'outlined', 'text']),
  color: PropTypes.oneOf([
    'primary',
    'secondary',
    'success',
    'error',
    'info',
    'warning'
  ]),
  size: PropTypes.oneOf(['small', 'medium', 'large']),
  fullWidth: PropTypes.bool,
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  startIcon: PropTypes.node,
  endIcon: PropTypes.node,
  className: PropTypes.string,
  onClick: PropTypes.func,
};

export default Button; 