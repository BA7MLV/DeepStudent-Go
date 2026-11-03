import { lazy } from 'react';
import type { NativeViewProvider } from '../builtins';
export default { id: 'review', views: { main: lazy(() => import('../learning/ReviewView')) } } satisfies NativeViewProvider;
