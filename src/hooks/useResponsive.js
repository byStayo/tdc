import { useTheme, useMediaQuery } from '@mui/material';

export const useResponsive = () => {
  const theme = useTheme();

  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.between('sm', 'md'));
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const isLargeScreen = useMediaQuery(theme.breakpoints.up('lg'));

  const isPortrait = useMediaQuery('(orientation: portrait)');
  const isLandscape = useMediaQuery('(orientation: landscape)');

  const isTouchDevice = useMediaQuery('(hover: none) and (pointer: coarse)');
  const isMouseDevice = useMediaQuery('(hover: hover) and (pointer: fine)');

  const getDeviceType = () => {
    if (isMobile) return 'mobile';
    if (isTablet) return 'tablet';
    if (isDesktop) return 'desktop';
    return 'unknown';
  };

  const getOrientation = () => {
    if (isPortrait) return 'portrait';
    if (isLandscape) return 'landscape';
    return 'unknown';
  };

  const getInputType = () => {
    if (isTouchDevice) return 'touch';
    if (isMouseDevice) return 'mouse';
    return 'unknown';
  };

  const getResponsiveValue = (values) => {
    const { mobile, tablet, desktop, fallback } = values;
    if (isMobile && mobile !== undefined) return mobile;
    if (isTablet && tablet !== undefined) return tablet;
    if (isDesktop && desktop !== undefined) return desktop;
    return fallback;
  };

  const getResponsiveStyles = (styles) => {
    return {
      ...(styles.base || {}),
      ...((isMobile && styles.mobile) || {}),
      ...((isTablet && styles.tablet) || {}),
      ...((isDesktop && styles.desktop) || {}),
      ...((isLargeScreen && styles.largeScreen) || {}),
    };
  };

  return {
    // Breakpoint flags
    isMobile,
    isTablet,
    isDesktop,
    isLargeScreen,

    // Orientation flags
    isPortrait,
    isLandscape,

    // Input type flags
    isTouchDevice,
    isMouseDevice,

    // Helper functions
    getDeviceType,
    getOrientation,
    getInputType,
    getResponsiveValue,
    getResponsiveStyles,

    // Breakpoint values for custom queries
    breakpoints: theme.breakpoints,
  };
}; 