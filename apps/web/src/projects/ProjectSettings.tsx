import { useState } from 'react';
import { Button, Drawer, Input, Label, TextArea, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { AgentProfileDto, ProjectDetailDto, ProjectPolicy, ProjectRole } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { confirmDialog, toast } from '../ui';
import { projectError } from './errors';
import { SettingSelect } from '../components/settings/controls';
import { useIsMobile } from '../utils/useMobile';

export default function ProjectSettings({ project, agents, onChange, onClose }: {
  project: ProjectDetailDto; agents: AgentProfileDto[]; onChange: (project: ProjectDetailDto) => void; onClose: () => void;
}) {
  const { t } = useTranslation('projects');
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const [policy, setPolicy] = useState(project.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mobile = useIsMobile();
  const baseline = JSON.stringify({ name: project.name, instructions: project.instructions, policy: project.policy });
  const dirty = JSON.stringify({ name, instructions, policy }) !== baseline;
  const close = async () => {
    if (busy) return;
    if (dirty && !await confirmDialog({
      headline: '放弃未保存的项目设置？',
      description: '名称、指令和执行策略的修改不会保存；已生效的 Agent 授权不受影响。',
      confirmText: '放弃修改', danger: true,
    })) return;
    onClose();
  };
  const save = async () => {
    setBusy(true); setError('');
    try { onChange(await serverClient.updateProject(project.id, { name, instructions, policy })); toast.success(t('saved')); onClose(); }
    catch (error) { setError(projectError(error)); }
    finally { setBusy(false); }
  };
  const grant = async (agentId: string, role: string) => {
    setBusy(true); setError('');
    try { onChange(await serverClient.grantProject(project.id, agentId, role === 'none' ? null : role as ProjectRole)); }
    catch (error) { setError(projectError(error)); }
    finally { setBusy(false); }
  };
  return <Drawer.Root isOpen onOpenChange={open => { if (!open) void close(); }}>
    <Drawer.Backdrop variant="opaque">
      <Drawer.Content placement={mobile ? 'bottom' : 'right'} className={mobile ? 'max-h-[88vh]' : 'w-[min(36rem,100vw)]'}>
        <Drawer.Dialog className="project-settings" data-testid="project-settings">
    <Drawer.Header><Drawer.Heading>{t('settings')}</Drawer.Heading><Drawer.CloseTrigger aria-label={t('cancel')} /></Drawer.Header>
    <Drawer.Body><div className="project-form">
      <TextField isRequired><Label>{t('name')}</Label><Input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></TextField>
      <TextField><Label>{t('instructions')}</Label><TextArea value={instructions} rows={4} maxLength={16000} onChange={e => setInstructions(e.target.value)} /></TextField>
      <div>
        <SettingSelect label={t('shell')} value={policy.shell} options={(['ask', 'allow', 'deny'] as const).map(value => ({ id: value, label: t(value) }))}
          onChange={value => setPolicy(p => ({ ...p, shell: value as ProjectPolicy['shell'] }))} />
        <SettingSelect label={t('network')} value={policy.network} options={(['deny', 'allow'] as const).map(value => ({ id: value, label: t(value) }))}
          onChange={value => setPolicy(p => ({ ...p, network: value as ProjectPolicy['network'] }))} />
      </div>
      <h3>{t('grants')}</h3>
      <div>
        {agents.map(agent => <SettingSelect key={agent.id} label={agent.name} isDisabled={busy}
          value={project.grants.find(g => g.agentId === agent.id)?.role ?? 'none'}
          options={(['none', 'read', 'write', 'manage'] as const).map(role => ({ id: role, label: t(role) }))}
          onChange={role => void grant(agent.id, role)} />)}
      </div>
      <p className="project-path"><code>{project.workspacePath}</code></p>
      {error && <p className="project-error" role="alert">{error}</p>}
    </div></Drawer.Body>
    <Drawer.Footer><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('cancel')}</Button><Button variant="primary" isDisabled={busy || !name.trim()} onPress={() => void save()}>{t('save')}</Button></Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  </Drawer.Root>;
}
