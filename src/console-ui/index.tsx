import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IndexExplorer } from './index-explorer';
import './index.css';

const host = document.getElementById('index-explorer-root');
const bootstrap = window.__INDEX_EXPLORER__;

if (host && bootstrap) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

  createRoot(host).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <IndexExplorer initial={bootstrap} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
