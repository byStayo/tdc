import React, { useState, useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  TableSortLabel,
  Box,
  useTheme,
  alpha,
  Checkbox,
  IconButton,
  Tooltip
} from '@mui/material';
import {
  KeyboardArrowUp as KeyboardArrowUpIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  FilterList as FilterListIcon,
  MoreVert as MoreVertIcon
} from '@mui/icons-material';
import PropTypes from 'prop-types';
import Card from './Card';
import LoadingState from './LoadingState';
import ErrorState from './ErrorState';

const DataTable = ({
  columns,
  data,
  loading = false,
  error = null,
  onRetry,
  selectable = false,
  onSelectionChange,
  actions,
  defaultSortBy,
  defaultSortDirection = 'asc',
  rowsPerPageOptions = [10, 25, 50],
  defaultRowsPerPage = 10,
  onSort,
  onFilter,
  className = '',
  stickyHeader = true,
  maxHeight,
  ...props
}) => {
  const theme = useTheme();
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(defaultRowsPerPage);
  const [sortBy, setSortBy] = useState(defaultSortBy);
  const [sortDirection, setSortDirection] = useState(defaultSortDirection);
  const [selected, setSelected] = useState([]);

  // Handle sorting
  const handleSort = (column) => {
    const isAsc = sortBy === column && sortDirection === 'asc';
    const newDirection = isAsc ? 'desc' : 'asc';
    setSortBy(column);
    setSortDirection(newDirection);
    onSort?.(column, newDirection);
  };

  // Handle pagination
  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  // Handle selection
  const handleSelectAll = (event) => {
    if (event.target.checked) {
      const newSelected = data.map(row => row.id);
      setSelected(newSelected);
      onSelectionChange?.(newSelected);
    } else {
      setSelected([]);
      onSelectionChange?.([]);
    }
  };

  const handleSelectRow = (id) => {
    const selectedIndex = selected.indexOf(id);
    let newSelected = [];

    if (selectedIndex === -1) {
      newSelected = [...selected, id];
    } else {
      newSelected = selected.filter(item => item !== id);
    }

    setSelected(newSelected);
    onSelectionChange?.(newSelected);
  };

  // Calculate displayed rows
  const displayedRows = useMemo(() => {
    const start = page * rowsPerPage;
    return data.slice(start, start + rowsPerPage);
  }, [data, page, rowsPerPage]);

  // Loading state
  if (loading) {
    return <LoadingState.Table />;
  }

  // Error state
  if (error) {
    return (
      <ErrorState
        type={typeof error === 'string' ? 'unknown' : error.type}
        message={typeof error === 'string' ? error : error.message}
        onRetry={onRetry}
        compact
      />
    );
  }

  return (
    <Card
      className={`data-table ${className}`}
      noPadding
      variant="elevated"
      elevation={1}
      {...props}
    >
      <TableContainer
        sx={{
          maxHeight: maxHeight,
          '&::-webkit-scrollbar': {
            width: 8,
            height: 8,
          },
          '&::-webkit-scrollbar-track': {
            backgroundColor: alpha(theme.palette.action.hover, 0.5),
            borderRadius: 4,
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: theme.palette.mode === 'dark' 
              ? alpha(theme.palette.primary.main, 0.3)
              : alpha(theme.palette.primary.main, 0.2),
            borderRadius: 4,
            '&:hover': {
              backgroundColor: theme.palette.mode === 'dark'
                ? alpha(theme.palette.primary.main, 0.4)
                : alpha(theme.palette.primary.main, 0.3),
            },
          },
        }}
      >
        <Table stickyHeader={stickyHeader} size="medium">
          <TableHead>
            <TableRow>
              {selectable && (
                <TableCell 
                  padding="checkbox"
                  sx={{
                    bgcolor: theme.palette.background.paper,
                    transition: theme.transitions.create(['background-color', 'box-shadow']),
                  }}
                >
                  <Checkbox
                    indeterminate={selected.length > 0 && selected.length < data.length}
                    checked={data.length > 0 && selected.length === data.length}
                    onChange={handleSelectAll}
                    sx={{
                      '&.Mui-checked, &.MuiCheckbox-indeterminate': {
                        color: theme.palette.primary.main,
                      },
                    }}
                  />
                </TableCell>
              )}
              {columns.map((column) => (
                <TableCell
                  key={column.field}
                  align={column.numeric ? 'right' : 'left'}
                  padding={column.disablePadding ? 'none' : 'normal'}
                  sortDirection={sortBy === column.field ? sortDirection : false}
                  sx={{
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    bgcolor: theme.palette.background.paper,
                    transition: theme.transitions.create(['background-color', 'box-shadow']),
                    borderBottom: `2px solid ${theme.palette.divider}`,
                    '&:hover': column.sortable !== false && {
                      bgcolor: alpha(theme.palette.action.hover, 0.5),
                    },
                  }}
                >
                  {column.sortable !== false ? (
                    <TableSortLabel
                      active={sortBy === column.field}
                      direction={sortBy === column.field ? sortDirection : 'asc'}
                      onClick={() => handleSort(column.field)}
                      sx={{
                        transition: theme.transitions.create(['transform', 'color']),
                        '&.Mui-active': {
                          color: theme.palette.primary.main,
                          transform: 'scale(1.02)',
                          '& .MuiTableSortLabel-icon': {
                            color: theme.palette.primary.main,
                          },
                        },
                      }}
                    >
                      {column.label}
                    </TableSortLabel>
                  ) : (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {column.label}
                      {column.filterable && (
                        <Tooltip title="Filter">
                          <IconButton
                            size="small"
                            onClick={() => onFilter?.(column.field)}
                            sx={{
                              transition: theme.transitions.create(['transform', 'background-color']),
                              '&:hover': {
                                transform: 'scale(1.1)',
                                bgcolor: alpha(theme.palette.primary.main, 0.1),
                              },
                            }}
                          >
                            <FilterListIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  )}
                </TableCell>
              ))}
              {actions && (
                <TableCell 
                  align="right"
                  sx={{
                    bgcolor: theme.palette.background.paper,
                    transition: theme.transitions.create(['background-color', 'box-shadow']),
                  }}
                >
                  Actions
                </TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {displayedRows.map((row, index) => {
              const isSelected = selected.indexOf(row.id) !== -1;
              return (
                <TableRow
                  hover
                  key={row.id}
                  selected={isSelected}
                  sx={{
                    cursor: selectable ? 'pointer' : 'default',
                    '&:last-child td, &:last-child th': { border: 0 },
                    '&.Mui-selected': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.08),
                    },
                    '&.Mui-selected:hover': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.12),
                    },
                    transition: theme.transitions.create(['background-color', 'box-shadow']),
                    '&:hover': {
                      backgroundColor: alpha(theme.palette.action.hover, 0.7),
                    },
                  }}
                  onClick={selectable ? () => handleSelectRow(row.id) : undefined}
                >
                  {selectable && (
                    <TableCell padding="checkbox">
                      <Checkbox 
                        checked={isSelected}
                        sx={{
                          '&.Mui-checked': {
                            color: theme.palette.primary.main,
                          },
                        }}
                      />
                    </TableCell>
                  )}
                  {columns.map((column) => (
                    <TableCell
                      key={column.field}
                      align={column.numeric ? 'right' : 'left'}
                      padding={column.disablePadding ? 'none' : 'normal'}
                      sx={{
                        transition: theme.transitions.create(['background-color', 'color']),
                        ...(isSelected && {
                          color: theme.palette.primary.main,
                        }),
                      }}
                    >
                      {column.render
                        ? column.render(row[column.field], row, index)
                        : row[column.field]}
                    </TableCell>
                  ))}
                  {actions && (
                    <TableCell align="right">
                      {typeof actions === 'function'
                        ? actions(row, index)
                        : (
                          <IconButton 
                            size="small"
                            sx={{
                              transition: theme.transitions.create(['transform', 'background-color']),
                              '&:hover': {
                                transform: 'scale(1.1)',
                                bgcolor: alpha(theme.palette.primary.main, 0.1),
                              },
                            }}
                          >
                            <MoreVertIcon />
                          </IconButton>
                        )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {displayedRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (selectable ? 1 : 0) + (actions ? 1 : 0)}
                  sx={{ 
                    textAlign: 'center',
                    py: 6,
                    color: theme.palette.text.secondary,
                  }}
                >
                  No data available
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      
      <TablePagination
        component="div"
        rowsPerPageOptions={rowsPerPageOptions}
        count={data.length}
        rowsPerPage={rowsPerPage}
        page={page}
        onPageChange={handleChangePage}
        onRowsPerPageChange={handleChangeRowsPerPage}
        sx={{
          borderTop: `1px solid ${theme.palette.divider}`,
          bgcolor: theme.palette.background.paper,
          transition: theme.transitions.create(['background-color']),
          '& .MuiTablePagination-select': {
            borderRadius: 1,
            '&:hover': {
              bgcolor: alpha(theme.palette.action.hover, 0.7),
            },
          },
          '& .MuiTablePagination-actions': {
            '& .MuiIconButton-root': {
              transition: theme.transitions.create(['transform', 'background-color']),
              '&:hover': {
                transform: 'scale(1.1)',
                bgcolor: alpha(theme.palette.primary.main, 0.1),
              },
              '&.Mui-disabled': {
                opacity: 0.5,
              },
            },
          },
        }}
      />
    </Card>
  );
};

DataTable.propTypes = {
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
  loading: PropTypes.bool,
  error: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.shape({
      type: PropTypes.string,
      message: PropTypes.string,
    }),
  ]),
  onRetry: PropTypes.func,
  selectable: PropTypes.bool,
  onSelectionChange: PropTypes.func,
  actions: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.bool,
  ]),
  defaultSortBy: PropTypes.string,
  defaultSortDirection: PropTypes.oneOf(['asc', 'desc']),
  rowsPerPageOptions: PropTypes.arrayOf(PropTypes.number),
  defaultRowsPerPage: PropTypes.number,
  onSort: PropTypes.func,
  onFilter: PropTypes.func,
  className: PropTypes.string,
  stickyHeader: PropTypes.bool,
  maxHeight: PropTypes.oneOfType([
    PropTypes.number,
    PropTypes.string,
  ]),
};

export default DataTable; 