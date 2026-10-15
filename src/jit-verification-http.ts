import type { JitConfig } from './jit-server.js';

/** Diagnostic PC transport only; no renderer SOAP operations. */
export interface JitVerificationConfig extends JitConfig {
  mediaPath?: string; statusPath?: string; verificationToken?: string; verificationDeviceId?:string; verificationRemoteIp?:string; seekTimes?: number[]; seekDurations?: number[]; oracleArtifact?: string; lifecycleSeek?: number; naturalEndSeek?:boolean;
}
export function jitVerificationRequest(base: string, config: JitVerificationConfig) {
  return async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (config.verificationToken) headers.set('x-pt3-jit-verify', config.verificationToken);
    if(config.verificationDeviceId)headers.set('x-pt3-jit-device',config.verificationDeviceId);
    const target = url.replace(base + '/jit/media.tts', base + (config.mediaPath ?? '/jit/media.tts')).replace(base + '/api/status', base + (config.statusPath ?? '/api/status'));
    const response = await fetch(target, { ...init, headers, ...(config.mediaPath && init.method === 'POST' && url.endsWith('/api/trials') ? { body: '{}' } : {}) });
    if (config.statusPath && url === base + '/api/status' && response.ok) {
      const sessions = await response.json();
      const namespace=config.mediaPath?.includes('/catalog-jit/')||config.mediaPath?.includes('/library/jit/')?'/experimental/catalog-item/':'/experimental/item/';
      return new Response(JSON.stringify(sessions.find((s:any)=>(!config.verificationRemoteIp||s.client.startsWith(config.verificationRemoteIp+'/'))&&(!config.mediaPath||s.client.endsWith(namespace+config.mediaPath.split('/').at(-1)))) ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  };
}
