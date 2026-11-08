import { useEffect, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { Field, LoadingButton, SectionCard, toast } from '../../ui';
import { cloudRequest } from '../../cloud/state';
import { useSettings } from '../../store/settings';

interface BiliStatus { configured: boolean; login: { isLogin: boolean; uname?: string } | null }

export default function SourcesModule() {
  const legacyCookie = useSettings(s => s.bilibiliCookie);
  const [status, setStatus] = useState<BiliStatus | null>(null);
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void cloudRequest<BiliStatus>('/bilibili/status', { signal: controller.signal }).then(setStatus).catch(() => {
      if (!controller.signal.aborted) setError('暂时无法检查服务器的 B 站登录状态。');
    });
    return () => controller.abort();
  }, []);

  async function save(value: string) {
    setBusy(true); setError('');
    try {
      const saved = await cloudRequest<{ configured: boolean }>('/bilibili/credentials', { method: 'PUT', body: JSON.stringify({ cookie: value }) });
      setCookie(''); setStatus({ ...saved, login: null });
      toast.success(saved.configured ? 'B 站 Cookie 已加密保存到服务器' : '已清除服务器的 B 站 Cookie');
      if (value && legacyCookie === value) useSettings.getState().update({ bilibiliCookie: '' });
      const next = await cloudRequest<BiliStatus>('/bilibili/status');
      setStatus(next);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  }

  return (
    <SectionCard title="哔哩哔哩导入" testId="card-bilibili">
      <Field label="服务器直接导入" layout="row">
        <span className="text-muted" data-testid="bili-server-status">
          {!status ? '正在检查服务器登录状态…' : status.login?.isLogin ? `B 站已登录${status.login.uname ? `：${status.login.uname}` : ''}` : status.login === null ? '登录状态未确认' : 'B 站未登录，清晰度和可访问内容可能受限'}
        </span>
      </Field>
      <p className="text-sm text-muted">由服务器解析、下载并保存视频，手机和平板也可直接导入，无需油猴或自建代理。任务提交后可关闭页面。</p>
      <Field label="B 站 Cookie（可选）" testId="field-bili-cookie">
        <div className="flex flex-col gap-2">
          <Input data-testid="bili-cookie" aria-label="B 站 Cookie" type="password" autoComplete="off" value={cookie}
            placeholder={status?.configured ? '服务器已保存 Cookie；输入新值可替换' : 'SESSDATA=...; bili_jct=...'}
            onChange={e => setCookie(e.target.value)} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <LoadingButton variant="secondary" data-testid="bili-cookie-save" loading={busy} isDisabled={!cookie.trim()} onPress={() => void save(cookie.trim())}>保存到服务器</LoadingButton>
            <Button variant="ghost" isDisabled={busy || !status?.configured} onPress={() => void save('')}>清除已保存 Cookie</Button>
            {legacyCookie ? <Button variant="ghost" isDisabled={busy} onPress={() => void save(legacyCookie)}>将此设备旧 Cookie 保存到服务器</Button> : null}
          </div>
          <span className="text-sm text-muted">Cookie 仅加密保存在当前账户的服务器上，不会回显或写入导入任务。登录本应用不等于登录 B 站；仅能访问该 B 站账号有权限的内容。</span>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        </div>
      </Field>
    </SectionCard>
  );
}
