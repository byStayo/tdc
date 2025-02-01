import React from 'react';
import { NavLink } from 'react-router-dom';
import DashboardIcon from '@mui/icons-material/Dashboard';
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import NewspaperIcon from '@mui/icons-material/Newspaper';
import './MobileNav.css';

function MobileNav() {
  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-content">
        <NavLink to="/" className="mobile-nav-item" end>
          <DashboardIcon />
          <span>Dashboard</span>
        </NavLink>
        <NavLink to="/signals" className="mobile-nav-item">
          <SignalCellularAltIcon />
          <span>Signals</span>
        </NavLink>
        <NavLink to="/technical" className="mobile-nav-item">
          <ShowChartIcon />
          <span>Charts</span>
        </NavLink>
        <NavLink to="/smart-money" className="mobile-nav-item">
          <AccountBalanceIcon />
          <span>Smart Money</span>
        </NavLink>
        <NavLink to="/news" className="mobile-nav-item">
          <NewspaperIcon />
          <span>News</span>
        </NavLink>
      </div>
    </nav>
  );
}

export default MobileNav; 