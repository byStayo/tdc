import React from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import { Construction as ConstructionIcon } from '@mui/icons-material';

const UnderConstruction = () => {
  return (
    <Box className="construction-container">
      <ConstructionIcon 
        sx={{ 
          fontSize: 64,
          color: 'text.secondary',
          mb: 3,
          opacity: 0.5
        }} 
      />
      <Typography className="construction-title" variant="h4" gutterBottom>
        Coming Soon
      </Typography>
      <Typography className="construction-text" variant="body1" color="text.secondary">
        We're working hard to bring you an amazing new feature. 
        This section is currently under development and will be available soon.
      </Typography>
      <Box sx={{ mt: 4 }}>
        <CircularProgress 
          size={32}
          sx={{
            color: 'text.disabled',
            opacity: 0.5
          }}
        />
      </Box>
    </Box>
  );
};

export default UnderConstruction; 