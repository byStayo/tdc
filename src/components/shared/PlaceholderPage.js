import React from 'react';
import PropTypes from 'prop-types';
import { Box, Typography, Paper } from '@mui/material';
import { Construction as ConstructionIcon } from '@mui/icons-material';

function PlaceholderPage({ title }) {
  return (
    <Box sx={{ p: 3, minHeight: 'calc(100vh - 64px)' }}>
      <Typography variant="h4" gutterBottom>
        {title}
      </Typography>
      
      <Paper 
        sx={{ 
          p: 4, 
          mt: 3, 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center',
          gap: 2,
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider'
        }}
      >
        <ConstructionIcon sx={{ fontSize: 60, color: 'text.secondary' }} />
        <Typography variant="h6" color="text.secondary">
          Under Construction
        </Typography>
        <Typography variant="body1" color="text.secondary" align="center">
          This page is currently being developed. Check back soon for updates!
        </Typography>
      </Paper>
    </Box>
  );
}

PlaceholderPage.propTypes = {
  title: PropTypes.string.isRequired,
};

export default PlaceholderPage; 