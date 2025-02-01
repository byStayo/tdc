import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Box } from '@mui/material';
import Header from '../Header/Header';
import Sidebar from '../Sidebar/Sidebar';
import { useResponsive } from '../../hooks/useResponsive';
import { useTheme } from '../../hooks/useTheme';
import './Layout.css';

function Layout({ children }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const { mode } = useTheme();
  const { isMobile } = useResponsive();

  const handleSidebarToggle = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  return (
    <Box 
      className={`layout ${mode}`}
      sx={{
        display: 'flex',
        minHeight: '100vh',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden'
      }}
    >
      <Sidebar 
        isOpen={isSidebarOpen} 
        onToggle={handleSidebarToggle}
      />
      <Box
        className="main-content"
        sx={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: isSidebarOpen ? 'var(--sidebar-width)' : 0,
          transition: 'left 0.3s ease',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <Header 
          isSidebarOpen={isSidebarOpen}
          onSidebarToggle={handleSidebarToggle}
        />
        <Box
          component="main"
          className="content"
          sx={{
            flex: 1,
            overflow: 'auto',
            position: 'relative',
            mt: 'var(--header-height)',
            p: 3
          }}
        >
          {children || <Outlet />}
        </Box>
      </Box>
    </Box>
  );
}

export default Layout; 