import React from 'react';
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Fade,
  LinearProgress
} from '@mui/material';
import {
  Close as CloseIcon,
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
  TrendingFlat as TrendingFlatIcon,
  Launch as LaunchIcon
} from '@mui/icons-material';
import './NewsPopup.css';

function NewsPopup({ news, onClose }) {
  if (!news) return null;

  const getSentimentIcon = (score) => {
    if (score > 0.3) return <TrendingUpIcon color="success" />;
    if (score < -0.3) return <TrendingDownIcon color="error" />;
    return <TrendingFlatIcon color="warning" />;
  };

  const getSentimentTooltip = (score) => {
    if (score > 0.3) return 'Positive sentiment';
    if (score < -0.3) return 'Negative sentiment';
    return 'Neutral sentiment';
  };

  return (
    <Fade in>
      <Box className="news-popup">
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {news.title}
          </Typography>
          <IconButton onClick={onClose} size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>

        <Typography variant="body2" color="text.secondary" gutterBottom>
          {news.description}
        </Typography>

        <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography variant="caption" color="text.secondary">
            {new Date(news.published_utc).toLocaleString()}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {news.publisher.name}
          </Typography>
          <Tooltip title={getSentimentTooltip(news.sentiment_score)}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              {getSentimentIcon(news.sentiment_score)}
            </Box>
          </Tooltip>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="Read full article">
            <IconButton
              href={news.article_url}
              target="_blank"
              rel="noopener noreferrer"
              size="small"
            >
              <LaunchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        {news.tickers && news.tickers.length > 0 && (
          <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {news.tickers.map((ticker, index) => (
              <Typography
                key={index}
                variant="caption"
                sx={{
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  bgcolor: 'action.hover'
                }}
              >
                {ticker}
              </Typography>
            ))}
          </Box>
        )}

        <LinearProgress
          variant="determinate"
          value={100}
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 2
          }}
        />
      </Box>
    </Fade>
  );
}

export default NewsPopup; 