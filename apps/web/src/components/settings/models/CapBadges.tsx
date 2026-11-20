import { ModelCapabilities } from '../../ModelCapabilities';
import type { ModelOverrides } from '../../../api/modelMeta';

/** 能力徽标：多模态 / 可思考。模型 id 长的行里这两枚最占地方，所以做成小圆角标签 */
export function CapBadges({ catalogId, model, overrides }: { catalogId: string; model: string; overrides?: ModelOverrides }) {
  return <ModelCapabilities catalogId={catalogId} model={model} overrides={overrides} compact />;
}
