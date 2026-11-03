import { lazy } from 'react';
import type { NativeViewProvider } from '../builtins';
export default { id: 'practice', views: { main: lazy(() => import('../learning/PracticeView')) } } satisfies NativeViewProvider;
