'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  // Always start with 'light' for SSR consistency
  const [theme, setTheme] = useState('light');
  const [mounted, setMounted] = useState(false);

  // Only run on client side
  useEffect(() => {
    setMounted(true);
    
    // Migrate old theme key if it exists
    const oldTheme = localStorage.getItem('safe-settings-theme');
    if (oldTheme && !localStorage.getItem('theme')) {
      localStorage.setItem('theme', oldTheme);
      localStorage.removeItem('safe-settings-theme');
    }
    
    // Get theme from localStorage
    const savedTheme = localStorage.getItem('theme') || 'light';
    
    // Set state (will trigger re-render with correct theme)
    setTheme(savedTheme);
    
    // Apply to DOM immediately to prevent flash
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  // Apply theme changes to DOM
  useEffect(() => {
    if (mounted) {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme, mounted]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const setSpecificTheme = (themeName) => {
    setTheme(themeName);
    localStorage.setItem('theme', themeName);
  };

  // Render children immediately - no hiding
  return (
    <ThemeContext.Provider value={{
      theme,
      toggleTheme,
      setTheme: setSpecificTheme,
      isDark: theme === 'dark',
      mounted
    }}>
      {children}
    </ThemeContext.Provider>
  );
};
