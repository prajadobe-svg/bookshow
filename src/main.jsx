import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

if (typeof window !== 'undefined') {
  window.BOOKSHOW_ADOBE_CONFIG = {
    enabled: true,
    consentGranted: true, // Temporary development test only.
    environment: 'development',
    xdmNamespace: '_aepsupport',
    decisionScope: 'bookshow-movie-offer',
    demoMode: true,
  };
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>,
);
