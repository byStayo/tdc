import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  Sector
} from 'recharts';
import { useTheme, alpha, keyframes } from '@mui/material';
import PropTypes from 'prop-types';
import Card from './Card';
import LoadingState from './LoadingState';
import ErrorState from './ErrorState';

export const CHART_TYPES = {
  LINE: 'line',
  BAR: 'bar',
  AREA: 'area',
  PIE: 'pie'
};

const fadeIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const Chart = ({
  type = CHART_TYPES.LINE,
  data,
  series,
  xAxis,
  loading = false,
  error = null,
  onRetry,
  height = 400,
  title,
  subtitle,
  className = '',
  showGrid = true,
  showLegend = true,
  showTooltip = true,
  customTooltip,
  customLegend,
  ...props
}) => {
  const theme = useTheme();

  // Generate colors from theme with gradients
  const colors = useMemo(() => {
    const baseColors = [
      theme.palette.primary.main,
      theme.palette.secondary.main,
      theme.palette.success.main,
      theme.palette.error.main,
      theme.palette.warning.main,
      theme.palette.info.main
    ];

    // Generate more colors if needed
    if (series.length > baseColors.length) {
      const extraColors = baseColors.map(color => alpha(color, 0.7));
      return [...baseColors, ...extraColors];
    }

    return baseColors;
  }, [theme, series.length]);

  // Generate gradients for area charts
  const gradients = useMemo(() => 
    colors.map((color, index) => ({
      id: `gradient-${index}`,
      color: color,
      stops: [
        { offset: '5%', stopColor: color, stopOpacity: 0.2 },
        { offset: '95%', stopColor: color, stopOpacity: 0 },
      ],
    })), [colors]
  );

  // Custom tooltip styles
  const tooltipStyle = {
    backgroundColor: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    boxShadow: theme.shadows[3],
    padding: '8px 12px',
    color: theme.palette.text.primary,
    fontSize: 12,
    transition: theme.transitions.create(['transform', 'opacity']),
    '& .recharts-tooltip-label': {
      color: theme.palette.text.secondary,
      marginBottom: 4,
      fontWeight: 500,
    },
    '& .recharts-tooltip-item': {
      color: theme.palette.text.primary,
      padding: '4px 0',
    },
  };

  // Custom legend styles
  const legendStyle = {
    padding: '8px 0',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    justifyContent: 'center',
    '& .recharts-legend-item': {
      display: 'inline-flex',
      alignItems: 'center',
      cursor: 'pointer',
      transition: theme.transitions.create(['opacity']),
      '&:hover': {
        opacity: 0.7,
      },
    },
  };

  // Loading state
  if (loading) {
    return <LoadingState.Chart height={height} />;
  }

  // Error state
  if (error) {
    return (
      <ErrorState
        type={typeof error === 'string' ? 'unknown' : error.type}
        message={typeof error === 'string' ? error : error.message}
        onRetry={onRetry}
      />
    );
  }

  // Common chart props
  const commonProps = {
    data,
    width: '100%',
    height: height,
  };

  // Common axis props
  const commonAxisProps = {
    stroke: theme.palette.text.secondary,
    style: {
      fontSize: 12,
      fontFamily: theme.typography.fontFamily,
    },
    tickLine: false,
    axisLine: {
      stroke: theme.palette.divider,
    },
  };

  // Render appropriate chart type
  const renderChart = () => {
    switch (type) {
      case CHART_TYPES.LINE:
        return (
          <LineChart {...commonProps}>
            <defs>
              {gradients.map((gradient) => (
                <linearGradient
                  key={gradient.id}
                  id={gradient.id}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  {gradient.stops.map((stop, index) => (
                    <stop
                      key={index}
                      offset={stop.offset}
                      stopColor={stop.stopColor}
                      stopOpacity={stop.stopOpacity}
                    />
                  ))}
                </linearGradient>
              ))}
            </defs>
            {showGrid && (
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={alpha(theme.palette.divider, 0.5)}
                vertical={false}
              />
            )}
            <XAxis
              dataKey={xAxis}
              {...commonAxisProps}
            />
            <YAxis {...commonAxisProps} />
            {showTooltip && (
              <Tooltip
                contentStyle={tooltipStyle}
                content={customTooltip}
                cursor={{ stroke: theme.palette.divider }}
              />
            )}
            {showLegend && (
              <Legend
                content={customLegend}
                wrapperStyle={legendStyle}
              />
            )}
            {series.map((item, index) => (
              <Line
                key={item.dataKey}
                type="monotone"
                dataKey={item.dataKey}
                name={item.name}
                stroke={colors[index]}
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 6,
                  stroke: theme.palette.background.paper,
                  strokeWidth: 2,
                }}
                animationDuration={1000}
                animationEasing="ease-out"
              />
            ))}
          </LineChart>
        );

      case CHART_TYPES.BAR:
        return (
          <BarChart {...commonProps}>
            <defs>
              {gradients.map((gradient) => (
                <linearGradient
                  key={gradient.id}
                  id={gradient.id}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  {gradient.stops.map((stop, index) => (
                    <stop
                      key={index}
                      offset={stop.offset}
                      stopColor={stop.stopColor}
                      stopOpacity={stop.stopOpacity}
                    />
                  ))}
                </linearGradient>
              ))}
            </defs>
            {showGrid && (
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={alpha(theme.palette.divider, 0.5)}
                vertical={false}
              />
            )}
            <XAxis
              dataKey={xAxis}
              {...commonAxisProps}
            />
            <YAxis {...commonAxisProps} />
            {showTooltip && (
              <Tooltip
                contentStyle={tooltipStyle}
                content={customTooltip}
                cursor={{ fill: alpha(theme.palette.action.hover, 0.1) }}
              />
            )}
            {showLegend && (
              <Legend
                content={customLegend}
                wrapperStyle={legendStyle}
              />
            )}
            {series.map((item, index) => (
              <Bar
                key={item.dataKey}
                dataKey={item.dataKey}
                name={item.name}
                fill={`url(#gradient-${index})`}
                stroke={colors[index]}
                strokeWidth={1}
                radius={[4, 4, 0, 0]}
                animationDuration={1000}
                animationEasing="ease-out"
              />
            ))}
          </BarChart>
        );

      case CHART_TYPES.AREA:
        return (
          <AreaChart {...commonProps}>
            <defs>
              {gradients.map((gradient) => (
                <linearGradient
                  key={gradient.id}
                  id={gradient.id}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  {gradient.stops.map((stop, index) => (
                    <stop
                      key={index}
                      offset={stop.offset}
                      stopColor={stop.stopColor}
                      stopOpacity={stop.stopOpacity}
                    />
                  ))}
                </linearGradient>
              ))}
            </defs>
            {showGrid && (
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={alpha(theme.palette.divider, 0.5)}
                vertical={false}
              />
            )}
            <XAxis
              dataKey={xAxis}
              {...commonAxisProps}
            />
            <YAxis {...commonAxisProps} />
            {showTooltip && (
              <Tooltip
                contentStyle={tooltipStyle}
                content={customTooltip}
                cursor={{ stroke: theme.palette.divider }}
              />
            )}
            {showLegend && (
              <Legend
                content={customLegend}
                wrapperStyle={legendStyle}
              />
            )}
            {series.map((item, index) => (
              <Area
                key={item.dataKey}
                type="monotone"
                dataKey={item.dataKey}
                name={item.name}
                fill={`url(#gradient-${index})`}
                stroke={colors[index]}
                strokeWidth={2}
                activeDot={{
                  r: 6,
                  stroke: theme.palette.background.paper,
                  strokeWidth: 2,
                }}
                animationDuration={1000}
                animationEasing="ease-out"
              />
            ))}
          </AreaChart>
        );

      case CHART_TYPES.PIE:
        return (
          <PieChart {...commonProps}>
            <Pie
              data={data}
              dataKey={series[0].dataKey}
              nameKey={xAxis}
              cx="50%"
              cy="50%"
              innerRadius="60%"
              outerRadius="80%"
              paddingAngle={2}
              animationDuration={1000}
              animationEasing="ease-out"
            >
              {data.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={colors[index % colors.length]}
                  stroke={theme.palette.background.paper}
                  strokeWidth={2}
                />
              ))}
            </Pie>
            {showTooltip && (
              <Tooltip
                contentStyle={tooltipStyle}
                content={customTooltip}
              />
            )}
            {showLegend && (
              <Legend
                content={customLegend}
                wrapperStyle={legendStyle}
              />
            )}
          </PieChart>
        );

      default:
        return null;
    }
  };

  return (
    <Card
      className={`chart ${className}`}
      title={title}
      subtitle={subtitle}
      variant="elevated"
      elevation={1}
      sx={{
        animation: `${fadeIn} 0.3s ease-out`,
        '& .recharts-responsive-container': {
          animation: `${fadeIn} 0.5s ease-out`,
        },
      }}
      {...props}
    >
      <ResponsiveContainer width="100%" height={height}>
        {renderChart()}
      </ResponsiveContainer>
    </Card>
  );
};

Chart.propTypes = {
  type: PropTypes.oneOf(Object.values(CHART_TYPES)),
  data: PropTypes.arrayOf(PropTypes.object).isRequired,
  series: PropTypes.arrayOf(PropTypes.shape({
    dataKey: PropTypes.string.isRequired,
    name: PropTypes.string,
  })).isRequired,
  xAxis: PropTypes.string.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.shape({
      type: PropTypes.string,
      message: PropTypes.string,
    }),
  ]),
  onRetry: PropTypes.func,
  height: PropTypes.number,
  title: PropTypes.node,
  subtitle: PropTypes.node,
  className: PropTypes.string,
  showGrid: PropTypes.bool,
  showLegend: PropTypes.bool,
  showTooltip: PropTypes.bool,
  customTooltip: PropTypes.func,
  customLegend: PropTypes.func,
};

Chart.types = CHART_TYPES;

export default Chart; 