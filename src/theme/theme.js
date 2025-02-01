import { createTheme } from '@mui/material/styles';

// Common palette values
const common = {
  primary: {
    main: '#424242',
    light: '#757575',
    dark: '#212121',
    contrastText: '#ffffff',
  },
  secondary: {
    main: '#616161',
    light: '#9e9e9e',
    dark: '#424242',
    contrastText: '#ffffff',
  },
  success: {
    main: '#22C55E',
    light: '#4ade80',
    dark: '#16a34a',
    contrastText: '#ffffff',
  },
  error: {
    main: '#EF4444',
    light: '#f87171',
    dark: '#dc2626',
    contrastText: '#ffffff',
  },
  warning: {
    main: '#F59E0B',
    light: '#fbbf24',
    dark: '#d97706',
    contrastText: 'rgba(0, 0, 0, 0.87)',
  },
  info: {
    main: '#757575',
    light: '#9e9e9e',
    dark: '#424242',
    contrastText: '#ffffff',
  },
};

// Common theme settings
const commonSettings = {
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: { 
      fontWeight: 600,
      fontSize: '2.5rem',
      lineHeight: 1.2,
    },
    h2: { 
      fontWeight: 600,
      fontSize: '2rem',
      lineHeight: 1.3,
    },
    h3: { 
      fontWeight: 600,
      fontSize: '1.75rem',
      lineHeight: 1.4,
    },
    h4: { 
      fontWeight: 500,
      fontSize: '1.5rem',
      lineHeight: 1.4,
    },
    h5: { 
      fontWeight: 500,
      fontSize: '1.25rem',
      lineHeight: 1.4,
    },
    h6: { 
      fontWeight: 500,
      fontSize: '1rem',
      lineHeight: 1.4,
    },
    subtitle1: { 
      fontWeight: 500,
      fontSize: '1rem',
      lineHeight: 1.75,
    },
    subtitle2: { 
      fontWeight: 500,
      fontSize: '0.875rem',
      lineHeight: 1.57,
    },
    body1: {
      fontSize: '1rem',
      lineHeight: 1.75,
    },
    body2: {
      fontSize: '0.875rem',
      lineHeight: 1.57,
    },
    button: {
      fontWeight: 500,
      fontSize: '0.875rem',
      lineHeight: 1.75,
      textTransform: 'none',
    },
    caption: {
      fontSize: '0.75rem',
      lineHeight: 1.66,
    },
    overline: {
      fontSize: '0.75rem',
      fontWeight: 600,
      letterSpacing: '0.5px',
      lineHeight: 2.5,
      textTransform: 'uppercase',
    },
  },
  shape: {
    borderRadius: 8,
  },
  spacing: 8,
  transitions: {
    duration: {
      shortest: 150,
      shorter: 200,
      short: 250,
      standard: 300,
      complex: 375,
      enteringScreen: 225,
      leavingScreen: 195,
    },
    easing: {
      easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
      easeOut: 'cubic-bezier(0.0, 0, 0.2, 1)',
      easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
      sharp: 'cubic-bezier(0.4, 0, 0.6, 1)',
    },
  },
};

// Common component overrides
const commonComponents = {
  MuiCssBaseline: {
    styleOverrides: {
      body: {
        transition: 'background-color 0.3s ease-in-out, color 0.3s ease-in-out',
        scrollbarWidth: 'thin',
        '&::-webkit-scrollbar': {
          width: '8px',
          height: '8px',
        },
        '&::-webkit-scrollbar-track': {
          background: 'transparent',
        },
        '&::-webkit-scrollbar-corner': {
          background: 'transparent',
        },
      },
    },
  },
  MuiCard: {
    defaultProps: {
      elevation: 0,
    },
    styleOverrides: {
      root: {
        transition: 'box-shadow 0.3s ease-in-out, transform 0.3s ease-in-out',
        '&:hover': {
          transform: 'translateY(-2px)',
        },
      },
    },
  },
  MuiChip: {
    styleOverrides: {
      root: {
        fontWeight: 500,
        transition: 'all 0.2s ease-in-out',
      },
    },
  },
  MuiButton: {
    defaultProps: {
      disableElevation: true,
    },
    styleOverrides: {
      root: {
        textTransform: 'none',
        fontWeight: 500,
        transition: 'all 0.2s ease-in-out',
      },
      contained: {
        '&:hover': {
          transform: 'translateY(-1px)',
        },
      },
    },
  },
  MuiIconButton: {
    styleOverrides: {
      root: {
        transition: 'all 0.2s ease-in-out',
        '&:hover': {
          transform: 'scale(1.1)',
        },
      },
    },
  },
  MuiListItem: {
    styleOverrides: {
      root: {
        transition: 'all 0.2s ease-in-out',
      },
    },
  },
  MuiPaper: {
    defaultProps: {
      elevation: 0,
    },
    styleOverrides: {
      root: {
        backgroundImage: 'none',
      },
    },
  },
  MuiTableCell: {
    styleOverrides: {
      root: {
        borderBottom: '1px solid',
      },
    },
  },
  MuiTooltip: {
    styleOverrides: {
      tooltip: {
        fontSize: '0.75rem',
        padding: '8px 12px',
        fontWeight: 500,
      },
    },
  },
};

// Light theme
export const lightTheme = createTheme({
  ...commonSettings,
  palette: {
    mode: 'light',
    ...common,
    background: {
      default: '#f8f9fa',
      paper: '#ffffff',
      elevated: '#ffffff',
      card: '#ffffff',
      sidebar: '#ffffff',
    },
    text: {
      primary: '#1a1a1a',
      secondary: '#666666',
      disabled: '#9e9e9e',
    },
    divider: 'rgba(0, 0, 0, 0.12)',
    action: {
      active: 'rgba(0, 0, 0, 0.54)',
      hover: 'rgba(0, 0, 0, 0.04)',
      selected: 'rgba(0, 0, 0, 0.08)',
      disabled: 'rgba(0, 0, 0, 0.26)',
      disabledBackground: 'rgba(0, 0, 0, 0.12)',
    },
  },
  components: {
    ...commonComponents,
    MuiCard: {
      ...commonComponents.MuiCard,
      styleOverrides: {
        root: {
          ...commonComponents.MuiCard.styleOverrides.root,
          boxShadow: '0 2px 4px rgba(0,0,0,0.08)',
          '&:hover': {
            ...commonComponents.MuiCard.styleOverrides.root['&:hover'],
            boxShadow: '0 4px 8px rgba(0,0,0,0.12)',
          },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        ...commonComponents.MuiCssBaseline.styleOverrides,
        body: {
          ...commonComponents.MuiCssBaseline.styleOverrides.body,
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: 'rgba(255, 255, 255, 0.2)',
            borderRadius: 8,
          },
          '&::-webkit-scrollbar-thumb:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.3)',
          },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#ffffff',
          color: '#1a1a1a',
          borderBottom: '1px solid rgba(0, 0, 0, 0.12)',
        },
      },
    },
  },
});

// Dark theme
export const darkTheme = createTheme({
  ...commonSettings,
  palette: {
    mode: 'dark',
    ...common,
    background: {
      default: '#121212',
      paper: '#1e1e1e',
      elevated: '#242424',
      card: '#1e1e1e',
      sidebar: '#1e1e1e',
    },
    text: {
      primary: '#ffffff',
      secondary: '#b3b3b3',
      disabled: '#666666',
    },
    divider: 'rgba(255, 255, 255, 0.12)',
    action: {
      active: 'rgba(255, 255, 255, 0.7)',
      hover: 'rgba(255, 255, 255, 0.08)',
      selected: 'rgba(255, 255, 255, 0.16)',
      disabled: 'rgba(255, 255, 255, 0.3)',
      disabledBackground: 'rgba(255, 255, 255, 0.12)',
    },
  },
  components: {
    ...commonComponents,
    MuiCard: {
      ...commonComponents.MuiCard,
      styleOverrides: {
        root: {
          ...commonComponents.MuiCard.styleOverrides.root,
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          backgroundColor: '#1a1a1a',
          '&:hover': {
            ...commonComponents.MuiCard.styleOverrides.root['&:hover'],
            boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
          },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        ...commonComponents.MuiCssBaseline.styleOverrides,
        body: {
          ...commonComponents.MuiCssBaseline.styleOverrides.body,
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: 'rgba(255, 255, 255, 0.2)',
            borderRadius: 8,
          },
          '&::-webkit-scrollbar-thumb:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.3)',
          },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#1e1e1e',
          color: '#ffffff',
          borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
        },
      },
    },
  },
}); 