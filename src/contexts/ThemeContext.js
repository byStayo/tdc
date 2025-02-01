import React, { createContext, useContext, useState, useEffect } from 'react';
import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { lightTheme, darkTheme } from '../theme/theme';

export const ThemeContext = createContext();

const THEME_COLORS = {
  dark: {
    '--background-default': '#0a1929',
    '--background-paper': '#132f4c',
    '--background-elevated': '#1a3b5c',
    '--text-primary': '#ffffff',
    '--text-secondary': 'rgba(255, 255, 255, 0.7)',
    '--text-disabled': 'rgba(255, 255, 255, 0.5)',
    '--border-color': 'rgba(255, 255, 255, 0.12)',
    '--divider-color': 'rgba(255, 255, 255, 0.12)',
    '--action-hover': 'rgba(255, 255, 255, 0.08)',
    '--action-selected': 'rgba(255, 255, 255, 0.16)',
    '--primary-main': '#90caf9',
    '--primary-light': 'rgba(144, 202, 249, 0.16)',
    '--primary-dark': '#42a5f5',
    '--error-main': '#f44336',
    '--error-light': 'rgba(244, 67, 54, 0.16)',
    '--error-dark': '#d32f2f',
    '--error-contrastText': '#ffffff',
    '--success-main': '#66bb6a',
    '--success-light': 'rgba(102, 187, 106, 0.16)',
    '--success-dark': '#388e3c',
    '--warning-main': '#ffa726',
    '--warning-light': 'rgba(255, 167, 38, 0.16)',
    '--warning-dark': '#f57c00',
    '--shadow-sm': '0 2px 4px rgba(0, 0, 0, 0.3)',
    '--shadow-md': '0 4px 8px rgba(0, 0, 0, 0.4)',
    '--shadow-lg': '0 8px 16px rgba(0, 0, 0, 0.5)',
  },
  light: {
    '--background-default': '#f5f5f5',
    '--background-paper': '#ffffff',
    '--background-elevated': '#f8f9fa',
    '--text-primary': 'rgba(0, 0, 0, 0.87)',
    '--text-secondary': 'rgba(0, 0, 0, 0.6)',
    '--text-disabled': 'rgba(0, 0, 0, 0.38)',
    '--border-color': 'rgba(0, 0, 0, 0.12)',
    '--divider-color': 'rgba(0, 0, 0, 0.12)',
    '--action-hover': 'rgba(0, 0, 0, 0.04)',
    '--action-selected': 'rgba(0, 0, 0, 0.08)',
    '--primary-main': '#1976d2',
    '--primary-light': 'rgba(25, 118, 210, 0.12)',
    '--primary-dark': '#1565c0',
    '--error-main': '#d32f2f',
    '--error-light': 'rgba(211, 47, 47, 0.12)',
    '--error-dark': '#c62828',
    '--error-contrastText': '#ffffff',
    '--success-main': '#2e7d32',
    '--success-light': 'rgba(46, 125, 50, 0.12)',
    '--success-dark': '#1b5e20',
    '--warning-main': '#ed6c02',
    '--warning-light': 'rgba(237, 108, 2, 0.12)',
    '--warning-dark': '#e65100',
    '--shadow-sm': '0 2px 4px rgba(0, 0, 0, 0.1)',
    '--shadow-md': '0 4px 8px rgba(0, 0, 0, 0.15)',
    '--shadow-lg': '0 8px 16px rgba(0, 0, 0, 0.2)',
  },
};

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const savedMode = localStorage.getItem('theme-mode');
    return savedMode || 'dark';
  });

  useEffect(() => {
    localStorage.setItem('theme-mode', mode);
    document.documentElement.setAttribute('data-theme', mode);
    
    // Update CSS variables
    const colors = THEME_COLORS[mode];
    Object.entries(colors).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
    
    // Update meta theme color for mobile
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', colors['--background-paper']);
    }
  }, [mode]);

  const toggleTheme = () => {
    setMode(prevMode => prevMode === 'dark' ? 'light' : 'dark');
  };

  const theme = mode === 'dark' ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider value={{ mode, toggleTheme }}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
} 