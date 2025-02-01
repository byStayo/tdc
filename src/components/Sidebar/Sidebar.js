import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useLocation } from 'react-router-dom';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Collapse,
  Divider,
  IconButton,
  Box,
  Typography,
  Avatar,
} from '@mui/material';
import {
  ChevronLeft as ChevronLeftIcon,
  Dashboard as DashboardIcon,
  ShowChart as ShowChartIcon,
  AccountBalance as AccountBalanceIcon,
  SignalCellularAlt as SignalCellularAltIcon,
  Assessment as AssessmentIcon,
  BubbleChart as BubbleChartIcon,
  TrendingUp as TrendingUpIcon,
  Article as ArticleIcon,
  Person as PersonIcon,
  ExpandLess as ExpandLessIcon,
  ExpandMore as ExpandMoreIcon,
  Notifications as NotificationsIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { useResponsive } from '../../hooks/useResponsive';
import { useTheme } from '../../hooks/useTheme';
import './Sidebar.css';

function Sidebar({ isOpen, onToggle }) {
  const location = useLocation();
  const { isMobile } = useResponsive();
  const { mode } = useTheme();
  const [openAnalysis, setOpenAnalysis] = useState(true);
  const [openMarket, setOpenMarket] = useState(true);

  const handleAnalysisClick = () => {
    setOpenAnalysis(!openAnalysis);
  };

  const handleMarketClick = () => {
    setOpenMarket(!openMarket);
  };

  const isActive = (path) => location.pathname === path;

  const sidebarContent = (
    <Box className={`sidebar-content ${mode}`}>
      <Box className="sidebar-header">
        <Typography variant="h6" component={Link} to="/" className="sidebar-logo">
          {isMobile ? 'TDC' : 'The Daily Consensus'}
        </Typography>
        {isMobile && (
          <IconButton onClick={onToggle} size="small" sx={{ color: 'var(--text-secondary)' }}>
            <ChevronLeftIcon />
          </IconButton>
        )}
      </Box>

      <Divider sx={{ backgroundColor: 'var(--divider)' }} />

      <List component="nav" className="sidebar-nav">
        <ListItemButton
          component={Link}
          to="/dashboard"
          selected={isActive('/dashboard')}
          className={isActive('/dashboard') ? 'active' : ''}
        >
          <ListItemIcon>
            <DashboardIcon />
          </ListItemIcon>
          <ListItemText 
            primary="Dashboard"
            primaryTypographyProps={{ 
              variant: 'body2',
              fontWeight: isActive('/dashboard') ? 600 : 400,
              color: 'var(--text-primary)',
            }}
          />
        </ListItemButton>

        <ListItem disablePadding>
          <ListItemButton 
            onClick={handleAnalysisClick}
            className={location.pathname.includes('/analysis') ? 'active' : ''}
          >
            <ListItemIcon>
              <ShowChartIcon />
            </ListItemIcon>
            <ListItemText 
              primary="Analysis"
              primaryTypographyProps={{ 
                variant: 'body2',
                fontWeight: location.pathname.includes('/analysis') ? 600 : 400,
                color: 'var(--text-primary)',
              }}
            />
            {openAnalysis ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </ListItemButton>
        </ListItem>

        <Collapse in={openAnalysis} timeout="auto" unmountOnExit>
          <List component="div" disablePadding className="nested-list">
            <ListItemButton
              component={Link}
              to="/technical"
              selected={isActive('/technical')}
              className={isActive('/technical') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <ShowChartIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Technical"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/technical') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/smart-money"
              selected={isActive('/smart-money')}
              className={isActive('/smart-money') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <AccountBalanceIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Smart Money"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/smart-money') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/sentiment"
              selected={isActive('/sentiment')}
              className={isActive('/sentiment') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <AssessmentIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Sentiment"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/sentiment') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/correlation"
              selected={isActive('/correlation')}
              className={isActive('/correlation') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <BubbleChartIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Correlation"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/correlation') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>
          </List>
        </Collapse>

        <ListItem disablePadding>
          <ListItemButton 
            onClick={handleMarketClick}
            className={location.pathname.includes('/market') ? 'active' : ''}
          >
            <ListItemIcon>
              <TrendingUpIcon />
            </ListItemIcon>
            <ListItemText 
              primary="Market"
              primaryTypographyProps={{ 
                variant: 'body2',
                fontWeight: location.pathname.includes('/market') ? 600 : 400,
                color: 'var(--text-primary)',
              }}
            />
            {openMarket ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </ListItemButton>
        </ListItem>

        <Collapse in={openMarket} timeout="auto" unmountOnExit>
          <List component="div" disablePadding className="nested-list">
            <ListItemButton
              component={Link}
              to="/signals"
              selected={isActive('/signals')}
              className={isActive('/signals') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <SignalCellularAltIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Signals"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/signals') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/news"
              selected={isActive('/news')}
              className={isActive('/news') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <ArticleIcon />
              </ListItemIcon>
              <ListItemText 
                primary="News"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/news') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>

            <ListItemButton
              component={Link}
              to="/anomalies"
              selected={isActive('/anomalies')}
              className={isActive('/anomalies') ? 'active' : ''}
              sx={{ pl: 4 }}
            >
              <ListItemIcon>
                <NotificationsIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Anomalies"
                primaryTypographyProps={{ 
                  variant: 'body2',
                  fontWeight: isActive('/anomalies') ? 600 : 400,
                  color: 'var(--text-primary)',
                }}
              />
            </ListItemButton>
          </List>
        </Collapse>
      </List>

      <Box sx={{ flexGrow: 1 }} />

      <Divider className="bottom-divider" />

      <Box className="account-info">
        <Box className="account-info-header">
          <Avatar className="account-avatar">
            <PersonIcon />
          </Avatar>
          <Box>
            <Typography className="account-name">John Doe</Typography>
            <Typography className="account-email">john@example.com</Typography>
          </Box>
        </Box>
      </Box>

      <List className="bottom-nav">
        <ListItemButton
          component={Link}
          to="/account"
          selected={isActive('/account')}
          className={isActive('/account') ? 'active' : ''}
        >
          <ListItemIcon>
            <PersonIcon />
          </ListItemIcon>
          <ListItemText 
            primary="Account"
            primaryTypographyProps={{ 
              variant: 'body2',
              fontWeight: isActive('/account') ? 600 : 400,
              color: 'var(--text-primary)',
            }}
          />
        </ListItemButton>

        <ListItemButton
          component={Link}
          to="/settings"
          selected={isActive('/settings')}
          className={isActive('/settings') ? 'active' : ''}
        >
          <ListItemIcon>
            <SettingsIcon />
          </ListItemIcon>
          <ListItemText 
            primary="Settings"
            primaryTypographyProps={{ 
              variant: 'body2',
              fontWeight: isActive('/settings') ? 600 : 400,
              color: 'var(--text-primary)',
            }}
          />
        </ListItemButton>
      </List>
    </Box>
  );

  return (
    <Drawer
      variant={isMobile ? 'temporary' : 'persistent'}
      open={isOpen}
      onClose={onToggle}
      className={`sidebar ${mode}`}
      PaperProps={{
        elevation: 0,
        className: `sidebar-paper ${mode}`,
        sx: {
          width: 'var(--sidebar-width)',
          border: 'none',
          boxShadow: 'none',
          background: 'none',
          '& .MuiPaper-root': {
            background: 'none',
            border: 'none'
          }
        }
      }}
      sx={{
        width: 'var(--sidebar-width)',
        '& .MuiDrawer-paper': {
          width: 'var(--sidebar-width)',
          position: 'relative',
          background: 'none',
          border: 'none',
          '& .MuiPaper-root': {
            background: 'none',
            border: 'none'
          }
        }
      }}
    >
      {sidebarContent}
    </Drawer>
  );
}

Sidebar.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
};

export default Sidebar; 