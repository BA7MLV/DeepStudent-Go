import { createContext } from 'react';
import type { WebsiteCitation } from './citationSources';

export const WebsiteCitationContext = createContext<ReadonlyMap<string, WebsiteCitation> | null>(null);
