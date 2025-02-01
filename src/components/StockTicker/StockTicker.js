import React, { useState, useEffect } from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import './StockTicker.css';

const StockTicker = () => {
  const theme = useTheme();
  const [stocks, setStocks] = useState([
    { symbol: 'AAPL', price: '182.52', change: '+1.25' },
    { symbol: 'MSFT', price: '415.32', change: '-0.45' },
    { symbol: 'GOOGL', price: '142.65', change: '+0.78' },
    { symbol: 'AMZN', price: '178.25', change: '+2.15' },
    { symbol: 'NVDA', price: '875.38', change: '+4.25' },
  ]);

  useEffect(() => {
    // Simulate live updates
    const interval = setInterval(() => {
      setStocks(prevStocks => 
        prevStocks.map(stock => ({
          ...stock,
          price: (parseFloat(stock.price) + (Math.random() - 0.5) * 0.1).toFixed(2),
          change: ((Math.random() - 0.5) * 2).toFixed(2)
        }))
      );
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  return (
    <Box className="stock-ticker">
      <Box className="ticker-container">
        <Box className="ticker-scroll">
          {stocks.map((stock, index) => (
            <Box 
              key={index} 
              className="ticker-item"
              sx={{
                backgroundColor: theme.palette.background.paper,
                borderColor: theme.palette.divider
              }}
            >
              <Typography variant="body2" className="symbol">
                {stock.symbol}
              </Typography>
              <Typography 
                variant="body2" 
                className="price"
                sx={{ color: theme.palette.text.primary }}
              >
                ${stock.price}
              </Typography>
              <Typography 
                variant="body2" 
                className="change"
                sx={{ 
                  color: parseFloat(stock.change) >= 0 
                    ? theme.palette.success.main 
                    : theme.palette.error.main 
                }}
              >
                {parseFloat(stock.change) >= 0 ? '+' : ''}{stock.change}%
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
};

export default StockTicker; 