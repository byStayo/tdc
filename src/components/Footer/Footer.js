import React from 'react';
import { Link } from 'react-router-dom';
import FacebookIcon from '@mui/icons-material/Facebook';
import TwitterIcon from '@mui/icons-material/Twitter';
import LinkedInIcon from '@mui/icons-material/LinkedIn';
import InstagramIcon from '@mui/icons-material/Instagram';
import './Footer.css';

function Footer() {
  const pages = [
    { name: 'Terms of Use', path: '/terms' },
    { name: 'Contact', path: '/contact' },
    { name: 'Services', path: '/services' },
    { name: 'FAQ', path: '/faq' },
    { name: 'Privacy Policy', path: '/privacy' }
  ];

  const services = [
    'Daily Consensus Report',
    '5 Individual Bias Reports',
    'Major Support/Resistance Levels',
    'Gamma Levels',
    'Live Trades',
    'Education'
  ];

  const socials = [
    { icon: <FacebookIcon />, link: 'https://facebook.com' },
    { icon: <TwitterIcon />, link: 'https://twitter.com' },
    { icon: <LinkedInIcon />, link: 'https://linkedin.com' },
    { icon: <InstagramIcon />, link: 'https://instagram.com' }
  ];

  return (
    <footer className="footer">
      <div className="container footer-content">
        <div className="footer-section">
          <h3>The Daily Consensus</h3>
          <p>Your trusted source for comprehensive market analysis and trading signals.</p>
        </div>

        <div className="footer-section">
          <h3>Pages</h3>
          <ul>
            {pages.map((page, index) => (
              <li key={index}>
                <Link to={page.path}>{page.name}</Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="footer-section">
          <h3>Services</h3>
          <ul>
            {services.map((service, index) => (
              <li key={index}>{service}</li>
            ))}
          </ul>
        </div>

        <div className="footer-section">
          <h3>Connect With Us</h3>
          <div className="social-links">
            {socials.map((social, index) => (
              <a
                key={index}
                href={social.link}
                target="_blank"
                rel="noopener noreferrer"
                className="social-icon"
              >
                {social.icon}
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="container">
          <p>&copy; {new Date().getFullYear()} The Daily Consensus. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

export default Footer; 