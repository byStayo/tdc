import PropTypes from 'prop-types';
import Card from './Card';
import Button from './Button';
import Chart from './Chart';
import ErrorState, { ERROR_TYPES } from './ErrorState';
import LoadingState from './LoadingState';
import DataTable from './DataTable';

// Core components
export {
  Card,
  Button,
  Chart,
  ErrorState,
  LoadingState,
  DataTable,
  ERROR_TYPES,
};

// Export types and configurations
export { CHART_TYPES } from './Chart';

// Export preset configurations
export const LoadingPresets = {
  Table: LoadingState.Table,
  Card: LoadingState.Card,
  Text: LoadingState.Text,
  Chart: LoadingState.Chart,
};

// Export common prop types
export const CommonPropTypes = {
  className: PropTypes.string,
  children: PropTypes.node,
  onClick: PropTypes.func,
  disabled: PropTypes.bool,
  loading: PropTypes.bool,
  error: PropTypes.oneOfType([
    PropTypes.bool,
    PropTypes.string,
    PropTypes.object
  ]),
  onRetry: PropTypes.func,
};

// Export data display prop types
export const DataDisplayProps = {
  ...CommonPropTypes,
  title: PropTypes.node,
  subtitle: PropTypes.node,
  actions: PropTypes.oneOfType([
    PropTypes.node,
    PropTypes.func
  ]),
  elevation: PropTypes.number,
  noPadding: PropTypes.bool,
};

// Export chart prop types
export const ChartProps = {
  ...DataDisplayProps,
  data: PropTypes.array.isRequired,
  series: PropTypes.arrayOf(PropTypes.shape({
    dataKey: PropTypes.string.isRequired,
    name: PropTypes.string,
  })).isRequired,
  xAxis: PropTypes.string.isRequired,
  height: PropTypes.number,
  showGrid: PropTypes.bool,
  showLegend: PropTypes.bool,
  showTooltip: PropTypes.bool,
  customTooltip: PropTypes.func,
  customLegend: PropTypes.func,
};

// Export table prop types
export const TableProps = {
  ...DataDisplayProps,
  columns: PropTypes.arrayOf(PropTypes.shape({
    field: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    numeric: PropTypes.bool,
    sortable: PropTypes.bool,
    filterable: PropTypes.bool,
    disablePadding: PropTypes.bool,
    render: PropTypes.func,
  })).isRequired,
  data: PropTypes.array.isRequired,
  selectable: PropTypes.bool,
  onSelectionChange: PropTypes.func,
  defaultSortBy: PropTypes.string,
  defaultSortDirection: PropTypes.oneOf(['asc', 'desc']),
  rowsPerPageOptions: PropTypes.arrayOf(PropTypes.number),
  defaultRowsPerPage: PropTypes.number,
  onSort: PropTypes.func,
  onFilter: PropTypes.func,
  stickyHeader: PropTypes.bool,
  maxHeight: PropTypes.oneOfType([
    PropTypes.number,
    PropTypes.string,
  ]),
}; 