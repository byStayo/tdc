import { useTheme, keyframes } from '@mui/material';

// Common animations
const fadeIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const fadeOut = keyframes`
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(10px);
  }
`;

const slideIn = keyframes`
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
`;

const slideOut = keyframes`
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(100%);
  }
`;

const pulse = keyframes`
  0% {
    transform: scale(1);
    opacity: 0.5;
  }
  50% {
    transform: scale(1.05);
    opacity: 0.8;
  }
  100% {
    transform: scale(1);
    opacity: 0.5;
  }
`;

const shimmer = keyframes`
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
`;

export const useAnimation = () => {
  const theme = useTheme();

  // Animation presets
  const presets = {
    fadeIn: {
      animation: `${fadeIn} 0.3s ${theme.transitions.easing.easeOut}`,
      opacity: 0,
      animationFillMode: 'forwards',
    },
    fadeOut: {
      animation: `${fadeOut} 0.3s ${theme.transitions.easing.easeOut}`,
      opacity: 1,
      animationFillMode: 'forwards',
    },
    slideIn: {
      animation: `${slideIn} 0.3s ${theme.transitions.easing.easeOut}`,
      transform: 'translateX(-100%)',
      animationFillMode: 'forwards',
    },
    slideOut: {
      animation: `${slideOut} 0.3s ${theme.transitions.easing.easeOut}`,
      transform: 'translateX(0)',
      animationFillMode: 'forwards',
    },
    pulse: {
      animation: `${pulse} 2s infinite ${theme.transitions.easing.easeInOut}`,
    },
    shimmer: {
      position: 'relative',
      overflow: 'hidden',
      '&::after': {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: `linear-gradient(90deg, transparent 25%, ${theme.palette.action.hover} 50%, transparent 75%)`,
        backgroundSize: '200% 100%',
        animation: `${shimmer} 2s infinite linear`,
      },
    },
  };

  // Helper function to create custom animations
  const createAnimation = (keyframe, options = {}) => {
    const {
      duration = '0.3s',
      delay = '0s',
      timing = theme.transitions.easing.easeOut,
      fillMode = 'forwards',
      iterationCount = 1,
      direction = 'normal',
    } = options;

    return {
      animation: `${keyframe} ${duration} ${timing} ${delay} ${iterationCount} ${direction}`,
      animationFillMode: fillMode,
    };
  };

  // Helper function to create transition styles
  const createTransition = (properties = ['all'], options = {}) => {
    const {
      duration = theme.transitions.duration.standard,
      easing = theme.transitions.easing.easeInOut,
      delay = 0,
    } = options;

    return theme.transitions.create(properties, {
      duration,
      easing,
      delay,
    });
  };

  // Helper function to create hover animation styles
  const createHoverAnimation = (styles, options = {}) => {
    const {
      scale = 1.05,
      duration = theme.transitions.duration.shortest,
      easing = theme.transitions.easing.easeOut,
    } = options;

    return {
      transition: createTransition(['transform'], { duration, easing }),
      '&:hover': {
        transform: `scale(${scale})`,
        ...styles,
      },
    };
  };

  return {
    // Animation keyframes
    keyframes: {
      fadeIn,
      fadeOut,
      slideIn,
      slideOut,
      pulse,
      shimmer,
    },

    // Animation presets
    presets,

    // Helper functions
    createAnimation,
    createTransition,
    createHoverAnimation,

    // Theme transitions for reference
    transitions: theme.transitions,
  };
}; 