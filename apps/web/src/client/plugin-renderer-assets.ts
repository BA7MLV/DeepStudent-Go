import { request } from '../api/serverClient';

/** HTML stays an untrusted asset. This never registers a Cordis contribution. */
export const readRendererPluginAsset = <T>(path: string) => request<T>(path);
