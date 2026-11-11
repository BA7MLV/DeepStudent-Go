import type {} from '@deepseek-ai/dsh-typert-protocol';
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'client/unauthenticated': {};
    'client/forbidden': {};
    'client/conflict': {};
    'client/uncertain': {};
    'client/domain': { code: string; admissionRejected?: boolean };
    'client/record-conflict': { table: string; key: string | number; fields: string[] };
  }
}
