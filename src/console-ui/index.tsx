import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConsoleApp } from './console-app';
import './index.css';
import './console-app.css';

const host = document.getElementById('console-app-root');
const bootstrap = window.__CONSOLE_APP__;

if (host && bootstrap) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    },
  });

  createRoot(host).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ConsoleApp bootstrap={bootstrap} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
