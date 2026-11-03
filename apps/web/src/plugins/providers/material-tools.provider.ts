import { lazy } from 'react';
import type { NativeViewProvider } from '../builtins';
export default { id: 'material-tools', views: { main: lazy(() => import('../learning/MaterialToolsView')) } } satisfies NativeViewProvider;
