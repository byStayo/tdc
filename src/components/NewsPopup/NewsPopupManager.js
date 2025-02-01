import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  IconButton,
  Box,
  Slide,
} from '@mui/material';
import {
  Close as CloseIcon,
  OpenInNew as OpenInNewIcon,
} from '@mui/icons-material';
import { useData } from '../../hooks/useData';
import { useTheme } from '../../hooks/useTheme';
import './NewsPopup.css';

const Transition = React.forwardRef(function Transition(props, ref) {
  return <Slide direction="up" ref={ref} {...props} />;
});

export const NewsPopupManager = () => {
  const { isDarkMode } = useTheme();
  const { state } = useData();
  const [open, setOpen] = useState(false);
  const [currentNews, setCurrentNews] = useState(null);
  const [newsQueue, setNewsQueue] = useState([]);

  useEffect(() => {
    // Filter and sort news by date
    if (state.news?.data) {
      const recentNews = state.news.data
        .filter(news => {
          const newsDate = new Date(news.published_utc);
          const now = new Date();
          // Show news from the last hour
          return (now - newsDate) <= 3600000;
        })
        .sort((a, b) => new Date(b.published_utc) - new Date(a.published_utc));

      setNewsQueue(recentNews);
    }
  }, [state.news?.data]);

  useEffect(() => {
    // Show next news item if available and popup is closed
    if (newsQueue.length > 0 && !open) {
      const nextNews = newsQueue[0];
      setCurrentNews(nextNews);
      setOpen(true);
      // Remove shown news from queue
      setNewsQueue(prev => prev.slice(1));
    }
  }, [newsQueue, open]);

  const handleClose = () => {
    setOpen(false);
    setCurrentNews(null);
  };

  const handleOpenArticle = () => {
    if (currentNews?.article_url) {
      window.open(currentNews.article_url, '_blank', 'noopener,noreferrer');
    }
  };

  if (!currentNews) return null;

  return (
    <Dialog
      open={open}
      TransitionComponent={Transition}
      keepMounted
      onClose={handleClose}
      aria-describedby="news-popup-description"
      className={`news-popup ${isDarkMode ? 'dark' : 'light'}`}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6" component="div">
            Breaking News
          </Typography>
          <IconButton
            aria-label="close"
            onClick={handleClose}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
            }}
          >
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        <Typography
          variant="subtitle1"
          color="primary"
          gutterBottom
          sx={{ fontWeight: 600 }}
        >
          {currentNews.title}
        </Typography>
        <Typography variant="body2" paragraph>
          {currentNews.description}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mt: 2,
          }}
        >
          {currentNews.tickers?.map((ticker) => (
            <Box
              key={ticker}
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1,
                backgroundColor: 'primary.main',
                color: 'primary.contrastText',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              {ticker}
            </Box>
          ))}
        </Box>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mt: 2,
            color: 'text.secondary',
          }}
        >
          {new Date(currentNews.published_utc).toLocaleString()}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Dismiss</Button>
        <Button
          onClick={handleOpenArticle}
          endIcon={<OpenInNewIcon />}
          variant="contained"
          color="primary"
        >
          Read More
        </Button>
      </DialogActions>
    </Dialog>
  );
}; 