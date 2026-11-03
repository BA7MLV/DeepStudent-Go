import { lazy } from 'react';
import type { NativeViewProvider } from '../builtins';
export default { id: 'flashcards', views: { main: lazy(() => import('../learning/FlashcardsView')) } } satisfies NativeViewProvider;
