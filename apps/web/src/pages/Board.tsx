import { useTranslation } from 'react-i18next';
import { PageShell } from '../ui';
import { PluginSlot } from '../plugins/PluginSlot';
import '../board/board.css';

export default function Board() {
  const { t } = useTranslation('common');
  return <PageShell title={t('board.title')} rootClassName="page-board"><div className="board" data-testid="board"><PluginSlot name="board.main" /></div></PageShell>;
}
