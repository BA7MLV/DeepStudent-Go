import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, ToggleButton, ToggleButtonGroup, Tooltip } from '@heroui/react';
import { renderAsync } from 'docx-preview';
import { ensureHandoutPreviewFonts } from '../handout/previewFonts';
import { db, type HandoutRow, type VideoRow } from '../store/db';
import { cloud } from '../cloud/state';
import { accountLifecycle, type AccountLifetime } from '../client/account-lifecycle';
import { readRecordKeys } from '../cloud/sync';
import { useLatestHandout } from './useLatestHandout';
import { useTranslation } from 'react-i18next';
import type { LatestHandout } from '@wangke/contracts/client-runtime';
import { resolveCloudBlob } from '../store/cloudBlob';
import { runHandout, type HandoutProgress } from '../pipelines/handout';
import { usePluginAvailable } from '../plugins/catalog';
import { loadEnabledSkillMeta, type SkillMeta } from '../skills/store';
import { useIsMobile } from '../utils/useMobile';
import { TextSwap } from './motion';
import ModelPicker from './ModelPicker';
import HandoutDocView from './HandoutDocView';
import PersistentError from './PersistentError';
import { formatCaughtError } from '../utils/errorText';
import './handout-panel.css';
import {
  LoadingButton,
  Panel,
  PanelBar,
  PanelProgress,
  PanelPlaceholder,
  EmptyState,
  Banner,
  Field,
  Sym,
  toast,
  MODAL_CONTAINER_CLASS,
} from '../ui';

interface Props {
  videoId: string;
  hasSubtitles: boolean | null;
}

type SkillMode = 'auto' | 'pin' | 'drop';

export default function HandoutPanel(props: Props) {
  return <HandoutPanelView key={`${cloud.userId}:${props.videoId}`} {...props} />;
}

function HandoutPanelView({ videoId, hasSubtitles }: Props) {
  const { t } = useTranslation('interface');
  const available = usePluginAvailable('material-tools');
  const { row: latest, media: latestMedia, ready, error: readError, retry: loadLatest } = useLatestHandout(videoId);
  // A pushed new document/version cannot close an editor or rebase its original
  // CAS baseline. Keep that user-owned draft until it settles or is cancelled.
  const [retained, setRetained] = useState<{ videoId: string; row: HandoutRow; media?: LatestHandout['media']; database: typeof db; lifetime?: AccountLifetime } | null>(null);
  const retainedCurrent = retained?.videoId === videoId && retained.database === db && (!retained.lifetime || retained.lifetime.current());
  const handout = retainedCurrent ? retained.row : latest;
  const media = retainedCurrent ? retained.media : latestMedia;
  const retainDocument = useCallback((retain: boolean) => setRetained(previous => !retain ? null
    : previous?.videoId === videoId && previous.database === db && (!previous.lifetime || previous.lifetime.current()) ? previous
      : latest ? { videoId, row: latest, media: latestMedia, database: db, lifetime: accountLifecycle.current() } : null), [videoId, latest, latestMedia]);
  const [progress, setProgress] = useState<HandoutProgress | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillModes, setSkillModes] = useState<Record<number, SkillMode>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const skelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const owner = cloud.userId, database = db;
  const view = useMemo(() => ({ videoId, owner, database, active: true }), [videoId, owner, database]);
  const currentView = useRef(view);
  currentView.current = view;
  const viewCurrent = () => view.active && currentView.current === view && view.database === db && view.owner === cloud.userId;
  useEffect(() => {
    view.active = true;
    return () => { view.active = false; };
  }, [view]);

  /**
   * 手机端 docx 预览等比缩放：docx-preview 按 A4 像素宽（~794px）渲染，窄屏溢出。
   * 逐页 transform scale 到容器宽，并用负 marginBottom 补偿布局高度（transform 不占布局）。
   * 非手机端重置，处理窗口宽窄互切。
   */
  const fitPreviewScale = useCallback(() => {
    const el = previewRef.current;
    if (!el) return;
    const pages = el.querySelectorAll<HTMLElement>('section.docx');
    const avail = el.clientWidth - 8;
    pages.forEach((p) => {
      // 先重置再测量，避免重复调用时叠加
      p.style.transform = '';
      p.style.marginBottom = '';
      const w = p.scrollWidth;
      if (isMobile && avail > 0 && w > avail) {
        const s = avail / w;
        p.style.transform = `scale(${s})`;
        p.style.transformOrigin = 'top left';
        p.style.marginBottom = `${-(p.scrollHeight * (1 - s)) + 8}px`;
      }
    });
  }, [isMobile]);

  // 窗口宽窄切换 / 插图加载完成（高度变化影响补偿）时重算缩放
  useEffect(() => {
    window.addEventListener('resize', fitPreviewScale);
    const el = previewRef.current;
    el?.addEventListener('load', fitPreviewScale, true); // img load 不冒泡，走捕获
    return () => {
      window.removeEventListener('resize', fitPreviewScale);
      el?.removeEventListener('load', fitPreviewScale, true);
    };
  }, [fitPreviewScale]);

  /** 打开技能覆盖面板时加载：启用中的技能 + 本视频的手动覆盖 */
  const loadSkillState = useCallback(async () => {
    const lifetime = accountLifecycle.current(), database = db;
    const [metas, course] = await Promise.all([loadEnabledSkillMeta('legacy-handout'),
      cloud.enabled ? readRecordKeys<VideoRow>('videos', [videoId]).then(rows => rows[0]) : database.videos.get(videoId)]);
    if (!viewCurrent() || database !== db || lifetime && !lifetime.current()) return;
    setSkills(metas);
    const ov = course?.skillOverride;
    const map: Record<number, SkillMode> = {};
    for (const m of metas) {
      map[m.id] = ov?.pin.includes(m.id) ? 'pin' : ov?.drop.includes(m.id) ? 'drop' : 'auto';
    }
    setSkillModes(map);
  }, [view]);

  const setSkillMode = async (id: number, mode: SkillMode) => {
    if (!viewCurrent()) return;
    const lifetime = accountLifecycle.current();
    const next = { ...skillModes, [id]: mode };
    setSkillModes(next);
    const pin = Object.entries(next).filter(([, v]) => v === 'pin').map(([k]) => Number(k));
    const drop = Object.entries(next).filter(([, v]) => v === 'drop').map(([k]) => Number(k));
    const { resourceCommand } = await import('../client/resources');
    if (!viewCurrent() || lifetime && !lifetime.current()) return;
    await resourceCommand({ kind: 'setCourseSkills', courseId: videoId, pin, drop });
  };

  // 渲染 DOCX 预览（skeleton-reveal：脉冲占位 → cross-fade + cross-blur 到内容）
  // 仅旧版无 IR 的讲义行走此路径；有 sectionsJson 的讲义由 HandoutDocView 结构化渲染
  useEffect(() => {
    const skel = skelRef.current;
    const el = previewRef.current;
    if (!handout || handout.sectionsJson || !skel || !el) return;
    const skeleton = skel.querySelector('.t-skel-skeleton');
    // 回到加载态：is-resetting 杀掉反向过渡，reflow 后恢复，重新脉冲
    skel.classList.add('is-resetting');
    skel.classList.remove('is-revealed');
    skeleton?.classList.remove('is-pulsing');
    void skel.offsetWidth;
    skel.classList.remove('is-resetting');
    skeleton?.classList.add('is-pulsing');

    el.innerHTML = '';
    ensureHandoutPreviewFonts(); // 公文字体兜底：local() 优先，缺字体设备下载开源仿宋分包
    const controller = new AbortController();
    const preview = document.createElement('div');
    resolveCloudBlob(handout.blob, controller.signal)
      .then(blob => { controller.signal.throwIfAborted(); return renderAsync(blob, preview, undefined, { inWrapper: true }); })
      .then(() => {
        if (controller.signal.aborted) return;
        el.replaceChildren(...preview.childNodes);
        skel.classList.add('is-revealed');
        fitPreviewScale();
        // 字体分包异步加载完成后页面高度可能微变，重算一次手机端缩放补偿
        void document.fonts.ready.then(() => { if (!controller.signal.aborted) fitPreviewScale(); });
      })
      .catch((e) => { if (!controller.signal.aborted) console.error('docx 预览失败', e); });
    return () => controller.abort();
  }, [handout, fitPreviewScale]);

  const start = async () => {
    const lifetime = accountLifecycle.current();
    const current = () => viewCurrent() && (!lifetime || lifetime.current());
    if (!current() || !ready) return;
    setErrorText(null);
    setProgress({ phase: 'frames', done: 0, total: 1, message: '准备中…' });
    try {
      await runHandout(videoId, progress => { if (current()) setProgress(progress); });
      if (current()) toast.success('讲义生成完成');
    } catch (e) {
      // 失败详情留在面板里（带复制按钮），不再自动弹出模态打断阅读。
      if (current()) setErrorText(formatCaughtError(e));
    } finally {
      if (current()) { setProgress(null); loadLatest(); }
    }
  };

  const downloadDocx = async () => {
    if (!ready || !handout?.id) return;
    const lifetime = accountLifecycle.current(), database = db;
    const current = () => viewCurrent() && database === db && (!lifetime || lifetime.current());
    // Export this selected complete document at its current authoritative version,
    // not a stale mirror row left by a previous visit or an earlier edit.
    const row = cloud.enabled ? (await readRecordKeys<HandoutRow>('handouts', [handout.id]))[0] : await database.handouts.get(handout.id);
    if (!current()) return;
    if (!row) return;
    const blob = await resolveCloudBlob(row.blob);
    if (!current()) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${row.title}.docx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const running = progress !== null;
  const pct = progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : undefined;

  return (
    <Panel testId="panel-handout">
      <PanelBar>
        <Tooltip>
          <Tooltip.Trigger>
            <LoadingButton
              loading={running}
              variant="primary"
              data-testid="handout-generate"
              isDisabled={!available || !ready || hasSubtitles !== true}
              onPress={start}
            >
              <Sym name="article" />
              {handout ? '重新生成讲义' : '生成讲义'}
            </LoadingButton>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>{hasSubtitles === false ? '请等待字幕自动处理完成' : '抽取课程画面、提炼大纲并排版为 DOCX'}</p>
          </Tooltip.Content>
        </Tooltip>
        {handout && (
          <Button data-testid="handout-export" variant="outline" isDisabled={!ready} onPress={() => { void downloadDocx().catch(error => setErrorText(formatCaughtError(error))); }}>
            <Sym name="download" />
            下载 DOCX
          </Button>
        )}
        <Button
          data-testid="handout-settings"
          variant="outline"
          onPress={() => {
            void loadSkillState().catch(error => setErrorText(formatCaughtError(error)));
            setSettingsOpen(true);
          }}
        >
          <Sym name="tune" />
          参数设置
        </Button>
      </PanelBar>

      {hasSubtitles === false && ready && !running && (
        <PanelPlaceholder>讲义基于字幕内容生成，请等待字幕自动处理完成</PanelPlaceholder>
      )}

      {running && progress && (
        <PanelProgress testId="handout-progress" percent={pct} text={<TextSwap text={progress.message} />} />
      )}

      <PersistentError title="讲义生成失败" text={errorText} onClose={() => setErrorText(null)} />
      {readError && <Banner variant="error" testId="handout-read-error" title={t('handoutRead.failed')} action={<Button variant="tertiary" onPress={loadLatest}>{t('handoutRead.retry')}</Button>} />}
      {!ready && !readError && !handout && <div role="status" data-testid="handout-loading">{t('handoutRead.loading')}</div>}

      <div className="hp-body" data-handout-latest-id={latest?.id} data-handout-id={handout?.id}>
        {handout ? (
          handout.sectionsJson ? (
            // 结构化视图：块级左滑 / hover → AI 改写、手动编辑；DOCX 由 IR 实时重建
            <HandoutDocView key={`${handout.videoId}:${handout.id}`} handout={handout} media={media} onRetainDocument={retainDocument} />
          ) : (
            // 旧版生成的讲义（无 IR）：只读 docx-preview 预览
            <div className="hp-legacy">
              <Banner variant="info" title="该讲义由旧版生成，仅支持只读预览；重新生成后可逐段 AI 改写 / 手动编辑" />
              <div className="hp-legacy__scroll">
                <div ref={skelRef} className="t-skel hp-legacy__skel">
                  <div className="t-skel-skeleton hp-skel">
                    <div className="hp-skel__bar hp-skel__bar--title" />
                    <div className="hp-skel__bar" />
                    <div className="hp-skel__bar" />
                    <div className="hp-skel__bar hp-skel__bar--short" />
                    <div className="hp-skel__img" />
                    <div className="hp-skel__bar" />
                    <div className="hp-skel__bar hp-skel__bar--short" />
                  </div>
                  <div
                    ref={previewRef}
                    className="t-skel-content docx-preview-container hp-legacy__preview"
                  />
                  <div className="hp-legacy__fade">目录页码将在 Word / WPS 中打开文档后自动生成</div>
                </div>
              </div>
            </div>
          )
        ) : (
           ready && !running &&
          hasSubtitles === true && (
            <EmptyState
              testId="handout-empty"
              icon={<Sym name="article" />}
              title="还没有讲义"
              description="点击「生成讲义」，将自动抽取课程画面、提炼大纲并排版为公文格式 DOCX"
            />
          )
        )}
      </div>

      {/* 生成参数（模型 + 技能覆盖）：原两个 antd Popover 合并为一个受控对话框。
          内容含模型下拉与每个技能的「自动/必用/排除」分段控件，不是「点一下就关」的单选项，
          用对话框比 dropdown 菜单更合适（菜单项点击即关、放不下多组交互控件）。
          Esc / 点遮罩关闭由 Modal 的 onOpenChange 同步回 React state。 */}
      <Modal.Root isOpen={settingsOpen} onOpenChange={setSettingsOpen}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="handout-settings-dialog">
              <Modal.Header>
                <Modal.Heading>生成参数</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <div className="hp-settings">
                  <Field label="抽帧筛选 / 截图描述（视觉）">
                    <ModelPicker slot="vision" field="visionModel" />
                  </Field>
                  <Field label="讲义写作（文本）">
                    <ModelPicker slot="chat" field="llmModel" />
                  </Field>
                  <div className="hp-settings__hint">
                    「自动」由路由器按课程内容选用；「必用 / 排除」为本视频的手动覆盖。
                  </div>
                  {skills.length === 0 ? (
                    <div className="hp-settings__empty">暂无启用的技能，请到「设置 → 写作技能」添加</div>
                  ) : (
                    skills.map((s) => (
                      <SkillModeRow
                        key={s.id}
                        skill={s}
                        mode={skillModes[s.id] ?? 'auto'}
                        onMode={(v) => { void setSkillMode(s.id, v).catch(error => { if (viewCurrent()) setErrorText(formatCaughtError(error)); }); }}
                      />
                    ))
                  )}
                  {handout?.usedSkills && handout.usedSkills.length > 0 && (
                    <div className="hp-settings__used">上次生成选用：{handout.usedSkills.join('、')}</div>
                  )}
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" onPress={() => setSettingsOpen(false)}>
                  关闭
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </Panel>
  );
}

/** 单个技能的「自动 / 必用 / 排除」分段控件行。
 *  不用列表项组件（custom 插槽覆盖式，塞不下标题 + 控件两组内容）；
 *  分段控件走 ToggleButtonGroup 的受控 selectedKeys。 */
function SkillModeRow({
  skill,
  mode,
  onMode,
}: {
  skill: SkillMeta;
  mode: SkillMode;
  onMode: (mode: SkillMode) => void;
}) {
  return (
    <div className="hp-skill-row">
      {/* 技能名是纯展示文本，不是可点元素：HeroUI 的 Tooltip.Trigger 会渲染一个
          div[role=button] 并带上 tabIndex，把标签说成一个「按了没反应」的按钮。
          这里改用原生 title —— 语义与 mdui-tooltip 在非交互元素上的效果一致。 */}
      <span className="hp-skill-row__name" title={skill.description || '（无描述）'}>
        {skill.name}
      </span>
      <ToggleButtonGroup
        selectionMode="single"
        disallowEmptySelection
        size="sm"
        aria-label={`${skill.name} 的技能使用方式`}
        selectedKeys={[mode]}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (next) onMode(next as SkillMode);
        }}
      >
        <ToggleButton id="auto">自动</ToggleButton>
        <ToggleButton id="pin">必用</ToggleButton>
        <ToggleButton id="drop">排除</ToggleButton>
      </ToggleButtonGroup>
    </div>
  );
}
