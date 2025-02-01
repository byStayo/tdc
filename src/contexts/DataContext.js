import React, { createContext, useContext, useReducer, useCallback } from 'react';
import { mockMarketData, mockNews, mockSignals, mockOptionsData, mockDarkpoolData, DATA_STATES } from '../mock/mockData';

// Initial state
const initialState = {
  marketData: {
    data: null,
    state: DATA_STATES.LOADING,
    error: null,
  },
  news: {
    data: [],
    state: DATA_STATES.LOADING,
    error: null,
  },
  signals: {
    data: [],
    state: DATA_STATES.LOADING,
    error: null,
  },
  options: {
    data: null,
    state: DATA_STATES.LOADING,
    error: null,
  },
  darkpool: {
    data: null,
    state: DATA_STATES.LOADING,
    error: null,
  },
};

// Action types
const ACTIONS = {
  SET_DATA: 'SET_DATA',
  SET_ERROR: 'SET_ERROR',
  SET_LOADING: 'SET_LOADING',
  RESET: 'RESET',
};

// Reducer
const dataReducer = (state, action) => {
  switch (action.type) {
    case ACTIONS.SET_DATA:
      return {
        ...state,
        [action.dataType]: {
          data: action.payload,
          state: DATA_STATES.SUCCESS,
          error: null,
        },
      };
    case ACTIONS.SET_ERROR:
      return {
        ...state,
        [action.dataType]: {
          ...state[action.dataType],
          state: DATA_STATES.ERROR,
          error: action.payload,
        },
      };
    case ACTIONS.SET_LOADING:
      return {
        ...state,
        [action.dataType]: {
          ...state[action.dataType],
          state: DATA_STATES.LOADING,
        },
      };
    case ACTIONS.RESET:
      return initialState;
    default:
      return state;
  }
};

// Context
const DataContext = createContext(null);

export { DataContext };

// Provider component
export const DataProvider = ({ children }) => {
  const [state, dispatch] = useReducer(dataReducer, initialState);

  // Helper function to simulate API calls
  const simulateApiCall = useCallback(async (mockData, delay = 1000) => {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (Math.random() > 0.1) { // 90% success rate
          resolve(mockData);
        } else {
          reject(new Error('Failed to fetch data'));
        }
      }, delay);
    });
  }, []);

  // Action creators
  const fetchMarketData = useCallback(async () => {
    dispatch({ type: ACTIONS.SET_LOADING, dataType: 'marketData' });
    try {
      const data = await simulateApiCall(mockMarketData);
      dispatch({ type: ACTIONS.SET_DATA, dataType: 'marketData', payload: data });
    } catch (error) {
      dispatch({ type: ACTIONS.SET_ERROR, dataType: 'marketData', payload: error.message });
    }
  }, [simulateApiCall]);

  const fetchNews = useCallback(async () => {
    dispatch({ type: ACTIONS.SET_LOADING, dataType: 'news' });
    try {
      const data = await simulateApiCall(mockNews);
      dispatch({ type: ACTIONS.SET_DATA, dataType: 'news', payload: data });
    } catch (error) {
      dispatch({ type: ACTIONS.SET_ERROR, dataType: 'news', payload: error.message });
    }
  }, [simulateApiCall]);

  const fetchSignals = useCallback(async () => {
    dispatch({ type: ACTIONS.SET_LOADING, dataType: 'signals' });
    try {
      const data = await simulateApiCall(mockSignals);
      dispatch({ type: ACTIONS.SET_DATA, dataType: 'signals', payload: data });
    } catch (error) {
      dispatch({ type: ACTIONS.SET_ERROR, dataType: 'signals', payload: error.message });
    }
  }, [simulateApiCall]);

  const fetchOptionsData = useCallback(async () => {
    dispatch({ type: ACTIONS.SET_LOADING, dataType: 'options' });
    try {
      const data = await simulateApiCall(mockOptionsData);
      dispatch({ type: ACTIONS.SET_DATA, dataType: 'options', payload: data });
    } catch (error) {
      dispatch({ type: ACTIONS.SET_ERROR, dataType: 'options', payload: error.message });
    }
  }, [simulateApiCall]);

  const fetchDarkpoolData = useCallback(async () => {
    dispatch({ type: ACTIONS.SET_LOADING, dataType: 'darkpool' });
    try {
      const data = await simulateApiCall(mockDarkpoolData);
      dispatch({ type: ACTIONS.SET_DATA, dataType: 'darkpool', payload: data });
    } catch (error) {
      dispatch({ type: ACTIONS.SET_ERROR, dataType: 'darkpool', payload: error.message });
    }
  }, [simulateApiCall]);

  const resetData = useCallback(() => {
    dispatch({ type: ACTIONS.RESET });
  }, []);

  const value = {
    state,
    fetchMarketData,
    fetchNews,
    fetchSignals,
    fetchOptionsData,
    fetchDarkpoolData,
    resetData,
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

// Custom hook
export const useData = () => {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
}; 