import React, { useState } from 'react';
import PropTypes from 'prop-types';
import {
  AppBar,
  Toolbar,
  IconButton,
  Badge,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  Box,
  Tooltip,
  Typography
} from '@mui/material';
import {
  Menu as MenuIcon,
  Notifications as NotificationsIcon,
  AccountCircle,
  Settings,
  Logout,
  DarkMode,
  LightMode,
} from '@mui/icons-material';
import { useTheme } from '../../hooks/useTheme';
import { useResponsive } from '../../hooks/useResponsive';
import StockTicker from '../StockTicker/StockTicker';
import './Header.css';

function Header({ isSidebarOpen, onSidebarToggle, onThemeToggle, isDarkMode }) {
  const { mode, toggleTheme } = useTheme();
  const { isMobile } = useResponsive();
  const [anchorEl, setAnchorEl] = useState(null);
  const [notificationsAnchor, setNotificationsAnchor] = useState(null);

  const handleMenu = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleNotifications = (event) => {
    setNotificationsAnchor(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
    setNotificationsAnchor(null);
  };

  const handleTickerSettings = () => {
    // Handle ticker settings
    console.log('Open ticker settings');
  };

  return (
    <AppBar 
      position="fixed" 
      className="header" 
      elevation={0}
      sx={{
        width: { 
          xs: '100%',
          md: isSidebarOpen && !isMobile ? `calc(100% - var(--sidebar-width))` : '100%',
        },
        ml: { 
          xs: 0,
          md: isSidebarOpen && !isMobile ? 'var(--sidebar-width)' : 0,
        },
        transition: theme =>
          theme.transitions.create(['margin', 'width'], {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.leavingScreen,
          }),
      }}
    >
      <Toolbar 
        sx={{
          minHeight: 'var(--header-height) !important',
          px: { xs: 1, sm: 2, md: 3 },
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Box 
          sx={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: 2,
            flex: '0 0 auto',
          }}
        >
          {isMobile && (
            <IconButton
              edge="start"
              color="inherit"
              aria-label="toggle sidebar"
              onClick={onSidebarToggle}
              className="header-icon-button"
            >
              <MenuIcon />
            </IconButton>
          )}
        </Box>

        <StockTicker onSettingsClick={handleTickerSettings} />

        <Box 
          sx={{ 
            display: 'flex', 
            alignItems: 'center',
            gap: { xs: 1, sm: 2 },
            flex: '0 0 auto',
          }}
        >
          <Tooltip title={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}>
            <IconButton
              onClick={toggleTheme}
              className="header-icon-button"
            >
              {mode === 'dark' ? <LightMode className="theme-toggle-icon" /> : <DarkMode className="theme-toggle-icon" />}
            </IconButton>
          </Tooltip>

          <Tooltip title="Notifications">
            <IconButton
              onClick={handleNotifications}
              className="header-icon-button"
            >
              <Badge 
                badgeContent={4} 
                color="error"
                sx={{
                  '& .MuiBadge-badge': {
                    backgroundColor: 'var(--error)',
                    color: '#fff',
                  }
                }}
              >
                <NotificationsIcon />
              </Badge>
            </IconButton>
          </Tooltip>

          <Tooltip title="Account settings">
            <IconButton
              onClick={handleMenu}
              className="header-icon-button"
            >
              <AccountCircle />
            </IconButton>
          </Tooltip>
        </Box>

        <Menu
          anchorEl={notificationsAnchor}
          open={Boolean(notificationsAnchor)}
          onClose={handleClose}
          className="header-menu notification-menu"
          transformOrigin={{ horizontal: 'right', vertical: 'top' }}
          anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        >
          <MenuItem onClick={handleClose} className="notification-item">
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography className="notification-title">
                New signal alert for NVDA
              </Typography>
              <Typography className="notification-description">
                Strong buy signal detected at $875.32
              </Typography>
            </Box>
          </MenuItem>
          <MenuItem onClick={handleClose} className="notification-item">
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography className="notification-title">
                Market sentiment update
              </Typography>
              <Typography className="notification-description">
                Bullish sentiment increasing across tech sector
              </Typography>
            </Box>
          </MenuItem>
          <Divider />
          <MenuItem onClick={handleClose} sx={{ justifyContent: 'center' }}>
            <Typography sx={{ fontWeight: 500 }}>
              View all notifications
            </Typography>
          </MenuItem>
        </Menu>

        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleClose}
          className="header-menu account-menu"
          transformOrigin={{ horizontal: 'right', vertical: 'top' }}
          anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        >
          <MenuItem onClick={handleClose}>
            <ListItemIcon>
              <AccountCircle fontSize="small" />
            </ListItemIcon>
            <Typography>Profile</Typography>
          </MenuItem>
          <MenuItem onClick={handleClose}>
            <ListItemIcon>
              <Settings fontSize="small" />
            </ListItemIcon>
            <Typography>Settings</Typography>
          </MenuItem>
          <Divider />
          <MenuItem onClick={handleClose}>
            <ListItemIcon>
              <Logout fontSize="small" />
            </ListItemIcon>
            <Typography>Logout</Typography>
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
}

Header.propTypes = {
  isSidebarOpen: PropTypes.bool.isRequired,
  onSidebarToggle: PropTypes.func.isRequired,
  onThemeToggle: PropTypes.func.isRequired,
  isDarkMode: PropTypes.bool.isRequired,
};

export default Header; 